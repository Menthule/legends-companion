//! The live tail session: Tailer -> Parser -> FightTracker + TriggerEngine,
//! with an ActionSink that emits Tauri events and forwards audio to the
//! audio thread. One session thread does everything; `recv_timeout(250ms)`
//! doubles as the timer/fight-update tick.

use std::collections::{HashMap, VecDeque};
use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use eqlog_core::catchup::{CatchUpGuard, CatchUpTransition};
use eqlog_core::events::Event;
use eqlog_core::fights::{FightConfig, FightTracker};
use eqlog_core::parser::Parser;
use eqlog_core::tail::{Tailer, TailerConfig};
use eqlog_triggers::engine::{ActionSink, TimerFireKind, TriggerFireInfo};
use eqlog_triggers::model::TimerLane;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::audio::AudioHandle;
use crate::config::AppConfig;
use crate::library::EngineBuild;
use crate::logging;
use crate::meters::LiveMeter;
use crate::store::SharedStore;

/// Tick period: timer polling + fight-update flush cadence.
const TICK_MS: u64 = 250;
/// Minimum interval between fight-update emissions (~2/sec).
const FIGHT_EMIT_MS: u64 = 500;
const TAILER_POLL_MS: u64 = 200;
/// "tail-stats" emission interval.
const STATS_EMIT_MS: u64 = 5_000;
/// Rolling window (in log lines) for the unclassified-rate canary.
const STATS_WINDOW: usize = 1_000;

// ---------- event payloads ----------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LogLinePayload {
    ts: i64,
    message: String,
    event: Event,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ActionPayload {
    kind: &'static str,
    text: String,
}

/// Identity of the trigger a fired action belongs to.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TriggerRef {
    id: String,
    name: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TriggerFiredPayload {
    /// `null` only for engine-internal housekeeping (e.g. a DoT timer
    /// reaped because its target died) — user-authored actions always
    /// carry their trigger.
    trigger: Option<TriggerRef>,
    action: ActionPayload,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TimerPayload {
    name: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_secs: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    warn_at_secs: Option<Option<u64>>,
    /// Overlay lane ("buff" | "enemy" | "other"); present on "started",
    /// "warning", "landed" and "expired" so the frontend can route bars
    /// without tracking name→lane itself.
    #[serde(skip_serializing_if = "Option::is_none")]
    lane: Option<&'static str>,
    /// Cast-time lead-in on "started": the bar renders as pending
    /// ("casting…") until the "landed" event (post-sprint item 12). Absent
    /// or 0 = the timer starts live.
    #[serde(skip_serializing_if = "Option::is_none")]
    pending_secs: Option<u64>,
}

/// Full snapshot of a live timer, returned by the `get_active_timers` command
/// so a reopened window or restarted app rehydrates running countdowns instead
/// of losing them (P3). Mirrors a "started" event plus `elapsedSecs`, which the
/// frontend feeds through its normal timer-start path.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ActiveTimerPayload {
    pub name: String,
    pub duration_secs: u64,
    pub elapsed_secs: u64,
    pub warn_at_secs: Option<u64>,
    pub lane: &'static str,
    pub pending_secs: u64,
}

/// Patch-day canary payload, emitted every [`STATS_EMIT_MS`].
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TailStatsPayload {
    /// Raw log lines seen this session.
    lines: u64,
    /// Percent of the last [`STATS_WINDOW`] lines the parser could not
    /// classify — the topbar ambers above ~3%.
    unclassified_pct: f64,
}

/// The tail thread died without the user asking it to stop.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SessionEndedPayload {
    reason: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FightsChangedPayload {
    /// Fights just persisted to the history store.
    added: usize,
}

/// "catch-up" event (post-sprint item 13): emitted once when replay
/// suppression starts (`active: true`) and once when the session is back at
/// the live edge (`active: false`, with the suppressed-line count).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CatchUpPayload {
    active: bool,
    /// Lines processed with actions suppressed (final on `active: false`).
    lines: u64,
}

// ---------- line clock ----------

/// Trigger timers run on log-line time. Between lines we extrapolate with
/// wall clock so countdowns keep firing when the log goes quiet.
struct LineClock {
    last_ts: i64,
    observed_at: Instant,
}

