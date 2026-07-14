//! Tauri commands: config, trigger pack CRUD, GINA import, sharing v1
//! (LCS1 strings + .gtp export), log discovery, tail session lifecycle, and
//! overlay window management.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use eqlog_triggers::model::Trigger;
use eqlog_triggers::SharePayload;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::audio::{self, AudioHandle};
use crate::config::{self, AppConfig};
use crate::discover::{self, DiscoveredLog};
use crate::library::{self, Library};
use crate::tailing::{self, TailSession};

/// Stable backend metadata for one overlay window. Trigger actions address
/// `id`; Tauri manages `window_label`; the webview selects its renderer from
/// `route`. Keep the catalog synchronized with the static windows in
/// `tauri.conf.json` until window creation becomes catalog-driven.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OverlayDescriptor {
    pub id: &'static str,
    pub window_label: &'static str,
    pub route: &'static str,
}

/// Canonical overlay catalog. Validation, arranging, and startup behavior all
/// iterate this list, so adding a destination has one backend registration.
pub const OVERLAYS: &[OverlayDescriptor] = &[
    OverlayDescriptor {
        id: "alerts",
        window_label: "overlay-alerts",
        route: "index.html?overlay=alerts",
    },
    OverlayDescriptor {
        id: "buffs",
        window_label: "overlay-buffs",
        route: "index.html?overlay=buffs",
    },
    OverlayDescriptor {
        id: "onothers",
        window_label: "overlay-onothers",
        route: "index.html?overlay=onothers",
    },
    OverlayDescriptor {
        id: "target",
        window_label: "overlay-target",
        route: "index.html?overlay=target",
    },
    OverlayDescriptor {
        id: "meter",
        window_label: "overlay-meter",
        route: "index.html?overlay=meter",
    },
    OverlayDescriptor {
        id: "xp",
        window_label: "overlay-xp",
        route: "index.html?overlay=xp",
    },
    OverlayDescriptor {
        id: "pace",
        window_label: "overlay-pace",
        route: "index.html?overlay=pace",
    },
    OverlayDescriptor {
        id: "stance",
        window_label: "overlay-stance",
        route: "index.html?overlay=stance",
    },
    OverlayDescriptor {
        id: "respawn",
        window_label: "overlay-respawn",
        route: "index.html?overlay=respawn",
    },
    OverlayDescriptor {
        id: "impact",
        window_label: "overlay-impact",
        route: "index.html?overlay=impact",
    },
    OverlayDescriptor {
        id: "scoreboard",
        window_label: "overlay-scoreboard",
        route: "index.html?overlay=scoreboard",
    },
];

pub fn overlay_by_window_label(label: &str) -> Option<&'static OverlayDescriptor> {
    OVERLAYS
        .iter()
        .find(|overlay| overlay.window_label == label)
}

/// True while the user is arranging overlays (Settings/Dashboard "Arrange").
/// While set, overlays are FORCED interactive (never click-through) so a drag
/// that shifts window focus can't re-lock the others — the root cause of the
/// "drag one overlay, then the rest freeze" bug. The window-event handler in
/// `lib.rs` also re-asserts interactivity on move/blur while this is set.
pub static OVERLAYS_ARRANGING: AtomicBool = AtomicBool::new(false);

pub fn overlays_arranging() -> bool {
    OVERLAYS_ARRANGING.load(Ordering::Relaxed)
}

pub struct AppState {
    pub config: Mutex<AppConfig>,
    pub session: Mutex<Option<TailSession>>,
    /// App-lifetime audio thread handle (TTS + sound playback + silence);
    /// tail sessions and sound previews all clone it. Mutex only because
    /// managed state must be Sync and the handle's mpsc Sender is not.
    pub audio: Mutex<AudioHandle>,
    /// Fight history database, opened during setup (state is managed before
    /// setup so commands can never race a missing entry). `None` inside =
    /// store unavailable; tailing and alerts still work.
    pub store: crate::store::SharedStore,
    /// Serializes every user-pack read-modify-write (save / append / GINA +
    /// share import) so concurrent mutations can't clobber each other (P15).
    pub pack_lock: Mutex<()>,
}

impl AppState {
    pub fn new(config: AppConfig) -> Self {
        AppState {
            config: Mutex::new(config),
            session: Mutex::new(None),
            audio: Mutex::new(audio::spawn()),
            store: Arc::new(Mutex::new(None)),
            pack_lock: Mutex::new(()),
        }
    }
}

