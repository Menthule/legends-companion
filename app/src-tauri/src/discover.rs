//! First-run log discovery: scan candidate Logs directories for
//! `eqlog_<Character>_<server>.txt` files so the welcome card can offer
//! one-click setup instead of a hardcoded path.

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use serde::Serialize;

/// Canonical `eqlog_<Character>_<server>.txt` parser, single-sourced in the
/// pure `eqlog-triggers` crate so identity logic is WSL-unit-tested (see
/// `storage::parse_log_filename`). Re-exported here for `scan` and callers.
pub use eqlog_triggers::storage::parse_log_filename;

/// One discovered log file, newest first in [`scan`]'s output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredLog {
    /// Full path, ready to drop into `AppConfig::log_path`.
    pub path: String,
    /// Character name parsed from the filename.
    pub character: String,
    /// Server slug parsed from the filename ("" when absent).
    pub server: String,
    /// Last-modified time, Unix seconds (0 when unavailable).
    pub modified: i64,
}

/// Scan `dirs` (duplicates tolerated) for log files, newest first.
/// Unreadable directories are skipped silently — a missing default install
/// dir is the normal case, not an error.
pub fn scan(dirs: &[PathBuf]) -> Vec<DiscoveredLog> {
    let mut seen_dirs: HashSet<String> = HashSet::new();
    let mut seen_paths: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for dir in dirs {
        // Case-insensitive key: Windows paths compare that way, and the
        // configured log's parent is often the default dir spelled anew.
        if !seen_dirs.insert(dir.to_string_lossy().to_lowercase()) {
            continue;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let file_name = entry.file_name();
            let Some(name) = file_name.to_str() else {
                continue;
            };
            let Some((character, server)) = parse_log_filename(name) else {
                continue;
            };
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            let path = entry.path().to_string_lossy().to_string();
            if !seen_paths.insert(path.to_lowercase()) {
                continue;
            }
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            out.push(DiscoveredLog {
                path,
                character,
                server,
                modified,
            });
        }
    }
    out.sort_by(|a, b| {
        b.modified
            .cmp(&a.modified)
            .then_with(|| a.path.cmp(&b.path))
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_character_and_server() {
        assert_eq!(
            parse_log_filename("eqlog_Nyasha_oggok.txt"),
            Some(("Nyasha".into(), "oggok".into()))
        );
        assert_eq!(
            parse_log_filename("eqlog_Torvin_test_server.txt"),
            Some(("Torvin".into(), "test_server".into()))
        );
        assert_eq!(
            parse_log_filename("eqlog_Vibarn.txt"),
            Some(("Vibarn".into(), "".into()))
        );
        assert_eq!(parse_log_filename("eqlog_.txt"), None);
        assert_eq!(parse_log_filename("dbg.txt"), None);
        assert_eq!(parse_log_filename("eqlog_Nyasha_oggok.bak"), None);
    }

    #[test]
    fn scan_finds_and_sorts_logs() {
        let dir = std::env::temp_dir().join(format!(
            "legends-companion-discover-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create scratch dir");
        fs::write(dir.join("eqlog_Aaa_oggok.txt"), "x").unwrap();
        fs::write(dir.join("eqlog_Bbb_oggok.txt"), "x").unwrap();
        fs::write(dir.join("dbg.txt"), "x").unwrap();

        // Duplicate dir entries must not duplicate results.
        let found = scan(&[dir.clone(), dir.clone()]);
        assert_eq!(found.len(), 2);
        assert!(found.iter().any(|l| l.character == "Aaa"));
        assert!(found
            .iter()
            .any(|l| l.character == "Bbb" && l.server == "oggok"));
        assert!(found.iter().all(|l| l.modified > 0));
        // Newest-first ordering (ties broken by path, so stable either way).
        assert!(found[0].modified >= found[1].modified);

        let _ = fs::remove_dir_all(&dir);
    }
}