impl LineClock {
    fn new() -> Self {
        LineClock {
            last_ts: 0,
            observed_at: Instant::now(),
        }
    }

    fn observe(&mut self, ts: i64) {
        if ts >= self.last_ts {
            self.last_ts = ts;
            self.observed_at = Instant::now();
        }
    }

    fn now(&self) -> i64 {
        if self.last_ts == 0 {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0)
        } else {
            self.last_ts + self.observed_at.elapsed().as_secs() as i64
        }
    }
}

// ---------- action sink ----------

/// One buffered `ActionSink` call, held until the line's `process_traced`
/// returns so it can be attributed to its firing trigger.
enum BufferedAction {
    Speak(String),
    /// Already resolved against the bundled sounds dir.
    PlaySound(String),
    DisplayText(String),
    StartTimer {
        name: String,
        duration_secs: u64,
        warn_at_secs: Option<u64>,
        lane: TimerLane,
        pending_secs: u64,
    },
    CancelTimer(String),
}

/// Emits "trigger-fired"/"timer" events and forwards audio. Sink calls are
/// buffered per line and flushed with trigger attribution: the engine makes
/// exactly one sink call per trigger action, in fire order, so the fire list
/// from `process_traced` plus the per-trigger action counts partition the
/// buffer. Sink calls made *before* the match loop (timer reaping on
/// wear-off/death lines) land at the front and get `trigger: null`.
struct EmitSink {
    app: AppHandle,
    audio: AudioHandle,
    /// Bundled sounds dir, cached at session start so PlaySound actions can
    /// reference bundled files by bare name ("danger.wav") portably.
    sounds_dir: Option<PathBuf>,
    /// `effective_id` → action count, from the current [`EngineBuild`].
    action_counts: HashMap<String, usize>,
    buffer: Vec<BufferedAction>,
    /// Catch-up mode (post-sprint item 13): alert-facing actions (Speak,
    /// PlaySound, DisplayText, StartTimer) are dropped at flush; timer
    /// cancels still go through so overlays never keep stale bars.
    suppress: bool,
}

impl EmitSink {
    fn set_counts(&mut self, counts: HashMap<String, usize>) {
        self.action_counts = counts;
    }

    /// Attribute and emit everything buffered while processing one line.
    fn flush(&mut self, fires: &[TriggerFireInfo]) {
        if self.buffer.is_empty() {
            return;
        }
        if self.suppress {
            // Replay catch-up: the line is old news. Drop every alert-facing
            // action unemitted; only pass timer cancels through (the engine
            // already dropped those timers — overlays must follow).
            let buffer = std::mem::take(&mut self.buffer);
            for action in buffer {
                if let BufferedAction::CancelTimer(name) = action {
                    self.emit_action(BufferedAction::CancelTimer(name), None);
                }
            }
            return;
        }
        let buffer = std::mem::take(&mut self.buffer);
        let attributed: usize = fires
            .iter()
            .map(|f| self.action_counts.get(&f.id).copied().unwrap_or(0))
            .sum();
        // Anything beyond the fired triggers' own actions came from the
        // engine's pre-match housekeeping, which always runs first.
        let lead = buffer.len().saturating_sub(attributed);
        let mut owners: Vec<Option<TriggerRef>> = vec![None; lead];
        'fill: for fire in fires {
            let n = self.action_counts.get(&fire.id).copied().unwrap_or(0);
            for _ in 0..n {
                if owners.len() == buffer.len() {
                    break 'fill;
                }
                owners.push(Some(TriggerRef {
                    id: fire.id.clone(),
                    name: fire.name.clone(),
                }));
            }
        }
        owners.resize(buffer.len(), None);
        for (action, trigger) in buffer.into_iter().zip(owners) {
            self.emit_action(action, trigger);
        }
    }

    fn emit_action(&mut self, action: BufferedAction, trigger: Option<TriggerRef>) {
        match action {
            BufferedAction::Speak(text) => {
                self.audio.speak(text.clone());
                self.fired("speak", text, trigger);
            }
            BufferedAction::PlaySound(resolved) => {
                self.audio.play(resolved.clone());
                self.fired("playSound", resolved, trigger);
            }
            BufferedAction::DisplayText(text) => {
                self.fired("displayText", text, trigger);
            }
            BufferedAction::StartTimer {
                name,
                duration_secs,
                warn_at_secs,
                lane,
                pending_secs,
            } => {
                // The engine tracks expiry itself (see TriggerEngine::due);
                // we only tell the overlay a countdown began.
                let _ = self.app.emit(
                    "timer",
                    TimerPayload {
                        name: name.clone(),
                        kind: "started",
                        duration_secs: Some(duration_secs),
                        warn_at_secs: Some(warn_at_secs),
                        lane: Some(lane.as_str()),
                        pending_secs: (pending_secs > 0).then_some(pending_secs),
                    },
                );
                self.fired("startTimer", name, trigger);
            }
            BufferedAction::CancelTimer(name) => {
                // The engine already dropped the timer; tell the overlay to
                // remove its countdown.
                let _ = self.app.emit(
                    "timer",
                    TimerPayload {
                        name: name.clone(),
                        kind: "cancelled",
                        duration_secs: None,
                        warn_at_secs: None,
                        lane: None,
                        pending_secs: None,
                    },
                );
                self.fired("cancelTimer", name, trigger);
            }
        }
    }

    fn fired(&self, kind: &'static str, text: String, trigger: Option<TriggerRef>) {
        let _ = self.app.emit(
            "trigger-fired",
            TriggerFiredPayload {
                trigger,
                action: ActionPayload { kind, text },
            },
        );
    }
}

