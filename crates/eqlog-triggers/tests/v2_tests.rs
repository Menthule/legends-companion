//! Trigger-library v2 integration tests: new pack fields, per-character
//! profile resolution, profile persistence, multi-pack loading, engine
//! fire-dedupe, and class auto-detection.

use std::collections::HashMap;
use std::path::PathBuf;

use eqlog_core::events::{Event, LogLine, ParsedLine};
use eqlog_triggers::{
    detect_classes, effective_enabled, effective_enabled_in_loadout, load_packs, Action,
    ActionSink, CharacterProfile, Loadout, Trigger, TriggerEngine, TriggerSource,
    DEFAULT_LOADOUT_NAME,
};

// ---------- helpers ----------

#[derive(Default)]
struct RecordingSink {
    spoken: Vec<String>,
    displayed: Vec<String>,
}

impl ActionSink for RecordingSink {
    fn speak(&mut self, text: &str) {
        self.spoken.push(text.to_string());
    }
    fn play_sound(&mut self, _path: &str) {}
    fn display_text(&mut self, text: &str) {
        self.displayed.push(text.to_string());
    }
    fn start_timer(
        &mut self,
        _name: &str,
        _duration_secs: u64,
        _warn_at_secs: Option<u64>,
        _lane: eqlog_triggers::TimerLane,
        _pending_secs: u64,
    ) {
    }
}

fn line(ts: i64, message: &str) -> ParsedLine {
    ParsedLine {
        line: LogLine {
            timestamp: ts,
            message: message.to_string(),
        },
        event: Event::Unclassified,
    }
}

/// Fresh, empty per-test temp directory (std-only; no tempfile dep).
fn fresh_dir(test: &str) -> PathBuf {
    let dir =
        std::env::temp_dir().join(format!("eqlog-triggers-v2-{}-{}", std::process::id(), test));
    if dir.exists() {
        std::fs::remove_dir_all(&dir).unwrap();
    }
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn trig(name: &str, category: Option<&str>, classes: &[&str], default_enabled: bool) -> Trigger {
    let mut t = Trigger::new(
        name,
        "^You are stunned!",
        vec![Action::Speak {
            template: "x".into(),
        }],
    );
    t.category = category.map(str::to_string);
    t.classes = classes.iter().map(|c| c.to_string()).collect();
    t.default_enabled = default_enabled;
    t
}

fn profile(classes: &[&str], overrides: &[(&str, bool)]) -> CharacterProfile {
    let mut p = CharacterProfile::new("Nyasha");
    let loadout = p.active_loadout_mut();
    loadout.classes = classes.iter().map(|c| c.to_string()).collect();
    loadout.overrides = overrides.iter().map(|(k, v)| (k.to_string(), *v)).collect();
    p
}

// ---------- pack JSON contract ----------

#[test]
fn pack_json_with_v2_fields_round_trips_and_defaults() {
    let json = r#"{
        "name": "v2 pack",
        "triggers": [
            {
                "name": "Mez broken",
                "pattern": "^(.+) has been awakened by (.+)\\.",
                "id": "class/enchanter/cc/mez-broken",
                "classes": ["Enchanter", "Bard"],
                "default_enabled": true,
                "source": "curated",
                "category": "Class/Enchanter/CC",
                "actions": [ { "Speak": { "template": "mez broke on ${1}" } } ]
            },
            {
                "name": "Legacy trigger",
                "pattern": "^You died\\.",
                "actions": [ { "Speak": { "template": "died" } } ]
            }
        ]
    }"#;
    let pack: eqlog_triggers::TriggerPack = serde_json::from_str(json).unwrap();
    let mez = &pack.triggers[0];
    assert_eq!(mez.id.as_deref(), Some("class/enchanter/cc/mez-broken"));
    assert_eq!(mez.classes, vec!["Enchanter", "Bard"]);
    assert_eq!(mez.source, TriggerSource::Curated);
    assert!(mez.default_enabled);

    let legacy = &pack.triggers[1];
    assert!(legacy.id.is_none());
    assert!(legacy.classes.is_empty());
    assert!(legacy.default_enabled);
    assert_eq!(legacy.source, TriggerSource::User);

    // Full round trip through JSON preserves everything.
    let back: eqlog_triggers::TriggerPack =
        serde_json::from_str(&serde_json::to_string(&pack).unwrap()).unwrap();
    assert_eq!(pack, back);
}

// ---------- resolution precedence matrix ----------

