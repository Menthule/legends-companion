//! Trigger data model: what a trigger is, what actions it can fire, and the
//! JSON pack format used for `triggers/*.json` on disk. Also the per-character
//! [`CharacterProfile`] that layers enable/disable overrides on top of packs.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

fn default_true() -> bool {
    true
}

/// Where a trigger definition came from. Serialized lowercase in pack JSON
/// (`"generated"`, `"curated"`, `"user"`, `"gina"`, `"shared"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TriggerSource {
    Generated,
    Curated,
    #[default]
    User,
    Gina,
    /// Imported from a Legends Companion share string (see [`crate::share`]).
    Shared,
}

fn is_user_source(source: &TriggerSource) -> bool {
    *source == TriggerSource::User
}

/// A single user trigger. Patterns are regexes over the message portion of a
/// log line and may contain GINA-style tokens (`{C}`, `{S}`, `{S1}`, `{N}`,
/// …) which the engine expands before compiling.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Trigger {
    pub name: String,
    /// Regex applied to the message portion of each log line. Supports
    /// GINA-style tokens ({C} = character name) expanded before compile.
    pub pattern: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub actions: Vec<Action>,
    /// Folder path for UI grouping, e.g. `"Combat/Defense"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// Free-form notes (GINA `Comments`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comments: Option<String>,
    /// Match case-insensitively (default true).
    #[serde(default = "default_true")]
    pub case_insensitive: bool,
    /// Stable slug id, e.g. `"class/enchanter/cc/mez-broken"`. When absent the
    /// id is derived from category + name (see [`Trigger::effective_id`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Class names this trigger applies to (exact names, e.g. `"Enchanter"`,
    /// `"ShadowKnight"`). Empty = applies to all classes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub classes: Vec<String>,
    /// Whether the trigger is on by default before profile overrides
    /// (default true). Distinct from `enabled`, the pack-level hard switch.
    #[serde(default = "default_true")]
    pub default_enabled: bool,
    /// Provenance of the definition (default `"user"`).
    #[serde(default, skip_serializing_if = "is_user_source")]
    pub source: TriggerSource,
    /// Refire cooldown in seconds: after firing, the trigger stays silent
    /// for this long even when new lines match (GINA's "lockout" — the
    /// anti-spam throttle for repeating combat lines). `None`/0 = fire on
    /// every match.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cooldown_secs: Option<u64>,
    /// Higher-priority triggers are evaluated before lower-priority triggers.
    /// This lets curated packs put specific "quiet" matches ahead of generic
    /// noisy matches without depending on file order.
    #[serde(default, skip_serializing_if = "is_zero_i32")]
    pub priority: i32,
    /// Match this trigger and then stop processing the line without firing its
    /// actions. Useful for null/suppression triggers that prevent broad catch-
    /// alls from speaking on known-benign lines.
    #[serde(default, skip_serializing_if = "is_false")]
    pub suppress: bool,
    /// Zone scope: zone-name substrings (case-insensitive) this trigger is
    /// limited to. Empty = fires in every zone. Non-empty = fires only while
    /// the current zone (learned from `You have entered …` log lines) contains
    /// one of these substrings — e.g. `["Sebilis"]` matches "New Sebilis
    /// Expedition". Until a zone line is seen, the current zone is unknown and
    /// zone-scoped triggers stay quiet. Pack-authored; the user can override it
    /// per loadout via [`Loadout::zone_scopes`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub zones: Vec<String>,
}

impl Trigger {
    /// Convenience constructor with the optional fields defaulted.
    pub fn new(name: impl Into<String>, pattern: impl Into<String>, actions: Vec<Action>) -> Self {
        Trigger {
            name: name.into(),
            pattern: pattern.into(),
            enabled: true,
            actions,
            category: None,
            comments: None,
            case_insensitive: true,
            id: None,
            classes: Vec::new(),
            default_enabled: true,
            source: TriggerSource::User,
            cooldown_secs: None,
            priority: 0,
            suppress: false,
            zones: Vec::new(),
        }
    }