impl ActionSink for EmitSink {
    fn speak(&mut self, text: &str) {
        self.buffer.push(BufferedAction::Speak(text.to_string()));
    }

    fn play_sound(&mut self, path: &str) {
        let resolved = crate::sounds::resolve_in(self.sounds_dir.as_deref(), path);
        self.buffer.push(BufferedAction::PlaySound(resolved));
    }

    fn display_text(&mut self, text: &str) {
        self.buffer
            .push(BufferedAction::DisplayText(text.to_string()));
    }

    fn start_timer(
        &mut self,
        name: &str,
        duration_secs: u64,
        warn_at_secs: Option<u64>,
        lane: TimerLane,
        pending_secs: u64,
    ) {
        self.buffer.push(BufferedAction::StartTimer {
            name: name.to_string(),
            duration_secs,
            warn_at_secs,
            lane,
            pending_secs,
        });
    }

    fn cancel_timer(&mut self, name: &str) {
        self.buffer
            .push(BufferedAction::CancelTimer(name.to_string()));
    }
}

// ---------- session ----------

/// Handle to a running tail session; `stop()` joins the worker thread.
pub struct TailSession {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
    engine_tx: Sender<EngineBuild>,
    /// Live timer snapshot, refreshed each tick by the loop; read by the
    /// `get_active_timers` command so a reloaded window can rehydrate (P3).
    snapshots: Arc<Mutex<Vec<ActiveTimerPayload>>>,
}

impl TailSession {
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }

    /// Current running timers, for UI resync after a window reload (P3).
    /// Empty if the snapshot lock is poisoned rather than propagating panic.
    pub fn active_timers(&self) -> Vec<ActiveTimerPayload> {
        self.snapshots
            .lock()
            .map(|s| s.clone())
            .unwrap_or_default()
    }

    /// Replace the live trigger engine (profile/override change while
    /// tailing). Running timers from the old engine are dropped. The
    /// caller announces `build.warnings`; the session only takes the
    /// engine + action counts.
    pub fn swap_engine(&self, build: EngineBuild) -> Result<(), String> {
        self.engine_tx
            .send(build)
            .map_err(|_| "tail session has ended".to_string())
    }
}

