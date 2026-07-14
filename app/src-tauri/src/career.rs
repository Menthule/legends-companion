//! Career history: the app-side wiring around `eqlog-store`'s `CareerStore`
//! (docs/career-db-design.md §7).
//!
//! The store (and the single import/fold writer) lives in `eqlog-store` and
//! is shared verbatim with the CLI — this module only resolves the DB path,
//! scopes queries to the active character, forwards import progress as
//! `career-import-progress` events, and enforces "one importer at a time".
//! Query row shapes come straight from `eqlog_store::career` (they already
//! serialize camelCase per the wire contract).

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use eqlog_store::career::{
    CareerLevelUp, CareerLootRow, CareerMobDrop, CareerMobKills, CareerSession, CareerStore,
    CareerSummary, ImportOptions, ImportReport, DEFAULT_GAP_SECS,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::commands::{lock, AppState};
use crate::config::AppConfig;
use crate::logging;

/// Same sharing pattern as [`crate::store::SharedStore`]: `CareerStore` is
/// `Send` but not `Sync`; commands and the import thread share one connection
/// behind a mutex. `None` = the database failed to open (career features
/// disabled, everything else keeps working).
pub type SharedCareer = Arc<Mutex<Option<CareerStore>>>;

const NO_CAREER: &str = "career history is unavailable (database failed to open — see app.log)";

/// Progress events are throttled to at least this far apart (§7).
const PROGRESS_MIN_INTERVAL: Duration = Duration::from_millis(100);

/// Open the career tables in `fights.db` under the resolved data root (the
/// ONE store DB — `FightStore` and `CareerStore` share the file and run the
/// same schema migration). Failures are logged and yield `None`.
pub fn open(app: &AppHandle) -> Option<CareerStore> {
    let path = crate::data_root::resolve(app).fights_db();
    match CareerStore::open(&path) {
        Ok(store) => {
            logging::info(&format!("career history opened: {}", path.display()));
            Some(store)
        }
        Err(e) => {
            logging::warn(&format!(
                "career history disabled — cannot open {}: {e}",
                path.display()
            ));
            None
        }
    }
}

/// Lazy reopen, mirroring `store::ensure_store` — setup normally opened the
/// store already; this retries after an early failure.
fn ensure_career(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let mut guard = lock(&state.career, "career store")?;
    if guard.is_some() {
        return Ok(());
    }
    match open(app) {
        Some(store) => {
            *guard = Some(store);
            Ok(())
        }
        None => Err(NO_CAREER.to_string()),
    }
}

/// The (character, server) every career query is scoped to — the active
/// character from AppConfig (same trust boundary as `get_profile`; the
/// frontend never passes names).
fn active_identity(cfg: &AppConfig) -> Result<(String, String), String> {
    if let Some(ac) = &cfg.active_character {
        if !ac.character.trim().is_empty() {
            return Ok((ac.character.clone(), ac.server.clone()));
        }
    }
    if let Some(id) = eqlog_triggers::storage::CharacterId::from_log_path(&cfg.log_path) {
        return Ok((id.character, id.server));
    }
    let name = cfg.character_name.trim();
    if !name.is_empty() {
        return Ok((name.to_string(), String::new()));
    }
    Err("no active character configured (set a log file in Settings first)".to_string())
}

/// Session-split gap for the importer: `careerGapMins` from settings.json,
/// `0`/absent = the store default (30 min). No Settings UI yet — the field
/// exists so the split is user-configurable without a rebuild.
fn gap_secs(cfg: &AppConfig) -> i64 {
    if cfg.career_gap_mins == 0 {
        DEFAULT_GAP_SECS
    } else {
        i64::from(cfg.career_gap_mins) * 60
    }
}

/// Per-file import options. The canonical `eqlog_<Character>_<server>.txt`
/// filename is the authority (archives of other characters import under
/// their own names); a non-canonical filename falls back to the active
/// character so a renamed log still imports.
fn import_options(cfg: &AppConfig, path: &str) -> ImportOptions {
    let (character, server) =
        if eqlog_triggers::storage::CharacterId::from_log_path(path).is_some() {
            (None, None) // the importer parses the filename itself
        } else {
            match active_identity(cfg) {
                Ok((c, s)) => (Some(c), Some(s)),
                // Let the importer report "cannot determine character".
                Err(_) => (None, None),
            }
        };
    ImportOptions {
        character,
        server,
        gap_secs: gap_secs(cfg),
        dry_run: false,
    }
}

/// Wire shape of the `career-import-progress` event (`CareerImportProgress`
/// in types.ts): the store's byte counters reduced to a percent, plus the
/// per-file done/error markers the UI keys its progress bars on.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ImportProgressPayload {
    /// Exactly the path string passed to `career_import` — the frontend
    /// keys progress bars by `p.file === DiscoveredLog.path`.
    file: String,
    /// 0..100 (bytes_read / bytes_total).
    percent: f64,
    lines_read: u64,
    sessions_found: u64,
    /// True exactly once per file.
    done: bool,
    /// Non-null => this file failed; the run continues with the next file.
    error: Option<String>,
}

