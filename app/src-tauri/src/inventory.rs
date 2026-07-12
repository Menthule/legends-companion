//! Import static `/outputfile inventory` TSV snapshots for quest matching.

use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

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

fn parse_tsv(
    text: &str,
    source_path: String,
    modified_ms: u64,
) -> Result<InventorySnapshot, String> {
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
        let name = fields[name_col].trim();
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
        let location = fields[location_col].trim();
        if !location.is_empty() {
            entry.locations.insert(location.to_string());
        }
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
    Ok(InventorySnapshot {
        source_path,
        source_modified_ms: modified_ms,
        imported_at_ms: now_ms(),
        row_count,
        skipped_rows,
        items,
    })
}

fn import_path(path: &Path) -> Result<InventorySnapshot, String> {
    let bytes = fs::read(path).map_err(|error| format!("read inventory export: {error}"))?;
    let text = String::from_utf8_lossy(&bytes);
    let modified_ms = fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0);
    parse_tsv(&text, path.display().to_string(), modified_ms)
}

#[tauri::command]
pub fn inventory_import(path: String) -> Result<InventorySnapshot, String> {
    import_path(Path::new(&path))
}

#[tauri::command]
pub fn inventory_discover(
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
        Some((_, _, path)) => import_path(&path).map(Some),
        None => Ok(None),
    }
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
        let snapshot = parse_tsv(source, "inventory.txt".into(), 123).unwrap();
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
        let error = parse_tsv("Name\tCount\nA\t1", "bad.txt".into(), 0).unwrap_err();
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
        let snapshot = parse_tsv(source, "inventory.txt".into(), 123).unwrap();
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
}
