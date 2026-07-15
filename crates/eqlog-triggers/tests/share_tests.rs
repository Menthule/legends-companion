//! Integration tests for sharing v1: LCS1 share-string round trips,
//! id-collision dedupe on import, and GINA .gtp export reimported through
//! our own GINA importer.

use std::collections::HashSet;

use eqlog_triggers::{
    export_gtp, export_string, import_gtp, parse_string, Action, ShareError, SharePayload,
    TimerLane, Trigger, TriggerSource, WatchObservationKind, SHARE_PREFIX,
};

fn sample_triggers() -> Vec<Trigger> {
    let mut mez = Trigger::new(
        "Mez Broken",
        r"^(?P<S1>.+) has been awakened by (?P<S2>.+)\.$",
        vec![
            Action::Speak {
                template: "mez broke on ${S1}".into(),
            },
            Action::DisplayText {
                template: "${S2} broke ${S1}".into(),
            },
        ],
    );
    mez.category = Some("Class/Enchanter/Crowd Control".into());
    mez.id = Some("class/enchanter/cc/mez-broken".into());
    mez.classes = vec!["Enchanter".into()];
    mez.comments = Some("raid CC discipline".into());

    let mut dot = Trigger::new(
        "Boil Blood timer",
        r"^You begin casting Boil Blood\.$",
        vec![Action::StartTimer {
            name: "Boil Blood".into(),
            duration_secs: 42,
            warn_at_secs: Some(6),
            duration_formula: Some(3),
            duration_cap_ticks: Some(7),
            cast_time_secs: Some(2),
            rank_variants: Default::default(),
            mode: None,
            repeat_secs: None,
            stopwatch: false,
            warn_text: None,
            expire_text: None,
            warn_sound: None,
            expire_sound: None,
            lane: Some(TimerLane::Enemy),
        }],
    );
    dot.category = Some("Class/Necromancer/DoTs".into());

    let bell = Trigger::new(
        "Ding",
        "^You have gained a level!",
        vec![Action::PlaySound {
            path: "sounds/ding.wav".into(),
        }],
    );
    vec![mez, dot, bell]
}

#[test]
fn share_string_round_trips_triggers() {
    let payload = SharePayload {
        name: Some("Kael Raid Pack".into()),
        triggers: sample_triggers(),
        ..Default::default()
    };
    let text = export_string(&payload);
    assert!(text.starts_with(SHARE_PREFIX), "got: {text}");
    // Single-line, paste-safe.
    assert!(!text.contains(char::is_whitespace));

    let import = parse_string(&text, &HashSet::new()).expect("valid share string parses");
    assert_eq!(import.name.as_deref(), Some("Kael Raid Pack"));
    assert!(
        import.renamed.is_empty(),
        "no collisions: {:?}",
        import.renamed
    );
    assert_eq!(import.triggers.len(), 3);
    for (got, sent) in import.triggers.iter().zip(&payload.triggers) {
        assert_eq!(
            got.source,
            TriggerSource::Shared,
            "imports carry the shared badge"
        );
        assert_eq!(got.name, sent.name);
        assert_eq!(got.pattern, sent.pattern);
        assert_eq!(got.actions, sent.actions);
        assert_eq!(got.category, sent.category);
        assert_eq!(got.comments, sent.comments);
        assert_eq!(got.classes, sent.classes);
        assert_eq!(got.effective_id(), sent.effective_id());
    }
}

#[test]
fn share_string_tolerates_chat_wrapping() {
    let payload = SharePayload {
        name: None,
        triggers: sample_triggers(),
        ..Default::default()
    };
    let text = export_string(&payload);
    // A chat client wrapped the string and added surrounding whitespace.
    let wrapped: String = text
        .chars()
        .enumerate()
        .flat_map(|(i, c)| {
            if i > 0 && i % 60 == 0 {
                vec!['\n', c]
            } else {
                vec![c]
            }
        })
        .collect();
    let wrapped = format!("  {wrapped}\n");
    let import = parse_string(&wrapped, &HashSet::new()).expect("wrapped string still parses");
    assert_eq!(import.triggers.len(), 3);
}

#[test]
fn watch_observation_action_round_trips_through_trigger_sharing() {
    let trigger = Trigger::new(
        "Editable loot source",
        r"^REWARD (?P<item>.+)$",
        vec![Action::ObserveWatch {
            kind: WatchObservationKind::Loot,
            name: "${item}".into(),
            quantity: Some("${quantity}".into()),
            context: [("source".into(), "custom".into())].into(),
        }],
    );
    let payload = SharePayload {
        triggers: vec![trigger.clone()],
        ..Default::default()
    };
    let imported = parse_string(&export_string(&payload), &HashSet::new()).unwrap();
    assert_eq!(imported.triggers[0].actions, trigger.actions);
}