    /// The trigger's stable id: the explicit `id` when set, otherwise a slug
    /// derived from the category path + name (`"combat/defense/stunned"`), or
    /// just the name slug when there is no category.
    pub fn effective_id(&self) -> String {
        if let Some(id) = &self.id {
            if !id.is_empty() {
                return id.clone();
            }
        }
        match self.category.as_deref().filter(|c| !c.is_empty()) {
            Some(category) => format!("{}/{}", slugify_path(category), slugify(&self.name)),
            None => slugify(&self.name),
        }
    }
}

fn is_zero_i32(value: &i32) -> bool {
    *value == 0
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// Lowercase a string into a slug: alphanumerics kept, every other run of
/// characters collapsed to a single `-`, trimmed of leading/trailing `-`.
pub fn slugify(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut pending_dash = false;
    for ch in s.chars() {
        if ch.is_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.extend(ch.to_lowercase());
        } else {
            pending_dash = true;
        }
    }
    out
}

/// Slugify each `/`-separated segment of a category path, preserving the
/// segment boundaries: `"Class/Enchanter/Crowd Control"` →
/// `"class/enchanter/crowd-control"`. Empty segments are dropped.
fn slugify_path(path: &str) -> String {
    path.split('/')
        .map(slugify)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

/// Which overlay lane a timer belongs to. Serialized lowercase in pack JSON
/// (`"buff"`, `"enemy"`, `"other"`).
///
/// - `Buff`: your own beneficial-buff countdowns (buffs overlay).
/// - `Enemy`: effects you put on enemies — DoTs, mez/root/snare, debuffs
///   (target overlay).
/// - `Other`: everything else (recast windows, respawns, …), shown with the
///   buff lane on the dashboard/buffs overlay so no timer is orphaned.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TimerLane {
    Buff,
    Enemy,
    /// Buffs YOU cast on OTHER people — a dedicated "on others" overlay lane,
    /// kept separate from your own buffs (the `Buff` lane).
    #[serde(rename = "on-others")]
    OnOthers,
    #[default]
    Other,
}

/// What to do when a `StartTimer` action starts a timer whose name is already
/// running. Serialized lowercase in JSON.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TimerStartMode {
    /// Replace the existing timer with the new countdown. This is the legacy
    /// behavior and matches most buff/debuff timers.
    #[default]
    Restart,
    /// Leave the existing timer alone and ignore this start.
    IgnoreIfRunning,
    /// Start another instance, suffixing the overlay name as "(2)", "(3)", …
    StartNewInstance,
}

impl TimerLane {
    /// Wire name, matching the serde encoding
    /// (`"buff"`/`"enemy"`/`"on-others"`/`"other"`).
    pub fn as_str(self) -> &'static str {
        match self {
            TimerLane::Buff => "buff",
            TimerLane::Enemy => "enemy",
            TimerLane::OnOthers => "on-others",
            TimerLane::Other => "other",
        }
    }
}

/// Lane inference fallback for `StartTimer` actions that don't carry an
/// explicit `lane` (curated v1 packs, GINA imports, user triggers): decide
/// from the trigger's category path and stable id.
///
/// - category starting with `Buffs/` → [`TimerLane::Buff`]
/// - category containing `Enemy`, `Debuff`, or `Crowd Control`, or an id
///   containing a `/cc/` segment → [`TimerLane::Enemy`]
/// - anything else → [`TimerLane::Other`]
pub fn infer_timer_lane(category: Option<&str>, id: &str) -> TimerLane {
    let cat = category.unwrap_or("").to_ascii_lowercase();
    if cat.starts_with("buffs/") || cat == "buffs" {
        return TimerLane::Buff;
    }
    let id = id.to_ascii_lowercase();
    if cat.contains("enemy")
        || cat.contains("debuff")
        || cat.contains("crowd control")
        || cat.contains("/cc")
        || id.contains("/cc/")
    {
        return TimerLane::Enemy;
    }
    TimerLane::Other
}

