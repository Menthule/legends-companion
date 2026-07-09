//! Trigger library v2: bundled multi-pack loading, per-character profiles,
//! the trigger tree the UI renders, class auto-detect, and live-engine
//! rebuilds when profile state changes mid-session.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use eqlog_triggers::engine::TriggerEngine;
use eqlog_triggers::model::{CharacterProfile, Trigger, TriggerSource};
use eqlog_triggers::packs::load_packs;
use eqlog_triggers::profile::effective_enabled;
use eqlog_triggers::storage::{self, CharacterId, CharacterOverrides};
use serde::Serialize;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::{lock, AppState};
use crate::config::{self, AppConfig};
use crate::logging;

// ---------- pack + profile loading ----------

/// The trigger pack directory, by precedence:
/// 1. a downloaded data update (`<data_root>/refdata-update/triggers/`,
///    installed by the `data_update_install` command) — only when it exists
///    AND holds at least one entry, so a botched/cleared update can never
///    silently blank out every bundled trigger,
/// 2. the bundled `triggers/` resource in installed builds,
/// 3. the repo's `triggers/` tree for dev runs (where the resource dir may
///    not exist yet).
pub fn packs_dir(app: &AppHandle) -> Option<PathBuf> {
    let updated = crate::data_root::resolve(app)
        .refdata_update_dir()
        .join("triggers");
    if updated.is_dir()
        && std::fs::read_dir(&updated)
            .map(|mut d| d.next().is_some())
            .unwrap_or(false)
    {
        return Some(updated);
    }
    if let Ok(dir) = app.path().resolve("triggers", BaseDirectory::Resource) {
        if dir.is_dir() {
            return Some(dir);
        }
    }
    // Dev fallback: app/src-tauri/../../triggers at compile time.
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../triggers");
    if dev.is_dir() {
        Some(dev)
    } else {
        None
    }
}

/// Everything the app knows about triggers: the read-only bundled packs and
/// the user's own editable pack, kept separate so the UI can index into the
/// user pack for edit/delete.
pub struct Library {
    pub packs: Vec<Trigger>,
    pub user: Vec<Trigger>,
    pub warnings: Vec<String>,
}

pub fn load_library(app: &AppHandle, cfg: &AppConfig) -> Result<Library, String> {
    let mut warnings = Vec::new();
    let packs = match packs_dir(app) {
        Some(dir) => match load_packs(&dir) {
            Ok(loaded) => {
                warnings.extend(loaded.warnings);
                loaded.triggers
            }
            Err(e) => {
                warnings.push(format!(
                    "trigger packs unreadable at {}: {e}",
                    dir.display()
                ));
                Vec::new()
            }
        },
        None => {
            warnings.push("bundled trigger packs not found (no triggers/ resource)".into());
            Vec::new()
        }
    };
    let user = config::load_triggers(&config::trigger_pack_file(app, cfg)?)?;
    Ok(Library {
        packs,
        user,
        warnings,
    })
}

/// The (server, character) identity of the active character. Derived from the
/// active-character pointer, else the configured log filename (which carries
/// the server), else the bare character name in the `default` server bucket.
fn active_id(cfg: &AppConfig) -> CharacterId {
    if let Some(ac) = &cfg.active_character {
        if !ac.character.trim().is_empty() {
            return CharacterId::new(ac.character.clone(), ac.server.clone());
        }
    }
    CharacterId::from_log_path(&cfg.log_path)
        .unwrap_or_else(|| CharacterId::new(cfg.character_name.clone(), ""))
}

/// The allowlisted per-character overrides taken from the live config: the log
/// path and pet names. Nothing else cascades per-character.
fn active_overrides(cfg: &AppConfig) -> CharacterOverrides {
    let log_path = cfg.log_path.trim();
    CharacterOverrides {
        log_path: (!log_path.is_empty()).then(|| log_path.to_string()),
        pets: cfg.pets.clone(),
    }
}

/// Load the active character's profile from the split store; any problem
/// (missing files, bad JSON) falls back to a fresh default profile.
pub fn load_profile(app: &AppHandle, cfg: &AppConfig) -> CharacterProfile {
    let root = &crate::data_root::resolve(app).path;
    let id = active_id(cfg);
    storage::load_character(root, &id)
        .map(|loaded| loaded.profile)
        .unwrap_or_else(|_| CharacterProfile::new(id.character))
}