#[test]
fn import_dedupes_id_collisions_with_numeric_suffixes() {
    let payload = SharePayload {
        name: None,
        triggers: sample_triggers(),
        ..Default::default()
    };
    let text = export_string(&payload);

    // The library already holds the mez trigger's id (e.g. from a first
    // paste of this very string — the verified double-import bug).
    let mut existing: HashSet<String> = HashSet::new();
    existing.insert("class/enchanter/cc/mez-broken".to_string());

    let import = parse_string(&text, &existing).unwrap();
    assert_eq!(
        import.renamed,
        vec![(
            "class/enchanter/cc/mez-broken".to_string(),
            "class/enchanter/cc/mez-broken-2".to_string()
        )]
    );
    assert_eq!(
        import.triggers[0].id.as_deref(),
        Some("class/enchanter/cc/mez-broken-2")
    );

    // Paste a third time with both ids taken: -3 is assigned.
    existing.insert("class/enchanter/cc/mez-broken-2".to_string());
    let import = parse_string(&text, &existing).unwrap();
    assert_eq!(
        import.triggers[0].id.as_deref(),
        Some("class/enchanter/cc/mez-broken-3")
    );
}

#[test]
fn import_dedupes_collisions_within_the_pasted_set_itself() {
    // Two triggers in one bundle that resolve to the same effective id
    // (same category + name): the second gets -2 even with an empty library.
    let a = Trigger::new("Stunned", "^You are stunned!", vec![]);
    let b = Trigger::new("Stunned", "^You are no longer stunned\\.", vec![]);
    let text = export_string(&SharePayload {
        name: None,
        triggers: vec![a, b],
        ..Default::default()
    });
    let import = parse_string(&text, &HashSet::new()).unwrap();
    assert_eq!(import.triggers[0].effective_id(), "stunned");
    assert_eq!(import.triggers[1].effective_id(), "stunned-2");
    assert_eq!(
        import.renamed,
        vec![("stunned".to_string(), "stunned-2".to_string())]
    );
}

#[test]
fn parse_string_rejects_garbage() {
    let empty = HashSet::new();
    assert!(matches!(
        parse_string("GINA:whatever", &empty),
        Err(ShareError::BadPrefix)
    ));
    assert!(matches!(
        parse_string("LCS1:not*base64!", &empty),
        Err(ShareError::Base64(_))
    ));
    // Valid base64, not valid deflate.
    assert!(matches!(
        parse_string("LCS1:AAAA", &empty),
        Err(ShareError::Inflate(_) | ShareError::Json(_))
    ));
}

#[test]
fn gtp_export_reimports_through_our_gina_importer() {
    let triggers = sample_triggers();
    let bytes = export_gtp("Legends Companion Export", &triggers).expect("gtp builds");
    assert!(bytes.starts_with(b"PK"), "gtp must be a zip archive");

    let reimport = import_gtp(&bytes).expect("our own export must reimport");
    assert_eq!(reimport.warnings, Vec::<String>::new());
    assert_eq!(reimport.triggers.len(), 3);
    // Document order is uncategorized-first, then groups alphabetically;
    // look triggers up by name.
    let by_name = |name: &str| {
        reimport
            .triggers
            .iter()
            .find(|t| t.name == name)
            .unwrap_or_else(|| panic!("trigger {name:?} missing from reimport"))
    };

    // Categories survive under the package folder.
    let mez = by_name("Mez Broken");
    assert_eq!(
        mez.category.as_deref(),
        Some("Legends Companion Export/Class/Enchanter/Crowd Control")
    );
    assert_eq!(
        mez.pattern,
        r"^(?P<S1>.+) has been awakened by (?P<S2>.+)\.$"
    );
    assert_eq!(mez.source, TriggerSource::Gina);
    // Speak + display both survive (template tokens re-imported to ${...}
    // form only for GINA-style {S1} tokens; named-group refs pass through).
    assert!(mez.actions.iter().any(|a| matches!(
        a,
        Action::Speak { template } if template == "mez broke on ${S1}"
    )));
    assert!(mez.actions.iter().any(|a| matches!(
        a,
        Action::DisplayText { template } if template == "${S2} broke ${S1}"
    )));

    let dot = by_name("Boil Blood timer");
    assert!(
        dot.actions.iter().any(|a| matches!(
            a,
            Action::StartTimer {
                name,
                duration_secs: 42,
                warn_at_secs: Some(6),
                ..
            } if name == "Boil Blood"
        )),
        "timer with warn survives: {:?}",
        dot.actions
    );

    let bell = by_name("Ding");
    assert!(bell.actions.iter().any(|a| matches!(
        a,
        Action::PlaySound { path } if path == "sounds/ding.wav"
    )));

    // And the whole reimport survives a second LCS1 round trip.
    let text = export_string(&SharePayload {
        name: None,
        triggers: reimport.triggers.clone(),
        ..Default::default()
    });
    let again = parse_string(&text, &HashSet::new()).unwrap();
    assert_eq!(again.triggers.len(), 3);
}

#[test]
fn gtp_export_escapes_xml_and_keeps_regex_patterns_unescaped() {
    let mut t = Trigger::new(
        r#"Tell <"&'> me"#,
        r"^(.+) tells you, '(?P<S1>.+)'$",
        vec![Action::Speak {
            template: "tell from ${S1} & co".into(),
        }],
    );
    t.category = Some("Chat & Social".into());
    let bytes = export_gtp("P", &[t]).unwrap();
    let reimport = import_gtp(&bytes).unwrap();
    assert_eq!(reimport.warnings, Vec::<String>::new());
    assert_eq!(reimport.triggers.len(), 1);
    let back = &reimport.triggers[0];
    assert_eq!(back.name, r#"Tell <"&'> me"#);
    assert_eq!(back.pattern, r"^(.+) tells you, '(?P<S1>.+)'$");
    assert_eq!(back.category.as_deref(), Some("P/Chat & Social"));
}