/// An action fired when a trigger matches. Templates may reference positional
/// captures (`${1}`), named captures (`${S1}`, `${sender}`), the character
/// name (`{C}`), and the line timestamp (`{TS}`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Action {
    /// Text-to-speech. Template may reference capture groups (`${1}`) and
    /// tokens ({C}).
    Speak {
        template: String,
    },
    PlaySound {
        path: String,
    },
    DisplayText {
        template: String,
    },
    StartTimer {
        name: String,
        duration_secs: u64,
        /// Seconds before expiry to fire the ending warning, if any.
        warn_at_secs: Option<u64>,
        /// Classic EQ duration formula id (spells_us field 11). When set,
        /// the engine recomputes `duration_secs` for the profile's level
        /// via [`duration_ticks_at_level`] — generated packs bake the
        /// level-50 duration and carry the formula for rescaling.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_formula: Option<u32>,
        /// Duration cap in ticks (spells_us field 12; 0/absent = uncapped).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_cap_ticks: Option<u32>,
        /// Overlay lane (`"buff"` | `"enemy"` | `"other"`). Additive: absent
        /// in older packs, in which case the engine falls back to
        /// [`infer_timer_lane`] over the trigger's category/id (an absent
        /// lane that infers nothing behaves as `"other"`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lane: Option<TimerLane>,
        /// Spell cast time in whole seconds (spells_us field 8, rounded up).
        /// Cast-start triggers fire before the effect exists; the engine
        /// adds this lead-in so expiry lands on the true wear-off moment.
        /// Additive: absent = 0.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cast_time_secs: Option<u64>,
        /// Duplicate-name behavior. Absent = restart, preserving legacy packs.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mode: Option<TimerStartMode>,
        /// Repeat the timer every N seconds after expiry. Absent/0 = one-shot.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        repeat_secs: Option<u64>,
        /// Start a stopwatch-style bar. The current overlay protocol has no
        /// elapsed-only timer primitive yet, so hosts may display this as a
        /// zero-duration running timer until cancelled.
        #[serde(default, skip_serializing_if = "is_false")]
        stopwatch: bool,
        /// Optional host-rendered timer warning/expiry labels. These preserve
        /// imported GINA timer-ending/ended text without adding nested action
        /// execution to timer polling.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        warn_text: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expire_text: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        warn_sound: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expire_sound: Option<String>,
    },
    /// Cancel any active timer with this (template-expanded) name — e.g. a
    /// wear-off line killing the countdown started by the matching cast.
    /// No-op when no such timer is running.
    CancelTimer {
        /// Timer name; supports the same capture/token expansion as the
        /// `StartTimer` name template.
        name: String,
    },
    /// Post a message to a user-configured webhook (a Discord "batphone", or
    /// any generic incoming webhook). The `webhook` names an entry in the
    /// host's settings — the URL lives there, NOT in the trigger — so a shared
    /// pack never leaks a private endpoint; `None` targets the default webhook.
    PostWebhook {
        /// Message body; supports the same capture/token expansion as `Speak`.
        template: String,
        /// Name of the configured webhook to target. Absent = the default one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        webhook: Option<String>,
    },
}

/// Classic EQ buff-duration formula → duration in ticks (1 tick = 6 s) at
/// `level`, clamped to `cap_ticks` when the cap is non-zero. Mirrors
/// `tools/spelldata/extract_spells.py::calc_duration_ticks` (verified
/// against EQSpellParser `Spell.CalcDuration`); keep the two in sync.
pub fn duration_ticks_at_level(formula: u32, cap_ticks: u32, level: u32) -> u32 {
    let value = match formula {
        0 => 0,
        1 => (level / 2).max(1),
        2 => (level / 2 + 5).max(6),
        3 => level * 30,
        4 => 50,
        5 => 2,
        6 => level / 2,
        7 => level,
        8 => level + 10,
        9 => level * 2 + 10,
        10 => level * 30 + 10,
        11 => (level + 3) * 30,
        12 => (level / 2).max(1),
        13 => level * 4 + 10,
        14 => level * 5 + 10,
        15 => (level * 5 + 50) * 2,
        50 => 72_000, // "permanent" (until dispelled/zoned)
        3600 => 3600,
        _ => cap_ticks,
    };
    if cap_ticks > 0 && value > cap_ticks {
        cap_ticks
    } else {
        value
    }
}

/// A named collection of triggers — the on-disk JSON pack format.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TriggerPack {
    pub name: String,
    pub triggers: Vec<Trigger>,
}