/// Persist the active character's profile (split loadout files) plus its
/// allowlisted overrides (log path, pets). Atomic writes live in storage.
fn save_profile(
    app: &AppHandle,
    cfg: &AppConfig,
    profile: &CharacterProfile,
) -> Result<(), String> {
    let root = &crate::data_root::resolve(app).path;
    let id = active_id(cfg);
    storage::save_character(root, &id, profile, &active_overrides(cfg)).map_err(|e| e.to_string())
}

/// Persist the live config's per-character overrides (log path, pets) into the
/// active character's stored profile, so a Settings-tab edit survives a
/// restart (startup hydrate reads them back). Best-effort — never blocks the
/// config save that triggered it.
pub fn persist_active_overrides(app: &AppHandle, cfg: &AppConfig) {
    let profile = load_profile(app, cfg);
    if let Err(e) = save_profile(app, cfg, &profile) {
        logging::warn(&format!("persist character overrides: {e}"));
    }
}

/// Populate the live config's working state (character name, log path, pets)
/// from the active character's stored profile. Called at startup after
/// `config::load`, because `settings.json` holds only global keys plus the
/// active-character pointer — the per-character log path and pets live in the
/// character's `profile.json`. Only overwrites a field when a stored value is
/// present, so a freshly configured character (no stored profile yet) keeps
/// whatever the welcome flow set.
pub fn hydrate_active_character(app: &AppHandle, cfg: &mut AppConfig) {
    let root = &crate::data_root::resolve(app).path;
    let id = active_id(cfg);
    let Ok(loaded) = storage::load_character(root, &id) else {
        return;
    };
    if !id.character.trim().is_empty() {
        cfg.character_name = id.character.clone();
    }
    if loaded.existed {
        if cfg.log_path.trim().is_empty() {
            if let Some(lp) = loaded.overrides.log_path {
                cfg.log_path = lp;
            }
        }
        cfg.pets = loaded.overrides.pets;
    }
}

/// A ready-to-run engine plus the sidecar data the tail session needs:
/// per-trigger action counts (so the emit sink can attribute buffered sink
/// calls back to the `process_traced` fire list) and every pack-load +
/// compile warning (surfaced via the "pack-warnings" event and app.log).
pub struct EngineBuild {
    pub engine: TriggerEngine,
    /// `effective_id` → number of actions on that trigger. Engine action
    /// dispatch makes exactly one sink call per action, in fire order, so
    /// these counts partition a line's buffered sink calls by trigger. On
    /// the (pathological) duplicate-id case the first definition's count
    /// wins — worst case a single line's attribution is off, never a crash.
    pub action_counts: HashMap<String, usize>,
    pub warnings: Vec<String>,
}

/// Build a trigger engine from all packs + the user pack, resolved through
/// the character's profile.
pub fn build_engine(app: &AppHandle, cfg: &AppConfig) -> Result<EngineBuild, String> {
    let lib = load_library(app, cfg)?;
    let mut warnings = lib.warnings;
    let profile = load_profile(app, cfg);
    let mut all = lib.packs;
    all.extend(lib.user);
    let mut action_counts = HashMap::with_capacity(all.len());
    for t in &all {
        action_counts
            .entry(t.effective_id())
            .or_insert(t.actions.len());
    }
    let mut engine = TriggerEngine::new_with_profile(all, &cfg.character_name, &profile);
    // Configured pet names are friendly casters — their casts must not fire
    // "Enemy Casts" triggers. Registered here (not just at session start) so
    // hot-swapped engines keep the pet list too.
    engine.add_friendly_names(cfg.pets.iter().map(|p| p.trim()).filter(|p| !p.is_empty()));
    warnings.extend(engine.warnings().iter().cloned());
    Ok(EngineBuild {
        engine,
        action_counts,
        warnings,
    })
}

/// Payload of the "pack-warnings" event, emitted at every engine build
/// (session start and hot rebuild) so the Triggers tab can show/clear its
/// dismissible warning banner.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PackWarningsPayload {
    count: usize,
    messages: Vec<String>,
}

/// Route engine-build warnings to app.log and the frontend. Always emitted
/// (count 0 lets the UI clear a stale banner).
pub fn announce_pack_warnings(app: &AppHandle, warnings: &[String]) {
    for w in warnings {
        logging::warn(w);
    }
    let _ = app.emit(
        "pack-warnings",
        PackWarningsPayload {
            count: warnings.len(),
            messages: warnings.to_vec(),
        },
    );
}