/// Clears the "import running" flag on every exit path.
struct RunningGuard<'a>(&'a AtomicBool);

impl Drop for RunningGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// The one import driver (blocking; callers move it off the main thread).
/// Empty `paths` = the configured log file. One importer at a time — a
/// concurrent call returns an error instead of queueing. Per-file failures
/// become error progress events plus a skipped report; the run continues.
fn run_import(
    app: &AppHandle,
    career: &SharedCareer,
    running: &AtomicBool,
    cfg: &AppConfig,
    paths: Vec<String>,
    emit_progress: bool,
) -> Result<Vec<ImportReport>, String> {
    if running.swap(true, Ordering::SeqCst) {
        return Err("a career import is already running".to_string());
    }
    let _guard = RunningGuard(running);

    let paths = if paths.is_empty() {
        let configured = cfg.log_path.trim();
        if configured.is_empty() {
            return Err("set a log file path in Settings first".to_string());
        }
        vec![configured.to_string()]
    } else {
        paths
    };

    // Holding the store lock for the whole run keeps queries out of the
    // import transaction's way; the UI reads refresh on the done events.
    let mut store_guard = lock(career, "career store")?;
    let store = store_guard.as_mut().ok_or(NO_CAREER)?;

    let mut reports: Vec<ImportReport> = Vec::with_capacity(paths.len());
    for path in &paths {
        let opts = import_options(cfg, path);
        let mut last_emit: Option<Instant> = None;
        let mut on_progress = |p: &eqlog_store::career::ImportProgress| {
            if !emit_progress {
                return;
            }
            let due = last_emit.map_or(true, |t| t.elapsed() >= PROGRESS_MIN_INTERVAL);
            if !due {
                return;
            }
            last_emit = Some(Instant::now());
            let percent = if p.bytes_total == 0 {
                100.0
            } else {
                (p.bytes_read as f64 / p.bytes_total as f64) * 100.0
            };
            let _ = app.emit(
                "career-import-progress",
                ImportProgressPayload {
                    file: path.clone(),
                    percent: percent.clamp(0.0, 100.0),
                    lines_read: p.lines_read,
                    sessions_found: p.sessions_found,
                    done: false,
                    error: None,
                },
            );
        };
        match store.import_file(Path::new(path), &opts, &mut on_progress) {
            Ok(report) => {
                if emit_progress {
                    let _ = app.emit(
                        "career-import-progress",
                        ImportProgressPayload {
                            file: path.clone(),
                            percent: 100.0,
                            lines_read: report.lines_read,
                            sessions_found: report.sessions_added + report.sessions_updated,
                            done: true,
                            error: None,
                        },
                    );
                }
                reports.push(report);
            }
            Err(e) => {
                let msg = e.to_string();
                logging::warn(&format!("career import failed for {path}: {msg}"));
                if emit_progress {
                    let _ = app.emit(
                        "career-import-progress",
                        ImportProgressPayload {
                            file: path.clone(),
                            percent: 100.0,
                            lines_read: 0,
                            sessions_found: 0,
                            done: true,
                            error: Some(msg.clone()),
                        },
                    );
                }
                // One report per file, even on failure (§6): a skipped
                // report whose skipReason carries the error.
                reports.push(ImportReport {
                    file: path.clone(),
                    character: String::new(),
                    server: String::new(),
                    lines_read: 0,
                    lines_skipped: 0,
                    sessions_added: 0,
                    sessions_updated: 0,
                    level_ups_added: 0,
                    loot_added: 0,
                    kills_added: 0,
                    skipped: true,
                    skip_reason: Some(msg),
                });
            }
        }
    }
    Ok(reports)
}

