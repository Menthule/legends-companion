//! Portable v2 storage layout: server-keyed character identity, split loadout
//! files, and migration from the flat v1 layout.
//!
//! Everything here is pure `std::fs` keyed off a **data-root** [`Path`], so it
//! unit-tests in isolation (no Tauri, no real OS config dir — just a tempdir).
//! The Tauri layer resolves the data-root (portable `data/` next to the exe, or
//! the OS app-config dir) and calls these functions.
//!
//! On-disk tree:
//! ```text
//! <data-root>/
//!   settings.json                       # global app settings + active char pointer
//!   characters/<server>/<character>/
//!     profile.json                      # level, active loadout NAME, allowlisted overrides
//!     loadouts/<name>.json              # classes + per-trigger enable + tts/alert
//!   triggers/my-triggers.json           # user pack only
//! ```

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::model::{slugify, CharacterProfile, Loadout, DEFAULT_LOADOUT_NAME};

/// Server bucket used when a log filename carries no server segment, and the
/// slug fallback when a name slugs to empty.
pub const DEFAULT_SERVER: &str = "default";

/// Errors from the storage layer.
#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("storage I/O failed for {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("storage JSON invalid in {path}: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
}

fn io_err(path: &Path) -> impl Fn(std::io::Error) -> StorageError + '_ {
    move |source| StorageError::Io {
        path: path.to_path_buf(),
        source,
    }
}

// ---------------------------------------------------------------------------
// Phase 2: server-keyed identity
// ---------------------------------------------------------------------------

/// Parse `eqlog_<Character>_<server>.txt` → (character, server). The server
/// part keeps any embedded underscores; a serverless `eqlog_Name.txt` still
/// yields the character (with an empty server). Canonical home for this parse
/// (the Tauri `discover` module re-exports it) so identity is WSL-testable.
pub fn parse_log_filename(name: &str) -> Option<(String, String)> {
    let rest = name.strip_prefix("eqlog_")?.strip_suffix(".txt")?;
    let (character, server) = match rest.split_once('_') {
        Some((c, s)) => (c, s),
        None => (rest, ""),
    };
    if character.is_empty() {
        return None;
    }
    Some((character.to_string(), server.to_string()))
}

/// A character's identity = (server, character). Display names are preserved;
/// filesystem paths use slugs. A serverless log maps to server [`DEFAULT_SERVER`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CharacterId {
    /// Display server name ("default" when the log carried no server).
    pub server: String,
    /// Display character name.
    pub character: String,
}

impl CharacterId {
    /// Build an id, mapping an empty/blank server to [`DEFAULT_SERVER`].
    pub fn new(character: impl Into<String>, server: impl Into<String>) -> Self {
        let server = server.into();
        let server = if server.trim().is_empty() {
            DEFAULT_SERVER.to_string()
        } else {
            server
        };
        CharacterId {
            server,
            character: character.into(),
        }
    }

    /// Identity from a bare log filename (`eqlog_<Char>_<server>.txt`).
    pub fn from_log_filename(name: &str) -> Option<Self> {
        let (character, server) = parse_log_filename(name)?;
        Some(CharacterId::new(character, server))
    }

    /// Identity from a full/relative log path (uses the file name only).
    pub fn from_log_path(path: &str) -> Option<Self> {
        let name = Path::new(path).file_name()?.to_str()?;
        Self::from_log_filename(name)
    }

    /// Filesystem-safe server slug (never empty — falls back to "default").
    pub fn server_slug(&self) -> String {
        slug_or_default(&self.server)
    }

    /// Filesystem-safe character slug (never empty — falls back to "unknown").
    pub fn character_slug(&self) -> String {
        let s = slugify(&self.character);
        if s.is_empty() {
            "unknown".to_string()
        } else {
            s
        }
    }

    /// `<root>/characters/<server-slug>/<character-slug>/`.
    pub fn dir(&self, root: &Path) -> PathBuf {
        root.join("characters")
            .join(self.server_slug())
            .join(self.character_slug())
    }
}

fn slug_or_default(s: &str) -> String {
    let s = slugify(s);
    if s.is_empty() {
        DEFAULT_SERVER.to_string()
    } else {
        s
    }
}

// ---------------------------------------------------------------------------
// Phase 3: split loadout files
// ---------------------------------------------------------------------------

fn default_level() -> u32 {
    50
}