/// First-run seeding: if the user's trigger pack file does not exist yet,
/// create it from the bundled starter pack (`triggers/default.json`) so the
/// editor works against a real file from the first launch. Best-effort; a
/// missing starter pack just leaves the lazy-create behavior in place.
pub fn seed_user_pack(app: &AppHandle, cfg: &AppConfig) {
    let Ok(path) = config::trigger_pack_file(app, cfg) else {
        return;
    };
    if path.exists() {
        return;
    }
    let Some(dir) = packs_dir(app) else {
        return;
    };
    let starter = dir.join("default.json");
    if !starter.is_file() {
        return;
    }
    match config::load_triggers(&starter) {
        Ok(triggers) => {
            if let Err(e) = config::save_triggers(&path, &triggers) {
                logging::warn(&format!("seed user pack: {e}"));
            }
        }
        Err(e) => logging::warn(&format!("starter pack unreadable: {e}")),
    }
}

/// If a tail session is live, rebuild its engine so profile/override/pack
/// edits apply immediately (no "restart tailing" step).
pub(crate) fn rebuild_if_tailing(
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> Result<(), String> {
    let session = lock(&state.session, "session")?;
    if let Some(session) = session.as_ref() {
        let cfg = lock(&state.config, "config")?.clone();
        let build = build_engine(app, &cfg)?;
        announce_pack_warnings(app, &build.warnings);
        session.swap_engine(build)?;
    }
    Ok(())
}

// ---------- commands: profile ----------

/// Broadcast that the character profile (loadouts, overrides, level, active
/// loadout) changed, with the new profile as payload, so every window can
/// refresh without polling.
fn emit_profile_changed(app: &AppHandle, profile: &CharacterProfile) {
    let _ = app.emit("profile-changed", profile.clone());
}

/// The full multi-loadout profile for the configured character.
#[tauri::command]
pub fn get_profile(app: AppHandle, state: State<'_, AppState>) -> Result<CharacterProfile, String> {
    let cfg = lock(&state.config, "config")?.clone();
    Ok(load_profile(&app, &cfg))
}

#[tauri::command]
pub fn set_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: CharacterProfile,
) -> Result<(), String> {
    let cfg = lock(&state.config, "config")?.clone();
    save_profile(&app, &cfg, &profile)?;
    rebuild_if_tailing(&app, &state)?;
    emit_profile_changed(&app, &profile);
    Ok(())
}

/// Make `name` the active loadout (matched case-insensitively against the
/// profile's loadouts), hot-reloading the live trigger engine. Returns the
/// updated profile.
#[tauri::command]
pub fn switch_loadout(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
) -> Result<CharacterProfile, String> {
    let cfg = lock(&state.config, "config")?.clone();
    let mut profile = load_profile(&app, &cfg);
    let canonical = profile
        .loadouts
        .iter()
        .find(|l| l.name.eq_ignore_ascii_case(&name))
        .map(|l| l.name.clone())
        .ok_or_else(|| format!("no loadout named \"{name}\""))?;
    profile.active_loadout = canonical;
    save_profile(&app, &cfg, &profile)?;
    rebuild_if_tailing(&app, &state)?;
    emit_profile_changed(&app, &profile);
    Ok(profile)
}

/// Set (or clear, with `value: null`) a single enable override keyed by
/// trigger id or category-path prefix. Overrides live on the ACTIVE loadout.
#[tauri::command]
pub fn set_override(
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
    value: Option<bool>,
) -> Result<(), String> {
    let cfg = lock(&state.config, "config")?.clone();
    let mut profile = load_profile(&app, &cfg);
    let overrides = &mut profile.active_loadout_mut().overrides;
    match value {
        Some(v) => {
            overrides.insert(key, v);
        }
        None => {
            overrides.remove(&key);
        }
    }
    save_profile(&app, &cfg, &profile)?;
    rebuild_if_tailing(&app, &state)?;
    emit_profile_changed(&app, &profile);
    Ok(())
}

/// Force a trigger's TTS (`speak`) and/or text-alert (`alert`) channel on or
/// off for the active loadout — the Triggers-tab chips call this so ANY
/// trigger (including read-only bundled ones) is configurable. Each argument
/// is tri-state: `Some(true/false)` sets that channel, `None` leaves it. When
/// the resulting override holds no forced channel it is dropped (back to the
/// trigger's own default).
#[tauri::command]
pub fn set_channel_override(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    speak: Option<bool>,
    alert: Option<bool>,
) -> Result<(), String> {
    let cfg = lock(&state.config, "config")?.clone();
    let mut profile = load_profile(&app, &cfg);
    let overrides = &mut profile.active_loadout_mut().channel_overrides;
    let entry = overrides.entry(id.clone()).or_default();
    if speak.is_some() {
        entry.speak = speak;
    }
    if alert.is_some() {
        entry.alert = alert;
    }
    if entry.speak.is_none() && entry.alert.is_none() {
        overrides.remove(&id);
    }
    save_profile(&app, &cfg, &profile)?;
    rebuild_if_tailing(&app, &state)?;
    emit_profile_changed(&app, &profile);
    Ok(())
}

