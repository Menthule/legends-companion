//! Storage-layout v2 tests (Phases 2/3/6): server-keyed identity, split
//! loadout round-trips, and copy-forward migration from the flat v1 layout.
//! All pure `std::fs` on a scratch tempdir — runs in WSL, no Tauri.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use eqlog_triggers::model::ChannelOverride;
use eqlog_triggers::storage::{self, CharacterId, CharacterOverrides, DEFAULT_SERVER};
use eqlog_triggers::{CharacterProfile, Loadout};

/// A unique, freshly-emptied scratch dir per call.
fn scratch(tag: &str) -> PathBuf {
    static N: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "lc-storage-{}-{}-{}",
        tag,
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create scratch");
    dir
}

fn loadout_with(name: &str, classes: &[&str], overrides: &[(&str, bool)]) -> Loadout {
    let mut l = Loadout::new(name);
    l.classes = classes.iter().map(|s| s.to_string()).collect();
    l.overrides = overrides.iter().map(|(k, v)| (k.to_string(), *v)).collect();
    l
}

// ------------------------------------------------------------------ Phase 2

#[test]
fn parse_log_filename_yields_character_and_server() {
    assert_eq!(
        storage::parse_log_filename("eqlog_Torvin_oggok.txt"),
        Some(("Torvin".into(), "oggok".into()))
    );
    assert_eq!(
        storage::parse_log_filename("eqlog_Vibarn.txt"),
        Some(("Vibarn".into(), "".into()))
    );
    assert_eq!(storage::parse_log_filename("dbg.txt"), None);
}

#[test]
fn serverless_log_maps_to_default_bucket() {
    let id = CharacterId::from_log_filename("eqlog_Vibarn.txt").unwrap();
    assert_eq!(id.server, DEFAULT_SERVER);
    assert_eq!(id.server_slug(), "default");
    assert_eq!(id.character_slug(), "vibarn");
}

#[test]
fn same_name_different_server_are_distinct_paths() {
    let root = scratch("distinct");
    let a = CharacterId::new("Torvin", "oggok");
    let b = CharacterId::new("Torvin", "vox");
    assert_ne!(a.dir(&root), b.dir(&root));
    assert!(a.dir(&root).ends_with("characters/oggok/torvin"));
    assert!(b.dir(&root).ends_with("characters/vox/torvin"));
}

// ------------------------------------------------------------------ Phase 3

#[test]
fn missing_profile_yields_fresh_default() {
    let root = scratch("missing");
    let id = CharacterId::new("Newbie", "oggok");
    let loaded = storage::load_character(&root, &id).unwrap();
    assert!(!loaded.existed);
    assert_eq!(loaded.profile.character, "Newbie");
    assert_eq!(loaded.profile.loadouts.len(), 1);
    assert_eq!(loaded.overrides, CharacterOverrides::default());
}

