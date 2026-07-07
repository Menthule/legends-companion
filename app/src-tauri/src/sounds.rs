//! Bundled alert sounds: manifest listing for the picker UI, preview
//! playback, and bare-filename resolution so trigger packs can reference
//! bundled sounds portably (`"danger.wav"` instead of an absolute path).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, State};

use crate::commands::{lock, AppState};

/// The bundled sounds directory: the `sounds/` resource in installed builds,
/// falling back to the repo's `assets/sounds/` tree for dev runs (same
/// pattern as `library::packs_dir`).
pub fn sounds_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = app.path().resolve("sounds", BaseDirectory::Resource) {
        if dir.is_dir() {
            return Some(dir);
        }
    }
    // Dev fallback: app/src-tauri/../../assets/sounds at compile time.
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/sounds");
    if dev.is_dir() {
        Some(dev)
    } else {
        None
    }
}

/// Resolve a PlaySound path. A path WITH a directory component (or absolute)
/// is honored literally — the audio thread opens it and reports any real error.
/// A bare filename (no directory component) is looked up in the bundled sounds
/// dir; it is NOT resolved against the process cwd, so a same-named file in
/// whatever directory the app happened to launch from can't shadow a bundled
/// sound (P43).
pub(crate) fn resolve_in(dir: Option<&Path>, path: &str) -> String {
    let p = Path::new(path);
    let is_bare = p.file_name().is_some_and(|f| f == p.as_os_str());
    if !is_bare {
        return path.to_string();
    }
    match dir.map(|d| d.join(p)) {
        Some(candidate) if candidate.is_file() => candidate.to_string_lossy().into_owned(),
        _ => path.to_string(),
    }
}

/// Convenience wrapper over [`resolve_in`] for call sites that hold an
/// `AppHandle` rather than a cached sounds dir.
pub fn resolve_sound_path(app: &AppHandle, path: &str) -> String {
    // A user-supplied sound (a bare filename dropped into the data-root
    // `sounds/` dir) wins over the bundled set of the same name.
    let trimmed = path.trim();
    if !trimmed.is_empty() && !trimmed.contains('/') && !trimmed.contains('\\') {
        let user = crate::data_root::resolve(app).sounds_dir().join(trimmed);
        if user.is_file() {
            return user.to_string_lossy().into_owned();
        }
    }
    resolve_in(sounds_dir(app).as_deref(), path)
}

// ---------- manifest ----------

/// One entry of `assets/sounds/manifest.json` (bundled alongside the .wav
/// files). Unknown fields (`intended_use`) are ignored.
#[derive(Deserialize)]
struct ManifestEntry {
    file: String,
    label: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    duration_ms: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SoundInfo {
    pub label: String,
    /// Bare filename — the portable form to store in PlaySound actions.
    pub file: String,
    /// Absolute path on this machine (for direct preview / display).
    pub path: String,
    pub duration_ms: u64,
    pub description: String,
}

// ---------- commands ----------

#[tauri::command]
pub fn list_sounds(app: AppHandle) -> Result<Vec<SoundInfo>, String> {
    let dir = sounds_dir(&app)
        .ok_or_else(|| "bundled sounds not found (no sounds/ resource)".to_string())?;
    let manifest = dir.join("manifest.json");
    let text = std::fs::read_to_string(&manifest)
        .map_err(|e| format!("read {}: {e}", manifest.display()))?;
    let entries: Vec<ManifestEntry> = serde_json::from_str(&text)
        .map_err(|e| format!("sound manifest {} is invalid JSON: {e}", manifest.display()))?;
    Ok(entries
        .into_iter()
        .map(|m| SoundInfo {
            path: dir.join(&m.file).to_string_lossy().into_owned(),
            label: m.label,
            file: m.file,
            duration_ms: m.duration_ms,
            description: m.description,
        })
        .collect())
}

/// Play a sound once on the app-lifetime audio thread. Accepts either an
/// absolute path or a bare bundled filename ("danger.wav").
#[tauri::command]
pub fn preview_sound(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    let resolved = resolve_sound_path(&app, &path);
    let audio = lock(&state.audio, "audio")?.clone();
    audio.play(resolved);
    Ok(())
}