fn apply_audio_dictionary(audio: &AudioHandle, config: &AppConfig) {
    audio.set_dictionary(
        config
            .tts_dictionary
            .iter()
            .map(|p| (p.from.clone(), p.to.clone()))
            .collect(),
    );
    audio.set_voice(config.tts_voice.clone());
    audio.set_muted(config.tts_muted);
}

/// Installed Windows TTS voice display names, for the Settings picker.
/// A separate throwaway synthesizer keeps this off the audio thread.
#[tauri::command]
pub fn list_tts_voices() -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        let t = tts::Tts::default().map_err(|e| format!("TTS unavailable: {e}"))?;
        let voices = t.voices().map_err(|e| format!("voices: {e}"))?;
        Ok(voices.iter().map(|v| v.name()).collect())
    }
    #[cfg(not(windows))]
    Ok(Vec::new())
}

/// Lock a state mutex, recovering from poisoning instead of failing forever
/// (P30). A single panic while some other command held the lock used to poison
/// it permanently, so every later call returned "state poisoned" and that whole
/// subsystem (config, session, audio) was bricked until the user restarted the
/// app. The guarded data may be mildly inconsistent after such a panic, but for
/// these small state cells recovering and carrying on beats a dead subsystem —
/// we log the recovery once so it isn't invisible.
pub(crate) fn lock<'a, T>(
    m: &'a Mutex<T>,
    what: &str,
) -> Result<std::sync::MutexGuard<'a, T>, String> {
    Ok(m.lock().unwrap_or_else(|poisoned| {
        crate::logging::warn(&format!(
            "{what} mutex was poisoned by an earlier panic; recovering"
        ));
        poisoned.into_inner()
    }))
}

/// Snapshot of running trigger timers (recasts, buffs, DoTs, CC) so a window
/// reopened mid-session — or the whole app after a restart — rehydrates live
/// countdowns instead of losing them (P3). Empty when nothing is tailing.
#[tauri::command]
pub fn get_active_timers(
    state: State<'_, AppState>,
) -> Result<Vec<crate::tailing::ActiveTimerPayload>, String> {
    let session = lock(&state.session, "session")?;
    Ok(session
        .as_ref()
        .map(|s| s.active_timers())
        .unwrap_or_default())
}

// ---------- config ----------

#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> Result<AppConfig, String> {
    Ok(lock(&state.config, "config")?.clone())
}

#[tauri::command]
pub fn set_config(
    app: AppHandle,
    state: State<'_, AppState>,
    mut config: AppConfig,
) -> Result<(), String> {
    // Keep the active-character pointer in sync with the configured log (its
    // filename carries server+character). The frontend AppConfig omits the
    // pointer, so fall back to the existing one when the log doesn't parse.
    config.active_character = eqlog_triggers::storage::CharacterId::from_log_path(&config.log_path)
        .map(|id| config::ActiveCharacter {
            server: id.server,
            character: id.character,
        })
        .or_else(|| {
            lock(&state.config, "config")
                .ok()
                .and_then(|c| c.active_character.clone())
        });
    config::save(&app, &config)?;
    // Persist this character's allowlisted overrides (log path, pets) into its
    // profile so a Settings edit survives a restart (startup hydrate reads
    // them back from the profile, not from settings.json).
    crate::library::persist_active_overrides(&app, &config);
    if let Ok(audio) = state.audio.lock() {
        apply_audio_dictionary(&audio, &config);
    }
    *lock(&state.config, "config")? = config;
    Ok(())
}

// ---------- log stats ----------

/// File stats for the configured log, backing the Settings "large log" nudge.
/// `size_bytes` is `None` when the path is unset or unreadable — the UI treats
/// missing as "unknown" and shows nothing rather than a scary 0.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LogStats {
    pub size_bytes: Option<u64>,
}

#[tauri::command]
pub fn log_stats(state: State<'_, AppState>) -> Result<LogStats, String> {
    let cfg = lock(&state.config, "config")?.clone();
    let path = cfg.log_path.trim();
    let size_bytes = if path.is_empty() {
        None
    } else {
        std::fs::metadata(path).ok().map(|m| m.len())
    };
    Ok(LogStats { size_bytes })
}

// ---------- triggers ----------