pub fn start(
    app: AppHandle,
    config: AppConfig,
    build: EngineBuild,
    audio: AudioHandle,
    store: SharedStore,
) -> Result<TailSession, String> {
    let tailer = Tailer::spawn(TailerConfig {
        path: PathBuf::from(config.log_path.trim()),
        from_start: false,
        poll_interval_ms: TAILER_POLL_MS,
    })
    .map_err(|e| {
        let msg = format!("cannot tail {}: {e}", config.log_path);
        logging::warn(&msg);
        msg
    })?;

    let sink = EmitSink {
        app: app.clone(),
        audio,
        sounds_dir: crate::sounds::sounds_dir(&app),
        action_counts: HashMap::new(),
        buffer: Vec::new(),
        suppress: false,
    };
    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = stop.clone();
    let snapshots: Arc<Mutex<Vec<ActiveTimerPayload>>> = Arc::new(Mutex::new(Vec::new()));
    let loop_snapshots = snapshots.clone();
    let (engine_tx, engine_rx) = mpsc::channel();
    let handle = thread::Builder::new()
        .name("legends-tail".into())
        .spawn(move || {
            let loop_app = app.clone();
            let loop_stop = stop_flag.clone();
            let result = std::panic::catch_unwind(AssertUnwindSafe(move || {
                run_loop(
                    loop_app, config, build, engine_rx, tailer, loop_stop, sink, store,
                    loop_snapshots,
                )
            }));
            let reason = match result {
                Ok(reason) => reason,
                Err(panic) => Some(format!("tail thread panicked: {}", panic_text(&panic))),
            };
            // A user-requested stop is a clean end even if the tailer raced
            // us to a disconnect; anything else is a lying green dot.
            if stop_flag.load(Ordering::Relaxed) {
                return;
            }
            if let Some(reason) = reason {
                logging::warn(&format!("tail session ended unexpectedly: {reason}"));
                // Clear the stale handle so is_tailing tells the truth and
                // the Restart button's start_tailing isn't rejected.
                // (Dropping our own JoinHandle just detaches — no join.)
                if let Some(state) = app.try_state::<crate::commands::AppState>() {
                    if let Ok(mut session) = state.session.lock() {
                        *session = None;
                    }
                }
                let _ = app.emit("session-ended", SessionEndedPayload { reason });
            }
        })
        .map_err(|e| format!("spawn tail thread: {e}"))?;

    Ok(TailSession {
        stop,
        handle: Some(handle),
        engine_tx,
        snapshots,
    })
}

fn panic_text(panic: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = panic.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = panic.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic".to_string()
    }
}

/// Persist a drained batch of completed fights; store problems are logged,
/// never fatal to the session.
fn persist_fights(
    app: &AppHandle,
    store: &SharedStore,
    completed: &[eqlog_core::fights::FightSummary],
) {
    if completed.is_empty() {
        return;
    }
    if let Ok(mut guard) = store.lock() {
        if let Some(store) = guard.as_mut() {
            for fight in completed {
                if let Err(e) = store.insert(fight) {
                    logging::warn(&format!("persist fight vs {}: {e}", fight.target));
                }
            }
        }
    }
    let _ = app.emit(
        "fights-changed",
        FightsChangedPayload {
            added: completed.len(),
        },
    );
}

