//! eqlog-triggers — regex trigger engine + GINA .gtp package import.
//! Playback (TTS/audio) is the host app's job via the [`engine::ActionSink`]
//! trait; this crate only models, matches, and times.

pub mod buff_lands;
pub mod classdetect;
pub mod engine;
pub mod gina;
pub mod model;
pub mod packs;
pub mod profile;
pub mod share;
pub mod storage;

pub use classdetect::{detect_classes, ClassDetection};
pub use engine::{
    apply_channel_override, ActionSink, OverlayFire, TimerFire, TimerFireKind, TriggerEngine,
    TriggerFireInfo,
};
pub use gina::{import_gtp, GinaImport, GinaImportError};
pub use model::{
    duration_ticks_at_level, infer_timer_lane, Action, ChannelOverride, CharacterProfile, Loadout,
    ProfileError, TimerLane, TimerStartMode, TimerTiming, Trigger, TriggerPack, TriggerSource,
    DEFAULT_LOADOUT_NAME,
};
pub use packs::{load_packs, LoadedPacks};
pub use profile::{effective_enabled, effective_enabled_in_loadout, zone_scope_for};
pub use share::{
    decode_string, diff_triggers, export_gtp, export_string, merge_update_user_pack, parse_string,
    DiffKind, MergeOutcome, ShareError, ShareImport, SharePayload, TriggerDiffEntry, SHARE_PREFIX,
};
pub use storage::{
    list_characters, load_character, migrate_flat_layout, parse_log_filename, save_character,
    CharacterId, CharacterOverrides, LoadedCharacter, MigrationReport, StorageError,
    DEFAULT_SERVER,
};
