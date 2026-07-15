//! Durable `/outputfile inventory` snapshots and player-authored inventory
//! metadata. Raw slot rows are retained; callers derive grouped views.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::{schema, StoreError};

#[derive(Debug, Clone)]
pub struct InventoryEntryInput {
    pub ordinal: i64,
    pub location: String,
    pub storage: String,
    pub item_id: Option<i64>,
    pub name: String,
    pub normalized_name: String,
    pub quantity: i64,
    pub slots: i64,
    pub keyring: bool,
    pub exaltation: bool,
}

#[derive(Debug, Clone)]
pub struct InventoryStorageSlotInput {
    pub ordinal: i64,
    pub location: String,
    pub storage: String,
    pub empty: bool,
}

#[derive(Debug, Clone)]
pub struct InventorySnapshotInput {
    pub character: String,
    pub server: String,
    pub source_path: String,
    pub source_modified_ms: u64,
    pub imported_at_ms: u64,
    pub fingerprint: String,
    pub row_count: usize,
    pub skipped_rows: usize,
    pub sections: Vec<String>,
    pub entries: Vec<InventoryEntryInput>,
    pub storage_slots: Vec<InventoryStorageSlotInput>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventorySnapshotMeta {
    pub id: i64,
    pub source_path: String,
    pub source_modified_ms: u64,
    pub imported_at_ms: u64,
    pub fingerprint: String,
    pub row_count: usize,
    pub skipped_rows: usize,
    pub sections: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryEntryRow {
    pub ordinal: i64,
    pub location: String,
    pub storage: String,
    pub item_id: Option<i64>,
    pub name: String,
    pub normalized_name: String,
    pub quantity: i64,
    pub slots: i64,
    pub keyring: bool,
    pub exaltation: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryStorageSlotRow {
    pub ordinal: i64,
    pub location: String,
    pub storage: String,
    pub empty: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryCurrency {
    pub name: String,
    pub quantity: i64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryCurrencyMeasurement {
    pub id: i64,
    pub name: String,
    pub quantity: i64,
    pub measured_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryDisposition {
    pub item_key: String,
    pub action: String,
    pub note: String,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestProgressRow {
    pub quest_id: String,
    pub status: String,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryDatabase {
    pub current: Option<InventorySnapshotMeta>,
    pub entries: Vec<InventoryEntryRow>,
    pub previous_entries: Vec<InventoryEntryRow>,
    pub storage_slots: Vec<InventoryStorageSlotRow>,
    pub history: Vec<InventorySnapshotMeta>,
    pub currencies: Vec<InventoryCurrency>,
    pub currency_history: Vec<InventoryCurrencyMeasurement>,
    pub keep_keys: Vec<String>,
    pub dispositions: Vec<InventoryDisposition>,
    pub quest_progress: Vec<QuestProgressRow>,
}

pub struct InventoryStore {
    conn: Connection,
}

impl InventoryStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let path = path.as_ref();
        if let Some(parent) = path.parent().filter(|value| !value.as_os_str().is_empty()) {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(path)?;
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        let _ = conn.pragma_update(None, "synchronous", "NORMAL");
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        schema::migrate(&conn)?;
        Ok(Self { conn })
    }

    pub fn open_in_memory() -> Result<Self, StoreError> {
        let conn = Connection::open_in_memory()?;
        schema::migrate(&conn)?;
        Ok(Self { conn })
    }

    pub fn import_snapshot(&mut self, input: &InventorySnapshotInput) -> Result<i64, StoreError> {
        if let Some(id) = self
            .conn
            .query_row(
                "SELECT id FROM inventory_snapshots
                 WHERE character = ?1 COLLATE NOCASE AND server = ?2 COLLATE NOCASE
                   AND fingerprint = ?3",
                params![input.character, input.server, input.fingerprint],
                |row| row.get(0),
            )
            .optional()?
        {
            let slot_count: i64 = self.conn.query_row(
                "SELECT COUNT(*) FROM inventory_storage_slots WHERE snapshot_id = ?1",
                params![id],
                |row| row.get(0),
            )?;
            if slot_count == 0 && !input.storage_slots.is_empty() {
                let tx = self.conn.transaction()?;
                {
                    let mut stmt = tx.prepare(
                        "INSERT INTO inventory_storage_slots
                         (snapshot_id, ordinal, location, storage, empty)
                         VALUES (?1, ?2, ?3, ?4, ?5)",
                    )?;
                    for slot in &input.storage_slots {
                        stmt.execute(params![
                            id,
                            slot.ordinal,
                            slot.location,
                            slot.storage,
                            slot.empty as i64,
                        ])?;
                    }
                }
                tx.commit()?;
            }
            return Ok(id);
        }
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO inventory_snapshots
             (character, server, source_path, source_modified_ms, imported_at_ms,
              fingerprint, row_count, skipped_rows, sections_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                input.character,
                input.server,
                input.source_path,
                input.source_modified_ms as i64,
                input.imported_at_ms as i64,
                input.fingerprint,
                input.row_count as i64,
                input.skipped_rows as i64,
                serde_json::to_string(&input.sections).unwrap_or_else(|_| "[]".into()),
            ],
        )?;
        let snapshot_id = tx.last_insert_rowid();
        {
            let mut stmt = tx.prepare(
                "INSERT INTO inventory_entries
                 (snapshot_id, ordinal, location, storage, item_id, name,
                  normalized_name, quantity, slots, keyring, exaltation)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            )?;
            for entry in &input.entries {
                stmt.execute(params![
                    snapshot_id,
                    entry.ordinal,
                    entry.location,
                    entry.storage,
                    entry.item_id,
                    entry.name,
                    entry.normalized_name,
                    entry.quantity,
                    entry.slots,
                    entry.keyring as i64,
                    entry.exaltation as i64,
                ])?;
            }
        }
        {
            let mut stmt = tx.prepare(
                "INSERT INTO inventory_storage_slots
                 (snapshot_id, ordinal, location, storage, empty)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )?;
            for slot in &input.storage_slots {
                stmt.execute(params![
                    snapshot_id,
                    slot.ordinal,
                    slot.location,
                    slot.storage,
                    slot.empty as i64,
                ])?;
            }
        }
        tx.commit()?;
        Ok(snapshot_id)
    }

    fn snapshot_meta(&self, id: i64) -> Result<InventorySnapshotMeta, StoreError> {
        Ok(self.conn.query_row(
            "SELECT id, source_path, source_modified_ms, imported_at_ms,
                    fingerprint, row_count, skipped_rows, sections_json
             FROM inventory_snapshots WHERE id = ?1",
            params![id],
            |row| {
                let sections_json: String = row.get(7)?;
                Ok(InventorySnapshotMeta {
                    id: row.get(0)?,
                    source_path: row.get(1)?,
                    source_modified_ms: row.get::<_, i64>(2)?.max(0) as u64,
                    imported_at_ms: row.get::<_, i64>(3)?.max(0) as u64,
                    fingerprint: row.get(4)?,
                    row_count: row.get::<_, i64>(5)?.max(0) as usize,
                    skipped_rows: row.get::<_, i64>(6)?.max(0) as usize,
                    sections: serde_json::from_str(&sections_json).unwrap_or_default(),
                })
            },
        )?)
    }

    pub fn database(&self, character: &str, server: &str) -> Result<InventoryDatabase, StoreError> {
        let current_id: Option<i64> = self
            .conn
            .query_row(
                "SELECT id FROM inventory_snapshots
                 WHERE character = ?1 COLLATE NOCASE AND server = ?2 COLLATE NOCASE
                 ORDER BY imported_at_ms DESC, id DESC LIMIT 1",
                params![character, server],
                |row| row.get(0),
            )
            .optional()?;
        let current = current_id.map(|id| self.snapshot_meta(id)).transpose()?;
        let load_entries = |id: i64| -> Result<Vec<InventoryEntryRow>, StoreError> {
            let mut stmt = self.conn.prepare(
                "SELECT ordinal, location, storage, item_id, name, normalized_name,
                        quantity, slots, keyring, exaltation
                 FROM inventory_entries WHERE snapshot_id = ?1 ORDER BY ordinal",
            )?;
            let rows = stmt.query_map(params![id], |row| {
                Ok(InventoryEntryRow {
                    ordinal: row.get(0)?,
                    location: row.get(1)?,
                    storage: row.get(2)?,
                    item_id: row.get(3)?,
                    name: row.get(4)?,
                    normalized_name: row.get(5)?,
                    quantity: row.get(6)?,
                    slots: row.get(7)?,
                    keyring: row.get::<_, i64>(8)? != 0,
                    exaltation: row.get::<_, i64>(9)? != 0,
                })
            })?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        };
        let entries = if let Some(id) = current_id {
            load_entries(id)?
        } else {
            Vec::new()
        };
        let storage_slots = if let Some(id) = current_id {
            let mut stmt = self.conn.prepare(
                "SELECT ordinal, location, storage, empty
                 FROM inventory_storage_slots WHERE snapshot_id = ?1 ORDER BY ordinal",
            )?;
            let rows = stmt.query_map(params![id], |row| {
                Ok(InventoryStorageSlotRow {
                    ordinal: row.get(0)?,
                    location: row.get(1)?,
                    storage: row.get(2)?,
                    empty: row.get::<_, i64>(3)? != 0,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        } else {
            Vec::new()
        };
        let history_ids = {
            let mut stmt = self.conn.prepare(
                "SELECT id FROM inventory_snapshots
                 WHERE character = ?1 COLLATE NOCASE AND server = ?2 COLLATE NOCASE
                 ORDER BY imported_at_ms DESC, id DESC LIMIT 20",
            )?;
            let rows = stmt.query_map(params![character, server], |row| row.get(0))?;
            rows.collect::<Result<Vec<i64>, _>>()?
        };
        let history = history_ids
            .iter()
            .copied()
            .map(|id| self.snapshot_meta(id))
            .collect::<Result<Vec<_>, _>>()?;
        let previous_entries = history_ids
            .get(1)
            .copied()
            .map(load_entries)
            .transpose()?
            .unwrap_or_default();
        let currencies = {
            let mut stmt = self.conn.prepare(
                "SELECT name, quantity, updated_at_ms FROM inventory_currencies
                 WHERE character = ?1 COLLATE NOCASE AND server = ?2 COLLATE NOCASE
                 ORDER BY name COLLATE NOCASE",
            )?;
            let rows = stmt.query_map(params![character, server], |row| {
                Ok(InventoryCurrency {
                    name: row.get(0)?,
                    quantity: row.get(1)?,
                    updated_at_ms: row.get::<_, i64>(2)?.max(0) as u64,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let currency_history = {
            let mut stmt = self.conn.prepare(
                "SELECT id, name, quantity, measured_at_ms
                 FROM inventory_currency_history
                 WHERE character = ?1 COLLATE NOCASE AND server = ?2 COLLATE NOCASE
                 ORDER BY measured_at_ms DESC, id DESC LIMIT 250",
            )?;
            let rows = stmt.query_map(params![character, server], |row| {
                Ok(InventoryCurrencyMeasurement {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    quantity: row.get(2)?,
                    measured_at_ms: row.get::<_, i64>(3)?.max(0) as u64,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let keep_keys = {
            let mut stmt = self.conn.prepare(
                "SELECT item_key FROM inventory_keeps
                 WHERE character = ?1 COLLATE NOCASE AND server = ?2 COLLATE NOCASE AND keep != 0
                 ORDER BY item_key",
            )?;
            let rows = stmt.query_map(params![character, server], |row| row.get(0))?;
            rows.collect::<Result<Vec<String>, _>>()?
        };
        let dispositions = {
            let mut stmt = self.conn.prepare(
                "SELECT item_key, action, note, updated_at_ms FROM inventory_dispositions
                 WHERE character = ?1 COLLATE NOCASE AND server = ?2 COLLATE NOCASE
                 ORDER BY action, item_key",
            )?;
            let rows = stmt.query_map(params![character, server], |row| {
                Ok(InventoryDisposition {
                    item_key: row.get(0)?,
                    action: row.get(1)?,
                    note: row.get(2)?,
                    updated_at_ms: row.get::<_, i64>(3)?.max(0) as u64,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let quest_progress = {
            let mut stmt = self.conn.prepare(
                "SELECT quest_id, status, updated_at_ms FROM quest_progress
                 WHERE character = ?1 COLLATE NOCASE AND server = ?2 COLLATE NOCASE
                 ORDER BY quest_id",
            )?;
            let rows = stmt.query_map(params![character, server], |row| {
                Ok(QuestProgressRow {
                    quest_id: row.get(0)?,
                    status: row.get(1)?,
                    updated_at_ms: row.get::<_, i64>(2)?.max(0) as u64,
                })
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        Ok(InventoryDatabase {
            current,
            entries,
            previous_entries,
            storage_slots,
            history,
            currencies,
            currency_history,
            keep_keys,
            dispositions,
            quest_progress,
        })
    }

    pub fn set_currency(
        &mut self,
        character: &str,
        server: &str,
        name: &str,
        quantity: i64,
        updated_at_ms: u64,
    ) -> Result<(), StoreError> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO inventory_currencies(character, server, name, quantity, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(character, server, name) DO UPDATE SET
                 quantity = excluded.quantity, updated_at_ms = excluded.updated_at_ms",
            params![
                character,
                server,
                name,
                quantity.max(0),
                updated_at_ms as i64
            ],
        )?;
        tx.execute(
            "INSERT INTO inventory_currency_history
             (character, server, name, quantity, measured_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                character,
                server,
                name,
                quantity.max(0),
                updated_at_ms as i64
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn set_disposition(
        &self,
        character: &str,
        server: &str,
        item_key: &str,
        action: &str,
        note: &str,
        updated_at_ms: u64,
    ) -> Result<(), StoreError> {
        if action.is_empty() {
            self.conn.execute(
                "DELETE FROM inventory_dispositions
                 WHERE character = ?1 COLLATE NOCASE AND server = ?2 COLLATE NOCASE
                   AND item_key = ?3",
                params![character, server, item_key],
            )?;
        } else {
            self.conn.execute(
                "INSERT INTO inventory_dispositions
                 (character, server, item_key, action, note, updated_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(character, server, item_key) DO UPDATE SET
                   action = excluded.action, note = excluded.note,
                   updated_at_ms = excluded.updated_at_ms",
                params![
                    character,
                    server,
                    item_key,
                    action,
                    note,
                    updated_at_ms as i64
                ],
            )?;
        }
        Ok(())
    }

    pub fn remove_currency(
        &self,
        character: &str,
        server: &str,
        name: &str,
    ) -> Result<(), StoreError> {
        self.conn.execute(
            "DELETE FROM inventory_currencies
             WHERE character = ?1 COLLATE NOCASE AND server = ?2 COLLATE NOCASE
               AND name = ?3 COLLATE NOCASE",
            params![character, server, name],
        )?;
        Ok(())
    }

    pub fn set_keep(
        &self,
        character: &str,
        server: &str,
        item_key: &str,
        keep: bool,
    ) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO inventory_keeps(character, server, item_key, keep)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(character, server, item_key) DO UPDATE SET keep = excluded.keep",
            params![character, server, item_key, keep as i64],
        )?;
        Ok(())
    }

    pub fn set_quest_status(
        &self,
        character: &str,
        server: &str,
        quest_id: &str,
        status: &str,
        updated_at_ms: u64,
    ) -> Result<(), StoreError> {
        if status == "unknown" {
            self.conn.execute(
                "DELETE FROM quest_progress
                 WHERE character = ?1 COLLATE NOCASE AND server = ?2 COLLATE NOCASE AND quest_id = ?3",
                params![character, server, quest_id],
            )?;
        } else {
            self.conn.execute(
                "INSERT INTO quest_progress(character, server, quest_id, status, updated_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(character, server, quest_id) DO UPDATE SET
                   status = excluded.status, updated_at_ms = excluded.updated_at_ms",
                params![character, server, quest_id, status, updated_at_ms as i64],
            )?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(fingerprint: &str, imported_at_ms: u64, name: &str) -> InventorySnapshotInput {
        InventorySnapshotInput {
            character: "Nyasha".into(),
            server: "oggok".into(),
            source_path: "Nyasha_oggok-Inventory.txt".into(),
            source_modified_ms: imported_at_ms,
            imported_at_ms,
            fingerprint: fingerprint.into(),
            row_count: 1,
            skipped_rows: 0,
            sections: vec!["carried".into()],
            entries: vec![InventoryEntryInput {
                ordinal: 0,
                location: "General1".into(),
                storage: "carried".into(),
                item_id: Some(42),
                name: name.into(),
                normalized_name: name.to_lowercase(),
                quantity: 1,
                slots: 10,
                keyring: false,
                exaltation: false,
            }],
            storage_slots: vec![InventoryStorageSlotInput {
                ordinal: 0,
                location: "General1".into(),
                storage: "carried".into(),
                empty: false,
            }],
        }
    }

    #[test]
    fn snapshots_are_idempotent_and_keep_previous_rows() {
        let mut store = InventoryStore::open_in_memory().unwrap();
        let first = store
            .import_snapshot(&snapshot("first", 100, "Old item"))
            .unwrap();
        assert_eq!(
            store
                .import_snapshot(&snapshot("first", 101, "Old item"))
                .unwrap(),
            first
        );
        store
            .import_snapshot(&snapshot("second", 200, "New item"))
            .unwrap();

        let database = store.database("nyasha", "OGGOK").unwrap();
        assert_eq!(database.history.len(), 2);
        assert_eq!(database.entries[0].name, "New item");
        assert_eq!(database.previous_entries[0].name, "Old item");
    }

    #[test]
    fn identical_snapshot_backfills_storage_slots_after_schema_upgrade() {
        let mut store = InventoryStore::open_in_memory().unwrap();
        let mut legacy = snapshot("same", 100, "Old item");
        legacy.storage_slots.clear();
        let first = store.import_snapshot(&legacy).unwrap();

        let refreshed = snapshot("same", 100, "Old item");
        assert_eq!(store.import_snapshot(&refreshed).unwrap(), first);

        let database = store.database("Nyasha", "oggok").unwrap();
        assert_eq!(database.history.len(), 1);
        assert_eq!(database.storage_slots.len(), 1);
        assert_eq!(database.storage_slots[0].location, "General1");
    }

    #[test]
    fn stores_character_metadata_separately_from_snapshots() {
        let mut store = InventoryStore::open_in_memory().unwrap();
        store
            .set_currency("Nyasha", "oggok", "Motes of Potential", 2, 123)
            .unwrap();
        store.set_keep("Nyasha", "oggok", "id:42", true).unwrap();
        store
            .set_quest_status("Nyasha", "oggok", "sky-test", "completed", 124)
            .unwrap();
        store
            .set_disposition("Nyasha", "oggok", "id:42", "move", "to bank", 125)
            .unwrap();

        let database = store.database("Nyasha", "oggok").unwrap();
        assert_eq!(database.currencies[0].quantity, 2);
        assert_eq!(database.currency_history[0].quantity, 2);
        assert_eq!(database.keep_keys, vec!["id:42"]);
        assert_eq!(database.dispositions[0].action, "move");
        assert_eq!(database.quest_progress[0].status, "completed");
    }
}