fn default_level() -> u32 {
    50
}

/// Name given to the loadout created by [`CharacterProfile::new`] and by
/// migration of legacy single-loadout profile files.
pub const DEFAULT_LOADOUT_NAME: &str = "Default";

/// Per-trigger output-channel override, layered on top of a trigger's own
/// actions at engine build. `None` for a channel = keep the trigger's default;
/// `Some(true)`/`Some(false)` = force that channel on/off. This is what makes
/// TTS (Speak) and the text alert (DisplayText) toggleable on ANY trigger —
/// including read-only bundled/pack triggers — without editing the pack file.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ChannelOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speak: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alert: Option<bool>,
}

/// One named trigger loadout, mirroring the in-game loadout system: a set of
/// classes (up to 3 — Legends characters are tri-class) plus its own complete
/// enable/disable override map. Trigger resolution always runs against
/// exactly one loadout (see [`CharacterProfile::active_loadout`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Loadout {
    pub name: String,
    /// Up to 3 class names, e.g. `["Enchanter", "Cleric", "Wizard"]`.
    #[serde(default)]
    pub classes: Vec<String>,
    /// `<trigger-id or category-path-prefix>` → forced on/off. Resolution:
    /// exact id override > longest matching path-prefix override > trigger
    /// defaults (see [`crate::profile::effective_enabled_in_loadout`]).
    #[serde(default)]
    pub overrides: BTreeMap<String, bool>,
    /// `<trigger-id>` → forced TTS/alert channel state, applied on top of the
    /// trigger's own actions at build time (see
    /// [`crate::engine::apply_channel_override`]).
    #[serde(default)]
    pub channel_overrides: BTreeMap<String, ChannelOverride>,
    /// `<trigger-id or category-path-prefix>` → the zones that scope of
    /// triggers is limited to (same resolution as `overrides`: exact id, then
    /// longest matching path-prefix). A matching entry REPLACES the trigger's
    /// pack-authored [`Trigger::zones`]. This is how a user scopes a whole pack
    /// to one hunting zone ("only run the Sebilis debuff pack in Sebilis")
    /// without editing pack files. Empty value list = the entry scopes to no
    /// zone (effectively muting the branch everywhere); omit the entry to keep
    /// the pack default.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub zone_scopes: BTreeMap<String, Vec<String>>,
}

impl Loadout {
    /// A fresh loadout with no classes and no overrides.
    pub fn new(name: impl Into<String>) -> Self {
        Loadout {
            name: name.into(),
            classes: Vec::new(),
            overrides: BTreeMap::new(),
            channel_overrides: BTreeMap::new(),
            zone_scopes: BTreeMap::new(),
        }
    }
}

/// Fallback for [`CharacterProfile::active_loadout`] on a profile whose
/// `loadouts` list is empty: no classes, no overrides.
static EMPTY_LOADOUT: Loadout = Loadout {
    name: String::new(),
    classes: Vec::new(),
    overrides: BTreeMap::new(),
    channel_overrides: BTreeMap::new(),
    zone_scopes: BTreeMap::new(),
};

/// Per-character trigger settings: level (drives generated timer durations)
/// plus one or more named [`Loadout`]s; classes and enable/disable overrides
/// live PER LOADOUT, and `active_loadout` names the one in effect.
///
/// Deserialization also accepts the legacy single-loadout shape
/// (`{ character, classes, level, overrides }`), migrating it to one loadout
/// named [`DEFAULT_LOADOUT_NAME`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(from = "ProfileWire")]
pub struct CharacterProfile {
    pub character: String,
    pub level: u32,
    /// Name of the entry in `loadouts` that resolution uses (matched
    /// ASCII-case-insensitively; falls back to the first loadout).
    pub active_loadout: String,
    pub loadouts: Vec<Loadout>,
}

/// The two on-disk profile shapes. Untagged: the current shape is tried
/// first and requires `active_loadout`, so legacy files (which lack it)
/// fall through to the migration variant.
#[derive(Deserialize)]
#[serde(untagged)]
enum ProfileWire {
    Current {
        character: String,
        #[serde(default = "default_level")]
        level: u32,
        active_loadout: String,
        #[serde(default)]
        loadouts: Vec<Loadout>,
    },
    Legacy {
        character: String,
        #[serde(default)]
        classes: Vec<String>,
        #[serde(default = "default_level")]
        level: u32,
        #[serde(default)]
        overrides: BTreeMap<String, bool>,
    },
}

