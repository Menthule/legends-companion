//! Multi-pack loading: merge every `*.json` trigger pack under a directory
//! tree (`triggers/`, `triggers/curated/`, `triggers/generated/`, …) into one
//! trigger list, in a stable order, with duplicate-id warnings.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};

use crate::model::{Trigger, TriggerPack};

/// Result of [`load_packs`]: the merged trigger list plus non-fatal warnings
/// (unreadable/unparseable files, duplicate trigger ids).
#[derive(Debug, Default)]
pub struct LoadedPacks {
    pub triggers: Vec<Trigger>,
    pub warnings: Vec<String>,
}

/// Recursively collect every `*.json` file under `dir`.
fn collect_json_files(dir: &Path, out: &mut Vec<PathBuf>) -> io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            collect_json_files(&path, out)?;
        } else if path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("json"))
        {
            out.push(path);
        }
    }
    Ok(())
}

/// Load and merge every `*.json` pack under `dir` (recursively). Files are
/// processed in sorted-path order so the merged list is stable across runs
/// and platforms. Each file may be either a [`TriggerPack`] object or a bare
/// `[Trigger, ...]` array.
///
/// Non-fatal problems — a file that can't be read or parsed, or two triggers
/// sharing an effective id — become entries in [`LoadedPacks::warnings`];
/// duplicates are kept in the merged list (the engine's fire-dedupe handles
/// identical patterns at match time). Errors reading `dir` itself are fatal.
pub fn load_packs(dir: &Path) -> io::Result<LoadedPacks> {
    let mut files = Vec::new();
    collect_json_files(dir, &mut files)?;
    files.sort();

    let mut loaded = LoadedPacks::default();
    let mut first_seen: HashMap<String, PathBuf> = HashMap::new();
    for path in files {
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(e) => {
                loaded
                    .warnings
                    .push(format!("skipped {}: read failed: {e}", path.display()));
                continue;
            }
        };
        let triggers = match serde_json::from_str::<TriggerPack>(&text) {
            Ok(pack) => pack.triggers,
            Err(pack_err) => match serde_json::from_str::<Vec<Trigger>>(&text) {
                Ok(triggers) => triggers,
                Err(_) => {
                    loaded.warnings.push(format!(
                        "skipped {}: not a trigger pack: {pack_err}",
                        path.display()
                    ));
                    continue;
                }
            },
        };
        for trigger in triggers {
            let id = trigger.effective_id();
            if let Some(first) = first_seen.get(&id) {
                loaded.warnings.push(format!(
                    "duplicate trigger id '{id}' in {} (first defined in {})",
                    path.display(),
                    first.display()
                ));
            } else {
                first_seen.insert(id, path.clone());
            }
            loaded.triggers.push(trigger);
        }
    }
    Ok(loaded)
}