fn pack_path(app: &AppHandle, state: &State<'_, AppState>) -> Result<std::path::PathBuf, String> {
    let cfg = lock(&state.config, "config")?.clone();
    config::trigger_pack_file(app, &cfg)
}

#[tauri::command]
pub fn get_triggers(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<Trigger>, String> {
    config::load_triggers(&pack_path(&app, &state)?)
}

#[tauri::command]
pub fn save_triggers(
    app: AppHandle,
    state: State<'_, AppState>,
    triggers: Vec<Trigger>,
) -> Result<(), String> {
    {
        let _guard = lock(&state.pack_lock, "trigger pack")?;
        config::save_triggers(&pack_path(&app, &state)?, &triggers)?;
    }
    // Edits apply immediately — no "restart tailing" step (ux-findings #4).
    crate::library::rebuild_if_tailing(&app, &state)
}

/// Append custom triggers to the user pack atomically (P15): the load → extend
/// → save happens server-side under `pack_lock`, so a quick-save can't lose a
/// concurrent GINA/share import (or another save) the way a client-side
/// get-then-save read-modify-write could.
#[tauri::command]
pub fn append_triggers(
    app: AppHandle,
    state: State<'_, AppState>,
    triggers: Vec<Trigger>,
) -> Result<(), String> {
    let pack = pack_path(&app, &state)?;
    {
        let _guard = lock(&state.pack_lock, "trigger pack")?;
        let mut existing = config::load_triggers(&pack)?;
        existing.extend(triggers);
        config::save_triggers(&pack, &existing)?;
    }
    crate::library::rebuild_if_tailing(&app, &state)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GinaImportResult {
    pub imported: usize,
    pub warnings: Vec<String>,
}

/// Import a GINA .gtp package and append its triggers to the pack file.
#[tauri::command]
pub fn import_gina(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<GinaImportResult, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("read {path}: {e}"))?;
    let import = eqlog_triggers::gina::import_gtp(&bytes).map_err(|e| e.to_string())?;
    let imported = import.triggers.len();
    let pack = pack_path(&app, &state)?;
    {
        let _guard = lock(&state.pack_lock, "trigger pack")?;
        let mut existing = config::load_triggers(&pack)?;
        existing.extend(import.triggers);
        config::save_triggers(&pack, &existing)?;
    }
    crate::library::rebuild_if_tailing(&app, &state)?;
    Ok(GinaImportResult {
        imported,
        warnings: import.warnings,
    })
}

// ---------- log discovery ----------

/// Scan the default Legends Logs dir (and the configured log's own folder)
/// for `eqlog_*.txt` files, newest first — the first-run welcome card's
/// one-click choices.
#[tauri::command]
pub fn discover_logs(state: State<'_, AppState>) -> Result<Vec<DiscoveredLog>, String> {
    let cfg = lock(&state.config, "config")?.clone();
    let mut dirs = vec![PathBuf::from(config::DEFAULT_LOGS_DIR)];
    let configured = cfg.log_path.trim();
    if !configured.is_empty() {
        if let Some(parent) = Path::new(configured).parent() {
            if !parent.as_os_str().is_empty() {
                dirs.push(parent.to_path_buf());
            }
        }
    }
    Ok(discover::scan(&dirs))
}

// ---------- sharing v1 ----------

/// Every trigger in the library (bundled packs + user pack) whose
/// `effective_id` is in `ids`, deduped, in library order.
fn collect_by_ids(lib: &Library, ids: &[String]) -> Vec<Trigger> {
    let wanted: HashSet<&str> = ids.iter().map(String::as_str).collect();
    let mut taken: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for t in lib.packs.iter().chain(lib.user.iter()) {
        let id = t.effective_id();
        if wanted.contains(id.as_str()) && taken.insert(id) {
            out.push(t.clone());
        }
    }
    out
}

/// Serialize the selected triggers to a paste-anywhere `LCS1:` share string.
/// `name` labels the bundle in the importer's summary dialog.
#[tauri::command]
pub fn share_export(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
    name: Option<String>,
) -> Result<String, String> {
    let cfg = lock(&state.config, "config")?.clone();
    let lib = library::load_library(&app, &cfg)?;
    let triggers = collect_by_ids(&lib, &ids);
    if triggers.is_empty() {
        return Err("no matching triggers to share".into());
    }
    Ok(eqlog_triggers::export_string(&SharePayload {
        name,
        triggers,
        ..Default::default()
    }))
}

/// Write the same lossless `LCS1:` payload as `share_export` to a `.lct`
/// package chosen by the user. Returns the number of exported triggers.
#[tauri::command]
pub fn share_export_file(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
    name: Option<String>,
    path: String,
) -> Result<usize, String> {
    let cfg = lock(&state.config, "config")?.clone();
    let lib = library::load_library(&app, &cfg)?;
    let triggers = collect_by_ids(&lib, &ids);
    if triggers.is_empty() {
        return Err("no matching triggers to export".into());
    }
    let count = triggers.len();
    let text = eqlog_triggers::export_string(&SharePayload {
        name,
        triggers,
        ..Default::default()
    });
    std::fs::write(&path, text).map_err(|e| format!("write {path}: {e}"))?;
    Ok(count)
}

/// Read a lossless `.lct` package for the existing share preview/import flow.
/// Already-installed effective ids are removed before re-encoding, preventing
/// a full-library package from creating renamed copies of every bundled item.
#[tauri::command]
pub fn share_read_file(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    const MAX_PACKAGE_BYTES: u64 = 32 * 1024 * 1024;

    let metadata = std::fs::metadata(&path).map_err(|e| format!("read {path}: {e}"))?;
    if metadata.len() > MAX_PACKAGE_BYTES {
        return Err("trigger package exceeds the 32 MiB safety limit".into());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("read {path}: {e}"))?;
    let empty = HashSet::new();
    let import = eqlog_triggers::parse_string(&text, &empty).map_err(|e| e.to_string())?;

    let cfg = lock(&state.config, "config")?.clone();
    let lib = library::load_library(&app, &cfg)?;
    let existing: HashSet<String> = lib
        .packs
        .iter()
        .chain(lib.user.iter())
        .map(|trigger| trigger.effective_id())
        .collect();
    let triggers: Vec<Trigger> = import
        .triggers
        .into_iter()
        .filter(|trigger| !existing.contains(&trigger.effective_id()))
        .collect();
    if triggers.is_empty() {
        return Err("all triggers in this package are already installed".into());
    }
    Ok(eqlog_triggers::export_string(&SharePayload {
        name: import.name,
        version: import.version,
        author: import.author,
        notes: import.notes,
        triggers,
    }))
}

/// What `share_import` did, for the summary dialog.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShareImportSummary {
    pub imported: usize,
    /// How many of `imported` replaced an existing Shared-source trigger in
    /// place (update-in-place mode only; 0 in copy mode).
    pub updated: usize,
    /// Bundle label the exporter set, if any.
    pub name: Option<String>,
    /// `[collidingId, assignedId]` pairs renamed by the dedupe.
    pub renamed: Vec<(String, String)>,
    /// Distinct categories among the imported triggers, first-seen order.
    pub categories: Vec<String>,
}