/// Import-at-tail-start (design §7): fold whatever bytes the configured log
/// gained since the last import, on a fire-and-forget thread with progress
/// events suppressed (the UI didn't ask). Watermark-resumed, so this is
/// normally a few milliseconds of I/O. Never blocks or fails tail start.
pub fn import_configured_on_start(app: &AppHandle, state: &AppState) {
    let cfg = match lock(&state.config, "config") {
        Ok(c) => c.clone(),
        Err(_) => return,
    };
    if cfg.log_path.trim().is_empty() {
        return;
    }
    let app = app.clone();
    let career = state.career.clone();
    let running = state.career_importing.clone();
    std::thread::spawn(move || {
        // Lazy open on the worker so tail start never waits on SQLite.
        if let Ok(mut guard) = lock(&career, "career store") {
            if guard.is_none() {
                *guard = open(&app);
            }
        }
        match run_import(&app, &career, &running, &cfg, Vec::new(), false) {
            Ok(reports) => {
                for r in reports.iter().filter(|r| !r.skipped) {
                    logging::info(&format!(
                        "career import at tail start: {} (+{} sessions, ~{} reopened, \
                         +{} loot, +{} kills)",
                        r.file, r.sessions_added, r.sessions_updated, r.loot_added, r.kills_added
                    ));
                }
            }
            Err(e) => logging::warn(&format!("career import at tail start skipped: {e}")),
        }
    });
}

// ---------- payload shapes ----------

/// `{ total, rows }` page wrapper (career_sessions / career_loot /
/// career_mob_kills wire shape).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CareerPage<T: Serialize> {
    pub total: u64,
    pub rows: Vec<T>,
}

// ---------- commands ----------

/// Import log history into the career DB. Empty `paths` = the configured
/// log. Blocking work runs on `spawn_blocking`; progress goes out as
/// `career-import-progress` events; resolves with one report per file.
#[tauri::command]
pub async fn career_import(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<Vec<ImportReport>, String> {
    ensure_career(&app, state.inner())?;
    let cfg = lock(&state.config, "config")?.clone();
    let career = state.career.clone();
    let running = state.career_importing.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_import(&app, &career, &running, &cfg, paths, true)
    })
    .await
    .map_err(|e| format!("career import task failed: {e}"))?
}

// The query/reset commands below are `#[tauri::command(async)]`: a running
// import holds the store mutex for its whole run, and a plain sync command
// would wait for it ON THE MAIN THREAD, freezing the webview. `(async)`
// moves the wait to a worker thread; the UI stays live and the query
// resolves when the import commits.

