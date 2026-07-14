//! Fight history: the app-side wiring around `eqlog-store`'s `FightStore`.
//!
//! The tail session inserts every completed fight (see `tailing.rs` — this is
//! what fixes the old "drain and keep one" discard bug); these commands page
//! through the archive for the Fights browser and build the
//! paste-parse-to-chat string.

use std::sync::{Arc, Mutex};

use eqlog_core::fights::{FightConfig, FightSummary, FightTracker};
use eqlog_core::parser::Parser;
use eqlog_store::FightStore;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::commands::{lock, AppState};
use crate::logging;
use crate::meters::{damage_rows, enemy_damage_rows, MeterRow};

/// `FightStore` is `Send` but not `Sync`; the tail thread writes and commands
/// read, so share one connection behind a mutex. `None` = the database
/// failed to open (history disabled, everything else keeps working).
pub type SharedStore = Arc<Mutex<Option<FightStore>>>;

/// Open `fights.db` under the resolved data root. Failures are logged and
/// yield `None` — fight history must never block tailing/alerts.
pub fn open(app: &AppHandle) -> Option<FightStore> {
    let path = crate::data_root::resolve(app).fights_db();
    match FightStore::open(&path) {
        Ok(store) => {
            logging::info(&format!("fight history opened: {}", path.display()));
            Some(store)
        }
        Err(e) => {
            logging::warn(&format!(
                "fight history disabled — cannot open {}: {e}",
                path.display()
            ));
            None
        }
    }
}

// ---------- payload shapes ----------

/// One stored fight, shaped for the frontend (camelCase, damage rows only —
/// mirrors the live "fight-update" rows so meter components can be reused).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FightRecord {
    pub id: i64,
    pub target: String,
    pub start_ts: i64,
    pub end_ts: i64,
    pub duration_secs: u64,
    pub total_damage: u64,
    pub target_slain: bool,
    pub rows: Vec<MeterRow>,
    pub enemy_rows: Vec<MeterRow>,
}

