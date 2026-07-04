//! Fight history: the app-side wiring around `eqlog-store`'s `FightStore`.
//!
//! The tail session inserts every completed fight (see `tailing.rs` — this is
//! what fixes the old "drain and keep one" discard bug); these commands page
//! through the archive for the Fights browser and build the
//! paste-parse-to-chat string.

use std::sync::{Arc, Mutex};

use eqlog_core::fights::FightSummary;
use eqlog_store::FightStore;
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::commands::{lock, AppState};
use crate::logging;
use crate::meters::{damage_rows, MeterRow};

/// `FightStore` is `Send` but not `Sync`; the tail thread writes and commands
/// read, so share one connection behind a mutex. `None` = the database
/// failed to open (history disabled, everything else keeps working).
pub type SharedStore = Arc<Mutex<Option<FightStore>>>;

/// Open `fights.db` under the resolved data root. Failures are logged and
/// yield `None` — fight history must never block tailing/alerts.
pub fn open(app: &AppHandle) -> Option<FightStore> {
    let path = crate::data_root::resolve(app).fights_db();
    match FightStore::open(&path) {
        Ok(store) => Some(store),
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
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FightPage {
    pub fights: Vec<FightRecord>,
    /// Total rows in the store (for pagination).
    pub total: u64,
}

// ---------- commands ----------

const NO_STORE: &str = "fight history is unavailable (database failed to open — see app.log)";

#[tauri::command]
pub fn list_fights(
    state: State<'_, AppState>,
    limit: u32,
    offset: u32,
) -> Result<FightPage, String> {
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
pub fn get_fight(state: State<'_, AppState>, id: i64) -> Result<Option<FightRecord>, String> {
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
pub fn paste_parse(state: State<'_, AppState>, id: Option<i64>) -> Result<Vec<String>, String> {
    let character = lock(&state.config, "config")?
        .character_name
        .trim()
        .to_string();
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
            target_slain: true,
            rows,
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