/// The per-character allowlisted overrides (spec: log path + pets ONLY). Kept
/// separate from the global settings and the per-loadout enable/tts state.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CharacterOverrides {
    /// Per-character log file path override (`None`/empty = use global default).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_path: Option<String>,
    /// Per-character pet names (fed to the engine as friendly casters).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub pets: Vec<String>,
}

/// On-disk `profile.json`: character-level state + active loadout NAME +
/// allowlisted overrides. Loadout bodies live in `loadouts/*.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileHeader {
    character: String,
    #[serde(default = "default_level")]
    level: u32,
    active_loadout: String,
    /// Display server name (informational; the path is the source of truth).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    server: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    log_path: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pets: Vec<String>,
}

/// Result of [`load_character`].
#[derive(Debug, Clone, PartialEq)]
pub struct LoadedCharacter {
    /// In-memory profile with loadouts reassembled from `loadouts/*.json`.
    pub profile: CharacterProfile,
    /// Allowlisted per-character overrides (log path, pets).
    pub overrides: CharacterOverrides,
    /// Whether a `profile.json` actually existed (false ⇒ fresh default).
    pub existed: bool,
}

/// Load a character from the split layout, reassembling `loadouts/*.json` into
/// the in-memory [`CharacterProfile`]. A missing `profile.json` yields a fresh
/// default (single empty `Default` loadout) with `existed == false`.
pub fn load_character(root: &Path, id: &CharacterId) -> Result<LoadedCharacter, StorageError> {
    let dir = id.dir(root);
    let profile_path = dir.join("profile.json");
    if !profile_path.exists() {
        return Ok(LoadedCharacter {
            profile: CharacterProfile::new(id.character.clone()),
            overrides: CharacterOverrides::default(),
            existed: false,
        });
    }

    let text = std::fs::read_to_string(&profile_path).map_err(io_err(&profile_path))?;
    let header: ProfileHeader =
        serde_json::from_str(&text).map_err(|source| StorageError::Parse {
            path: profile_path.clone(),
            source,
        })?;

    // Read every loadout file, sorted by (case-insensitive) name for a stable
    // fallback-to-first ordering.
    let mut loadouts: Vec<Loadout> = Vec::new();
    let loadouts_dir = dir.join("loadouts");
    if loadouts_dir.is_dir() {
        let mut entries: Vec<PathBuf> = std::fs::read_dir(&loadouts_dir)
            .map_err(io_err(&loadouts_dir))?
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "json"))
            .collect();
        entries.sort();
        for path in entries {
            let text = std::fs::read_to_string(&path).map_err(io_err(&path))?;
            let loadout: Loadout =
                serde_json::from_str(&text).map_err(|source| StorageError::Parse {
                    path: path.clone(),
                    source,
                })?;
            loadouts.push(loadout);
        }
    }
    loadouts.sort_by_key(|l| l.name.to_lowercase());

    // No loadout files (corrupt/empty dir) ⇒ one empty loadout named by header.
    if loadouts.is_empty() {
        let name = if header.active_loadout.trim().is_empty() {
            DEFAULT_LOADOUT_NAME.to_string()
        } else {
            header.active_loadout.clone()
        };
        loadouts.push(Loadout::new(name));
    }

    let active_loadout = if header.active_loadout.trim().is_empty() {
        loadouts[0].name.clone()
    } else {
        header.active_loadout.clone()
    };

    Ok(LoadedCharacter {
        profile: CharacterProfile {
            character: header.character,
            level: header.level,
            active_loadout,
            loadouts,
        },
        overrides: CharacterOverrides {
            log_path: header.log_path.filter(|s| !s.trim().is_empty()),
            pets: header.pets,
        },
        existed: true,
    })
}