fn record(id: i64, summary: &FightSummary) -> FightRecord {
    FightRecord {
        id,
        target: summary.target.clone(),
        start_ts: summary.start_ts,
        end_ts: summary.end_ts,
        duration_secs: summary.duration_secs,
        total_damage: summary.total_damage,
        target_slain: summary.target_slain,
        rows: damage_rows(summary),
        enemy_rows: enemy_damage_rows(summary),
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FightPage {
    pub fights: Vec<FightRecord>,
    /// Total rows in the store (for pagination).
    pub total: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionExportFight {
    id: i64,
    summary: FightSummary,
}

/// Stable, portable session snapshot. `session` holds the frontend-owned
/// collections (loot, rolls, XP, and similar); fights come directly from the
/// store so their complete summaries are preserved.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionExport {
    format: &'static str,
    version: u32,
    app_version: &'static str,
    exported_at: u64,
    character: String,
    started_ts: i64,
    ended_ts: i64,
    session: Value,
    fights: Vec<SessionExportFight>,
}

// ---------- commands ----------

const NO_STORE: &str = "fight history is unavailable (database failed to open — see app.log)";

fn ensure_store(app: &AppHandle, state: &State<'_, AppState>) -> Result<(), String> {
    let mut guard = lock(&state.store, "fight store")?;
    if guard.is_some() {
        return Ok(());
    }
    let path = crate::data_root::resolve(app).fights_db();
    match FightStore::open(&path) {
        Ok(store) => {
            logging::info(&format!("fight history opened: {}", path.display()));
            *guard = Some(store);
            Ok(())
        }
        Err(e) => {
            logging::warn(&format!(
                "fight history disabled — cannot open {}: {e}",
                path.display()
            ));
            Err(NO_STORE.to_string())
        }
    }
}

#[tauri::command]
pub fn list_fights(
    app: AppHandle,
    state: State<'_, AppState>,
    limit: u32,
    offset: u32,
) -> Result<FightPage, String> {
    ensure_store(&app, &state)?;
    let guard = lock(&state.store, "fight store")?;
    let store = guard.as_ref().ok_or(NO_STORE)?;
    let limit = limit.clamp(1, 500);
    let fights = store
        .list(limit, offset)
        .map_err(|e| e.to_string())?
        .iter()
        .map(|f| record(f.id, &f.summary))
        .collect();
    let total = store.count().map_err(|e| e.to_string())?;
    Ok(FightPage { fights, total })
}

#[tauri::command]
pub fn get_fight(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
) -> Result<Option<FightRecord>, String> {
    ensure_store(&app, &state)?;
    let guard = lock(&state.store, "fight store")?;
    let store = guard.as_ref().ok_or(NO_STORE)?;
    Ok(store
        .get(id)
        .map_err(|e| e.to_string())?
        .map(|f| record(f.id, &f.summary)))
}

/// Build the "post the parse" chat string for a stored fight (`id`), or for
/// the most recently stored one (`id: null` — the Meters tab's Copy button).
/// Returned as ready-to-paste chunks, each within the EQ chat length limit.
#[tauri::command]
pub fn paste_parse(
    app: AppHandle,
    state: State<'_, AppState>,
    id: Option<i64>,
) -> Result<Vec<String>, String> {
    let character = lock(&state.config, "config")?
        .character_name
        .trim()
        .to_string();
    ensure_store(&app, &state)?;
    let guard = lock(&state.store, "fight store")?;
    let store = guard.as_ref().ok_or(NO_STORE)?;
    let stored = match id {
        Some(id) => store
            .get(id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("no stored fight with id {id}"))?,
        None => store
            .list(1, 0)
            .map_err(|e| e.to_string())?
            .into_iter()
            .next()
            .ok_or("no completed fights recorded yet")?,
    };
    Ok(paste_lines(&stored.summary, &character))
}

/// Delete one stored fight (the Fights-tab row × button). Returns whether a
/// row was actually removed.
#[tauri::command]
pub fn delete_fight(app: AppHandle, state: State<'_, AppState>, id: i64) -> Result<bool, String> {
    ensure_store(&app, &state)?;
    let mut guard = lock(&state.store, "fight store")?;
    let store = guard.as_mut().ok_or(NO_STORE)?;
    store.delete(id).map_err(|e| e.to_string())
}

/// Prune history: keep the newest `keep_last_n` fights and/or drop everything
/// started before `before_ts` (log-domain unix seconds). Both are optional —
/// applies whichever is provided. Returns the total rows removed. Used by the
/// "Clear history" button (keep_last_n: 0) and the retention sweep at startup.
#[tauri::command]
pub fn prune_fights(
    app: AppHandle,
    state: State<'_, AppState>,
    keep_last_n: Option<u32>,
    before_ts: Option<i64>,
) -> Result<u64, String> {
    ensure_store(&app, &state)?;
    let mut guard = lock(&state.store, "fight store")?;
    let store = guard.as_mut().ok_or(NO_STORE)?;
    let mut removed = 0;
    if let Some(n) = keep_last_n {
        removed += store.prune_keep_last(n).map_err(|e| e.to_string())?;
    }
    if let Some(ts) = before_ts {
        removed += store.prune_before(ts).map_err(|e| e.to_string())?;
    }
    Ok(removed)
}

/// Offline log import / raid replay (P26): parse a past log file end-to-end
/// through a fresh FightTracker (no engine, no audio, no persistence) and
/// return its completed fights for a read-only review. The character/pets come
/// from the current config so "You" attribution and pet folding match live.
/// Ids are positional (0-based) — these fights are NOT stored, so `get_fight`
/// won't resolve them; the frontend renders the returned list directly.
#[tauri::command]
pub fn analyze_log(state: State<'_, AppState>, path: String) -> Result<Vec<FightRecord>, String> {
    let (character, pets) = {
        let cfg = lock(&state.config, "config")?;
        (cfg.character_name.clone(), cfg.pets.clone())
    };
    let text = std::fs::read_to_string(&path).map_err(|e| format!("cannot read log file: {e}"))?;
    let parser = Parser::new();
    let mut cfg = FightConfig::new(character.clone());
    for pet in &pets {
        cfg.pet_owners.insert(pet.clone(), character.clone());
    }
    let mut tracker = FightTracker::new(cfg);
    let mut summaries: Vec<FightSummary> = Vec::new();
    for line in text.lines() {
        if let Some(parsed) = parser.parse_line(line) {
            tracker.ingest(&parsed);
            summaries.append(&mut tracker.completed_fights());
        }
    }
    // Flush any fight still open at end-of-file.
    tracker.close_all();
    summaries.append(&mut tracker.completed_fights());
    // Negative, 1-based ids so an imported fight can never collide with a
    // stored fight's id (paste/export then knows to format locally).
    let records = summaries
        .iter()
        .enumerate()
        .map(|(i, s)| record(-(i as i64 + 1), s))
        .collect();
    Ok(records)
}

/// Export one stored fight's full summary as pretty JSON (the Fights-tab
/// Export button; the frontend offers it as a download).
#[tauri::command]
pub fn export_fight(app: AppHandle, state: State<'_, AppState>, id: i64) -> Result<String, String> {
    ensure_store(&app, &state)?;
    let guard = lock(&state.store, "fight store")?;
    let store = guard.as_ref().ok_or(NO_STORE)?;
    let stored = store
        .get(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no stored fight with id {id}"))?;
    serde_json::to_string_pretty(&stored.summary).map_err(|e| e.to_string())
}

/// Export the current frontend session collections plus every stored fight
/// overlapping the captured log-time bounds. Raw log lines are deliberately
/// excluded because they can contain private chat.
#[tauri::command]
pub fn export_session(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    character: String,
    start_ts: i64,
    end_ts: i64,
    details: Value,
) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("export path is empty".to_string());
    }
    if start_ts > end_ts {
        return Err("session start is after its end".to_string());
    }
    ensure_store(&app, &state)?;
    let guard = lock(&state.store, "fight store")?;
    let store = guard.as_ref().ok_or(NO_STORE)?;
    let fights = store
        .list_between(start_ts, end_ts)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|stored| SessionExportFight {
            id: stored.id,
            summary: stored.summary,
        })
        .collect();
    drop(guard);
    let exported_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    let export = SessionExport {
        format: "legends-companion-session",
        version: 1,
        app_version: env!("CARGO_PKG_VERSION"),
        exported_at,
        character,
        started_ts: start_ts,
        ended_ts: end_ts,
        session: details,
        fights,
    };
    let json = serde_json::to_vec_pretty(&export).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| format!("write session export: {e}"))
}

