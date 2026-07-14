//! eqlog-store — SQLite persistence for completed fights and per-character
//! career history.
//!
//! Fixes the "meters amnesia" gap (APP_REVIEW N7): completed
//! [`FightSummary`]s were drained and discarded in memory; this crate gives
//! hosts (the Tauri app, the CLI) a durable, browsable fight history. The
//! [`career`] module adds durable per-character career tables plus the
//! log-history backfill importer (docs/career-db-design.md).
//!
//! Design:
//! - One `fights` table. Hot list/sort columns (`target`, `start_ts`, …) are
//!   real columns; the full summary (per-combatant rows included) is stored
//!   as the crate-of-record JSON blob, so the schema never chases
//!   [`FightSummary`] field additions.
//! - Schema is versioned via `PRAGMA user_version` ([`schema`] module, shared
//!   by [`FightStore`] and [`career::CareerStore`]). Opening a newer database
//!   than this crate understands is a hard error (never silently rewrite a
//!   future schema); older versions are migrated in place.
//! - SQLite is compiled in (`rusqlite` `bundled`), so there is no system
//!   library dependency on any platform.

pub mod career;
mod import;
mod schema;

use std::path::Path;

use eqlog_core::fights::FightSummary;
use rusqlite::{params, Connection, OptionalExtension};

/// Errors from [`FightStore`] operations.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("fight store database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("fight store row {id} holds invalid summary JSON: {source}")]
    Corrupt {
        id: i64,
        #[source]
        source: serde_json::Error,
    },
    #[error(
        "fight store schema is version {found}, newer than supported version {supported}; \
         update the app instead of downgrading the database"
    )]
    FutureSchema { found: i64, supported: i64 },
    #[error("career import I/O error on {path}: {source}")]
    ImportIo {
        path: std::path::PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("career import error: {0}")]
    Import(String),
}

/// A persisted fight: its database id plus the full summary.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredFight {
    /// Stable row id (`INTEGER PRIMARY KEY`), usable with [`FightStore::get`].
    pub id: i64,
    pub summary: FightSummary,
}

/// SQLite-backed store of completed fights.
///
/// Not `Sync`: wrap in a mutex (or confine to one thread) for concurrent
/// hosts — the Tauri app already funnels fight completion through a single
/// tick thread.
pub struct FightStore {
    conn: Connection,
}

impl FightStore {
    /// Open (creating and migrating as needed) the store at `path`. Parent
    /// directories are created.
    pub fn open(path: impl AsRef<Path>) -> Result<FightStore, StoreError> {
        let path = path.as_ref();
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            // Best-effort: if this fails, Connection::open reports the real error.
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(path)?;
        Self::from_connection(conn)
    }

    /// In-memory store (tests, mock mode). Same schema and behavior.
    pub fn open_in_memory() -> Result<FightStore, StoreError> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(conn: Connection) -> Result<FightStore, StoreError> {
        // WAL keeps the raid-night writer from blocking a UI reader; NORMAL
        // sync is durable enough for a parse archive. Both are best-effort
        // (in-memory databases reject WAL).
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        let _ = conn.pragma_update(None, "synchronous", "NORMAL");
        // The app runs a second connection to this file (CareerStore, career
        // importer). WAL allows one writer at a time; without a busy timeout
        // a fight insert colliding with an import commit fails immediately
        // with SQLITE_BUSY instead of waiting the few ms it needs.
        let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
        schema::migrate(&conn)?;
        Ok(FightStore { conn })
    }