/// Persist a character in the split layout: `profile.json` header + one
/// `loadouts/<slug>.json` per loadout. All writes are atomic (temp + rename).
/// Stale loadout files (a loadout deleted in memory) are pruned.
pub fn save_character(
    root: &Path,
    id: &CharacterId,
    profile: &CharacterProfile,
    overrides: &CharacterOverrides,
) -> Result<(), StorageError> {
    let dir = id.dir(root);
    let loadouts_dir = dir.join("loadouts");
    std::fs::create_dir_all(&loadouts_dir).map_err(io_err(&loadouts_dir))?;

    // Write each loadout; track the filenames we expect to keep. Two loadout
    // names can slugify identically ("PvP" vs "pvp", "Raid!" vs "Raid"), so
    // disambiguate colliding slugs with a numeric suffix — otherwise the
    // second write clobbers the first file and that loadout is silently lost
    // on the next load. The display name lives in the file body, so a suffixed
    // filename never changes what the user sees.
    let mut keep: Vec<String> = Vec::new();
    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
    for loadout in &profile.loadouts {
        let mut base = slugify(&loadout.name);
        if base.is_empty() {
            base = "loadout".to_string();
        }
        let mut fname = format!("{base}.json");
        let mut n = 2;
        while used.contains(&fname) {
            fname = format!("{base}-{n}.json");
            n += 1;
        }
        used.insert(fname.clone());
        keep.push(fname.clone());
        let json = serde_json::to_string_pretty(loadout).expect("loadout serialization infallible");
        write_atomic(&loadouts_dir.join(&fname), &json)?;
    }

    // Prune loadout files that no longer correspond to an in-memory loadout.
    if let Ok(entries) = std::fs::read_dir(&loadouts_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if name.ends_with(".json") && !keep.iter().any(|k| k == name) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    let header = ProfileHeader {
        character: profile.character.clone(),
        level: profile.level,
        active_loadout: profile.active_loadout.clone(),
        server: Some(id.server.clone()),
        log_path: overrides.log_path.clone().filter(|s| !s.trim().is_empty()),
        pets: overrides.pets.clone(),
    };
    let json =
        serde_json::to_string_pretty(&header).expect("profile header serialization infallible");
    write_atomic(&dir.join("profile.json"), &json)
}

/// List every character present under `<root>/characters/` as (server, char)
/// slugs paired with the display names from each `profile.json`.
pub fn list_characters(root: &Path) -> Vec<CharacterId> {
    let mut out = Vec::new();
    let base = root.join("characters");
    let Ok(servers) = std::fs::read_dir(&base) else {
        return out;
    };
    for server in servers.flatten().filter(|e| e.path().is_dir()) {
        let Ok(chars) = std::fs::read_dir(server.path()) else {
            continue;
        };
        for ch in chars.flatten().filter(|e| e.path().is_dir()) {
            let header = ch.path().join("profile.json");
            if let Ok(text) = std::fs::read_to_string(&header) {
                if let Ok(h) = serde_json::from_str::<ProfileHeader>(&text) {
                    out.push(CharacterId::new(
                        h.character,
                        h.server.unwrap_or_else(|| DEFAULT_SERVER.to_string()),
                    ));
                }
            }
        }
    }
    out.sort_by_key(|c| (c.server.to_lowercase(), c.character.to_lowercase()));
    out
}

// ---------------------------------------------------------------------------
// Phase 6: migration from the flat v1 layout
// ---------------------------------------------------------------------------

/// What [`migrate_flat_layout`] did (for logging + tests).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MigrationReport {
    /// True when a migration was performed (false = already v2 / nothing to do).
    pub ran: bool,
    /// The character identity derived for the migrated profile.
    pub character: Option<CharacterId>,
    /// Number of loadouts written under `loadouts/`.
    pub loadouts_migrated: usize,
    /// Total enable + tts/alert overrides carried across all loadouts.
    pub overrides_migrated: usize,
    /// `triggers.json` was copied to `triggers/my-triggers.json`.
    pub triggers_pack_migrated: bool,
    /// `settings.json` was written from the folded `config.json`.
    pub settings_written: bool,
}