/// Distinct categories among `triggers`, first-seen order.
fn distinct_categories(triggers: &[Trigger]) -> Vec<String> {
    let mut categories: Vec<String> = Vec::new();
    for t in triggers {
        let c = t
            .category
            .clone()
            .unwrap_or_else(|| "Uncategorized".to_string());
        if !categories.contains(&c) {
            categories.push(c);
        }
    }
    categories
}

/// Import an `LCS1:` share string into the user pack.
///
/// Default (`update_in_place` absent/false): ids colliding with the local
/// library (or within the paste) get `-2`/`-3` suffixes — nothing existing is
/// touched. With `update_in_place: true`, incoming ids matching an existing
/// Shared-source user-pack trigger REPLACE it in place (same stable id, so
/// per-id user overrides keep applying); everything else appends with the
/// classic collision rename. Every imported trigger is stamped source
/// "shared". A live session hot-reloads.
#[tauri::command]
pub fn share_import(
    app: AppHandle,
    state: State<'_, AppState>,
    text: String,
    update_in_place: Option<bool>,
) -> Result<ShareImportSummary, String> {
    let cfg = lock(&state.config, "config")?.clone();
    let lib = library::load_library(&app, &cfg)?;

    let (summary, user) = if update_in_place.unwrap_or(false) {
        let payload = eqlog_triggers::decode_string(&text).map_err(|e| e.to_string())?;
        if payload.triggers.is_empty() {
            return Err("share string contains no triggers".into());
        }
        let categories = distinct_categories(&payload.triggers);
        let external_ids: HashSet<String> =
            lib.packs.iter().map(|t| t.effective_id()).collect();
        let mut user = lib.user;
        let outcome =
            eqlog_triggers::merge_update_user_pack(payload.triggers, &mut user, &external_ids);
        (
            ShareImportSummary {
                imported: outcome.updated.len() + outcome.added.len(),
                updated: outcome.updated.len(),
                name: payload.name,
                renamed: outcome.renamed,
                categories,
            },
            user,
        )
    } else {
        let existing: HashSet<String> = lib
            .packs
            .iter()
            .chain(lib.user.iter())
            .map(|t| t.effective_id())
            .collect();
        let import = eqlog_triggers::parse_string(&text, &existing).map_err(|e| e.to_string())?;
        if import.triggers.is_empty() {
            return Err("share string contains no triggers".into());
        }
        let categories = distinct_categories(&import.triggers);
        let summary = ShareImportSummary {
            imported: import.triggers.len(),
            updated: 0,
            name: import.name,
            renamed: import.renamed,
            categories,
        };
        let mut user = lib.user;
        user.extend(import.triggers);
        (summary, user)
    };

    let pack = pack_path(&app, &state)?;
    {
        let _guard = lock(&state.pack_lock, "trigger pack")?;
        config::save_triggers(&pack, &user)?;
    }
    crate::library::rebuild_if_tailing(&app, &state)?;
    crate::logging::info(&format!(
        "imported {} shared trigger(s) ({} updated in place){}",
        summary.imported,
        summary.updated,
        summary
            .name
            .as_deref()
            .map(|n| format!(" from \"{n}\""))
            .unwrap_or_default()
    ));
    Ok(summary)
}