#[test]
fn default_enabled_and_class_intersection() {
    // (trigger classes, trigger default_enabled, profile classes) -> expected
    let cases: &[(&[&str], bool, &[&str], bool)] = &[
        (&[], true, &[], true),                          // no restriction, no classes
        (&[], true, &["Cleric"], true),                  // no restriction
        (&[], false, &["Cleric"], false),                // default off wins
        (&["Enchanter"], true, &["Enchanter"], true),    // exact intersect
        (&["Enchanter"], true, &["enchanter"], true),    // case-insensitive
        (&["Enchanter"], true, &["Cleric"], false),      // no intersect
        (&["Enchanter"], true, &[], false),              // restricted, profile empty
        (&["Enchanter", "Bard"], true, &["Bard"], true), // any-of intersect
        (&["Enchanter"], false, &["Enchanter"], false),  // default off + intersect
    ];
    for (i, (tc, def, pc, expect)) in cases.iter().enumerate() {
        let t = trig("t", Some("Class/X"), tc, *def);
        let p = profile(pc, &[]);
        assert_eq!(
            effective_enabled(&t, &p),
            *expect,
            "case {i}: classes={tc:?} default={def} profile={pc:?}"
        );
    }
}

#[test]
fn exact_id_override_beats_prefix_and_default() {
    let mut t = trig(
        "Mez broken",
        Some("Class/Enchanter/CC"),
        &["Enchanter"],
        true,
    );
    t.id = Some("class/enchanter/cc/mez-broken".into());
    // Wrong class + group disabled, but exact id forces on.
    let p = profile(
        &["Cleric"],
        &[
            ("Class/Enchanter", false),
            ("class/enchanter/cc/mez-broken", true),
        ],
    );
    assert!(effective_enabled(&t, &p));
    // And exact id forces off even when everything else says on.
    let p = profile(
        &["Enchanter"],
        &[
            ("Class/Enchanter", true),
            ("class/enchanter/cc/mez-broken", false),
        ],
    );
    assert!(!effective_enabled(&t, &p));
}

#[test]
fn longest_prefix_override_wins() {
    let t = trig("Mez broken", Some("Class/Enchanter/CC"), &[], true);
    // Deeper prefix beats shallower, in both directions.
    let p = profile(&[], &[("Class", true), ("Class/Enchanter", false)]);
    assert!(!effective_enabled(&t, &p));
    let p = profile(
        &[],
        &[
            ("Class", false),
            ("Class/Enchanter", false),
            ("Class/Enchanter/CC", true),
        ],
    );
    assert!(effective_enabled(&t, &p));
}

#[test]
fn prefix_override_matches_category_on_slash_boundaries_only() {
    let t = trig("t", Some("Class/EnchanterX/CC"), &[], false);
    // "Class/Enchanter" must NOT match category "Class/EnchanterX/CC".
    let p = profile(&[], &[("Class/Enchanter", true)]);
    assert!(!effective_enabled(&t, &p));
    // The full segment does.
    let p = profile(&[], &[("Class/EnchanterX", true)]);
    assert!(effective_enabled(&t, &p));
}

#[test]
fn prefix_override_also_matches_derived_id_path() {
    // No explicit id: derived id is "class/enchanter/cc/mez-broken", and a
    // lowercase slug-style group override still lands (case-insensitive).
    let t = trig(
        "Mez Broken",
        Some("Class/Enchanter/CC"),
        &["Enchanter"],
        true,
    );
    assert_eq!(t.effective_id(), "class/enchanter/cc/mez-broken");
    let p = profile(&["Enchanter"], &[("class/enchanter/cc", false)]);
    assert!(!effective_enabled(&t, &p));
}

#[test]
fn prefix_override_beats_class_and_default() {
    // Group override ON revives a trigger the class filter would drop...
    let t = trig("t", Some("Class/Enchanter/CC"), &["Enchanter"], true);
    let p = profile(&["Warrior"], &[("Class/Enchanter", true)]);
    assert!(effective_enabled(&t, &p));
    // ...and revives a default-off trigger too.
    let t = trig("t", Some("Class/Enchanter/CC"), &[], false);
    let p = profile(&[], &[("Class/Enchanter/CC", true)]);
    assert!(effective_enabled(&t, &p));
}

// ---------- profile persistence ----------

