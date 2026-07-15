//! Shared schema versioning for the ONE store database.
//!
//! `fights` (v1), career tables (v2, docs/career-db-design.md section 1), and
//! inventory snapshots (v3) live in the same SQLite file. Every store calls
//! [`migrate`] on open, so whichever opens the file first brings it fully up
//! to date.

use rusqlite::Connection;

use crate::StoreError;

/// Schema version written to `PRAGMA user_version`. Bump when the schema
/// changes and add a migration step in [`migrate`].
pub(crate) const SCHEMA_VERSION: i64 = 3;

/// Bring the schema up to [`SCHEMA_VERSION`]. Version 0 = fresh database.
/// Opening a newer database than this crate understands is a hard error
/// (never silently rewrite a future schema); older versions are migrated in
/// place, one `if found < N` step per version, in order.
pub(crate) fn migrate(conn: &Connection) -> Result<(), StoreError> {
    let found: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if found > SCHEMA_VERSION {
        return Err(StoreError::FutureSchema {
            found,
            supported: SCHEMA_VERSION,
        });
    }
    if found < 1 {
        conn.execute_batch(
            "BEGIN;
             CREATE TABLE IF NOT EXISTS fights (
                 id            INTEGER PRIMARY KEY,
                 target        TEXT    NOT NULL,
                 start_ts      INTEGER NOT NULL,
                 end_ts        INTEGER NOT NULL,
                 duration_secs INTEGER NOT NULL,
                 total_damage  INTEGER NOT NULL,
                 target_slain  INTEGER NOT NULL,
                 summary_json  TEXT    NOT NULL
             );
             CREATE INDEX IF NOT EXISTS fights_start_ts ON fights (start_ts DESC, id DESC);
             COMMIT;",
        )?;
    }
    if found < 2 {
        // Career tables (docs/career-db-design.md §1). All `ts` columns are
        // LOG-DOMAIN epoch seconds (the log's naive-local time interpreted as
        // UTC — the fights.start_ts convention). character/server hold
        // canonical case; matching is COLLATE NOCASE, never lowercased data.
        conn.execute_batch(
            "BEGIN;
             CREATE TABLE IF NOT EXISTS sessions (
                 id               INTEGER PRIMARY KEY,
                 character        TEXT    NOT NULL,
                 server           TEXT    NOT NULL,
                 start_ts         INTEGER NOT NULL,
                 end_ts           INTEGER NOT NULL,
                 duration_secs    INTEGER NOT NULL,
                 zones_json       TEXT    NOT NULL,
                 kills            INTEGER NOT NULL,
                 deaths           INTEGER NOT NULL,
                 xp_percent       REAL    NOT NULL,
                 party_xp_percent REAL    NOT NULL,
                 level_ups        INTEGER NOT NULL,
                 end_level        INTEGER,
                 aa_points        INTEGER NOT NULL,
                 coin_copper      INTEGER NOT NULL,
                 coin_json        TEXT    NOT NULL,
                 skill_ups        INTEGER NOT NULL,
                 loot_count       INTEGER NOT NULL,
                 source_file      TEXT    NOT NULL
             );
             CREATE INDEX IF NOT EXISTS sessions_char_start
                 ON sessions (character COLLATE NOCASE, server COLLATE NOCASE,
                              start_ts DESC);

             CREATE TABLE IF NOT EXISTS level_ups (
                 id         INTEGER PRIMARY KEY,
                 character  TEXT    NOT NULL,
                 server     TEXT    NOT NULL,
                 ts         INTEGER NOT NULL,
                 level      INTEGER NOT NULL,
                 session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL
             );
             CREATE INDEX IF NOT EXISTS level_ups_char_ts
                 ON level_ups (character COLLATE NOCASE, server COLLATE NOCASE,
                               ts ASC);

             CREATE TABLE IF NOT EXISTS loot (
                 id              INTEGER PRIMARY KEY,
                 character       TEXT    NOT NULL,
                 server          TEXT    NOT NULL,
                 ts              INTEGER NOT NULL,
                 item            TEXT    NOT NULL,
                 quantity        INTEGER NOT NULL,
                 corpse          TEXT,
                 looter          TEXT    NOT NULL,
                 sold_for_copper INTEGER,
                 session_id      INTEGER REFERENCES sessions(id) ON DELETE SET NULL
             );
             CREATE INDEX IF NOT EXISTS loot_char_ts
                 ON loot (character COLLATE NOCASE, server COLLATE NOCASE, ts DESC);
             CREATE INDEX IF NOT EXISTS loot_char_item
                 ON loot (character COLLATE NOCASE, server COLLATE NOCASE,
                          item COLLATE NOCASE);

             CREATE TABLE IF NOT EXISTS session_mob_kills (
                 session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                 character  TEXT    NOT NULL,
                 server     TEXT    NOT NULL,
                 mob        TEXT    NOT NULL,
                 kills      INTEGER NOT NULL,
                 PRIMARY KEY (session_id, mob)
             );
             CREATE INDEX IF NOT EXISTS smk_char_mob
                 ON session_mob_kills (character COLLATE NOCASE,
                                       server COLLATE NOCASE, mob COLLATE NOCASE);

             CREATE TABLE IF NOT EXISTS import_files (
                 id              INTEGER PRIMARY KEY,
                 character       TEXT    NOT NULL,
                 server          TEXT    NOT NULL,
                 path            TEXT    NOT NULL,
                 prefix_sha256   TEXT    NOT NULL,
                 prefix_len      INTEGER NOT NULL,
                 byte_offset     INTEGER NOT NULL,
                 line_count      INTEGER NOT NULL,
                 last_ts         INTEGER NOT NULL,
                 last_session_id INTEGER,
                 imported_at     INTEGER NOT NULL,
                 UNIQUE (character, server, path)
             );

             CREATE TABLE IF NOT EXISTS career_watermarks (
                 character TEXT NOT NULL,
                 server    TEXT NOT NULL,
                 max_ts    INTEGER NOT NULL,
                 PRIMARY KEY (character, server)
             );
             COMMIT;",
        )?;
    }
    if found < 3 {
        conn.execute_batch(
            "BEGIN;
             CREATE TABLE IF NOT EXISTS inventory_snapshots (
                 id                 INTEGER PRIMARY KEY,
                 character          TEXT NOT NULL,
                 server             TEXT NOT NULL,
                 source_path        TEXT NOT NULL,
                 source_modified_ms INTEGER NOT NULL,
                 imported_at_ms     INTEGER NOT NULL,
                 fingerprint        TEXT NOT NULL,
                 row_count          INTEGER NOT NULL,
                 skipped_rows       INTEGER NOT NULL,
                 sections_json      TEXT NOT NULL,
                 UNIQUE(character, server, fingerprint)
             );
             CREATE INDEX IF NOT EXISTS inventory_snapshots_current
                 ON inventory_snapshots(character COLLATE NOCASE,
                                        server COLLATE NOCASE,
                                        imported_at_ms DESC, id DESC);

             CREATE TABLE IF NOT EXISTS inventory_entries (
                 snapshot_id    INTEGER NOT NULL REFERENCES inventory_snapshots(id)
                                    ON DELETE CASCADE,
                 ordinal        INTEGER NOT NULL,
                 location       TEXT NOT NULL,
                 storage        TEXT NOT NULL,
                 item_id        INTEGER,
                 name           TEXT NOT NULL,
                 normalized_name TEXT NOT NULL,
                 quantity       INTEGER NOT NULL,
                 slots          INTEGER NOT NULL,
                 keyring        INTEGER NOT NULL,
                 exaltation     INTEGER NOT NULL,
                 PRIMARY KEY(snapshot_id, ordinal)
             );
             CREATE INDEX IF NOT EXISTS inventory_entries_item
                 ON inventory_entries(snapshot_id, item_id, normalized_name);
             CREATE INDEX IF NOT EXISTS inventory_entries_storage
                 ON inventory_entries(snapshot_id, storage, location);

             CREATE TABLE IF NOT EXISTS inventory_currencies (
                 character     TEXT NOT NULL,
                 server        TEXT NOT NULL,
                 name          TEXT NOT NULL,
                 quantity      INTEGER NOT NULL,
                 updated_at_ms INTEGER NOT NULL,
                 PRIMARY KEY(character, server, name)
             );
             CREATE TABLE IF NOT EXISTS inventory_keeps (
                 character  TEXT NOT NULL,
                 server     TEXT NOT NULL,
                 item_key   TEXT NOT NULL,
                 keep       INTEGER NOT NULL,
                 PRIMARY KEY(character, server, item_key)
             );
             CREATE TABLE IF NOT EXISTS quest_progress (
                 character   TEXT NOT NULL,
                 server      TEXT NOT NULL,
                 quest_id    TEXT NOT NULL,
                 status      TEXT NOT NULL,
                 updated_at_ms INTEGER NOT NULL,
                 PRIMARY KEY(character, server, quest_id)
             );
             COMMIT;",
        )?;
    }
    conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    Ok(())
}