/// Switch the active character. Repoints the configured log at that
/// character's file, loads its stored profile (a fresh default if absent),
/// hydrates the per-character overrides (log path, pets) into the live config,
/// persists both `settings.json` and the character's profile, rebuilds the
/// live engine if tailing, and re-emits `config-changed` + `profile-changed`
/// so every window resyncs.
#[tauri::command]
pub fn set_active_character(
    app: AppHandle,
    state: State<'_, AppState>,
    server: String,
    character: String,
) -> Result<(), String> {
    let id = CharacterId::new(character, server);
    let mut cfg = lock(&state.config, "config")?.clone();
    let root = &crate::data_root::resolve(&app).path;
    let loaded = storage::load_character(root, &id).map_err(|e| e.to_string())?;

    // Point the live config at the chosen character.
    cfg.character_name = id.character.clone();
    cfg.active_character = Some(config::ActiveCharacter {
        server: id.server.clone(),
        character: id.character.clone(),
    });
    if let Some(log) = find_log_for(&cfg, &id) {
        cfg.log_path = log;
    } else if let Some(lp) = &loaded.overrides.log_path {
        cfg.log_path = lp.clone();
    }
    cfg.pets = loaded.overrides.pets.clone();

    // Persist settings + the character's overrides (so its log/pets stick),
    // then adopt the new config as the live one BEFORE rebuilding the engine.
    config::save(&app, &cfg)?;
    save_profile(&app, &cfg, &loaded.profile)?;
    *lock(&state.config, "config")? = cfg.clone();
    rebuild_if_tailing(&app, &state)?;

    let _ = app.emit("config-changed", &cfg);
    emit_profile_changed(&app, &loaded.profile);
    Ok(())
}

/// Best-effort resolution of a character's log file: prefer a real
/// `eqlog_<char>_<server>.txt` found by scanning the default Logs dir and the
/// current log's own folder; otherwise construct the conventional filename in
/// whichever logs dir we know about.
fn find_log_for(cfg: &AppConfig, id: &CharacterId) -> Option<String> {
    let mut dirs = vec![PathBuf::from(config::DEFAULT_LOGS_DIR)];
    let current_dir = Path::new(cfg.log_path.trim())
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf);
    if let Some(dir) = &current_dir {
        dirs.push(dir.clone());
    }
    let matches = |server: &str| {
        server.eq_ignore_ascii_case(&id.server)
            || (server.is_empty() && id.server == storage::DEFAULT_SERVER)
    };
    if let Some(found) = crate::discover::scan(&dirs)
        .into_iter()
        .find(|d| d.character.eq_ignore_ascii_case(&id.character) && matches(&d.server))
    {
        return Some(found.path);
    }
    // No file on disk yet — construct the conventional name.
    let file = if id.server == storage::DEFAULT_SERVER {
        format!("eqlog_{}.txt", id.character)
    } else {
        format!("eqlog_{}_{}.txt", id.character, id.server)
    };
    let dir = current_dir.unwrap_or_else(|| PathBuf::from(config::DEFAULT_LOGS_DIR));
    Some(dir.join(file).to_string_lossy().into_owned())
}

// ---------- commands: tree ----------

/// One trigger, flattened for the Triggers-tab tree. `effective_enabled` is
/// the profile resolution AND the pack-level `enabled` switch — exactly what
/// the engine would compile.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TriggerTreeEntry {
    pub id: String,
    pub name: String,
    pub category: Option<String>,
    pub classes: Vec<String>,
    pub default_enabled: bool,
    pub effective_enabled: bool,
    pub enabled: bool,
    pub source: &'static str,
    pub pattern: String,
    /// Output channels this trigger uses, summarized from its actions so the
    /// Triggers tab can show at a glance whether a trigger speaks (TTS), shows
    /// a text alert, plays a sound, runs a timer, or posts to a webhook —
    /// without opening each one.
    pub speaks: bool,
    pub shows: bool,
    pub sound: bool,
    pub timer: bool,
    pub webhook: bool,
    /// Index into the user pack file for user/gina triggers (edit/delete
    /// target); `None` for read-only bundled triggers.
    pub user_index: Option<usize>,
}

