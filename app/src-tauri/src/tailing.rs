//! The live tail session: Tailer -> Parser -> FightTracker + TriggerEngine,
//! with an ActionSink that emits Tauri events and forwards audio to the
//! audio thread. One session thread does everything; `recv_timeout(250ms)`
//! doubles as the timer/fight-update tick.

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use eqlog_core::cast_stats::CastStats;
use eqlog_core::catchup::{CatchUpGuard, CatchUpTransition};
use eqlog_core::events::Event;
use eqlog_core::fights::{FightConfig, FightTracker};
use eqlog_core::parser::Parser;
use eqlog_core::tail::{Tailer, TailerConfig};
use eqlog_triggers::engine::{
    ActionSink, ImpactFire, OverlayFire, TimerFireKind, TriggerFireInfo, TriggerSignal,
    WatchObservation,
};
use eqlog_triggers::model::{TimerLane, TriggerEvent, WatchObservationKind};
use eqlog_triggers::storage::CharacterId;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::audio::AudioHandle;
use crate::config::AppConfig;
use crate::library::EngineBuild;
use crate::logging;
use crate::meters::LiveMeter;
use crate::store::SharedStore;
use crate::watches::{SharedWatchStore, WatchList, WatchStore};

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

/// A fired `Impact` action, emitted on the `impact` event for the Impact
/// overlay. Every field comes straight from the trigger's `Impact` action
/// (already template-expanded) — nothing here is hardcoded per moment.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ImpactPayload {
    style: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    headline: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    big: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sub: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    glyph: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    color: Option<String>,
}

/// Destination-neutral overlay delivery. The selected overlay owns the field
/// and configuration schema; the backend transports it without interpretation.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TriggerOverlayPayload {
    trigger: Option<TriggerRef>,
    overlay: String,
    fields: BTreeMap<String, String>,
    config: BTreeMap<String, serde_json::Value>,
}

/// One row of the live caster resist/fizzle/land% view (P45), emitted on the
/// `cast-update` event. Percentages are precomputed so the frontend is a plain
/// table.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CastRowPayload {
    caster: String,
    spell: String,
    casts: u32,
    landed: u32,
    fizzles: u32,
    resists: u32,
    interrupts: u32,
    land_pct: f64,
    fizzle_pct: f64,
    resist_pct: f64,
}

/// Top-N cast rows (by attempts) sent to the frontend — bounds the payload on
/// long sessions with many caster/spell combinations.
const CAST_ROWS_CAP: usize = 100;

fn cast_rows_payload(casts: &CastStats) -> Vec<CastRowPayload> {
    casts
        .rows()
        .into_iter()
        .take(CAST_ROWS_CAP)
        .map(|r| CastRowPayload {
            casts: r.attempts(),
            landed: r.landed(),
            fizzles: r.fizzles,
            resists: r.resists,
            interrupts: r.interrupts,
            land_pct: r.land_pct(),
            fizzle_pct: r.fizzle_pct(),
            resist_pct: r.resist_pct(),
            caster: r.caster,
            spell: r.spell,
        })
        .collect()
}

/// Identity of the trigger a fired action belongs to.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TriggerRef {
    id: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    icon: Option<String>,
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

/// One player condition currently inferred from the log. Conditions are
/// trigger-authored, but state is host-owned so an overlay reload can recover
/// the truth without waiting for another begin/end line.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveConditionPayload {
    pub key: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub priority: i64,
    /// Host-owned safety deadline. The log normally supplies an explicit
    /// clear, but zoning/form/client quirks can drop it; never serialize this
    /// implementation detail to the overlay.
    #[serde(skip)]
    expires_at: Instant,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TimerPayload {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    icon: Option<String>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
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
        icon: Option<String>,
        duration_secs: u64,
        warn_at_secs: Option<u64>,
        lane: TimerLane,
        pending_secs: u64,
    },
    CancelTimer(String),
    Impact(ImpactPayload),
    Overlay {
        overlay: String,
        fields: BTreeMap<String, String>,
        config: BTreeMap<String, serde_json::Value>,
    },
    ObserveWatch(WatchObservation),
}