/// Migrate a flat v1 data-root to the v2 split layout.
///
/// **Idempotent** — if `<root>/characters/` already exists, does nothing.
/// **Copy-forward** — the old `config.json`, `triggers.json`, and `profiles/`
/// are left untouched as a one-version safety net; nothing is moved or deleted.
/// **Atomic** — every write is temp + rename, so a crash mid-migration cannot
/// truncate a loadout to garbage.
pub fn migrate_flat_layout(root: &Path) -> Result<MigrationReport, StorageError> {
    if root.join("characters").exists() {
        return Ok(MigrationReport::default());
    }

    // Read the old config (best-effort; absent ⇒ maybe still have profiles).
    let config_path = root.join("config.json");
    let config: Value = std::fs::read_to_string(&config_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);

    let cfg_str = |key: &str| -> Option<String> {
        config
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|s| !s.trim().is_empty())
    };
    let character_name = cfg_str("characterName");
    let log_path = cfg_str("logPath");

    // Derive identity: prefer the log filename, else the character name.
    let id = log_path
        .as_deref()
        .and_then(CharacterId::from_log_path)
        .or_else(|| character_name.clone().map(|c| CharacterId::new(c, "")))
        .or_else(|| find_sole_profile(root).map(|(c, _)| CharacterId::new(c, "")));

    // Nothing to migrate at all (no config, no profiles) ⇒ bail cleanly.
    let Some(id) = id else {
        return Ok(MigrationReport::default());
    };

    // Load the old embedded-loadout profile (CharacterProfile's Deserialize
    // handles both the current multi-loadout and legacy single-loadout shapes).
    let profile = load_old_profile(root, &id.character)
        .unwrap_or_else(|| CharacterProfile::new(id.character.clone()));

    let pets: Vec<String> = config
        .get("pets")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let overrides = CharacterOverrides {
        log_path: log_path.clone(),
        pets,
    };

    let overrides_migrated: usize = profile
        .loadouts
        .iter()
        .map(|l| l.overrides.len() + l.channel_overrides.len())
        .sum();
    let loadouts_migrated = profile.loadouts.len();

    // Write the split character (COPY: old profiles/ stays put).
    save_character(root, &id, &profile, &overrides)?;

    // Copy triggers.json → triggers/my-triggers.json (keep the original).
    let mut triggers_pack_migrated = false;
    let old_triggers = root.join("triggers.json");
    if old_triggers.is_file() {
        let dest = root.join("triggers").join("my-triggers.json");
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(io_err(parent))?;
        }
        let contents = std::fs::read_to_string(&old_triggers).map_err(io_err(&old_triggers))?;
        write_atomic(&dest, &contents)?;
        triggers_pack_migrated = true;
    }

    // Fold config.json into settings.json: keep the GLOBAL keys, drop the
    // per-character allowlist (moved into profile.json), add the active-char
    // pointer. Lossless for any future global key.
    let mut settings_written = false;
    if config.is_object() {
        let mut settings = config.as_object().cloned().unwrap_or_default();
        for k in [
            "logPath",
            "characterName",
            "character_name",
            "log_path",
            "pets",
        ] {
            settings.remove(k);
        }
        settings.insert(
            "activeCharacter".to_string(),
            serde_json::json!({ "server": id.server, "character": id.character }),
        );
        let json = serde_json::to_string_pretty(&Value::Object(settings))
            .expect("settings serialization infallible");
        write_atomic(&root.join("settings.json"), &json)?;
        settings_written = true;
    }

    Ok(MigrationReport {
        ran: true,
        character: Some(id),
        loadouts_migrated,
        overrides_migrated,
        triggers_pack_migrated,
        settings_written,
    })
}

/// Load the old `profiles/<slug>.json`; fall back to the sole profile file when
/// the name-derived one is absent.
fn load_old_profile(root: &Path, character: &str) -> Option<CharacterProfile> {
    let dir = root.join("profiles");
    let by_name = dir.join(format!("{}.json", slugify(character)));
    if by_name.is_file() {
        return CharacterProfile::load(&by_name).ok();
    }
    find_sole_profile(root).map(|(_, p)| p)
}

/// If `profiles/` holds exactly one `*.json`, return its (character, profile).
fn find_sole_profile(root: &Path) -> Option<(String, CharacterProfile)> {
    let dir = root.join("profiles");
    let files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    if files.len() != 1 {
        return None;
    }
    let profile = CharacterProfile::load(&files[0]).ok()?;
    Some((profile.character.clone(), profile))
}

// ---------------------------------------------------------------------------
// atomic write (temp sibling + rename) — mirrors config::write_atomic
// ---------------------------------------------------------------------------

fn write_atomic(path: &Path, contents: &str) -> Result<(), StorageError> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).map_err(io_err(parent))?;
    }
    let mut tmp_name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_else(|| std::ffi::OsString::from("file"));
    tmp_name.push(".tmp");
    let tmp = path.with_file_name(tmp_name);
    std::fs::write(&tmp, contents).map_err(io_err(&tmp))?;
    std::fs::rename(&tmp, path).map_err(io_err(path))
}