    /// Persist one completed fight. Returns the new row's id.
    pub fn insert(&mut self, summary: &FightSummary) -> Result<i64, StoreError> {
        let json =
            serde_json::to_string(summary).expect("FightSummary serialization is infallible");
        self.conn.execute(
            "INSERT INTO fights (target, start_ts, end_ts, duration_secs, total_damage, \
             target_slain, summary_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                summary.target,
                summary.start_ts,
                summary.end_ts,
                summary.duration_secs as i64,
                summary.total_damage as i64,
                summary.target_slain,
                json,
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Page through stored fights, most recent first (by `start_ts`, ties by
    /// insertion order, newest first). `limit` rows starting at `offset`.
    pub fn list(&self, limit: u32, offset: u32) -> Result<Vec<StoredFight>, StoreError> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT id, summary_json FROM fights \
             ORDER BY start_ts DESC, id DESC LIMIT ?1 OFFSET ?2",
        )?;
        let rows = stmt.query_map(params![limit, offset], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut fights = Vec::new();
        for row in rows {
            let (id, json) = row?;
            fights.push(StoredFight {
                id,
                summary: parse_summary(id, &json)?,
            });
        }
        Ok(fights)
    }

    /// Return every fight that overlaps the inclusive log-time range, oldest
    /// first. Session exports use overlap rather than start-time containment so
    /// a fight already in progress at either boundary is not silently lost.
    pub fn list_between(&self, start_ts: i64, end_ts: i64) -> Result<Vec<StoredFight>, StoreError> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT id, summary_json FROM fights \
             WHERE end_ts >= ?1 AND start_ts <= ?2 \
             ORDER BY start_ts ASC, id ASC",
        )?;
        let rows = stmt.query_map(params![start_ts, end_ts], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut fights = Vec::new();
        for row in rows {
            let (id, json) = row?;
            fights.push(StoredFight {
                id,
                summary: parse_summary(id, &json)?,
            });
        }
        Ok(fights)
    }

    /// Fetch one fight by id. `Ok(None)` when no such row exists.
    pub fn get(&self, id: i64) -> Result<Option<StoredFight>, StoreError> {
        let json: Option<String> = self
            .conn
            .prepare_cached("SELECT summary_json FROM fights WHERE id = ?1")?
            .query_row(params![id], |row| row.get(0))
            .optional()?;
        match json {
            Some(json) => Ok(Some(StoredFight {
                id,
                summary: parse_summary(id, &json)?,
            })),
            None => Ok(None),
        }
    }

    /// Total number of stored fights (for pagination UIs).
    pub fn count(&self) -> Result<u64, StoreError> {
        let n: i64 = self
            .conn
            .prepare_cached("SELECT COUNT(*) FROM fights")?
            .query_row([], |row| row.get(0))?;
        Ok(n.max(0) as u64)
    }

    /// Delete one fight by id. Returns whether a row was removed.
    pub fn delete(&mut self, id: i64) -> Result<bool, StoreError> {
        let n = self
            .conn
            .execute("DELETE FROM fights WHERE id = ?1", params![id])?;
        Ok(n > 0)
    }

    /// Delete every fight that STARTED strictly before `before_ts` (a log-domain
    /// unix timestamp). Returns how many rows were removed. Used by the
    /// "keep last N days" retention sweep at startup.
    pub fn prune_before(&mut self, before_ts: i64) -> Result<u64, StoreError> {
        let n = self
            .conn
            .execute("DELETE FROM fights WHERE start_ts < ?1", params![before_ts])?;
        Ok(n as u64)
    }

    /// Keep the `keep_last_n` most recent fights (by start_ts, then id) and
    /// delete the rest. `keep_last_n == 0` clears the whole table. Returns how
    /// many rows were removed.
    pub fn prune_keep_last(&mut self, keep_last_n: u32) -> Result<u64, StoreError> {
        // Rows NOT among the newest N (ordered the same way `list` pages them)
        // are pruned. The subquery is empty when the table has ≤ N rows, so
        // nothing is deleted.
        let n = self.conn.execute(
            "DELETE FROM fights WHERE id NOT IN (
                 SELECT id FROM fights ORDER BY start_ts DESC, id DESC LIMIT ?1
             )",
            params![keep_last_n],
        )?;
        Ok(n as u64)
    }
}

fn parse_summary(id: i64, json: &str) -> Result<FightSummary, StoreError> {
    serde_json::from_str(json).map_err(|source| StoreError::Corrupt { id, source })
}

#[cfg(test)]
mod tests {
    use super::*;
    use eqlog_core::fights::CombatantRow;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Unique per-test scratch directory under the system temp dir (same
    /// pattern as eqlog-core's tail tests; no tempfile crate).
    struct TestDir {
        dir: PathBuf,
    }

    impl TestDir {
        fn new(tag: &str) -> TestDir {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "eqlog_store_tests_{}_{}_{}",
                std::process::id(),
                tag,
                nanos
            ));
            std::fs::create_dir_all(&dir).unwrap();
            TestDir { dir }
        }