struct BufferedEntry {
    action: BufferedAction,
    trigger: Option<TriggerRef>,
}

/// Emits "trigger-fired"/"timer" events and forwards audio. Sink calls are
/// buffered per line. The engine explicitly enters each trigger's scope, so
/// every buffered call captures its owner immediately. Housekeeping calls are
/// made outside a scope and carry `trigger: null`.
struct EmitSink {
    app: AppHandle,
    audio: AudioHandle,
    /// Bundled sounds dir, cached at session start so PlaySound actions can
    /// reference bundled files by bare name ("danger.wav") portably.
    sounds_dir: Option<PathBuf>,
    current_trigger: Option<TriggerRef>,
    buffer: Vec<BufferedEntry>,
    /// Catch-up mode (post-sprint item 13): alert-facing actions (Speak,
    /// PlaySound, DisplayText, StartTimer) are dropped at flush; timer
    /// cancels still go through so overlays never keep stale bars.
    suppress: bool,
    /// Canonical active-condition snapshot shared with the command layer.
    conditions: Arc<Mutex<BTreeMap<String, ActiveConditionPayload>>>,
}

fn apply_condition_transition(
    conditions: &mut BTreeMap<String, ActiveConditionPayload>,
    fields: &BTreeMap<String, String>,
    config: &BTreeMap<String, serde_json::Value>,
    trigger_icon: Option<&str>,
    now: Instant,
) -> Option<(String, bool)> {
    let key = fields.get("key").map(|value| value.trim()).unwrap_or("");
    if key.is_empty() {
        return None;
    }
    let active = fields
        .get("active")
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "true" | "1" | "on"
            )
        })
        .unwrap_or(true);
    if !active {
        return conditions.remove(key).map(|_| (key.to_string(), false));
    }

    let ttl_secs = config
        .get("max_age_secs")
        .and_then(serde_json::Value::as_u64)
        .filter(|seconds| *seconds > 0)
        .unwrap_or_else(|| default_condition_max_age_secs(key))
        .min(86_400);
    let next = ActiveConditionPayload {
        key: key.to_string(),
        label: fields
            .get("label")
            .filter(|value| !value.trim().is_empty())
            .cloned()
            .unwrap_or_else(|| key.to_string()),
        icon: fields
            .get("icon")
            .filter(|value| !value.trim().is_empty())
            .cloned()
            .or_else(|| trigger_icon.map(str::to_string)),
        priority: config
            .get("priority")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0),
        expires_at: now + Duration::from_secs(ttl_secs),
    };
    if let Some(current) = conditions.get_mut(key) {
        if current.key == next.key
            && current.label == next.label
            && current.icon == next.icon
            && current.priority == next.priority
        {
            // Repeated evidence refreshes the safety deadline without
            // needlessly animating or re-emitting an unchanged condition.
            current.expires_at = next.expires_at;
            return None;
        }
    }
    conditions.insert(key.to_string(), next);
    Some((key.to_string(), true))
}

/// Conservative upper bounds for inferred state. Explicit off messages still
/// clear immediately; these deadlines only prevent a missing line from
/// leaving a chip on screen forever. Trigger authors may override with
/// `config.max_age_secs` for a condition with known timing.
fn default_condition_max_age_secs(key: &str) -> u64 {
    match key {
        "stun" => 15,
        "spin" => 45,
        "fear" => 90,
        "mez" => 180,
        "root" | "silence" | "blind" => 300,
        "charm" | "slow" | "snare" => 900,
        "poison" | "disease" | "encumbered" => 1_800,
        _ => 900,
    }
}