// ---------- paste formatting ----------

/// EQ chat input safety limit per pasted line.
const PASTE_CHUNK_MAX: usize = 240;

/// "target (32s) | You: 2761 (38.3 DPS) | Torvin: 1520 (21.1 DPS) | ...",
/// split at row boundaries into chunks of at most [`PASTE_CHUNK_MAX`] chars.
pub fn paste_lines(summary: &FightSummary, character: &str) -> Vec<String> {
    let header = format!("{} ({}s)", summary.target, summary.duration_secs);
    let parts: Vec<String> = summary
        .rows
        .iter()
        .filter(|r| r.damage > 0)
        .map(|r| {
            let name = if !character.is_empty() && r.name.eq_ignore_ascii_case(character) {
                "You"
            } else {
                r.name.as_str()
            };
            format!("{name}: {} ({:.1} DPS)", r.damage, r.dps)
        })
        .collect();

    let mut chunks: Vec<String> = Vec::new();
    let mut current = header;
    for part in parts {
        let candidate = format!("{current} | {part}");
        if candidate.len() > PASTE_CHUNK_MAX && !current.is_empty() {
            chunks.push(current);
            current = part;
        } else {
            current = candidate;
        }
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;
    use eqlog_core::fights::CombatantRow;

    fn row(name: &str, damage: u64, dps: f64) -> CombatantRow {
        CombatantRow {
            name: name.into(),
            damage,
            pet_damage: 0,
            hits: 1,
            misses: 0,
            crits: 0,
            max_hit: damage,
            damage_taken: 0,
            healing: 0,
            overheal: 0,
            dps,
            percent: 0.0,
            sources: Vec::new(),
        }
    }

    fn summary(rows: Vec<CombatantRow>) -> FightSummary {
        FightSummary {
            target: "a gnoll pup".into(),
            start_ts: 100,
            end_ts: 172,
            duration_secs: 72,
            total_damage: rows.iter().map(|r| r.damage).sum(),
            total_enemy_damage: 0,
            target_slain: true,
            rows,
            enemy_rows: Vec::new(),
        }
    }

    #[test]
    fn paste_maps_character_to_you_and_skips_zero_rows() {
        let s = summary(vec![
            row("Nyasha", 2761, 38.3),
            row("Torvin", 1520, 21.1),
            row("Healer", 0, 0.0),
        ]);
        let lines = paste_lines(&s, "Nyasha");
        assert_eq!(lines.len(), 1);
        assert_eq!(
            lines[0],
            "a gnoll pup (72s) | You: 2761 (38.3 DPS) | Torvin: 1520 (21.1 DPS)"
        );
    }

    #[test]
    fn paste_splits_at_240_chars_on_row_boundaries() {
        let rows: Vec<CombatantRow> = (0..24)
            .map(|i| row(&format!("Combatant{i:02}"), 1000 + i, 10.0 + i as f64))
            .collect();
        let s = summary(rows);
        let lines = paste_lines(&s, "Nyasha");
        assert!(lines.len() > 1, "24 rows cannot fit one 240-char chunk");
        for line in &lines {
            assert!(line.len() <= 240, "chunk over limit: {} chars", line.len());
        }
        // No row lost or duplicated across the split.
        let joined = lines.join(" | ");
        for i in 0..24 {
            assert_eq!(joined.matches(&format!("Combatant{i:02}:")).count(), 1);
        }
    }
}