#[test]
fn round_trip_splits_loadouts_into_files_and_reassembles() {
    let root = scratch("roundtrip");
    let id = CharacterId::new("Torvin", "oggok");

    let mut raiding = loadout_with("Raiding", &["Shaman"], &[("universal/resist-out", false)]);
    raiding.channel_overrides.insert(
        "universal/ding".to_string(),
        ChannelOverride {
            speak: Some(true),
            alert: Some(false),
        },
    );
    let soloing = loadout_with("Soloing", &["Necromancer"], &[("dots/curse", true)]);

    let profile = CharacterProfile {
        character: "Torvin".into(),
        level: 60,
        active_loadout: "Soloing".into(),
        loadouts: vec![raiding, soloing],
    };
    let overrides = CharacterOverrides {
        log_path: Some("C:/Logs/eqlog_Torvin_oggok.txt".into()),
        pets: vec!["Gerp".into()],
    };

    storage::save_character(&root, &id, &profile, &overrides).unwrap();

    // Each loadout is its own file; profile.json does NOT embed loadout bodies.
    let dir = id.dir(&root);
    assert!(dir.join("loadouts/raiding.json").is_file());
    assert!(dir.join("loadouts/soloing.json").is_file());
    let header = std::fs::read_to_string(dir.join("profile.json")).unwrap();
    assert!(
        !header.contains("\"overrides\""),
        "loadout bodies leaked into profile.json"
    );
    assert!(header.contains("\"activeLoadout\""));

    let loaded = storage::load_character(&root, &id).unwrap();
    assert!(loaded.existed);
    assert_eq!(loaded.profile.level, 60);
    assert_eq!(loaded.overrides, overrides);
    // active-loadout resolution survives the split.
    assert_eq!(loaded.profile.active_loadout().name, "Soloing");
    assert_eq!(loaded.profile.active_loadout().classes, vec!["Necromancer"]);
    // override-by-ID preserved.
    let raid = loaded
        .profile
        .loadouts
        .iter()
        .find(|l| l.name == "Raiding")
        .unwrap();
    assert_eq!(raid.overrides.get("universal/resist-out"), Some(&false));
    assert_eq!(
        raid.channel_overrides.get("universal/ding"),
        Some(&ChannelOverride {
            speak: Some(true),
            alert: Some(false)
        })
    );
}

#[test]
fn colliding_loadout_slugs_do_not_overwrite_each_other() {
    // P19: two loadout names that slugify identically ("Raid" and "Raid!")
    // must not share a filename — otherwise the second write clobbers the
    // first and that loadout silently vanishes on the next load.
    let root = scratch("slug-collision");
    let id = CharacterId::new("Torvin", "oggok");

    let a = loadout_with("Raid", &["Warrior"], &[("a/one", true)]);
    let b = loadout_with("Raid!", &["Cleric"], &[("b/two", false)]);
    let profile = CharacterProfile {
        character: "Torvin".into(),
        level: 40,
        active_loadout: "Raid".into(),
        loadouts: vec![a, b],
    };
    storage::save_character(&root, &id, &profile, &CharacterOverrides::default()).unwrap();

    // Distinct files: the second colliding slug gets a numeric suffix.
    let dir = id.dir(&root);
    assert!(dir.join("loadouts/raid.json").is_file());
    assert!(dir.join("loadouts/raid-2.json").is_file());

    // Both loadouts survive the round-trip with their display names intact.
    let loaded = storage::load_character(&root, &id).unwrap();
    assert_eq!(loaded.profile.loadouts.len(), 2);
    let names: std::collections::BTreeSet<&str> = loaded
        .profile
        .loadouts
        .iter()
        .map(|l| l.name.as_str())
        .collect();
    assert!(names.contains("Raid"), "names: {names:?}");
    assert!(names.contains("Raid!"), "names: {names:?}");
}

#[test]
fn deleting_a_loadout_prunes_its_file() {
    let root = scratch("prune");
    let id = CharacterId::new("Torvin", "oggok");

    let two = CharacterProfile {
        character: "Torvin".into(),
        level: 50,
        active_loadout: "Raiding".into(),
        loadouts: vec![
            loadout_with("Raiding", &[], &[]),
            loadout_with("Soloing", &[], &[]),
        ],
    };
    storage::save_character(&root, &id, &two, &CharacterOverrides::default()).unwrap();
    assert!(id.dir(&root).join("loadouts/soloing.json").is_file());

    // Save again without Soloing → its file must be gone.
    let one = CharacterProfile {
        loadouts: vec![loadout_with("Raiding", &[], &[])],
        ..two
    };
    storage::save_character(&root, &id, &one, &CharacterOverrides::default()).unwrap();
    assert!(id.dir(&root).join("loadouts/raiding.json").is_file());
    assert!(!id.dir(&root).join("loadouts/soloing.json").exists());
}