fn tree_entry(
    t: &Trigger,
    profile: &CharacterProfile,
    user_index: Option<usize>,
) -> TriggerTreeEntry {
    use eqlog_triggers::model::Action;
    // Resolve channels AFTER any per-trigger channel override, so the chips
    // show the effective TTS/alert state (works for read-only pack triggers).
    let id = t.effective_id();
    let actions: std::borrow::Cow<'_, [Action]> =
        match profile.active_loadout().channel_overrides.get(&id) {
            Some(ov) => {
                let mut resolved = t.clone();
                eqlog_triggers::apply_channel_override(&mut resolved, ov);
                std::borrow::Cow::Owned(resolved.actions)
            }
            None => std::borrow::Cow::Borrowed(&t.actions),
        };
    let mut speaks = false;
    let mut shows = false;
    let mut sound = false;
    let mut timer = false;
    let mut webhook = false;
    for a in actions.iter() {
        match a {
            Action::Speak { .. } => speaks = true,
            Action::DisplayText { .. } => shows = true,
            Action::PlaySound { .. } => sound = true,
            Action::StartTimer { .. } | Action::CancelTimer { .. } => timer = true,
            Action::PostWebhook { .. } => webhook = true,
        }
    }
    TriggerTreeEntry {
        id,
        name: t.name.clone(),
        category: t.category.clone(),
        classes: t.classes.clone(),
        default_enabled: t.default_enabled,
        effective_enabled: t.enabled && effective_enabled(t, profile),
        enabled: t.enabled,
        source: match t.source {
            TriggerSource::Generated => "generated",
            TriggerSource::Curated => "curated",
            TriggerSource::User => "user",
            TriggerSource::Gina => "gina",
            TriggerSource::Shared => "shared",
        },
        pattern: t.pattern.clone(),
        speaks,
        shows,
        sound,
        timer,
        webhook,
        user_index,
    }
}

#[tauri::command]
pub fn get_trigger_tree(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<TriggerTreeEntry>, String> {
    let cfg = lock(&state.config, "config")?.clone();
    let lib = load_library(&app, &cfg)?;
    let profile = load_profile(&app, &cfg);
    let mut out = Vec::with_capacity(lib.packs.len() + lib.user.len());
    for t in &lib.packs {
        out.push(tree_entry(t, &profile, None));
    }
    for (i, t) in lib.user.iter().enumerate() {
        out.push(tree_entry(t, &profile, Some(i)));
    }
    Ok(out)
}

// ---------- commands: class auto-detect ----------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DetectedClasses {
    pub classes: Vec<String>,
    pub confidence: f64,
}

/// If `s` is a pure regex-escaped literal, un-escape it; `None` when it
/// contains real regex machinery (alternations, wildcards, …).
fn regex_literal(s: &str) -> Option<String> {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            out.push(chars.next()?);
        } else if ".*+?()[]{}|^$".contains(c) {
            return None;
        } else {
            out.push(c);
        }
    }
    Some(out)
}

/// Spell name → castable classes, derived from the generated buff packs'
/// cast-start patterns (`^You begin casting <literal>\.$`), so class detect
/// needs no separate spell database at runtime.
fn spell_class_map(triggers: &[Trigger]) -> HashMap<String, Vec<String>> {
    const PREFIX: &str = "^You begin casting ";
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    for t in triggers {
        if t.classes.is_empty() {
            continue;
        }
        let Some(rest) = t.pattern.strip_prefix(PREFIX) else {
            continue;
        };
        let rest = rest
            .strip_suffix("\\.$")
            .or_else(|| rest.strip_suffix("\\."))
            .unwrap_or(rest);
        let Some(name) = regex_literal(rest).filter(|n| !n.is_empty()) else {
            continue;
        };
        let entry = map.entry(name).or_default();
        for class in &t.classes {
            if !entry.iter().any(|e| e.eq_ignore_ascii_case(class)) {
                entry.push(class.clone());
            }
        }
    }
    map
}

/// Guess the character's up-to-3 classes from spells they were seen casting.
#[tauri::command]
#[allow(dead_code)] // unregistered — auto-detect UI removed; CLI has eqlog detect
pub fn detect_character_classes(
    app: AppHandle,
    state: State<'_, AppState>,
    spell_names: Vec<String>,
) -> Result<DetectedClasses, String> {
    let cfg = lock(&state.config, "config")?.clone();
    let lib = load_library(&app, &cfg)?;
    let map = spell_class_map(&lib.packs);
    let names: Vec<&str> = spell_names.iter().map(String::as_str).collect();
    let detection = eqlog_triggers::detect_classes(&names, &map);
    Ok(DetectedClasses {
        classes: detection.classes,
        confidence: detection.confidence,
    })
}