fn expire_condition_transitions(
    conditions: &mut BTreeMap<String, ActiveConditionPayload>,
    now: Instant,
) -> Vec<String> {
    let expired = conditions
        .iter()
        .filter(|(_, condition)| condition.expires_at <= now)
        .map(|(key, _)| key.clone())
        .collect::<Vec<_>>();
    for key in &expired {
        conditions.remove(key);
    }
    expired
}

impl EmitSink {
    fn push(&mut self, action: BufferedAction) {
        self.buffer.push(BufferedEntry {
            action,
            trigger: self.current_trigger.clone(),
        });
    }

    /// Attribute and emit everything buffered while processing one line.
    fn flush(&mut self) {
        if self.buffer.is_empty() {
            return;
        }
        if self.suppress {
            // Replay catch-up: the line is old news. Drop every alert-facing
            // action unemitted; only pass timer cancels through (the engine
            // already dropped those timers — overlays must follow).
            let buffer = std::mem::take(&mut self.buffer);
            for entry in buffer {
                match entry.action {
                    BufferedAction::CancelTimer(name) => {
                        self.emit_action(BufferedAction::CancelTimer(name), entry.trigger)
                    }
                    BufferedAction::Overlay {
                        overlay,
                        fields,
                        config,
                    } if overlay == "conditions" => {
                        self.apply_condition(fields, config, entry.trigger, false)
                    }
                    _ => {}
                }
            }
            return;
        }
        let buffer = std::mem::take(&mut self.buffer);
        for entry in buffer {
            self.emit_action(entry.action, entry.trigger);
        }
    }

