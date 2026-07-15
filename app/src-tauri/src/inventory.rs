//! Import static `/outputfile inventory` TSV snapshots for quest matching.

use eqlog_store::inventory::{
    InventoryDatabase, InventoryEntryInput, InventorySnapshotInput, InventoryStorageSlotInput,
    InventoryStore,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InventoryItem {
    pub item_id: Option<i64>,
    pub name: String,
    pub names: Vec<String>,
    pub quantity: i64,
    pub locations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InventorySnapshot {
    pub source_path: String,
    pub source_modified_ms: u64,
    pub imported_at_ms: u64,
    pub row_count: usize,
    pub skipped_rows: usize,
    pub items: Vec<InventoryItem>,
}

#[derive(Default)]
struct Aggregate {
    item_id: Option<i64>,
    name: String,
    names: BTreeSet<String>,
    quantity: i64,
    locations: BTreeSet<String>,
}

struct ParsedInventory {
    snapshot: InventorySnapshot,
    entries: Vec<InventoryEntryInput>,
    sections: Vec<String>,
    fingerprint: String,
    storage_slots: Vec<InventoryStorageSlotInput>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn normalize(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .chars()
        .map(|character| {
            if character.is_alphanumeric() {
                character
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalize_item_name(value: &str) -> String {
    let without_rank = regex::Regex::new(r"(?i)\s+\+\d+\s*$")
        .expect("valid rank regex")
        .replace(value.trim(), "");
    let without_variant = regex::Regex::new(r"(?i)\s+\([^()]+\)\s*$")
        .expect("valid variant regex")
        .replace(&without_rank, "");
    normalize(&without_variant)
}

fn storage_for(location: &str, keyring: bool) -> String {
    if keyring {
        return format!("keyring-{}", normalize(location).replace(' ', "-"));
    }
    let lower = location.to_ascii_lowercase();
    if lower.starts_with("sharedbank") {
        "shared-bank"
    } else if lower.starts_with("bank") {
        "bank"
    } else if lower.starts_with("hoard") {
        "hoard"
    } else if lower.starts_with("personal-depot") {
        "personal-depot"
    } else if lower.starts_with("general") || lower.starts_with("cursor") {
        "carried"
    } else {
        "equipped"
    }
    .into()
}

fn parse_tsv(text: &str, source_path: String, modified_ms: u64) -> Result<ParsedInventory, String> {
    let mut lines = text.lines();
    let header = lines.next().ok_or("inventory export is empty")?;
    let columns: Vec<String> = header
        .trim_start_matches('\u{feff}')
        .split('\t')
        .map(normalize)
        .collect();
    let column = |columns: &[String], name: &str| {
        columns
            .iter()
            .position(|value| value == name)
            .ok_or_else(|| format!("inventory export is missing the {name:?} column"))
    };
    let mut location_col = column(&columns, "location")?;
    let mut name_col = column(&columns, "name")?;
    let mut id_col = column(&columns, "id")?;
    let mut count_col = Some(column(&columns, "count")?);

    let mut grouped: BTreeMap<String, Aggregate> = BTreeMap::new();
    let mut entries = Vec::new();
    let mut sections = BTreeSet::new();
    let mut storage_slots = Vec::new();
    let mut keyring = false;
    let mut row_count = 0usize;
    let mut skipped_rows = 0usize;
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.trim_end_matches('\r').split('\t').collect();
        let normalized_fields: Vec<String> = fields.iter().map(|field| normalize(field)).collect();
        if let (Some(next_name), Some(next_id)) = (
            normalized_fields.iter().position(|value| value == "name"),
            normalized_fields.iter().position(|value| value == "id"),
        ) {
            // Legends appends key-ring/equipment sections with an implicit quantity of one.
            location_col = 0;
            name_col = next_name;
            id_col = next_id;
            count_col = normalized_fields.iter().position(|value| value == "count");
            keyring = normalized_fields
                .first()
                .is_some_and(|value| value == "keyring");
            continue;
        }
        row_count += 1;
        let max_col = [Some(location_col), Some(name_col), Some(id_col), count_col]
            .into_iter()
            .flatten()
            .max()
            .unwrap_or(0);
        if fields.len() <= max_col {
            skipped_rows += 1;
            continue;
        }
        let location = fields[location_col].trim();
        let storage = storage_for(location, keyring);
        if !location.is_empty() {
            sections.insert(storage.clone());
        }
        let name = fields[name_col].trim();
        if !location.is_empty() {
            storage_slots.push(InventoryStorageSlotInput {
                ordinal: (row_count - 1) as i64,
                location: location.to_string(),
                storage: storage.clone(),
                empty: name.is_empty() || name.eq_ignore_ascii_case("empty"),
            });
        }
        let count = match count_col {
            None => 1,
            Some(index) => match fields[index].trim().parse::<i64>() {
                Ok(value) if value > 0 => value,
                _ => {
                    skipped_rows += 1;
                    continue;
                }
            },
        };
        let item_id = fields[id_col]
            .trim()
            .parse::<i64>()
            .ok()
            .filter(|value| *value > 0);
        if name.is_empty() || name.eq_ignore_ascii_case("empty") {
            skipped_rows += 1;
            continue;
        }
        let key = item_id
            .map(|value| format!("id:{value}"))
            .unwrap_or_else(|| format!("name:{}", normalize(name)));
        let entry = grouped.entry(key).or_default();
        entry.item_id = entry.item_id.or(item_id);
        if entry.name.is_empty() {
            entry.name = name.to_string();
        }
        entry.names.insert(name.to_string());
        entry.quantity += count;
        if !location.is_empty() {
            entry.locations.insert(location.to_string());
        }
        entries.push(InventoryEntryInput {
            ordinal: entries.len() as i64,
            location: location.to_string(),
            storage,
            item_id,
            name: name.to_string(),
            normalized_name: normalize_item_name(name),
            quantity: count,
            slots: columns
                .iter()
                .position(|value| value == "slots")
                .and_then(|index| fields.get(index))
                .and_then(|value| value.trim().parse::<i64>().ok())
                .unwrap_or(0),
            keyring,
            exaltation: name.to_ascii_lowercase().contains("(exaltation)"),
        });
    }
    let items = grouped
        .into_values()
        .map(|entry| InventoryItem {
            item_id: entry.item_id,
            name: entry.name,
            names: entry.names.into_iter().collect(),
            quantity: entry.quantity,
            locations: entry.locations.into_iter().collect(),
        })
        .collect();
    let imported_at_ms = now_ms();
    Ok(ParsedInventory {
        snapshot: InventorySnapshot {
            source_path,
            source_modified_ms: modified_ms,
            imported_at_ms,
            row_count,
            skipped_rows,
            items,
        },
        entries,
        sections: sections.into_iter().collect(),
        fingerprint: String::new(),
        storage_slots,
    })
}

fn import_path(path: &Path) -> Result<ParsedInventory, String> {
    let bytes = fs::read(path).map_err(|error| format!("read inventory export: {error}"))?;
    let text = String::from_utf8_lossy(&bytes);
    let modified_ms = fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0);
    let mut parsed = parse_tsv(&text, path.display().to_string(), modified_ms)?;
    parsed.fingerprint = format!("{:x}", Sha256::digest(&bytes));
    Ok(parsed)
}

fn store(app: &AppHandle) -> Result<InventoryStore, String> {
    InventoryStore::open(crate::data_root::resolve(app).fights_db())
        .map_err(|error| format!("open inventory database: {error}"))
}

fn persist(
    app: &AppHandle,
    parsed: &ParsedInventory,
    character: &str,
    server: &str,
) -> Result<(), String> {
    if character.trim().is_empty() {
        return Ok(());
    }
    let mut store = store(app)?;
    store
        .import_snapshot(&InventorySnapshotInput {
            character: character.trim().into(),
            server: server.trim().into(),
            source_path: parsed.snapshot.source_path.clone(),
            source_modified_ms: parsed.snapshot.source_modified_ms,
            imported_at_ms: parsed.snapshot.imported_at_ms,
            fingerprint: parsed.fingerprint.clone(),
            row_count: parsed.snapshot.row_count,
            skipped_rows: parsed.snapshot.skipped_rows,
            sections: parsed.sections.clone(),
            entries: parsed.entries.clone(),
            storage_slots: parsed.storage_slots.clone(),
        })
        .map(|_| ())
        .map_err(|error| format!("save inventory snapshot: {error}"))
}

#[tauri::command]
pub fn inventory_import(
    app: AppHandle,
    path: String,
    character: Option<String>,
    server: Option<String>,
) -> Result<InventorySnapshot, String> {
    let parsed = import_path(Path::new(&path))?;
    persist(
        &app,
        &parsed,
        character.as_deref().unwrap_or_default(),
        server.as_deref().unwrap_or_default(),
    )?;
    Ok(parsed.snapshot)
}

#[tauri::command]
pub fn inventory_discover(
    app: AppHandle,
    log_path: String,
    character: String,
    server: String,
) -> Result<Option<InventorySnapshot>, String> {
    let log = PathBuf::from(log_path);
    let root = log
        .parent()
        .filter(|parent| {
            parent
                .file_name()
                .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("Logs"))
        })
        .and_then(Path::parent)
        .ok_or("cannot derive the EverQuest install folder from the configured log path")?;
    let character_norm = normalize(&character);
    let server_norm = normalize(&server);
    let mut candidates: Vec<(bool, SystemTime, PathBuf)> = fs::read_dir(root)
        .map_err(|error| format!("scan EverQuest install folder: {error}"))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let filename = path.file_name()?.to_string_lossy();
            let filename_norm = normalize(&filename);
            if !path.is_file()
                || !filename.to_lowercase().ends_with(".txt")
                || !filename_norm.contains("inventory")
                || (!character_norm.is_empty() && !filename_norm.contains(&character_norm))
            {
                return None;
            }
            let modified = entry.metadata().ok()?.modified().ok()?;
            let server_match = !server_norm.is_empty() && filename_norm.contains(&server_norm);
            Some((server_match, modified, path))
        })
        .collect();
    candidates.sort_by_key(|(server_match, modified, _)| (*server_match, *modified));
    match candidates.pop() {
        Some((_, _, path)) => {
            let parsed = import_path(&path)?;
            persist(&app, &parsed, &character, &server)?;
            Ok(Some(parsed.snapshot))
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub fn inventory_database(
    app: AppHandle,
    character: String,
    server: String,
) -> Result<InventoryDatabase, String> {
    store(&app)?
        .database(&character, &server)
        .map_err(|error| format!("read inventory database: {error}"))
}

#[tauri::command]
pub fn inventory_set_currency(
    app: AppHandle,
    character: String,
    server: String,
    name: String,
    quantity: i64,
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("currency name is required".into());
    }
    let mut store = store(&app)?;
    store
        .set_currency(&character, &server, name.trim(), quantity, now_ms())
        .map_err(|error| format!("save currency: {error}"))
}

#[tauri::command]
pub fn inventory_set_disposition(
    app: AppHandle,
    character: String,
    server: String,
    item_key: String,
    action: String,
    note: String,
) -> Result<(), String> {
    if !["", "keep", "move", "sell", "trade", "review"].contains(&action.as_str()) {
        return Err("invalid inventory disposition".into());
    }
    store(&app)?
        .set_disposition(
            &character,
            &server,
            &item_key,
            &action,
            note.trim(),
            now_ms(),
        )
        .map_err(|error| format!("save inventory disposition: {error}"))
}

#[tauri::command]
pub fn inventory_remove_currency(
    app: AppHandle,
    character: String,
    server: String,
    name: String,
) -> Result<(), String> {
    store(&app)?
        .remove_currency(&character, &server, &name)
        .map_err(|error| format!("remove currency: {error}"))
}

#[tauri::command]
pub fn inventory_set_keep(
    app: AppHandle,
    character: String,
    server: String,
    item_key: String,
    keep: bool,
) -> Result<(), String> {
    store(&app)?
        .set_keep(&character, &server, &item_key, keep)
        .map_err(|error| format!("save keep flag: {error}"))
}

#[tauri::command]
pub fn inventory_set_quest_status(
    app: AppHandle,
    character: String,
    server: String,
    quest_id: String,
    status: String,
) -> Result<(), String> {
    if !["unknown", "planned", "in-progress", "completed", "ignored"]
        .contains(&status.as_str())
    {
        return Err("invalid quest status".into());
    }
    store(&app)?
        .set_quest_status(&character, &server, &quest_id, &status, now_ms())
        .map_err(|error| format!("save quest status: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_header_driven_export_and_aggregates_ids() {
        let source = concat!(
            "Location\tName\tID\tCount\tSlots\r\n",
            "General1\tWind Rune Caza\t100\t2\t0\r\n",
            "Bank1\tWind Rune Caza +1\t100\t3\t0\r\n",
            "General2\tCloudy Stone\t0\t4\t0\r\n",
            "General3\tEmpty\t0\t0\t0\r\n",
            "bad row\r\n",
        );
        let parsed = parse_tsv(source, "inventory.txt".into(), 123).unwrap();
        let snapshot = parsed.snapshot;
        assert_eq!(snapshot.row_count, 5);
        assert_eq!(snapshot.skipped_rows, 2);
        assert_eq!(snapshot.items.len(), 2);
        let rune = snapshot
            .items
            .iter()
            .find(|item| item.item_id == Some(100))
            .unwrap();
        assert_eq!(rune.quantity, 5);
        assert_eq!(rune.locations, vec!["Bank1", "General1"]);
        assert_eq!(rune.names.len(), 2);
        let stone = snapshot
            .items
            .iter()
            .find(|item| item.name == "Cloudy Stone")
            .unwrap();
        assert_eq!(stone.quantity, 4);
    }

    #[test]
    fn rejects_exports_without_required_columns() {
        let error = parse_tsv("Name\tCount\nA\t1", "bad.txt".into(), 0)
            .err()
            .unwrap();
        assert!(error.contains("location"));
    }

    #[test]
    fn parses_legends_key_ring_section_with_implicit_counts() {
        let source = concat!(
            "Location\tName\tID\tCount\tSlots\r\n",
            "General1\tDiamond Rod +1\t11570\t1\t0\r\n",
            "\t\r\n",
            "KeyRing\tName\tID\t\r\n",
            "Augmentation\tDiamond Rod (Exaltation)\t11570\t\r\n",
            "Equipment\tShroud of the Sky\t177763\t\r\n",
        );
        let parsed = parse_tsv(source, "inventory.txt".into(), 123).unwrap();
        assert_eq!(parsed.entries[1].storage, "keyring-augmentation");
        let snapshot = parsed.snapshot;
        assert_eq!(snapshot.row_count, 3);
        assert_eq!(snapshot.skipped_rows, 0);
        assert_eq!(snapshot.items.len(), 2);
        let rod = snapshot
            .items
            .iter()
            .find(|item| item.item_id == Some(11570))
            .unwrap();
        assert_eq!(rod.quantity, 2);
        assert_eq!(rod.locations, vec!["Augmentation", "General1"]);
        assert_eq!(rod.names.len(), 2);
    }

    #[test]
    fn records_open_conditional_storage_even_when_empty() {
        let source = concat!(
            "Location\tName\tID\tCount\tSlots\r\n",
            "Hoard1\tEmpty\t0\t0\t0\r\n",
            "Personal-Depot1\tEmpty\t0\t0\t0\r\n",
        );
        let parsed = parse_tsv(source, "inventory.txt".into(), 123).unwrap();
        assert!(parsed.sections.contains(&"hoard".into()));
        assert!(parsed.sections.contains(&"personal-depot".into()));
        assert!(parsed.entries.is_empty());
        assert_eq!(parsed.storage_slots.len(), 2);
        assert!(parsed.storage_slots.iter().all(|slot| slot.empty));
    }
}