        fn db_path(&self) -> PathBuf {
            self.dir.join("fights.sqlite")
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn summary(target: &str, start_ts: i64) -> FightSummary {
        FightSummary {
            target: target.to_string(),
            start_ts,
            end_ts: start_ts + 30,
            duration_secs: 30,
            total_damage: 2761,
            total_enemy_damage: 0,
            target_slain: true,
            rows: vec![CombatantRow {
                name: "Nyasha".to_string(),
                damage: 2761,
                pet_damage: 500,
                hits: 40,
                misses: 3,
                crits: 2,
                max_hit: 210,
                damage_taken: 55,
                healing: 120,
                overheal: 10,
                dps: 92.0,
                percent: 100.0,
                sources: vec![eqlog_core::fights::SourceRow {
                    name: "crush".to_string(),
                    total: 2761,
                    hits: 40,
                    crits: 2,
                    max_hit: 210,
                    misses: 6,
                    casts: 0,
                }],
            }],
            enemy_rows: Vec::new(),
        }
    }

    #[test]
    fn insert_get_round_trips_full_summary() {
        let td = TestDir::new("round_trip");
        let mut store = FightStore::open(td.db_path()).unwrap();
        let fight = summary("A zol ghoul knight", 1_000);
        let id = store.insert(&fight).unwrap();

        let back = store.get(id).unwrap().expect("row exists");
        assert_eq!(back.id, id);
        assert_eq!(back.summary, fight);
        assert_eq!(store.get(id + 999).unwrap(), None);
    }

    #[test]
    fn source_misses_and_casts_round_trip() {
        // A melee source carries misses; a spell source can have casts with
        // zero damage (a resisted / debuff cast). Both must survive the JSON
        // blob round-trip so the app's Acc% / per-cast columns work on stored
        // fights, not just live ones.
        let mut store = FightStore::open_in_memory().unwrap();
        let mut fight = summary("a gnoll pup", 1);
        fight.rows[0].sources = vec![
            eqlog_core::fights::SourceRow {
                name: "crush".to_string(),
                total: 2761,
                hits: 40,
                crits: 2,
                max_hit: 210,
                misses: 6,
                casts: 0,
            },
            eqlog_core::fights::SourceRow {
                name: "Negation of Life".to_string(),
                total: 0,
                hits: 0,
                crits: 0,
                max_hit: 0,
                misses: 0,
                casts: 3,
            },
        ];
        let id = store.insert(&fight).unwrap();
        let back = store.get(id).unwrap().unwrap();
        assert_eq!(back.summary, fight);
        let crush = &back.summary.rows[0].sources[0];
        assert_eq!(crush.misses, 6);
        let spell = &back.summary.rows[0].sources[1];
        assert_eq!(spell.casts, 3);
        assert_eq!(spell.total, 0);
    }

    #[test]
    fn list_pages_newest_first() {
        let mut store = FightStore::open_in_memory().unwrap();
        for (i, target) in ["a", "b", "c", "d", "e"].iter().enumerate() {
            store
                .insert(&summary(target, 1_000 + i as i64 * 60))
                .unwrap();
        }
        assert_eq!(store.count().unwrap(), 5);

        let page1 = store.list(2, 0).unwrap();
        let names: Vec<&str> = page1.iter().map(|f| f.summary.target.as_str()).collect();
        assert_eq!(names, ["e", "d"]);

        let page2 = store.list(2, 2).unwrap();
        let names: Vec<&str> = page2.iter().map(|f| f.summary.target.as_str()).collect();
        assert_eq!(names, ["c", "b"]);

        let tail = store.list(10, 4).unwrap();
        let names: Vec<&str> = tail.iter().map(|f| f.summary.target.as_str()).collect();
        assert_eq!(names, ["a"]);
    }

    #[test]
    fn equal_start_ts_orders_by_insertion_newest_first() {
        let mut store = FightStore::open_in_memory().unwrap();
        store.insert(&summary("first", 1_000)).unwrap();
        store.insert(&summary("second", 1_000)).unwrap();
        let names: Vec<String> = store
            .list(10, 0)
            .unwrap()
            .into_iter()
            .map(|f| f.summary.target)
            .collect();
        assert_eq!(names, ["second", "first"]);
    }

    #[test]
    fn list_between_includes_boundary_overlaps_in_chronological_order() {
        let mut store = FightStore::open_in_memory().unwrap();
        for (target, start) in [
            ("before", 900),
            ("crosses start", 980),
            ("inside", 1_050),
            ("at end", 1_100),
            ("after", 1_101),
        ] {
            store.insert(&summary(target, start)).unwrap();
        }

        let names: Vec<String> = store
            .list_between(1_000, 1_100)
            .unwrap()
            .into_iter()
            .map(|f| f.summary.target)
            .collect();
        assert_eq!(names, ["crosses start", "inside", "at end"]);
    }

    #[test]
    fn reopen_persists_across_connections() {
        let td = TestDir::new("reopen");
        let id = {
            let mut store = FightStore::open(td.db_path()).unwrap();
            store.insert(&summary("Gynok Moltor", 5_000)).unwrap()
        };
        let store = FightStore::open(td.db_path()).unwrap();
        assert_eq!(store.count().unwrap(), 1);
        let back = store.get(id).unwrap().unwrap();
        assert_eq!(back.summary.target, "Gynok Moltor");
    }

    #[test]
    fn delete_removes_row() {
        let mut store = FightStore::open_in_memory().unwrap();
        let id = store.insert(&summary("x", 1)).unwrap();
        assert!(store.delete(id).unwrap());
        assert!(!store.delete(id).unwrap());
        assert_eq!(store.count().unwrap(), 0);
    }

    #[test]
    fn prune_before_removes_only_older_fights() {
        let mut store = FightStore::open_in_memory().unwrap();
        for (i, target) in ["old1", "old2", "keep1", "keep2"].iter().enumerate() {
            store
                .insert(&summary(target, 1_000 + i as i64 * 100))
                .unwrap();
        }
        // start_ts: old1=1000 old2=1100 keep1=1200 keep2=1300.
        let removed = store.prune_before(1_200).unwrap();
        assert_eq!(removed, 2);
        let names: Vec<String> = store
            .list(10, 0)
            .unwrap()
            .into_iter()
            .map(|f| f.summary.target)
            .collect();
        assert_eq!(names, ["keep2", "keep1"]);
    }

    #[test]
    fn prune_keep_last_keeps_the_newest_n() {
        let mut store = FightStore::open_in_memory().unwrap();
        for (i, target) in ["a", "b", "c", "d", "e"].iter().enumerate() {
            store
                .insert(&summary(target, 1_000 + i as i64 * 60))
                .unwrap();
        }
        let removed = store.prune_keep_last(2).unwrap();
        assert_eq!(removed, 3);
        let names: Vec<String> = store
            .list(10, 0)
            .unwrap()
            .into_iter()
            .map(|f| f.summary.target)
            .collect();
        assert_eq!(names, ["e", "d"]);
        // keep_last_n greater than the row count is a no-op.
        assert_eq!(store.prune_keep_last(10).unwrap(), 0);
        // keep_last_n == 0 clears the table.
        assert_eq!(store.prune_keep_last(0).unwrap(), 2);
        assert_eq!(store.count().unwrap(), 0);
    }

    #[test]
    fn future_schema_version_is_a_hard_error() {
        let td = TestDir::new("future");
        {
            let _ = FightStore::open(td.db_path()).unwrap();
        }
        {
            let conn = Connection::open(td.db_path()).unwrap();
            conn.pragma_update(None, "user_version", schema::SCHEMA_VERSION + 1)
                .unwrap();
        }
        let err = FightStore::open(td.db_path())
            .err()
            .expect("opening a future-versioned store must fail");
        match err {
            StoreError::FutureSchema { found, supported } => {
                assert_eq!(found, schema::SCHEMA_VERSION + 1);
                assert_eq!(supported, schema::SCHEMA_VERSION);
            }
            other => panic!("expected FutureSchema error, got {other:?}"),
        }
    }

    #[test]
    fn pre_misses_casts_summary_json_still_loads() {
        // A fight persisted before the misses/casts source fields existed:
        // the blob omits them entirely. They must default to 0, not error.
        let store = FightStore::open_in_memory().unwrap();
        let json = r#"{
            "target":"a gnoll pup","start_ts":1,"end_ts":31,"duration_secs":30,
            "total_damage":100,"target_slain":true,
            "rows":[{"name":"Nyasha","damage":100,"pet_damage":0,"hits":2,
              "misses":0,"crits":0,"max_hit":60,"damage_taken":0,"healing":0,
              "overheal":0,"dps":3.3,"percent":100.0,
              "sources":[{"name":"crush","total":100,"hits":2,"crits":0,"max_hit":60}]}]
        }"#;
        store
            .conn
            .execute(
                "INSERT INTO fights (target, start_ts, end_ts, duration_secs, \
                 total_damage, target_slain, summary_json) \
                 VALUES ('a gnoll pup', 1, 31, 30, 100, 1, ?1)",
                [json],
            )
            .unwrap();
        let id = store.conn.last_insert_rowid();
        let back = store.get(id).unwrap().unwrap();
        let src = &back.summary.rows[0].sources[0];
        assert_eq!(src.misses, 0);
        assert_eq!(src.casts, 0);
    }

    #[test]
    fn corrupt_json_reports_row_id() {
        let mut store = FightStore::open_in_memory().unwrap();
        let id = store.insert(&summary("x", 1)).unwrap();
        store
            .conn
            .execute(
                "UPDATE fights SET summary_json = 'not json' WHERE id = ?1",
                [id],
            )
            .unwrap();
        match store.get(id) {
            Err(StoreError::Corrupt { id: bad, .. }) => assert_eq!(bad, id),
            other => panic!("expected Corrupt error, got {other:?}"),
        }
    }
}
