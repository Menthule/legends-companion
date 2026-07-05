//! Single source of truth for where the app keeps its data.
//!
//! Portable-with-fallback, resolved ONCE per process and cached: if a
//! **writable** `data/` directory sits next to the executable, use it
//! (portable mode — the whole app is self-contained, e.g. on a USB stick).
//! Otherwise fall back to the OS app-config dir (installed mode: exactly
//! today's behavior). Every persistent path — global settings, per-character
//! profiles, the user trigger pack, `fights.db`, `app.log`, user sounds —
//! derives from the one [`DataRoot`] returned here.

use std::path::PathBuf;
use std::sync::OnceLock;

use tauri::{AppHandle, Manager};

/// The resolved data root plus whether we ended up running portably.
#[derive(Debug, Clone)]
pub struct DataRoot {
    /// Directory that holds everything the app persists.
    pub path: PathBuf,
    /// True when `path` is the portable `data/` dir beside the executable.
    pub portable: bool,
}

static ROOT: OnceLock<DataRoot> = OnceLock::new();

/// Resolve (once) and cache the data root; the first call decides for the
/// whole process. Later calls ignore their `app` argument and return the
/// cached value, so every module can call this freely.
pub fn resolve(app: &AppHandle) -> &'static DataRoot {
    ROOT.get_or_init(|| {
        if let Some(dir) = portable_data_dir() {
            let _ = std::fs::create_dir_all(&dir);
            return DataRoot {
                path: dir,
                portable: true,
            };
        }
        let path = app
            .path()
            .app_config_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        let _ = std::fs::create_dir_all(&path);
        DataRoot {
            path,
            portable: false,
        }
    })
}

/// A `data/` directory next to the executable that we can actually write to,
/// else `None`. Existence alone is not enough — a read-only `data/` (e.g. one
/// shipped under `Program Files`) must fall through to the OS config dir, so
/// we probe with a throwaway temp file.
fn portable_data_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.join("data");
    if !dir.is_dir() {
        return None;
    }
    let probe = dir.join(".write-probe");
    match std::fs::write(&probe, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            Some(dir)
        }
        Err(_) => None,
    }
}

impl DataRoot {
    /// Global app settings file (was `config.json`; now `settings.json`).
    pub fn settings_file(&self) -> PathBuf {
        self.path.join("settings.json")
    }

    /// Root of the per-character store (`characters/<server>/<char>/…`).
    pub fn characters_dir(&self) -> PathBuf {
        self.path.join("characters")
    }

    /// The user's own editable trigger pack; bundled packs stay read-only in
    /// the app resources and never land here.
    pub fn user_trigger_pack(&self) -> PathBuf {
        self.path.join("triggers").join("my-triggers.json")
    }

    /// Fight-history SQLite database.
    pub fn fights_db(&self) -> PathBuf {
        self.path.join("fights.db")
    }

    /// Append-only diagnostics log.
    pub fn app_log(&self) -> PathBuf {
        self.path.join("app.log")
    }

    /// User-supplied custom alert sounds, checked before the bundled set.
    pub fn sounds_dir(&self) -> PathBuf {
        self.path.join("sounds")
    }

    /// Downloaded reference-data updates (`datapack` commands): a newer
    /// `drops.sqlite` and an extracted `triggers/` pack tree, plus the
    /// `version.txt` marker. When present these override the bundled
    /// resources (see `dropdb::db_path` / `library::packs_dir`).
    pub fn refdata_update_dir(&self) -> PathBuf {
        self.path.join("refdata-update")
    }
}
