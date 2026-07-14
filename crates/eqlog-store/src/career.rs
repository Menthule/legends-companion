//! Career persistence: per-character sessions, level-ups, loot ledger, and
//! per-mob kill aggregates, plus the query API the CLI and Tauri app share.
//!
//! Implementation contract: docs/career-db-design.md. All `ts` values are
//! LOG-DOMAIN epoch seconds (the log's naive-local time interpreted as UTC,
//! the `fights.start_ts` convention); `last_import_at` alone is true-UTC
//! bookkeeping. Serialized shapes (camelCase) match the frontend wire
//! contract verbatim so the Tauri layer passes rows straight through.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::{schema, StoreError};

pub use crate::import::{ImportOptions, ImportProgress, ImportReport, DEFAULT_GAP_SECS};

/// Lifetime aggregate over one character's sessions (wire: `CareerSummary`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CareerSummary {
    pub character: String,
    pub server: String,
    pub sessions: u64,
    pub total_duration_secs: i64,
    pub first_ts: Option<i64>,
    pub last_ts: Option<i64>,
    pub kills: u64,
    pub deaths: u64,
    pub xp_percent: f64,
    pub level_ups: u64,
    pub end_level: Option<u32>,
    pub coin_copper: i64,
    pub loot_count: u64,
    pub skill_ups: u64,
    pub aa_points: u64,
    /// TRUE-UTC epoch seconds of the most recent import (bookkeeping only).
    pub last_import_at: Option<i64>,
}

/// One contiguous play block (wire: `CareerSession`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CareerSession {
    pub id: i64,
    pub start_ts: i64,
    pub end_ts: i64,
    pub duration_secs: i64,
    pub zones: Vec<String>,
    pub kills: u64,
    pub deaths: u64,
    pub xp_percent: f64,
    pub party_xp_percent: f64,
    pub level_ups: u64,
    pub end_level: Option<u32>,
    pub aa_points: u64,
    pub coin_copper: i64,
    pub skill_ups: u64,
    pub loot_count: u64,
    pub source_file: String,
}

/// One level-up event (wire: `CareerLevelUp`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CareerLevelUp {
    pub id: i64,
    pub ts: i64,
    pub level: u32,
    pub session_id: Option<i64>,
}

/// One loot event (wire: `CareerLootRow`). `sold_for_copper`: `None` = kept,
/// `Some(0)` = "sold it for free".
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CareerLootRow {
    pub id: i64,
    pub ts: i64,
    pub item: String,
    pub quantity: u32,
    pub corpse: Option<String>,
    pub looter: String,
    pub sold_for_copper: Option<i64>,
    pub session_id: Option<i64>,
}

/// Career per-mob kill + observed-drop counts (wire: `CareerMobKills`).
/// Counts, never rates — the character only sees loot they were present for.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CareerMobKills {
    pub mob: String,
    pub kills: u64,
    pub loot_drops: u64,
    pub distinct_items: u64,
    /// Log-domain end_ts of the most recent session with a kill of this mob.
    pub last_ts: i64,
}

/// Observed drops of one item off one mob (wire: `CareerMobDrop`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CareerMobDrop {
    pub item: String,
    pub count: u64,
}

/// SQLite-backed career store. Same file as [`crate::FightStore`] — both run
/// the shared [`schema`] migration on open. Not `Sync`: wrap in a mutex for
/// concurrent hosts.
pub struct CareerStore {
    pub(crate) conn: Connection,
}

impl CareerStore {
    /// Open (creating and migrating as needed) the store at `path`. Parent
    /// directories are created.
    pub fn open(path: impl AsRef<Path>) -> Result<CareerStore, StoreError> {
        let path = path.as_ref();
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            // Best-effort: if this fails, Connection::open reports the real error.
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(path)?;
        Self::from_connection(conn)
    }