#[test]
fn list_characters_enumerates_all_servers() {
    let root = scratch("list");
    for (c, s) in [("Torvin", "oggok"), ("Torvin", "vox"), ("Ellara", "oggok")] {
        let id = CharacterId::new(c, s);
        storage::save_character(
            &root,
            &id,
            &CharacterProfile::new(c),
            &CharacterOverrides::default(),
        )
        .unwrap();
    }
    let all = storage::list_characters(&root);
    assert_eq!(all.len(), 3);
    assert!(all
        .iter()
        .any(|i| i.character == "Torvin" && i.server == "vox"));
    assert!(all
        .iter()
        .any(|i| i.character == "Ellara" && i.server == "oggok"));
}

// ------------------------------------------------------------------ Phase 6

/// Build a mock flat v1 layout under `root` and return the expected identity.
fn mock_flat_layout(root: &std::path::Path) {
    // config.json (camelCase, as the app writes it).
    let config = serde_json::json!({
        "logPath": "C:/Logs/eqlog_Torvin_oggok.txt",
        "characterName": "Torvin",
        "triggerPackPath": "",
        "pets": ["Gerp", "Blorp"],
        "resumeTailing": true
    });
    std::fs::write(
        root.join("config.json"),
        serde_json::to_string_pretty(&config).unwrap(),
    )
    .unwrap();

    // profiles/torvin.json — current multi-loadout shape with overrides.
    let mut raiding = loadout_with("Raiding", &["Shaman"], &[("universal/resist-out", false)]);
    raiding.channel_overrides.insert(
        "universal/ding".into(),
        ChannelOverride {
            speak: Some(false),
            alert: Some(true),
        },
    );
    let soloing = loadout_with(
        "Soloing",
        &["Necromancer"],
        &[("dots/curse", true), ("dots/venom", false)],
    );
    let profile = CharacterProfile {
        character: "Torvin".into(),
        level: 65,
        active_loadout: "Soloing".into(),
        loadouts: vec![raiding, soloing],
    };
    std::fs::create_dir_all(root.join("profiles")).unwrap();
    profile.save(&root.join("profiles/torvin.json")).unwrap();

    // triggers.json — a user pack.
    std::fs::write(root.join("triggers.json"), "{\"triggers\":[]}").unwrap();
}

#[test]
fn migration_copies_forward_and_preserves_everything() {
    let root = scratch("migrate");
    mock_flat_layout(&root);

    // Snapshot old files to prove they're untouched afterward.
    let old_config = std::fs::read_to_string(root.join("config.json")).unwrap();
    let old_profile = std::fs::read_to_string(root.join("profiles/torvin.json")).unwrap();
    let old_triggers = std::fs::read_to_string(root.join("triggers.json")).unwrap();

    let report = storage::migrate_flat_layout(&root).unwrap();
    assert!(report.ran);
    let id = report.character.clone().unwrap();
    assert_eq!(id.server, "oggok");
    assert_eq!(id.character, "Torvin");
    assert_eq!(report.loadouts_migrated, 2);
    // 1 enable + 1 channel (raiding) + 2 enable (soloing) = 4 overrides.
    assert_eq!(report.overrides_migrated, 4);
    assert!(report.triggers_pack_migrated);
    assert!(report.settings_written);

    // New layout is correct + complete.
    let loaded = storage::load_character(&root, &id).unwrap();
    assert!(loaded.existed);
    assert_eq!(loaded.profile.level, 65);
    assert_eq!(loaded.profile.active_loadout().name, "Soloing");
    assert_eq!(
        loaded.overrides.log_path.as_deref(),
        Some("C:/Logs/eqlog_Torvin_oggok.txt")
    );
    assert_eq!(loaded.overrides.pets, vec!["Gerp", "Blorp"]);
    let raid = loaded
        .profile
        .loadouts
        .iter()
        .find(|l| l.name == "Raiding")
        .unwrap();
    assert_eq!(raid.overrides.get("universal/resist-out"), Some(&false));
    assert_eq!(
        raid.channel_overrides.get("universal/ding"),
        Some(&ChannelOverride {
            speak: Some(false),
            alert: Some(true)
        })
    );

    // User pack copied.
    assert_eq!(
        std::fs::read_to_string(root.join("triggers/my-triggers.json")).unwrap(),
        old_triggers
    );

    // settings.json: global keys folded in, per-char keys dropped, pointer added.
    let settings: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(root.join("settings.json")).unwrap())
            .unwrap();
    assert_eq!(settings["resumeTailing"], serde_json::json!(true));
    assert!(settings.get("logPath").is_none());
    assert!(settings.get("characterName").is_none());
    assert!(settings.get("pets").is_none());
    assert_eq!(settings["activeCharacter"]["server"], "oggok");
    assert_eq!(settings["activeCharacter"]["character"], "Torvin");

    // COPY-FORWARD: old flat files untouched, byte-for-byte.
    assert_eq!(
        std::fs::read_to_string(root.join("config.json")).unwrap(),
        old_config
    );
    assert_eq!(
        std::fs::read_to_string(root.join("profiles/torvin.json")).unwrap(),
        old_profile
    );
    assert_eq!(
        std::fs::read_to_string(root.join("triggers.json")).unwrap(),
        old_triggers
    );
}