/// Returns `None` on a clean (user-requested) stop, `Some(reason)` when the
/// session dies on its own (tailer thread ended on fatal I/O).
#[allow(clippy::too_many_arguments)]
fn run_loop(
    app: AppHandle,
    config: AppConfig,
    build: EngineBuild,
    engine_rx: Receiver<EngineBuild>,
    tailer: Tailer,
    stop: Arc<AtomicBool>,
    mut sink: EmitSink,
    store: SharedStore,
    snapshots: Arc<Mutex<Vec<ActiveTimerPayload>>>,
) -> Option<String> {
    let mut engine = build.engine;
    sink.set_counts(build.action_counts);
    let parser = Parser::new();
    // Configured pets attribute to the character so meters fold named pets
    // (the possessive "<char>'s pet/warder" forms are auto-attributed).
    let mut fight_config = FightConfig::new(config.character_name.clone());
    for pet in &config.pets {
        let pet = pet.trim();
        if !pet.is_empty() {
            fight_config
                .pet_owners
                .insert(pet.to_string(), config.character_name.clone());
        }
    }
    let mut fights = FightTracker::new(fight_config);
    let mut meter = LiveMeter::new();
    let mut clock = LineClock::new();
    let mut fights_dirty = false;
    let start_at = Instant::now();
    let mut last_fight_emit = start_at
        .checked_sub(Duration::from_millis(FIGHT_EMIT_MS))
        .unwrap_or(start_at);
    // Patch-day canary: total lines + rolling unclassified flags.
    let mut lines_total: u64 = 0;
    let mut unclassified_window: VecDeque<bool> = VecDeque::with_capacity(STATS_WINDOW);
    let mut last_stats_emit = Instant::now();
    // Catch-up guard (post-sprint item 13): while a replayed backlog streams
    // through (line timestamps >30 s behind the newest seen), audible/visible
    // actions and fight-history writes are suppressed; meters still ingest.
    let mut catchup = CatchUpGuard::new();
    let mut last_line_at = Instant::now();
    // Set when the session dies on its own (tailer disconnect); the loop
    // then falls through to the final persist instead of returning early.
    let mut end_reason: Option<String> = None;

    /// Live wall clock in the log-timestamp domain (Unix seconds).
    fn wall_now() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    }

    fn announce_catchup(app: &AppHandle, transition: CatchUpTransition) {
        match transition {
            CatchUpTransition::Entered => {
                logging::warn(
                    "catch-up: replayed log content detected — \
                     suppressing alerts and fight-history writes",
                );
                let _ = app.emit(
                    "catch-up",
                    CatchUpPayload {
                        active: true,
                        lines: 0,
                    },
                );
            }
            CatchUpTransition::Exited { suppressed_lines } => {
                logging::info(&format!(
                    "catch-up over: {suppressed_lines} replayed line(s) suppressed"
                ));
                let _ = app.emit(
                    "catch-up",
                    CatchUpPayload {
                        active: false,
                        lines: suppressed_lines,
                    },
                );
            }
            CatchUpTransition::None => {}
        }
    }

    while end_reason.is_none() && !stop.load(Ordering::Relaxed) {
        // Hot-swap the engine when profile/override edits arrive (warnings
        // were already announced by the rebuild that sent it).
        while let Ok(next) = engine_rx.try_recv() {
            engine = next.engine;
            sink.set_counts(next.action_counts);
        }

        match tailer.lines.recv_timeout(Duration::from_millis(TICK_MS)) {
            Ok(raw) => {
                lines_total += 1;
                let parsed = parser.parse_line(&raw);
                // A line the parser can't even timestamp counts as
                // unclassified too — a launch-day format change must move
                // this needle, whatever shape it takes.
                let unclassified = match &parsed {
                    None => true,
                    Some(p) => matches!(p.event, Event::Unclassified),
                };
                if unclassified_window.len() == STATS_WINDOW {
                    unclassified_window.pop_front();
                }
                unclassified_window.push_back(unclassified);
                let Some(parsed) = parsed else {
                    continue; // wrapped/garbage line without a timestamp prefix
                };
                last_line_at = Instant::now();
                // Catch-up transitions are decided BEFORE the line's actions
                // run: an entering line is already suppressed; the exiting
                // (live) line goes through normally.
                let transition = catchup.observe_line(parsed.line.timestamp, wall_now());
                announce_catchup(&app, transition);
                sink.suppress = catchup.is_active();
                clock.observe(parsed.line.timestamp);
                fights.ingest(&parsed);
                fights_dirty = true;
                let fires = engine.process_traced(&parsed, &mut sink);
                sink.flush(&fires);
                let _ = app.emit(
                    "log-line",
                    LogLinePayload {
                        ts: parsed.line.timestamp,
                        message: parsed.line.message,
                        event: parsed.event,
                    },
                );
            }
            Err(e) => {
                if e.is_disconnected() {
                    // Tailer thread ended (fatal I/O). Run the tick below
                    // one last time, then end the session too.
                    end_reason = Some(format!(
                        "log reader stopped (I/O error on {})",
                        config.log_path.trim()
                    ));
                }
                // Timeout: run the tick below; a drained backlog (quiet
                // channel while catching up) means we are at the live edge.
                let transition = catchup.observe_idle(last_line_at.elapsed().as_secs());
                announce_catchup(&app, transition);
                sink.suppress = catchup.is_active();
            }
        }

        for fire in engine.due(clock.now()) {
            // Restarted fires (repeating timers) carry the new cycle's
            // duration so the frontend can draw a replacement bar.
            let mut duration_secs = None;
            let mut warn_at_secs = None;
            let kind = match fire.kind {
                TimerFireKind::Landed => {
                    // The cast completed: the bar flips from "casting…" to a
                    // live countdown. Visual-only.
                    "landed"
                }
                TimerFireKind::Warn => {
                    // Speak the ending warning — the whole point of a buff
                    // timer is hearing it before the buff drops. Expiry
                    // stays visual-only (warn+expire speech is spammy).
                    // Muted during catch-up: replayed timers expiring in
                    // bulk must not narrate.
                    if !catchup.is_active() {
                        sink.audio
                            .speak(fire.text.clone().unwrap_or_else(|| format!("{} ending", fire.name)));
                        if let Some(sound) = &fire.sound {
                            sink.audio
                                .play(crate::sounds::resolve_in(sink.sounds_dir.as_deref(), sound));
                        }
                    }
                    "warning"
                }
                TimerFireKind::Expire => {
                    if !catchup.is_active() {
                        if let Some(text) = &fire.text {
                            sink.audio.speak(text.clone());
                        }
                        if let Some(sound) = &fire.sound {
                            sink.audio
                                .play(crate::sounds::resolve_in(sink.sounds_dir.as_deref(), sound));
                        }
                    }
                    "expired"
                }
                TimerFireKind::Restarted => {
                    // Visual-only: the Expire fire in the same batch already
                    // spoke/played anything the timer defines. The payload's
                    // warn field is doubly optional (outer = include in the
                    // JSON at all), hence the Some wrap.
                    duration_secs = fire.duration_secs;
                    warn_at_secs = Some(fire.warn_secs);
                    "started"
                }
            };
            let _ = app.emit(
                "timer",
                TimerPayload {
                    name: fire.name,
                    kind,
                    duration_secs,
                    warn_at_secs,
                    lane: Some(fire.lane.as_str()),
                    pending_secs: None,
                },
            );
        }

        // Refresh the resync snapshot (P3) on the same clock the due() poll
        // just used, so a reopened window's get_active_timers call restores
        // live countdowns. Cheap: a handful of timers cloned per tick.
        if let Ok(mut snap) = snapshots.lock() {
            *snap = engine
                .timer_snapshots(clock.now())
                .into_iter()
                .map(|t| ActiveTimerPayload {
                    name: t.name,
                    duration_secs: t.duration_secs,
                    elapsed_secs: t.elapsed_secs,
                    warn_at_secs: t.warn_at_secs,
                    lane: t.lane.as_str(),
                    pending_secs: t.pending_secs,
                })
                .collect();
        }

        if fights_dirty && last_fight_emit.elapsed() >= Duration::from_millis(FIGHT_EMIT_MS) {
            // Drain ALL completed fights: every one goes to the history
            // store (the old code kept only the last per tick — AE pulls
            // lost fights), the batch's tail keeps the meter populated.
            // During catch-up the drained batch is NOT persisted (a replay
            // would double-write history) but still feeds the meter.
            let completed = fights.completed_fights();
            if !catchup.is_active() {
                persist_fights(&app, &store, &completed);
            }
            if let Some(update) = meter.update(&fights, &completed) {
                let _ = app.emit("fight-update", update);
            }
            fights_dirty = false;
            last_fight_emit = Instant::now();
        }

        if last_stats_emit.elapsed() >= Duration::from_millis(STATS_EMIT_MS) {
            let pct = if unclassified_window.is_empty() {
                0.0
            } else {
                let bad = unclassified_window.iter().filter(|u| **u).count();
                bad as f64 * 100.0 / unclassified_window.len() as f64
            };
            let _ = app.emit(
                "tail-stats",
                TailStatsPayload {
                    lines: lines_total,
                    unclassified_pct: pct,
                },
            );
            last_stats_emit = Instant::now();
        }
    }
    // Session is ending (clean Stop or tailer death) — persist anything
    // that completed since the last flush so no fight is lost. Skipped
    // while catching up: those fights are replayed history, not new pulls.
    let completed = fights.completed_fights();
    if !catchup.is_active() {
        persist_fights(&app, &store, &completed);
    }
    end_reason
}