    /// In-memory store (tests, mock mode). Same schema and behavior.
    pub fn open_in_memory() -> Result<CareerStore, StoreError> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(conn: Connection) -> Result<CareerStore, StoreError> {
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        let _ = conn.pragma_update(None, "synchronous", "NORMAL");
        // The career schema uses ON DELETE CASCADE / SET NULL child links;
        // SQLite only honors them with foreign_keys on.
        let _ = conn.pragma_update(None, "foreign_keys", "ON");
        // Second connection to the fights.db file (FightStore is the other):
        // wait out the other writer's commit instead of failing SQLITE_BUSY.
        let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
        schema::migrate(&conn)?;
        Ok(CareerStore { conn })
    }

    /// Delete every career row + import watermark for one character
    /// (the supported "Reset career data" operation). Returns the number of
    /// rows removed across all career tables.
    pub fn reset_character(&mut self, character: &str, server: &str) -> Result<u64, StoreError> {
        let tx = self.conn.transaction()?;
        let mut removed = 0u64;
        for table in [
            "loot",
            "level_ups",
            "session_mob_kills",
            "sessions",
            "import_files",
            "career_watermarks",
        ] {
            let sql = format!(
                "DELETE FROM {table} \
                 WHERE character = ?1 COLLATE NOCASE AND server = ?2 COLLATE NOCASE"
            );
            removed += tx.execute(&sql, params![character, server])? as u64;
        }
        tx.commit()?;
        Ok(removed)
    }