#[test]
fn profile_save_and_load_round_trip() {
    let dir = fresh_dir("profile-roundtrip");
    // Nested path exercises parent-dir creation.
    let path = dir.join("profiles").join("nyasha.json");
    let p = profile(
        &["Enchanter", "Cleric", "Wizard"],
        &[("Class/Enchanter", true), ("Enemy Casts/AoE", false)],
    );
    p.save(&path).unwrap();
    let back = CharacterProfile::load(&path).unwrap();
    assert_eq!(p, back);

    // Contract shape on disk: character/level/active_loadout/loadouts, with
    // classes + overrides nested per loadout.
    let raw: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(raw["character"], "Nyasha");
    assert_eq!(raw["level"], 50);
    assert_eq!(raw["active_loadout"], DEFAULT_LOADOUT_NAME);
    assert_eq!(raw["loadouts"][0]["name"], DEFAULT_LOADOUT_NAME);
    assert_eq!(raw["loadouts"][0]["classes"][0], "Enchanter");
    assert_eq!(raw["loadouts"][0]["overrides"]["Class/Enchanter"], true);
    std::fs::remove_dir_all(&dir).ok();
}

// ---------- loadouts: migration + switching ----------

#[test]
fn legacy_single_profile_file_migrates_to_default_loadout() {
    let dir = fresh_dir("profile-migration");
    let path = dir.join("old.json");
    // The pre-loadout on-disk shape: flat classes/overrides.
    std::fs::write(
        &path,
        r#"{
            "character": "Nyasha",
            "classes": ["Enchanter", "Cleric"],
            "level": 20,
            "overrides": { "Class/Enchanter": false, "Universal": true }
        }"#,
    )
    .unwrap();
    let p = CharacterProfile::load(&path).unwrap();
    assert_eq!(p.character, "Nyasha");
    assert_eq!(p.level, 20);
    assert_eq!(p.active_loadout, DEFAULT_LOADOUT_NAME);
    assert_eq!(p.loadouts.len(), 1);
    let loadout = p.active_loadout();
    assert_eq!(loadout.name, DEFAULT_LOADOUT_NAME);
    assert_eq!(loadout.classes, vec!["Enchanter", "Cleric"]);
    assert_eq!(loadout.overrides.get("Class/Enchanter"), Some(&false));
    assert_eq!(loadout.overrides.get("Universal"), Some(&true));

    // Saving writes the new shape; reloading round-trips it.
    p.save(&path).unwrap();
    let raw: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert!(raw.get("loadouts").is_some(), "must persist as loadouts");
    assert!(raw.get("overrides").is_none(), "flat shape must be gone");
    assert_eq!(CharacterProfile::load(&path).unwrap(), p);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn switching_active_loadout_changes_effective_enabled() {
    let enc = trig("Enc trigger", Some("Class/Enchanter"), &["Enchanter"], true);

    let mut cc = Loadout::new("CC");
    cc.classes = vec!["Enchanter".into()];
    let mut melee = Loadout::new("Melee");
    melee.classes = vec!["Warrior".into()];

    let mut p = CharacterProfile::new("Nyasha");
    p.loadouts = vec![cc, melee];
    p.active_loadout = "CC".into();
    assert!(effective_enabled(&enc, &p), "enchanter loadout enables it");

    p.active_loadout = "Melee".into();
    assert!(!effective_enabled(&enc, &p), "warrior loadout drops it");

    // Overrides live PER LOADOUT: forcing it on in Melee doesn't leak to CC.
    p.loadouts[1]
        .overrides
        .insert("Class/Enchanter".into(), true);
    assert!(effective_enabled(&enc, &p));
    p.active_loadout = "CC".into();
    assert!(effective_enabled(&enc, &p));
    p.loadouts[0]
        .overrides
        .insert("Class/Enchanter".into(), false);
    assert!(!effective_enabled(&enc, &p), "CC's own override wins there");

    // Direct loadout-level resolution agrees with the wrapper.
    assert!(effective_enabled_in_loadout(&enc, &p.loadouts[1]));
    assert!(!effective_enabled_in_loadout(&enc, &p.loadouts[0]));

    // And the engine compiles a different trigger set per loadout.
    let count_for = |active: &str| {
        let mut p = p.clone();
        p.active_loadout = active.to_string();
        TriggerEngine::new_with_profile(vec![enc.clone()], "Nyasha", &p).active_trigger_count()
    };
    assert_eq!(count_for("CC"), 0);
    assert_eq!(count_for("Melee"), 1);
}

