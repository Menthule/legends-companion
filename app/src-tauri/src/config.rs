//! App configuration + trigger pack persistence (JSON files in the Tauri app
//! config directory).

use std::fs;
use std::path::{Path, PathBuf};

use eqlog_triggers::model::{Trigger, TriggerPack};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Where a default Legends install writes its logs (the `discover_logs`
/// scan root; the config itself defaults to *empty* so first-run UI can
/// tell "never configured" from "configured").
pub const DEFAULT_LOGS_DIR: &str =
    "C:/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/Logs";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    /// Full path of the log file to tail.
    pub log_path: String,
    /// Character whose log this is ({C} token, "You" attribution).
    pub character_name: String,
    /// Trigger pack JSON path; empty = `triggers.json` in the app config dir.
    pub trigger_pack_path: String,
    /// Named pets/charmed mobs owned by the character (exact in-game names).
    /// Fed to the trigger engine as friendly casters and to the fight
    /// tracker's pet→owner map so meters fold them into the character.
    /// Additive: absent in older config files.
    #[serde(default)]
    pub pets: Vec<String>,
    /// TTS pronunciation substitutions, applied in order before speech is
    /// queued. Example: `{"from":"Cazic","to":"Kaz-ick"}`.
    #[serde(default)]
    pub tts_dictionary: Vec<Pronunciation>,
    /// Windows TTS voice display name; "" = system default. Additive.
    #[serde(default)]
    pub tts_voice: String,
    /// Master audio mute: while set, alert speech and sounds are dropped at
    /// enqueue time (voice/sound previews in Settings still play). Distinct
    /// from the one-shot Silence, which only drains the current queue.
    /// Additive.
    #[serde(default)]
    pub tts_muted: bool,
    /// Whether tailing was running when the app last changed it — Start
    /// persists true, Stop persists false, launch resumes accordingly so
    /// the user never re-clicks Start after a restart. Additive.
    #[serde(default)]
    pub resume_tailing: bool,
    /// Which (server, character) is active. This is the GLOBAL pointer into
    /// the per-character store; the character's own state (log path, pets,
    /// loadouts) lives under `characters/<server>/<char>/`. `None` in legacy
    /// configs — resolved then from `log_path`/`character_name`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_character: Option<ActiveCharacter>,
    /// Fight-history retention: drop stored fights older than this many days at
    /// startup. `0` (default) keeps history forever. Additive.
    #[serde(default)]
    pub fight_retention_days: u32,
    /// Career-import session-split gap in minutes ("everything
    /// configurable"); `0` (the default) means the importer default (30 —
    /// `eqlog_store::career::DEFAULT_GAP_SECS`). Editable in settings.json;
    /// no Settings UI yet. Additive.
    #[serde(default)]
    pub career_gap_mins: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pronunciation {
    pub from: String,
    pub to: String,
}

/// Global pointer to the active character (persisted in `settings.json`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveCharacter {
    pub server: String,
    pub character: String,
}

/// Identifier the app shipped under before the "Legends Companion" rename;
/// its config dir is a sibling of the current one.
const LEGACY_IDENTIFIER: &str = "com.eqlogs.app";

/// One-time migration for the `com.eqlogs.app` → `com.legendscompanion.app`
/// identifier rename, which moved the app config directory. If the new dir
/// has no `config.json` yet but the old sibling dir exists, copy
/// `config.json`, `triggers.json`, and `profiles/*` across (never
/// overwriting anything already present). Best-effort: failures log to
/// stderr and the app continues with defaults. Call before `load`.
pub fn migrate_legacy_config_dir(app: &AppHandle) {
    let Ok(new_dir) = app.path().app_config_dir() else {
        return;
    };
    if new_dir.join("config.json").exists() {
        return; // already migrated (or configured fresh)
    }
    let Some(old_dir) = new_dir.parent().map(|p| p.join(LEGACY_IDENTIFIER)) else {
        return;
    };
    if !old_dir.is_dir() {
        return; // nothing to migrate
    }
    if let Err(e) = fs::create_dir_all(&new_dir) {
        crate::logging::warn(&format!("migrate: create {}: {e}", new_dir.display()));
        return;
    }
    for name in ["config.json", "triggers.json"] {
        copy_if_absent(&old_dir.join(name), &new_dir.join(name));
    }
    let old_profiles = old_dir.join("profiles");
    if old_profiles.is_dir() {
        let new_profiles = new_dir.join("profiles");
        if let Err(e) = fs::create_dir_all(&new_profiles) {
            crate::logging::warn(&format!("migrate: create {}: {e}", new_profiles.display()));
            return;
        }
        if let Ok(entries) = fs::read_dir(&old_profiles) {
            for entry in entries.flatten() {
                copy_if_absent(&entry.path(), &new_profiles.join(entry.file_name()));
            }
        }
    }
    crate::logging::info(&format!(
        "migrated settings from {} to {}",
        old_dir.display(),
        new_dir.display()
    ));
}

/// Copy `from` to `to` unless `from` isn't a file or `to` already exists.
fn copy_if_absent(from: &Path, to: &Path) {
    if !from.is_file() || to.exists() {
        return;
    }
    if let Err(e) = fs::copy(from, to) {
        crate::logging::warn(&format!(
            "migrate {} -> {}: {e}",
            from.display(),
            to.display()
        ));
    }
}

/// `<name>.tmp` sibling used for atomic replace-on-save.
pub(crate) fn tmp_sibling(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_else(|| std::ffi::OsString::from("file"));
    name.push(".tmp");
    path.with_file_name(name)
}

/// Atomic save: write a temp sibling, then rename over the target. A crash
/// mid-write can no longer truncate config/triggers/profiles to garbage
/// (std rename replaces the destination on Windows and Unix alike).
pub(crate) fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let tmp = tmp_sibling(path);
    fs::write(&tmp, contents).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("replace {}: {e}", path.display()))
}

/// Path of the global settings file under the resolved data root.
fn config_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::data_root::resolve(app).settings_file())
}

/// Load the persisted config; any problem falls back to defaults.
pub fn load(app: &AppHandle) -> AppConfig {
    config_file(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let path = config_file(app)?;
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    write_atomic(&path, &json)
}

/// Resolve the trigger pack file for this config.
pub fn trigger_pack_file(app: &AppHandle, config: &AppConfig) -> Result<PathBuf, String> {
    if config.trigger_pack_path.trim().is_empty() {
        Ok(crate::data_root::resolve(app).user_trigger_pack())
    } else {
        Ok(PathBuf::from(config.trigger_pack_path.trim()))
    }
}

/// Load the trigger pack; a missing file is an empty pack, a corrupt file is
/// an error (so we never silently clobber someone's triggers on next save).
/// Accepts the canonical `TriggerPack` shape and, for hand-made files, a bare
/// `[Trigger, ...]` array.
pub fn load_triggers(path: &Path) -> Result<Vec<Trigger>, String> {
    match fs::read_to_string(path) {
        Ok(s) => serde_json::from_str::<TriggerPack>(&s)
            .map(|p| p.triggers)
            .or_else(|_| serde_json::from_str::<Vec<Trigger>>(&s))
            .map_err(|e| format!("trigger pack {} is invalid JSON: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

pub fn save_triggers(path: &Path, triggers: &[Trigger]) -> Result<(), String> {
    let pack = TriggerPack {
        name: "Legends Companion".to_string(),
        triggers: triggers.to_vec(),
    };
    let json = serde_json::to_string_pretty(&pack).map_err(|e| e.to_string())?;
    write_atomic(path, &json)
}