    /// Every (character, server) pair with career data, canonical case.
    /// Used by the CLI to default `--character` when the DB is unambiguous.
    pub fn characters(&self) -> Result<Vec<(String, String)>, StoreError> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT DISTINCT character, server FROM sessions ORDER BY character, server",
        )?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Lifetime summary; `Ok(None)` when this character has no sessions yet.
    pub fn summary(
        &self,
        character: &str,
        server: &str,
    ) -> Result<Option<CareerSummary>, StoreError> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT character, server, COUNT(*), SUM(duration_secs),
                    MIN(start_ts), MAX(end_ts), SUM(kills), SUM(deaths),
                    SUM(xp_percent), SUM(level_ups), MAX(end_level),
                    SUM(coin_copper), SUM(loot_count), SUM(skill_ups),
                    SUM(aa_points)
             FROM sessions
             WHERE character = ?1 COLLATE NOCASE AND server = ?2 COLLATE NOCASE",
        )?;
        let row = stmt.query_row(params![character, server], |row| {
            let sessions: u64 = row.get::<_, i64>(2)?.max(0) as u64;
            if sessions == 0 {
                return Ok(None);
            }
            Ok(Some(CareerSummary {
                character: row.get(0)?,
                server: row.get(1)?,
                sessions,
                total_duration_secs: row.get(3)?,
                first_ts: row.get(4)?,
                last_ts: row.get(5)?,
                kills: row.get::<_, i64>(6)?.max(0) as u64,
                deaths: row.get::<_, i64>(7)?.max(0) as u64,
                xp_percent: row.get(8)?,
                level_ups: row.get::<_, i64>(9)?.max(0) as u64,
                end_level: row.get(10)?,
                coin_copper: row.get(11)?,
                loot_count: row.get::<_, i64>(12)?.max(0) as u64,
                skill_ups: row.get::<_, i64>(13)?.max(0) as u64,
                aa_points: row.get::<_, i64>(14)?.max(0) as u64,
                last_import_at: None,
            }))
        })?;
        let Some(mut summary) = row else {
            return Ok(None);
        };
        summary.last_import_at = self
            .conn
            .prepare_cached(
                "SELECT MAX(imported_at) FROM import_files \
                 WHERE character = ?1 COLLATE NOCASE AND server = ?2 COLLATE NOCASE",
            )?
            .query_row(params![character, server], |row| row.get(0))?;
        Ok(Some(summary))
    }

    /// Page through sessions, most recent first. Returns `(total, rows)`.
    pub fn sessions(
        &self,
        character: &str,
        server: &str,
        limit: u32,
        offset: u32,
    ) -> Result<(u64, Vec<CareerSession>), StoreError> {
        let total: i64 = self
            .conn
            .prepare_cached(
                "SELECT COUNT(*) FROM sessions \
                 WHERE character = ?1 COLLATE NOCASE AND server = ?2 COLLATE NOCASE",
            )?
            .query_row(params![character, server], |row| row.get(0))?;
        let mut stmt = self.conn.prepare_cached(
            "SELECT id, start_ts, end_ts, duration_secs, zones_json, kills,
                    deaths, xp_percent, party_xp_percent, level_ups, end_level,
                    aa_points, coin_copper, skill_ups, loot_count, source_file
             FROM sessions
             WHERE character = ?1 COLLATE NOCASE AND server = ?2 COLLATE NOCASE
             ORDER BY start_ts DESC, id DESC LIMIT ?3 OFFSET ?4",
        )?;
        let rows = stmt.query_map(params![character, server, limit, offset], |row| {
            let zones_json: String = row.get(4)?;
            Ok(CareerSession {
                id: row.get(0)?,
                start_ts: row.get(1)?,
                end_ts: row.get(2)?,
                duration_secs: row.get(3)?,
                zones: serde_json::from_str(&zones_json).unwrap_or_default(),
                kills: row.get::<_, i64>(5)?.max(0) as u64,
                deaths: row.get::<_, i64>(6)?.max(0) as u64,
                xp_percent: row.get(7)?,
                party_xp_percent: row.get(8)?,
                level_ups: row.get::<_, i64>(9)?.max(0) as u64,
                end_level: row.get(10)?,
                aa_points: row.get::<_, i64>(11)?.max(0) as u64,
                coin_copper: row.get(12)?,
                skill_ups: row.get::<_, i64>(13)?.max(0) as u64,
                loot_count: row.get::<_, i64>(14)?.max(0) as u64,
                source_file: row.get(15)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok((total.max(0) as u64, out))
    }

    /// Every level-up, ascending ts (the level timeline chart).
    pub fn level_timeline(
        &self,
        character: &str,
        server: &str,
    ) -> Result<Vec<CareerLevelUp>, StoreError> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT id, ts, level, session_id FROM level_ups
             WHERE character = ?1 COLLATE NOCASE AND server = ?2 COLLATE NOCASE
             ORDER BY ts ASC, id ASC",
        )?;
        let rows = stmt.query_map(params![character, server], |row| {
            Ok(CareerLevelUp {
                id: row.get(0)?,
                ts: row.get(1)?,
                level: row.get(2)?,
                session_id: row.get(3)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Paged loot ledger, newest first. `search` filters the item name as a
    /// case-insensitive substring; empty string = all (fixed-parameter guard).
    pub fn loot(
        &self,
        character: &str,
        server: &str,
        search: &str,
        limit: u32,
        offset: u32,
    ) -> Result<(u64, Vec<CareerLootRow>), StoreError> {
        let total: i64 = self
            .conn
            .prepare_cached(
                "SELECT COUNT(*) FROM loot
                 WHERE character = ?1 COLLATE NOCASE AND server = ?2 COLLATE NOCASE
                   AND (?3 = '' OR item LIKE '%' || ?3 || '%')",
            )?
            .query_row(params![character, server, search], |row| row.get(0))?;
        let mut stmt = self.conn.prepare_cached(
            "SELECT id, ts, item, quantity, corpse, looter, sold_for_copper, session_id
             FROM loot
             WHERE character = ?1 COLLATE NOCASE AND server = ?2 COLLATE NOCASE
               AND (?3 = '' OR item LIKE '%' || ?3 || '%')
             ORDER BY ts DESC, id DESC LIMIT ?4 OFFSET ?5",
        )?;
        let rows = stmt.query_map(params![character, server, search, limit, offset], |row| {
            Ok(CareerLootRow {
                id: row.get(0)?,
                ts: row.get(1)?,
                item: row.get(2)?,
                quantity: row.get(3)?,
                corpse: row.get(4)?,
                looter: row.get(5)?,
                sold_for_copper: row.get(6)?,
                session_id: row.get(7)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok((total.max(0) as u64, out))
    }

    /// Paged per-mob career kill counts plus observed drop counts, most-killed
    /// first. `search` filters the mob name as a case-insensitive substring;
    /// empty string = all.
    pub fn mob_kills(
        &self,
        character: &str,
        server: &str,
        search: &str,
        limit: u32,
        offset: u32,
    ) -> Result<(u64, Vec<CareerMobKills>), StoreError> {
        let total: i64 = self
            .conn
            .prepare_cached(
                "SELECT COUNT(*) FROM (
                     SELECT 1 FROM session_mob_kills
                     WHERE character = ?1 COLLATE NOCASE AND server = ?2 COLLATE NOCASE
                       AND (?3 = '' OR mob LIKE '%' || ?3 || '%')
                     GROUP BY mob COLLATE NOCASE
                 )",
            )?
            .query_row(params![character, server, search], |row| row.get(0))?;
        let mut stmt = self.conn.prepare_cached(
            "WITH k AS (
                 SELECT smk.mob AS mob, SUM(smk.kills) AS kills,
                        MAX(s.end_ts) AS last_ts
                 FROM session_mob_kills smk
                 JOIN sessions s ON s.id = smk.session_id
                 WHERE smk.character = ?1 COLLATE NOCASE
                   AND smk.server = ?2 COLLATE NOCASE
                   AND (?3 = '' OR smk.mob LIKE '%' || ?3 || '%')
                 GROUP BY smk.mob COLLATE NOCASE
             ), d AS (
                 SELECT corpse AS mob, COUNT(*) AS drops,
                        COUNT(DISTINCT item COLLATE NOCASE) AS items
                 FROM loot
                 WHERE character = ?1 COLLATE NOCASE AND server = ?2 COLLATE NOCASE
                   AND corpse IS NOT NULL
                 GROUP BY corpse COLLATE NOCASE
             )
             SELECT k.mob, k.kills, COALESCE(d.drops, 0), COALESCE(d.items, 0),
                    k.last_ts
             FROM k LEFT JOIN d ON d.mob = k.mob COLLATE NOCASE
             ORDER BY k.kills DESC, k.mob COLLATE NOCASE ASC
             LIMIT ?4 OFFSET ?5",
        )?;
        let rows = stmt.query_map(params![character, server, search, limit, offset], |row| {
            Ok(CareerMobKills {
                mob: row.get(0)?,
                kills: row.get::<_, i64>(1)?.max(0) as u64,
                loot_drops: row.get::<_, i64>(2)?.max(0) as u64,
                distinct_items: row.get::<_, i64>(3)?.max(0) as u64,
                last_ts: row.get(4)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok((total.max(0) as u64, out))
    }

    /// Observed drops off one mob, most-seen first (counts, never rates).
    pub fn mob_drops(
        &self,
        character: &str,
        server: &str,
        mob: &str,
    ) -> Result<Vec<CareerMobDrop>, StoreError> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT item, COUNT(*) AS n FROM loot
             WHERE character = ?1 COLLATE NOCASE AND server = ?2 COLLATE NOCASE
               AND corpse = ?3 COLLATE NOCASE
             GROUP BY item COLLATE NOCASE
             ORDER BY n DESC, item COLLATE NOCASE ASC",
        )?;
        let rows = stmt.query_map(params![character, server, mob], |row| {
            Ok(CareerMobDrop {
                item: row.get(0)?,
                count: row.get::<_, i64>(1)?.max(0) as u64,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// The Layer-2 per-character time floor (`career_watermarks.max_ts`);
    /// `Ok(None)` when nothing has ever been folded for this character.
    pub fn max_folded_ts(&self, character: &str, server: &str) -> Result<Option<i64>, StoreError> {
        let ts = self
            .conn
            .prepare_cached(
                "SELECT max_ts FROM career_watermarks \
                 WHERE character = ?1 COLLATE NOCASE AND server = ?2 COLLATE NOCASE",
            )?
            .query_row(params![character, server], |row| row.get(0))
            .optional()?;
        Ok(ts)
    }
}