    /// Remove raw-line watch observations from the normal output buffer.
    /// They are consumed by the tail loop and may enqueue structured trigger
    /// signals; keeping that handoff outside `ActionSink` avoids recursively
    /// borrowing the engine while it is still executing a trigger.
    fn take_watch_observations(&mut self) -> Vec<WatchObservation> {
        let buffer = std::mem::take(&mut self.buffer);
        let mut observations = Vec::new();
        let mut retained = Vec::with_capacity(buffer.len());
        for entry in buffer {
            match entry.action {
                BufferedAction::ObserveWatch(observation) => {
                    if !self.suppress {
                        let label = format!("{:?}: {}", observation.kind, observation.name);
                        self.fired("observeWatch", label, entry.trigger);
                        observations.push(observation);
                    }
                }
                action => retained.push(BufferedEntry {
                    action,
                    trigger: entry.trigger,
                }),
            }
        }
        self.buffer = retained;
        observations
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
                icon,
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
                        icon,
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
                        icon: None,
                        kind: "cancelled",
                        duration_secs: None,
                        warn_at_secs: None,
                        lane: None,
                        pending_secs: None,
                    },
                );
                self.fired("cancelTimer", name, trigger);
            }
            BufferedAction::Impact(payload) => {
                // Trigger-driven Impact moment → the Impact overlay. Also
                // reported as a fired action (kind "impact") so the trigger
                // audit/attribution sees it like any other channel.
                let label = payload.big.clone().unwrap_or_else(|| payload.style.clone());
                let _ = self.app.emit("impact", payload);
                self.fired("impact", label, trigger);
            }
            BufferedAction::Overlay {
                overlay,
                fields,
                config,
            } => {
                if overlay == "conditions" {
                    self.apply_condition(fields, config, trigger, true);
                    return;
                }
                let label = fields
                    .get("text")
                    .or_else(|| fields.get("headline"))
                    .or_else(|| fields.get("value"))
                    .cloned()
                    .unwrap_or_else(|| overlay.clone());
                let _ = self.app.emit(
                    "trigger-overlay",
                    TriggerOverlayPayload {
                        trigger: trigger.clone(),
                        overlay,
                        fields,
                        config,
                    },
                );
                self.fired("overlay", label, trigger);
            }
            BufferedAction::ObserveWatch(_) => {
                unreachable!("watch observations are drained before normal action flush")
            }
        }
    }

    fn condition_snapshot(&self) -> Vec<ActiveConditionPayload> {
        let mut values = self
            .conditions
            .lock()
            .map(|conditions| conditions.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        values.sort_by(|a, b| {
            b.priority
                .cmp(&a.priority)
                .then_with(|| a.label.cmp(&b.label))
        });
        values
    }

    fn emit_conditions_snapshot(&self) {
        let _ = self.app.emit("conditions-changed", self.condition_snapshot());
    }

    fn clear_conditions(&mut self, emit: bool) {
        if let Ok(mut conditions) = self.conditions.lock() {
            if conditions.is_empty() {
                return;
            }
            conditions.clear();
        }
        if emit {
            self.emit_conditions_snapshot();
        }
    }

    fn apply_condition(
        &mut self,
        fields: BTreeMap<String, String>,
        config: BTreeMap<String, serde_json::Value>,
        trigger: Option<TriggerRef>,
        emit: bool,
    ) {
        let transition = self.conditions.lock().ok().and_then(|mut conditions| {
            apply_condition_transition(
                &mut conditions,
                &fields,
                &config,
                trigger.as_ref().and_then(|owner| owner.icon.as_deref()),
                Instant::now(),
            )
        });
        if let Some((key, active)) = transition.as_ref() {
            let owner = trigger
                .as_ref()
                .map(|owner| owner.id.as_str())
                .unwrap_or("<unknown>");
            logging::info(&format!(
                "condition {key} {} via {owner}",
                if *active { "on" } else { "off" }
            ));
        }
        if emit && transition.is_some() {
            self.emit_conditions_snapshot();
            let (key, active) = transition.expect("checked above");
            self.fired(
                "overlay",
                format!("{} {}", key, if active { "on" } else { "off" }),
                trigger,
            );
        }
    }

    fn expire_conditions(&mut self, now: Instant, emit: bool) {
        let expired = self
            .conditions
            .lock()
            .map(|mut conditions| expire_condition_transitions(&mut conditions, now))
            .unwrap_or_default();
        if expired.is_empty() {
            return;
        }
        for key in &expired {
            logging::info(&format!("condition {key} off via safety-expiry"));
        }
        if emit {
            self.emit_conditions_snapshot();
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
    fn begin_trigger(&mut self, trigger: &TriggerFireInfo) {
        self.current_trigger = Some(TriggerRef {
            id: trigger.id.clone(),
            name: trigger.name.clone(),
            icon: trigger.icon.clone(),
        });
    }

    fn end_trigger(&mut self) {
        self.current_trigger = None;
    }

    fn speak(&mut self, text: &str) {
        self.push(BufferedAction::Speak(text.to_string()));
    }

    fn play_sound(&mut self, path: &str) {
        let resolved = crate::sounds::resolve_in(self.sounds_dir.as_deref(), path);
        self.push(BufferedAction::PlaySound(resolved));
    }

    fn display_text(&mut self, text: &str) {
        self.push(BufferedAction::DisplayText(text.to_string()));
    }

    fn start_timer(
        &mut self,
        name: &str,
        icon: Option<&str>,
        duration_secs: u64,
        warn_at_secs: Option<u64>,
        lane: TimerLane,
        pending_secs: u64,
    ) {
        self.push(BufferedAction::StartTimer {
            name: name.to_string(),
            icon: icon.map(str::to_string),
            duration_secs,
            warn_at_secs,
            lane,
            pending_secs,
        });
    }

    fn cancel_timer(&mut self, name: &str) {
        self.push(BufferedAction::CancelTimer(name.to_string()));
    }

    fn impact(&mut self, spec: ImpactFire<'_>) {
        self.push(BufferedAction::Impact(ImpactPayload {
            style: spec.style.to_string(),
            headline: spec.headline,
            big: spec.big,
            sub: spec.sub,
            glyph: spec.glyph.map(|s| s.to_string()),
            color: spec.color.map(|s| s.to_string()),
        }));
    }

    fn overlay(&mut self, spec: OverlayFire<'_>) {
        self.push(BufferedAction::Overlay {
            overlay: spec.overlay.to_string(),
            fields: spec.fields,
            config: spec.config.clone(),
        });
    }

    fn observe_watch(&mut self, observation: WatchObservation) {
        self.push(BufferedAction::ObserveWatch(observation));
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
    conditions: Arc<Mutex<BTreeMap<String, ActiveConditionPayload>>>,
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
        self.snapshots.lock().map(|s| s.clone()).unwrap_or_default()
    }

    pub fn active_conditions(&self) -> Vec<ActiveConditionPayload> {
        let mut values = self
            .conditions
            .lock()
            .map(|conditions| conditions.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        values.sort_by(|a, b| {
            b.priority
                .cmp(&a.priority)
                .then_with(|| a.label.cmp(&b.label))
        });
        values
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
    watches: SharedWatchStore,
) -> Result<TailSession, String> {
    let watch_character = config
        .active_character
        .as_ref()
        .map(|active| CharacterId::new(&active.character, &active.server))
        .or_else(|| CharacterId::from_log_path(&config.log_path))
        .unwrap_or_else(|| CharacterId::new(&config.character_name, ""));
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

    let conditions = Arc::new(Mutex::new(BTreeMap::new()));
    let sink = EmitSink {
        app: app.clone(),
        audio,
        sounds_dir: crate::sounds::sounds_dir(&app),
        current_trigger: None,
        buffer: Vec::new(),
        suppress: false,
        conditions: conditions.clone(),
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
                    loop_app,
                    config,
                    build,
                    engine_rx,
                    tailer,
                    loop_stop,
                    sink,
                    store,
                    watches,
                    watch_character,
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
        conditions,
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

fn observation_quantity(value: Option<&str>) -> Result<u32, String> {
    let value = value.unwrap_or_default().trim();
    if value.is_empty() {
        return Ok(1);
    }
    value
        .parse::<u32>()
        .ok()
        .filter(|quantity| *quantity > 0)
        .ok_or_else(|| {
            format!("watch observation quantity must be a positive number, got {value:?}")
        })
}

/// Apply one trigger-authored raw-line observation and produce the canonical
/// structured signal consumed by ordinary output triggers. Raw log grammar is
/// intentionally absent here: changing a message format only changes the
/// event-source trigger's regex/capture templates.
fn apply_watch_observation(
    store: &mut WatchStore,
    character: &CharacterId,
    timestamp: i64,
    observation: WatchObservation,
) -> Result<Option<(TriggerSignal, WatchList)>, String> {
    let quantity = observation_quantity(observation.quantity.as_deref())?;
    let mut fields = observation.context;
    let event = match observation.kind {
        WatchObservationKind::Loot => {
            let Some(matched) = store.apply_self_loot(character, &observation.name, quantity)?
            else {
                return Ok(None);
            };
            fields.insert("item".into(), matched.item);
            fields.insert("quantity".into(), matched.quantity.to_string());
            fields.insert(
                "appliedQuantity".into(),
                matched.applied_quantity.to_string(),
            );
            fields.insert("remaining".into(), matched.remaining_quantity.to_string());
            fields.insert("quests".into(), matched.quests.join(", "));
            fields.insert("completed".into(), matched.completed.to_string());
            TriggerEvent::WatchedLoot
        }
        WatchObservationKind::Kill => {
            // A kill log line represents one observed death. Quantity remains
            // part of the generic action contract for future event sources,
            // but deliberately cannot manufacture multiple deaths here.
            if quantity != 1 {
                return Err("kill watch observations must have quantity 1".into());
            }
            let Some(matched) = store.apply_observed_kill(character, &observation.name)? else {
                return Ok(None);
            };
            fields.insert("mob".into(), matched.mob);
            fields.insert(
                "appliedQuantity".into(),
                matched.applied_quantity.to_string(),
            );
            fields.insert("remaining".into(), matched.remaining_quantity.to_string());
            fields.insert("quests".into(), matched.quests.join(", "));
            fields.insert("completed".into(), matched.completed.to_string());
            TriggerEvent::WatchedKill
        }
    };
    let list = store.list(character)?;
    Ok(Some((TriggerSignal::new(event, timestamp, fields), list)))
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
    watches: SharedWatchStore,
    watch_character: CharacterId,
    snapshots: Arc<Mutex<Vec<ActiveTimerPayload>>>,
) -> Option<String> {
    let mut engine = build.engine;
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
    let mut casts = CastStats::new(config.character_name.clone());
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
    // Targets for which the game emitted its authoritative rare-creature con
    // marker. The name stays armed until that mob dies or the zone changes.
    let mut rare_targets: HashSet<String> = HashSet::new();

    /// Live wall clock in the log-timestamp domain (Unix seconds).
    fn wall_now() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    }

    /// `/pet leader` reply: `My leader is <owner>.` When the owner is this
    /// character, persist the speaker into config.pets so the pet survives
    /// restarts (meters attribution + friendly-caster seeding at session
    /// start) instead of being re-taught every session. The live trigger
    /// engine already learned it in-memory; the fight tracker picks it up
    /// on the next session start.
    fn persist_learned_pet(
        app: &AppHandle,
        character: &str,
        parsed: &eqlog_core::events::ParsedLine,
    ) {
        use eqlog_core::events::Entity;
        let Event::Chat {
            speaker: Entity::Named(name),
            text,
            ..
        } = &parsed.event
        else {
            return;
        };
        let Some(owner) = text.trim().strip_prefix("My leader is ") else {
            return;
        };
        if !owner.trim_end_matches('.').eq_ignore_ascii_case(character) || character.is_empty() {
            return;
        }
        let Some(state) = app.try_state::<crate::commands::AppState>() else {
            return;
        };
        let Ok(mut cfg) = crate::commands::lock(&state.config, "config") else {
            return;
        };
        if cfg.pets.iter().any(|p| p.trim().eq_ignore_ascii_case(name)) {
            return; // already known
        }
        cfg.pets.push(name.clone());
        let snapshot = cfg.clone();
        drop(cfg);
        if let Err(e) = crate::config::save(app, &snapshot) {
            logging::warn(&format!("persist learned pet '{name}': {e}"));
            return;
        }
        crate::library::persist_active_overrides(app, &snapshot);
        let _ = app.emit("config-changed", &snapshot);
        logging::info(&format!("learned pet '{name}' for {character} (persisted)"));
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
        }
        sink.expire_conditions(Instant::now(), !catchup.is_active());

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
                let catchup_exited = matches!(transition, CatchUpTransition::Exited { .. });
                announce_catchup(&app, transition);
                sink.suppress = catchup.is_active();
                if catchup_exited {
                    sink.emit_conditions_snapshot();
                }
                clock.observe(parsed.line.timestamp);
                persist_learned_pet(&app, &config.character_name, &parsed);
                fights.ingest(&parsed);
                casts.ingest(&parsed);
                fights_dirty = true;
                let rare_kill_signal = match &parsed.event {
                    Event::Consider { target, rare: true, .. } => {
                        rare_targets.insert(target.to_ascii_lowercase());
                        None
                    }
                    Event::Slain {
                        victim: eqlog_core::events::Entity::Named(victim),
                        killer,
                    } if rare_targets.remove(&victim.to_ascii_lowercase()) => Some(
                        TriggerSignal::new(
                            TriggerEvent::RareKill,
                            parsed.line.timestamp,
                            BTreeMap::from([
                                ("mob".to_string(), victim.clone()),
                                (
                                    "killer".to_string(),
                                    killer
                                        .as_ref()
                                        .map(|entity| entity.name(&config.character_name).to_string())
                                        .unwrap_or_else(|| "Unknown".to_string()),
                                ),
                            ]),
                        ),
                    ),
                    Event::Loading | Event::ZoneEnter { .. } => {
                        rare_targets.clear();
                        None
                    }
                    _ => None,
                };
                if matches!(
                    &parsed.event,
                    Event::Loading
                        | Event::ZoneEnter { .. }
                        | Event::Slain {
                            victim: eqlog_core::events::Entity::You,
                            ..
                        }
                ) {
                    sink.clear_conditions(!catchup.is_active());
                }
                let _fires = engine.process_traced(&parsed, &mut sink);
                // Observation actions are produced only by raw-line triggers.
                // Drain them after raw processing, apply watch progress, then
                // feed the resulting structured signals back through the
                // engine. Structured triggers cannot emit observations, so
                // this queue cannot recurse.
                for observation in sink.take_watch_observations() {
                    let outcome = match watches.lock() {
                        Ok(mut shared) => shared.as_mut().map(|store| {
                            apply_watch_observation(
                                store,
                                &watch_character,
                                parsed.line.timestamp,
                                observation,
                            )
                        }),
                        Err(_) => {
                            logging::warn("watch store lock poisoned");
                            None
                        }
                    };
                    match outcome {
                        Some(Ok(Some((signal, list)))) => {
                            let _ = engine.process_signal_traced(&signal, &mut sink);
                            let _ = app.emit("watch-changed", list);
                        }
                        Some(Ok(None)) | None => {}
                        Some(Err(error)) => {
                            logging::warn(&format!("apply watch observation: {error}"))
                        }
                    }
                }
                if let Some(signal) =
                    eqlog_triggers::signal_from_event(&parsed.event, parsed.line.timestamp)
                {
                    let _ = engine.process_signal_traced(&signal, &mut sink);
                }
                if let Some(signal) = rare_kill_signal {
                    let _ = engine.process_signal_traced(&signal, &mut sink);
                }
                sink.flush();
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
                        sink.audio.speak(
                            fire.text
                                .clone()
                                .unwrap_or_else(|| format!("{} ending", fire.name)),
                        );
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
                    icon: fire.icon,
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
                    icon: t.icon,
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
            // Caster resist/fizzle/land% rides the same cadence (P45); it
            // accumulates across the whole session, so no per-fight reset.
            if !casts.is_empty() {
                let _ = app.emit("cast-update", cast_rows_payload(&casts));
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

#[cfg(test)]
mod watch_tests {
    use super::*;
    use eqlog_core::events::Entity;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn watch_store() -> (WatchStore, PathBuf) {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("eqlogs-observe-watch-{unique}"));
        (WatchStore::new(root.clone()), root)
    }

    #[test]
    fn trigger_observation_advances_watch_and_preserves_open_context() {
        let (mut store, root) = watch_store();
        let character = CharacterId::new("Nyasha", "oggok");
        store
            .add_manual(&character, "Large Sky Sapphire", 2, false)
            .unwrap();
        let observation = WatchObservation {
            kind: WatchObservationKind::Loot,
            name: "Large Sky Sapphire".into(),
            quantity: Some("2".into()),
            context: [("source".into(), "alternate-format".into())].into(),
        };

        let (signal, list) = apply_watch_observation(&mut store, &character, 100, observation)
            .unwrap()
            .unwrap();

        assert_eq!(signal.event, TriggerEvent::WatchedLoot);
        assert_eq!(
            signal.fields.get("item").map(String::as_str),
            Some("Large Sky Sapphire")
        );
        assert_eq!(
            signal.fields.get("source").map(String::as_str),
            Some("alternate-format")
        );
        assert_eq!(list.items[0].goals[0].remaining_quantity, 0);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn blank_quantity_defaults_to_one_and_invalid_quantity_is_rejected() {
        assert_eq!(observation_quantity(None).unwrap(), 1);
        assert_eq!(observation_quantity(Some("")).unwrap(), 1);
        assert!(observation_quantity(Some("many")).is_err());
    }

    #[test]
    fn achievement_facts_become_self_or_other_trigger_signals() {
        let own = eqlog_triggers::signal_from_event(
            &Event::Achievement {
                who: Entity::You,
                name: "Hide Your Brains!".into(),
            },
            100,
        )
        .unwrap();
        assert_eq!(own.event, TriggerEvent::AchievementSelf);
        assert_eq!(own.fields.get("player").map(String::as_str), Some("You"));
        assert_eq!(
            own.fields.get("achievement").map(String::as_str),
            Some("Hide Your Brains!")
        );

        let other = eqlog_triggers::signal_from_event(
            &Event::Achievement {
                who: Entity::Named("Daer".into()),
                name: "Befallen Traveler".into(),
            },
            101,
        )
        .unwrap();
        assert_eq!(other.event, TriggerEvent::AchievementOther);
        assert_eq!(other.fields.get("player").map(String::as_str), Some("Daer"));
    }

    #[test]
    fn condition_transitions_are_idempotent_and_unmatched_clears_are_noops() {
        let mut active = BTreeMap::new();
        let started = Instant::now();
        let start = BTreeMap::from([
            ("key".into(), "root".into()),
            ("label".into(), "Rooted".into()),
        ]);
        let config = BTreeMap::from([("priority".into(), serde_json::json!(90))]);

        assert_eq!(
            apply_condition_transition(
                &mut active,
                &start,
                &config,
                Some("spell:99"),
                started,
            ),
            Some(("root".into(), true))
        );
        assert_eq!(
            apply_condition_transition(
                &mut active,
                &start,
                &config,
                Some("spell:99"),
                started + Duration::from_secs(1),
            ),
            None
        );
        assert_eq!(active.len(), 1);

        let clear = BTreeMap::from([
            ("key".into(), "root".into()),
            ("active".into(), "false".into()),
        ]);
        assert_eq!(
            apply_condition_transition(
                &mut active,
                &clear,
                &BTreeMap::new(),
                None,
                started,
            ),
            Some(("root".into(), false))
        );
        assert_eq!(
            apply_condition_transition(
                &mut active,
                &clear,
                &BTreeMap::new(),
                None,
                started,
            ),
            None
        );
        assert!(active.is_empty());
    }

    #[test]
    fn condition_safety_expiry_is_bounded_and_repeated_evidence_refreshes_it() {
        let mut active = BTreeMap::new();
        let started = Instant::now();
        let fields = BTreeMap::from([
            ("key".into(), "slow".into()),
            ("label".into(), "Slowed".into()),
        ]);
        let config = BTreeMap::from([("max_age_secs".into(), serde_json::json!(10))]);

        assert_eq!(
            apply_condition_transition(&mut active, &fields, &config, None, started),
            Some(("slow".into(), true))
        );
        assert_eq!(
            apply_condition_transition(
                &mut active,
                &fields,
                &config,
                None,
                started + Duration::from_secs(8),
            ),
            None
        );
        assert!(expire_condition_transitions(
            &mut active,
            started + Duration::from_secs(11)
        )
        .is_empty());
        assert_eq!(
            expire_condition_transitions(&mut active, started + Duration::from_secs(19)),
            vec!["slow"]
        );
        assert!(active.is_empty());
    }

    #[test]
    fn every_shipped_condition_kind_has_a_finite_safety_age() {
        for key in [
            "blind",
            "charm",
            "disease",
            "encumbered",
            "fear",
            "mez",
            "poison",
            "root",
            "silence",
            "slow",
            "snare",
            "spin",
            "stun",
        ] {
            assert!(default_condition_max_age_secs(key) <= 1_800, "{key}");
        }
    }
}