/// Export the selected triggers as a GINA-compatible `.gtp` package at
/// `path` (the frontend picks it with the dialog plugin's save dialog).
/// Returns how many triggers were written.
#[tauri::command]
pub fn share_export_gtp(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
    package_name: String,
    path: String,
) -> Result<usize, String> {
    let cfg = lock(&state.config, "config")?.clone();
    let lib = library::load_library(&app, &cfg)?;
    let triggers = collect_by_ids(&lib, &ids);
    if triggers.is_empty() {
        return Err("no matching triggers to export".into());
    }
    let bytes = eqlog_triggers::export_gtp(&package_name, &triggers).map_err(|e| e.to_string())?;
    std::fs::write(&path, &bytes).map_err(|e| format!("write {path}: {e}"))?;
    Ok(triggers.len())
}

// ---------- tail session ----------

/// Start the tail session. Shared by the command and launch auto-resume.
pub fn start_tailing_inner(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let mut session = lock(&state.session, "session")?;
    if session.is_some() {
        return Err("already tailing".into());
    }
    let cfg = lock(&state.config, "config")?.clone();
    if cfg.log_path.trim().is_empty() {
        return Err("set a log file path in Settings first".into());
    }
    // Bundled packs + the user pack, resolved through the character profile.
    let build = crate::library::build_engine(app, &cfg)?;
    crate::library::announce_pack_warnings(app, &build.warnings);
    let audio = lock(&state.audio, "audio")?.clone();
    *session = Some(tailing::start(
        app.clone(),
        cfg,
        build,
        audio,
        state.store.clone(),
    )?);
    // The frontend may have sampled is_tailing before boot auto-resume ran —
    // push the truth so the topbar never shows Idle while actually tailing.
    let _ = app.emit("tailing-changed", serde_json::json!({ "tailing": true }));
    Ok(())
}

/// Persist the user's tailing intent so the next launch resumes it.
fn remember_tailing(app: &AppHandle, state: &AppState, tailing: bool) {
    if let Ok(mut cfg) = state.config.lock() {
        if cfg.resume_tailing != tailing {
            cfg.resume_tailing = tailing;
            let _ = config::save(app, &cfg);
        }
    }
}

#[tauri::command]
pub fn start_tailing(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    start_tailing_inner(&app, &state)?;
    remember_tailing(&app, &state, true);
    Ok(())
}