impl From<ProfileWire> for CharacterProfile {
    fn from(wire: ProfileWire) -> Self {
        match wire {
            ProfileWire::Current {
                character,
                level,
                active_loadout,
                loadouts,
            } => CharacterProfile {
                character,
                level,
                active_loadout,
                loadouts,
            },
            ProfileWire::Legacy {
                character,
                classes,
                level,
                overrides,
            } => CharacterProfile {
                character,
                level,
                active_loadout: DEFAULT_LOADOUT_NAME.to_string(),
                loadouts: vec![Loadout {
                    name: DEFAULT_LOADOUT_NAME.to_string(),
                    classes,
                    overrides,
                    channel_overrides: BTreeMap::new(),
                    zone_scopes: BTreeMap::new(),
                }],
            },
        }
    }
}

impl CharacterProfile {
    /// A fresh profile at level 50 with a single empty loadout named
    /// [`DEFAULT_LOADOUT_NAME`], active.
    pub fn new(character: impl Into<String>) -> Self {
        CharacterProfile {
            character: character.into(),
            level: default_level(),
            active_loadout: DEFAULT_LOADOUT_NAME.to_string(),
            loadouts: vec![Loadout::new(DEFAULT_LOADOUT_NAME)],
        }
    }

    /// The loadout named by `active_loadout` (ASCII-case-insensitive),
    /// falling back to the first loadout, then to an empty loadout (no
    /// classes, no overrides) when the profile has none at all.
    pub fn active_loadout(&self) -> &Loadout {
        self.loadouts
            .iter()
            .find(|l| l.name.eq_ignore_ascii_case(&self.active_loadout))
            .or_else(|| self.loadouts.first())
            .unwrap_or(&EMPTY_LOADOUT)
    }

    /// Mutable access to the active loadout, creating one first when the
    /// profile has none — so `profile.active_loadout_mut().classes = …`
    /// always sticks. Same name resolution as [`Self::active_loadout`].
    pub fn active_loadout_mut(&mut self) -> &mut Loadout {
        if self.loadouts.is_empty() {
            if self.active_loadout.is_empty() {
                self.active_loadout = DEFAULT_LOADOUT_NAME.to_string();
            }
            self.loadouts
                .push(Loadout::new(self.active_loadout.clone()));
        }
        let idx = self
            .loadouts
            .iter()
            .position(|l| l.name.eq_ignore_ascii_case(&self.active_loadout))
            .unwrap_or(0);
        &mut self.loadouts[idx]
    }

    /// Load a profile from a JSON file.
    pub fn load(path: &Path) -> Result<Self, ProfileError> {
        let text = std::fs::read_to_string(path).map_err(|source| ProfileError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        serde_json::from_str(&text).map_err(|source| ProfileError::Parse {
            path: path.to_path_buf(),
            source,
        })
    }

    /// Save the profile as pretty-printed JSON, creating parent directories
    /// as needed.
    pub fn save(&self, path: &Path) -> Result<(), ProfileError> {
        let io_err = |source| ProfileError::Io {
            path: path.to_path_buf(),
            source,
        };
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent).map_err(io_err)?;
        }
        let json = serde_json::to_string_pretty(self).expect("profile serialization is infallible");
        std::fs::write(path, json).map_err(io_err)
    }
}