/// Lifetime career summary for the active character; `None` = no career
/// data imported yet.
#[tauri::command(async)]
pub fn career_summary(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<CareerSummary>, String> {
    ensure_career(&app, state.inner())?;
    let (character, server) = active_identity(&lock(&state.config, "config")?)?;
    let guard = lock(&state.career, "career store")?;
    let store = guard.as_ref().ok_or(NO_CAREER)?;
    store.summary(&character, &server).map_err(|e| e.to_string())
}

/// Paged career sessions, newest first.
#[tauri::command(async)]
pub fn career_sessions(
    app: AppHandle,
    state: State<'_, AppState>,
    limit: u32,
    offset: u32,
) -> Result<CareerPage<CareerSession>, String> {
    ensure_career(&app, state.inner())?;
    let (character, server) = active_identity(&lock(&state.config, "config")?)?;
    let guard = lock(&state.career, "career store")?;
    let store = guard.as_ref().ok_or(NO_CAREER)?;
    let (total, rows) = store
        .sessions(&character, &server, limit.clamp(1, 500), offset)
        .map_err(|e| e.to_string())?;
    Ok(CareerPage { total, rows })
}

/// Every level-up, ascending ts (the level timeline chart).
#[tauri::command(async)]
pub fn career_level_timeline(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<CareerLevelUp>, String> {
    ensure_career(&app, state.inner())?;
    let (character, server) = active_identity(&lock(&state.config, "config")?)?;
    let guard = lock(&state.career, "career store")?;
    let store = guard.as_ref().ok_or(NO_CAREER)?;
    store
        .level_timeline(&character, &server)
        .map_err(|e| e.to_string())
}

/// Paged loot ledger; `search` filters the item substring, "" = all.
#[tauri::command(async)]
pub fn career_loot(
    app: AppHandle,
    state: State<'_, AppState>,
    search: String,
    limit: u32,
    offset: u32,
) -> Result<CareerPage<CareerLootRow>, String> {
    ensure_career(&app, state.inner())?;
    let (character, server) = active_identity(&lock(&state.config, "config")?)?;
    let guard = lock(&state.career, "career store")?;
    let store = guard.as_ref().ok_or(NO_CAREER)?;
    let (total, rows) = store
        .loot(&character, &server, search.trim(), limit.clamp(1, 500), offset)
        .map_err(|e| e.to_string())?;
    Ok(CareerPage { total, rows })
}

/// Paged per-mob kill counts + observed drop counts; `search` "" = all.
#[tauri::command(async)]
pub fn career_mob_kills(
    app: AppHandle,
    state: State<'_, AppState>,
    search: String,
    limit: u32,
    offset: u32,
) -> Result<CareerPage<CareerMobKills>, String> {
    ensure_career(&app, state.inner())?;
    let (character, server) = active_identity(&lock(&state.config, "config")?)?;
    let guard = lock(&state.career, "career store")?;
    let store = guard.as_ref().ok_or(NO_CAREER)?;
    let (total, rows) = store
        .mob_kills(&character, &server, search.trim(), limit.clamp(1, 500), offset)
        .map_err(|e| e.to_string())?;
    Ok(CareerPage { total, rows })
}

/// Observed drops off one mob, most-seen first (counts, never rates).
#[tauri::command(async)]
pub fn career_mob_drops(
    app: AppHandle,
    state: State<'_, AppState>,
    mob: String,
) -> Result<Vec<CareerMobDrop>, String> {
    ensure_career(&app, state.inner())?;
    let (character, server) = active_identity(&lock(&state.config, "config")?)?;
    let guard = lock(&state.career, "career store")?;
    let store = guard.as_ref().ok_or(NO_CAREER)?;
    store
        .mob_drops(&character, &server, &mob)
        .map_err(|e| e.to_string())
}

/// Delete all career rows + import watermarks for the active character
/// (the supported "Reset career data" operation; frontend confirms first).
#[tauri::command(async)]
pub fn career_reset(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    ensure_career(&app, state.inner())?;
    let (character, server) = active_identity(&lock(&state.config, "config")?)?;
    let mut guard = lock(&state.career, "career store")?;
    let store = guard.as_mut().ok_or(NO_CAREER)?;
    let removed = store
        .reset_character(&character, &server)
        .map_err(|e| e.to_string())?;
    logging::info(&format!(
        "career reset for {character} ({server}): {removed} row(s) removed"
    ));
    Ok(())
}