#[tauri::command]
pub fn stop_tailing(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let taken = lock(&state.session, "session")?.take();
    match taken {
        Some(session) => {
            session.stop();
            // Auto-silence: stopping the session must also flush whatever
            // the session already queued (post-sprint item 14) — otherwise
            // TTS keeps narrating a session the user just killed.
            if let Ok(audio) = state.audio.lock() {
                let _ = audio.silence();
            }
            remember_tailing(&app, &state, false);
            let _ = app.emit("tailing-changed", serde_json::json!({ "tailing": false }));
            Ok(())
        }
        None => Err("not tailing".into()),
    }
}

/// Kill switch for queued audio (post-sprint item 14): bumps the audio
/// generation so queued Speak/Play entries are dropped, and cuts the current
/// TTS utterance. Wired to the topbar speaker button and Esc-Esc.
#[tauri::command]
pub fn silence_audio(state: State<'_, AppState>) -> Result<(), String> {
    lock(&state.audio, "audio")?.silence()
}

/// Speak arbitrary frontend-supplied text through the app audio thread —
/// the same queue trigger Speak actions use, so it shares the TTS voice,
/// the pronunciation dictionary, and the silence kill-switch. Bypasses the
/// master mute: this is an explicit user action (voice/trigger preview).
#[tauri::command]
pub fn speak_text(state: State<'_, AppState>, text: String) -> Result<(), String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Ok(());
    }
    lock(&state.audio, "audio")?.speak_unchecked(text);
    Ok(())
}

#[tauri::command]
pub fn is_tailing(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(lock(&state.session, "session")?.is_some())
}

// ---------- overlays ----------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OverlayLockPayload {
    label: String,
    click_through: bool,
}

fn overlay_window(app: &AppHandle, label: &str) -> Result<WebviewWindow, String> {
    let overlay =
        overlay_by_window_label(label).ok_or_else(|| format!("unknown overlay window: {label}"))?;
    app.get_webview_window(overlay.window_label)
        .ok_or_else(|| format!("overlay window {} not found", overlay.window_label))
}

#[tauri::command]
pub fn overlay_show(app: AppHandle, label: String) -> Result<(), String> {
    overlay_window(&app, &label)?
        .show()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn overlay_hide(app: AppHandle, label: String) -> Result<(), String> {
    overlay_window(&app, &label)?
        .hide()
        .map_err(|e| e.to_string())
}

/// Toggle click-through. `ignore = true` (locked) makes the overlay ignore
/// the mouse; `ignore = false` (unlocked) lets the user drag it into place.
#[tauri::command]
pub fn overlay_set_click_through(
    app: AppHandle,
    label: String,
    ignore: bool,
) -> Result<(), String> {
    let win = match overlay_window(&app, &label) {
        Ok(w) => w,
        Err(e) => {
            crate::logging::warn(&format!(
                "overlay_set_click_through({label}, {ignore}): {e}"
            ));
            return Err(e);
        }
    };
    // While arranging, NEVER let an overlay go click-through — a stray lock
    // from a focus/blur re-render must not freeze dragging mid-arrange.
    let ignore = if overlays_arranging() { false } else { ignore };
    win.set_ignore_cursor_events(ignore)
        .map_err(|e| e.to_string())?;
    crate::logging::info(&format!(
        "overlay_set_click_through({label}, ignore={ignore}) ok; emitting overlay-lock-changed"
    ));
    let _ = app.emit(
        "overlay-lock-changed",
        OverlayLockPayload {
            label,
            click_through: ignore,
        },
    );
    Ok(())
}

/// Enter/leave overlay arrange mode. Single source of truth for the whole
/// arrange lifecycle so Settings and the Dashboard sidebar can't fight each
/// other. Entering reveals + unlocks EVERY overlay and latches the
/// `OVERLAYS_ARRANGING` guard so nothing can re-lock them until the user
/// leaves. Leaving clears the guard; the caller then applies its normal
/// lock/hide pass.
#[tauri::command]
pub fn overlay_set_arranging(app: AppHandle, arranging: bool) -> Result<(), String> {
    OVERLAYS_ARRANGING.store(arranging, Ordering::Relaxed);
    crate::logging::info(&format!("overlay_set_arranging({arranging})"));
    if arranging {
        for overlay in OVERLAYS {
            let label = overlay.window_label;
            if let Some(w) = app.get_webview_window(label) {
                let _ = w.show();
                let _ = w.set_ignore_cursor_events(false);
                let _ = app.emit(
                    "overlay-lock-changed",
                    OverlayLockPayload {
                        label: label.to_string(),
                        click_through: false,
                    },
                );
            }
        }
    }
    Ok(())
}