#[test]
fn profile_load_errors_are_typed() {
    let dir = fresh_dir("profile-errors");
    let missing = CharacterProfile::load(&dir.join("nope.json"));
    assert!(matches!(
        missing,
        Err(eqlog_triggers::ProfileError::Io { .. })
    ));
    let bad = dir.join("bad.json");
    std::fs::write(&bad, "{not json").unwrap();
    assert!(matches!(
        CharacterProfile::load(&bad),
        Err(eqlog_triggers::ProfileError::Parse { .. })
    ));
    std::fs::remove_dir_all(&dir).ok();
}

// ---------- multi-pack loading ----------

#[test]
fn load_packs_merges_tree_in_stable_order_and_flags_duplicates() {
    let dir = fresh_dir("packs");
    std::fs::create_dir_all(dir.join("curated")).unwrap();
    std::fs::create_dir_all(dir.join("generated")).unwrap();

    let pack = |name: &str, trigger_name: &str, id: Option<&str>| {
        let mut t = Trigger::new(trigger_name, "^x$", vec![]);
        t.id = id.map(str::to_string);
        serde_json::to_string(&eqlog_triggers::TriggerPack {
            name: name.into(),
            triggers: vec![t],
        })
        .unwrap()
    };
    std::fs::write(
        dir.join("default.json"),
        pack("root", "Root T", Some("a/root")),
    )
    .unwrap();
    std::fs::write(
        dir.join("curated/universal.json"),
        pack("universal", "Uni T", Some("a/uni")),
    )
    .unwrap();
    // Duplicate id vs. default.json, and a bare-array file, and junk.
    std::fs::write(
        dir.join("generated/buffs.json"),
        pack("buffs", "Dup T", Some("a/root")),
    )
    .unwrap();
    let bare = serde_json::to_string(&vec![Trigger::new("Bare T", "^y$", vec![])]).unwrap();
    std::fs::write(dir.join("generated/bare.json"), bare).unwrap();
    std::fs::write(dir.join("generated/junk.json"), "not json at all").unwrap();
    std::fs::write(dir.join("readme.txt"), "ignored").unwrap();

    let loaded = load_packs(&dir).unwrap();
    // Sorted-path order: curated/universal, default, generated/bare, generated/buffs.
    let names: Vec<&str> = loaded.triggers.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(names, vec!["Uni T", "Root T", "Bare T", "Dup T"]);
    assert!(
        loaded
            .warnings
            .iter()
            .any(|w| w.contains("duplicate trigger id 'a/root'")),
        "expected duplicate-id warning, got {:?}",
        loaded.warnings
    );
    assert!(
        loaded.warnings.iter().any(|w| w.contains("junk.json")),
        "expected junk-file warning, got {:?}",
        loaded.warnings
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn load_packs_missing_dir_is_an_error() {
    let dir = fresh_dir("packs-missing");
    std::fs::remove_dir_all(&dir).unwrap();
    assert!(load_packs(&dir).is_err());
}

// ---------- engine: profile filtering + dedupe + counts ----------

#[test]
fn new_with_profile_filters_and_pack_switch_still_wins() {
    let enc = trig("Enc only", Some("Class/Enchanter"), &["Enchanter"], true);
    let war = trig("War only", Some("Class/Warrior"), &["Warrior"], true);
    let all = trig("Universal", Some("Universal"), &[], true);
    let mut hard_off = trig("Hard off", Some("Universal"), &[], true);
    hard_off.enabled = false; // pack-level switch: profile cannot revive it

    let p = profile(&["Enchanter", "Cleric"], &[("Universal", true)]);
    let engine = TriggerEngine::new_with_profile(vec![enc, war, all, hard_off], "Nyasha", &p);
    assert_eq!(engine.active_trigger_count(), 2, "enc + universal only");

    let counts = engine.trigger_count_by_category();
    assert_eq!(counts.get("Class/Enchanter"), Some(&1));
    assert_eq!(counts.get("Universal"), Some(&1));
    assert_eq!(counts.get("Class/Warrior"), None);
}

#[test]
fn identical_expanded_patterns_fire_once_per_line() {
    // Two generated wear-off triggers that collided to the same pattern: only
    // the first fires. A third, distinct trigger on the same line still fires.
    let mk = |name: &str, template: &str| {
        Trigger::new(
            name,
            r"^Your (.+) spell has worn off\.",
            vec![Action::Speak {
                template: template.into(),
            }],
        )
    };
    let a = mk("Wear-off A", "a: ${1}");
    let b = mk("Wear-off B", "b: ${1}");
    let mut c = Trigger::new(
        "Any wear-off",
        r"spell has worn off",
        vec![Action::DisplayText {
            template: "faded".into(),
        }],
    );
    c.category = Some("Universal".into());

    let mut engine = TriggerEngine::new(vec![a, b, c], "Nyasha");
    assert_eq!(engine.active_trigger_count(), 3, "dedupe is at fire time");
    let mut sink = RecordingSink::default();
    engine.process(&line(0, "Your Clarity spell has worn off."), &mut sink);
    assert_eq!(sink.spoken, vec!["a: Clarity"], "only the first twin fires");
    assert_eq!(
        sink.displayed,
        vec!["faded"],
        "distinct pattern still fires"
    );

    // Next line dedupes independently.
    engine.process(&line(1, "Your Haste spell has worn off."), &mut sink);
    assert_eq!(sink.spoken, vec!["a: Clarity", "a: Haste"]);
}

#[test]
fn case_flag_differentiates_dedupe_groups() {
    let mut a = Trigger::new(
        "ci",
        "^You died\\.",
        vec![Action::Speak {
            template: "one".into(),
        }],
    );
    a.case_insensitive = true;
    let mut b = a.clone();
    b.name = "cs".into();
    b.case_insensitive = false;
    b.actions = vec![Action::Speak {
        template: "two".into(),
    }];
    let mut engine = TriggerEngine::new(vec![a, b], "Nyasha");
    let mut sink = RecordingSink::default();
    engine.process(&line(0, "You died."), &mut sink);
    // Different expanded patterns ((?i) prefix) → both fire.
    assert_eq!(sink.spoken, vec!["one", "two"]);
}

// ---------- class auto-detect ----------

fn spell_map(entries: &[(&str, &[&str])]) -> HashMap<String, Vec<String>> {
    entries
        .iter()
        .map(|(spell, classes)| {
            (
                spell.to_string(),
                classes.iter().map(|c| c.to_string()).collect(),
            )
        })
        .collect()
}

#[test]
fn detect_classes_tri_class_synthetic() {
    let map = spell_map(&[
        ("Walking Sleep", &["Enchanter"]),
        ("Tashani", &["Enchanter"]),
        ("Complete Heal", &["Cleric"]),
        ("Courage", &["Cleric", "Paladin"]),
        ("Blast of Frost", &["Wizard", "Magician", "Druid", "Shaman"]),
        (
            "Gate",
            &[
                "Wizard",
                "Magician",
                "Necromancer",
                "Enchanter",
                "Druid",
                "Shaman",
                "Cleric",
            ],
        ),
    ]);
    let casts = [
        "Walking Sleep",
        "Tashani",
        "Complete Heal",
        "Courage",
        "Blast of Frost",
        "Gate",
        "Walking Sleep", // repeat: counted once
        "Unknown Spell", // not in map: ignored
    ];
    let det = detect_classes(&casts, &map);
    assert_eq!(det.classes.len(), 3);
    assert!(det.classes.contains(&"Enchanter".to_string()));
    assert!(det.classes.contains(&"Cleric".to_string()));
    // Third slot explains Blast of Frost; alphabetical tie-break at equal
    // votes/gain lands on Druid (Druid/Magician/Shaman/Wizard all cover it).
    assert!(
        (det.confidence - 1.0).abs() < f64::EPSILON,
        "all 6 known spells explained"
    );
    // Ranked list is vote-sorted, ties alphabetical: Cleric and Enchanter
    // both saw 3 distinct spells.
    assert_eq!(det.ranked[0], ("Cleric".to_string(), 3));
    assert_eq!(det.ranked[1], ("Enchanter".to_string(), 3));
}

#[test]
fn detect_classes_partial_confidence_and_cap() {
    // 4 known spells across 4 disjoint classes: only 3 picks allowed, so one
    // spell stays unexplained -> confidence 0.75.
    let map = spell_map(&[
        ("A", &["Warrior"]),
        ("B", &["Cleric"]),
        ("C", &["Rogue"]),
        ("D", &["Bard"]),
    ]);
    let det = detect_classes(&["A", "B", "C", "D"], &map);
    assert_eq!(det.classes.len(), 3);
    assert!((det.confidence - 0.75).abs() < 1e-9);
}

#[test]
fn detect_classes_no_data() {
    let det = detect_classes(&["Mystery"], &HashMap::new());
    assert!(det.classes.is_empty());
    assert_eq!(det.confidence, 0.0);
    assert!(det.ranked.is_empty());
    let det = detect_classes(&[], &spell_map(&[("A", &["Warrior"])]));
    assert!(det.classes.is_empty());
}