#[test]
fn migration_is_idempotent() {
    let root = scratch("idem");
    mock_flat_layout(&root);
    assert!(storage::migrate_flat_layout(&root).unwrap().ran);

    // Tamper with the migrated profile, then re-run: must NOT clobber it.
    let id = CharacterId::new("Torvin", "oggok");
    let mut loaded = storage::load_character(&root, &id).unwrap();
    loaded.profile.level = 99;
    storage::save_character(&root, &id, &loaded.profile, &loaded.overrides).unwrap();

    let second = storage::migrate_flat_layout(&root).unwrap();
    assert!(!second.ran, "second migration must be a no-op");
    assert_eq!(
        storage::load_character(&root, &id).unwrap().profile.level,
        99
    );
}

#[test]
fn migration_serverless_log_uses_default_bucket() {
    let root = scratch("migrate-serverless");
    let config = serde_json::json!({
        "logPath": "C:/Logs/eqlog_Vibarn.txt",
        "characterName": "Vibarn",
        "pets": []
    });
    std::fs::write(root.join("config.json"), config.to_string()).unwrap();
    std::fs::create_dir_all(root.join("profiles")).unwrap();
    CharacterProfile::new("Vibarn")
        .save(&root.join("profiles/vibarn.json"))
        .unwrap();

    let report = storage::migrate_flat_layout(&root).unwrap();
    let id = report.character.unwrap();
    assert_eq!(id.server, DEFAULT_SERVER);
    assert!(id.dir(&root).ends_with("characters/default/vibarn"));
    assert!(id.dir(&root).join("profile.json").is_file());
}

#[test]
fn migration_accepts_legacy_single_loadout_profile() {
    let root = scratch("migrate-legacy");
    let config = serde_json::json!({
        "logPath": "C:/Logs/eqlog_Old_oggok.txt",
        "characterName": "Old"
    });
    std::fs::write(root.join("config.json"), config.to_string()).unwrap();
    std::fs::create_dir_all(root.join("profiles")).unwrap();
    // Legacy shape: no active_loadout, flat classes+overrides.
    let legacy = serde_json::json!({
        "character": "Old",
        "level": 55,
        "classes": ["Warrior"],
        "overrides": { "universal/ding": false }
    });
    std::fs::write(root.join("profiles/old.json"), legacy.to_string()).unwrap();

    let report = storage::migrate_flat_layout(&root).unwrap();
    assert!(report.ran);
    let loaded = storage::load_character(&root, &report.character.unwrap()).unwrap();
    assert_eq!(loaded.profile.level, 55);
    assert_eq!(loaded.profile.active_loadout().classes, vec!["Warrior"]);
    assert_eq!(
        loaded
            .profile
            .active_loadout()
            .overrides
            .get("universal/ding"),
        Some(&false)
    );
}

// Silence unused-import lints if a helper drifts.
#[allow(dead_code)]
fn _touch(_: BTreeMap<String, bool>) {}