/// Errors from [`CharacterProfile::load`]/[`CharacterProfile::save`].
#[derive(Debug, thiserror::Error)]
pub enum ProfileError {
    #[error("profile I/O failed for {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("profile JSON invalid in {path}: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_json_round_trip() {
        let pack = TriggerPack {
            name: "test pack".into(),
            triggers: vec![
                Trigger {
                    name: "stun".into(),
                    pattern: "^You are stunned!".into(),
                    enabled: true,
                    actions: vec![Action::Speak {
                        template: "stunned".into(),
                    }],
                    category: Some("Combat/Defense".into()),
                    comments: Some("classic".into()),
                    case_insensitive: false,
                    id: Some("combat/defense/stunned".into()),
                    classes: vec!["Warrior".into(), "Monk".into()],
                    default_enabled: false,
                    source: TriggerSource::Curated,
                    cooldown_secs: Some(5),
                    priority: 0,
                    suppress: false,
                    zones: Vec::new(),
                },
                Trigger::new(
                    "timer",
                    "^You begin casting {S}\\.",
                    vec![Action::StartTimer {
                        name: "${S}".into(),
                        duration_secs: 30,
                        warn_at_secs: Some(5),
                        duration_formula: Some(3),
                        duration_cap_ticks: Some(360),
                        cast_time_secs: None,
                        mode: None,
                        repeat_secs: None,
                        stopwatch: false,
                        warn_text: None,
                        expire_text: None,
                        warn_sound: None,
                        expire_sound: None,
                        lane: Some(TimerLane::Buff),
                    }],
                ),
                Trigger::new(
                    "canceller",
                    "^Your {S} spell has worn off\\.",
                    vec![Action::CancelTimer {
                        name: "${S}".into(),
                    }],
                ),
            ],
        };
        let json = serde_json::to_string_pretty(&pack).unwrap();
        let back: TriggerPack = serde_json::from_str(&json).unwrap();
        assert_eq!(pack, back);
    }

    #[test]
    fn optional_fields_default_when_absent() {
        let json = r#"{
            "name": "t",
            "pattern": "^x$",
            "actions": []
        }"#;
        let t: Trigger = serde_json::from_str(json).unwrap();
        assert!(t.enabled);
        assert!(t.case_insensitive);
        assert!(t.category.is_none());
        assert!(t.comments.is_none());
        // v2 fields default: id absent, all classes, on by default, user-made.
        assert!(t.id.is_none());
        assert!(t.classes.is_empty());
        assert!(t.default_enabled);
        assert_eq!(t.source, TriggerSource::User);
    }

    #[test]
    fn source_serializes_lowercase() {
        for (source, expect) in [
            (TriggerSource::Generated, "\"generated\""),
            (TriggerSource::Curated, "\"curated\""),
            (TriggerSource::User, "\"user\""),
            (TriggerSource::Gina, "\"gina\""),
            (TriggerSource::Shared, "\"shared\""),
        ] {
            assert_eq!(serde_json::to_string(&source).unwrap(), expect);
            assert_eq!(
                serde_json::from_str::<TriggerSource>(expect).unwrap(),
                source
            );
        }
    }

    #[test]
    fn effective_id_explicit_wins() {
        let mut t = Trigger::new("Mez Broken!", "^x$", vec![]);
        t.id = Some("class/enchanter/cc/mez-broken".into());
        t.category = Some("Something/Else".into());
        assert_eq!(t.effective_id(), "class/enchanter/cc/mez-broken");
    }

    #[test]
    fn effective_id_derived_from_category_and_name() {
        let mut t = Trigger::new("Mez Broken!", "^x$", vec![]);
        assert_eq!(t.effective_id(), "mez-broken");
        t.category = Some("Class/Enchanter/Crowd Control".into());
        assert_eq!(t.effective_id(), "class/enchanter/crowd-control/mez-broken");
    }

    #[test]
    fn slugify_collapses_runs_and_trims() {
        assert_eq!(slugify("  Mez -- Broken!! "), "mez-broken");
        assert_eq!(slugify("Tishan's Clash"), "tishan-s-clash");
        assert_eq!(slugify("SoW"), "sow");
    }

    #[test]
    fn start_timer_formula_fields_optional_and_omitted_when_absent() {
        // Packs without the level-scaling metadata (curated v1, GINA) parse.
        let json =
            r#"{ "StartTimer": { "name": "t", "duration_secs": 30, "warn_at_secs": null } }"#;
        let a: Action = serde_json::from_str(json).unwrap();
        assert_eq!(
            a,
            Action::StartTimer {
                name: "t".into(),
                duration_secs: 30,
                warn_at_secs: None,
                duration_formula: None,
                duration_cap_ticks: None,
                cast_time_secs: None,
                mode: None,
                repeat_secs: None,
                stopwatch: false,
                warn_text: None,
                expire_text: None,
                warn_sound: None,
                expire_sound: None,
                lane: None,
            }
        );
        // And absent metadata stays off the wire.
        let out = serde_json::to_string(&a).unwrap();
        assert!(!out.contains("duration_formula"));
        assert!(!out.contains("duration_cap_ticks"));
        assert!(!out.contains("lane"));
    }

    #[test]
    fn timer_lane_serializes_lowercase_and_defaults_other() {
        for (lane, expect) in [
            (TimerLane::Buff, "\"buff\""),
            (TimerLane::Enemy, "\"enemy\""),
            (TimerLane::Other, "\"other\""),
        ] {
            assert_eq!(serde_json::to_string(&lane).unwrap(), expect);
            assert_eq!(serde_json::from_str::<TimerLane>(expect).unwrap(), lane);
            assert_eq!(format!("\"{}\"", lane.as_str()), expect);
        }
        assert_eq!(TimerLane::default(), TimerLane::Other);
        // Explicit lane round-trips through the action encoding.
        let json = r#"{ "StartTimer": { "name": "t", "duration_secs": 30,
                        "warn_at_secs": null, "lane": "enemy" } }"#;
        let a: Action = serde_json::from_str(json).unwrap();
        assert!(matches!(
            a,
            Action::StartTimer {
                cast_time_secs: None,
                mode: None,
                repeat_secs: None,
                stopwatch: false,
                warn_text: None,
                expire_text: None,
                warn_sound: None,
                expire_sound: None,
                lane: Some(TimerLane::Enemy),
                ..
            }
        ));
        assert!(serde_json::to_string(&a)
            .unwrap()
            .contains("\"lane\":\"enemy\""));
    }

    #[test]
    fn infer_timer_lane_from_category_and_id() {
        use super::infer_timer_lane as infer;
        // Generated buff packs.
        assert_eq!(infer(Some("Buffs/Shaman/Timers"), "x"), TimerLane::Buff);
        assert_eq!(infer(Some("buffs"), "x"), TimerLane::Buff);
        // CC / enemy / debuff categories, and /cc/ id segments.
        assert_eq!(
            infer(Some("Class/Enchanter/Crowd Control"), "x"),
            TimerLane::Enemy
        );
        assert_eq!(infer(Some("Enemy Casts/Gate"), "x"), TimerLane::Enemy);
        assert_eq!(
            infer(Some("Debuffs/Necromancer/Timers"), "x"),
            TimerLane::Enemy
        );
        assert_eq!(
            infer(None, "class/shaman/cc/walking-sleep-timer"),
            TimerLane::Enemy
        );
        // Everything else is "other".
        assert_eq!(
            infer(
                Some("Class/Paladin/Abilities"),
                "class/paladin/abilities/lay-hands-recast"
            ),
            TimerLane::Other
        );
        assert_eq!(infer(None, "my-trigger"), TimerLane::Other);
    }

    #[test]
    fn duration_ticks_reference_values() {
        // SoW: formula 3 cap 360 -> 36 min at 50+, level-scaled below.
        assert_eq!(duration_ticks_at_level(3, 360, 50), 360);
        assert_eq!(duration_ticks_at_level(3, 360, 10), 300);
        // Level 16: 16*30 = 480 ticks, capped to 360 -> 2160 s.
        assert_eq!(duration_ticks_at_level(3, 360, 16), 360);
        assert_eq!(u64::from(duration_ticks_at_level(3, 360, 16)) * 6, 2160);
        // Root: formula 2 cap 8 -> 8 ticks = 48 s at any level.
        assert_eq!(duration_ticks_at_level(2, 8, 50), 8);
        assert_eq!(u64::from(duration_ticks_at_level(2, 8, 16)) * 6, 48);
        // Courage: formula 11 cap 270 -> 27 min.
        assert_eq!(duration_ticks_at_level(11, 270, 50), 270);
        // Walking Sleep: formula 6 cap 35 -> 25 ticks at 50, 8 at level 16.
        assert_eq!(duration_ticks_at_level(6, 35, 50), 25);
        assert_eq!(duration_ticks_at_level(6, 35, 16), 8);
        // Unknown formulas fall back to the cap; cap 0 = uncapped.
        assert_eq!(duration_ticks_at_level(999, 12, 50), 12);
        assert_eq!(duration_ticks_at_level(3, 0, 50), 1500);
    }

    #[test]
    fn duration_ticks_full_table_matches_python_reference() {
        // Byte-sync contract with calc_duration_ticks in
        // tools/spelldata/extract_spells.py (P13): assert EVERY formula branch
        // uncapped at level 20 so a divergence in either implementation trips a
        // test rather than silently mis-scaling generated timers.
        let at20 = |f| duration_ticks_at_level(f, 0, 20);
        assert_eq!(at20(0), 0);
        assert_eq!(at20(1), 10); // max(20/2, 1)
        assert_eq!(at20(2), 15); // max(20/2 + 5, 6)
        assert_eq!(at20(3), 600); // 20*30
        assert_eq!(at20(4), 50);
        assert_eq!(at20(5), 2);
        assert_eq!(at20(6), 10); // 20/2
        assert_eq!(at20(7), 20);
        assert_eq!(at20(8), 30); // 20+10
        assert_eq!(at20(9), 50); // 20*2+10
        assert_eq!(at20(10), 610); // 20*30+10
        assert_eq!(at20(11), 690); // (20+3)*30
        assert_eq!(at20(12), 10); // max(20/2, 1)
        assert_eq!(at20(13), 90); // 20*4+10
        assert_eq!(at20(14), 110); // 20*5+10
        assert_eq!(at20(15), 300); // (20*5+50)*2
        assert_eq!(at20(50), 72_000); // "permanent"
        assert_eq!(at20(3600), 3600);
        assert_eq!(at20(42), 0); // unknown -> cap (0 = uncapped)

        // The max() floors on formulas 1/2/12 bite at level 1; formula 6 has
        // no floor and reaches 0.
        assert_eq!(duration_ticks_at_level(1, 0, 1), 1);
        assert_eq!(duration_ticks_at_level(2, 0, 1), 6);
        assert_eq!(duration_ticks_at_level(6, 0, 1), 0);
        assert_eq!(duration_ticks_at_level(12, 0, 1), 1);

        // Cap clamps only when non-zero and exceeded.
        assert_eq!(duration_ticks_at_level(3, 100, 20), 100); // 600 -> 100
        assert_eq!(duration_ticks_at_level(3, 100, 3), 90); // 90 < 100, kept
        assert_eq!(duration_ticks_at_level(42, 250, 20), 250); // unknown -> cap
    }

    #[test]
    fn profile_defaults_when_fields_absent() {
        // Bare legacy shape: migrates to one empty "Default" loadout.
        let p: CharacterProfile = serde_json::from_str(r#"{"character":"Nyasha"}"#).unwrap();
        assert_eq!(p.character, "Nyasha");
        assert_eq!(p.level, 50);
        assert_eq!(p.active_loadout, DEFAULT_LOADOUT_NAME);
        assert_eq!(p.loadouts.len(), 1);
        assert!(p.active_loadout().classes.is_empty());
        assert!(p.active_loadout().overrides.is_empty());
    }

    #[test]
    fn active_loadout_accessors_resolve_and_self_heal() {
        let mut p = CharacterProfile::new("Nyasha");
        p.loadouts.push(Loadout::new("Raid"));
        p.active_loadout = "raid".into(); // case-insensitive match
        assert_eq!(p.active_loadout().name, "Raid");
        // Unknown name falls back to the first loadout.
        p.active_loadout = "nope".into();
        assert_eq!(p.active_loadout().name, DEFAULT_LOADOUT_NAME);
        // Empty loadout list: read side yields the empty loadout, write side
        // creates one so mutations stick.
        p.loadouts.clear();
        assert!(p.active_loadout().classes.is_empty());
        p.active_loadout = String::new();
        p.active_loadout_mut().classes = vec!["Cleric".into()];
        assert_eq!(p.active_loadout, DEFAULT_LOADOUT_NAME);
        assert_eq!(p.active_loadout().classes, vec!["Cleric"]);
    }
}
