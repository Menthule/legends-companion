//! Integration tests for the trigger engine: token expansion, capture
//! substitution, the fast-reject path, timer semantics and profile-level
//! timer scaling — plus a pass over the real fixture log with the shipped
//! trigger library.

use eqlog_core::events::{ChatChannel, Entity, Event, LogLine, ParsedLine};
use eqlog_triggers::{
    Action, ActionSink, ChannelOverride, CharacterProfile, OverlayFire, TimerFireKind, TimerLane,
    TimerStartMode, TimerTiming, Trigger, TriggerEngine, TriggerEvent, TriggerFireInfo,
    TriggerSignal, WatchObservation,
};

type RecordedOverlay = (
    String,
    std::collections::BTreeMap<String, String>,
    std::collections::BTreeMap<String, serde_json::Value>,
);

/// Records every sink call for assertions.
#[derive(Default)]
struct RecordingSink {
    spoken: Vec<String>,
    sounds: Vec<String>,
    displayed: Vec<String>,
    timers: Vec<(String, u64, Option<u64>, TimerLane)>,
    timer_icons: Vec<(String, Option<String>)>,
    cancels: Vec<String>,
    webhooks: Vec<(Option<String>, String)>,
    overlays: Vec<RecordedOverlay>,
    observations: Vec<WatchObservation>,
    current_trigger: Option<String>,
    attributed_calls: Vec<(String, Option<String>)>,
}

impl ActionSink for RecordingSink {
    fn begin_trigger(&mut self, trigger: &TriggerFireInfo) {
        self.current_trigger = Some(trigger.id.clone());
    }
    fn end_trigger(&mut self) {
        self.current_trigger = None;
    }
    fn speak(&mut self, text: &str) {
        self.spoken.push(text.to_string());
        self.attributed_calls
            .push(("speak".into(), self.current_trigger.clone()));
    }
    fn play_sound(&mut self, path: &str) {
        self.sounds.push(path.to_string());
    }
    fn display_text(&mut self, text: &str) {
        self.displayed.push(text.to_string());
    }
    fn post_webhook(&mut self, name: Option<&str>, text: &str) {
        self.webhooks
            .push((name.map(str::to_string), text.to_string()));
    }
    fn start_timer(
        &mut self,
        name: &str,
        icon: Option<&str>,
        duration_secs: u64,
        warn_at_secs: Option<u64>,
        lane: TimerLane,
        _pending_secs: u64,
    ) {
        self.timers
            .push((name.to_string(), duration_secs, warn_at_secs, lane));
        self.timer_icons
            .push((name.to_string(), icon.map(str::to_string)));
        self.attributed_calls
            .push(("timer".into(), self.current_trigger.clone()));
    }
    fn cancel_timer(&mut self, name: &str) {
        self.cancels.push(name.to_string());
    }
    fn overlay(&mut self, spec: OverlayFire<'_>) {
        self.attributed_calls
            .push(("overlay".into(), self.current_trigger.clone()));
        self.overlays
            .push((spec.overlay.to_string(), spec.fields, spec.config.clone()));
    }
    fn observe_watch(&mut self, observation: WatchObservation) {
        self.observations.push(observation);
    }
}

impl RecordingSink {
    fn total_calls(&self) -> usize {
        self.spoken.len()
            + self.sounds.len()
            + self.displayed.len()
            + self.timers.len()
            + self.cancels.len()
            + self.webhooks.len()
            + self.overlays.len()
            + self.observations.len()
    }
}

#[test]
fn watch_observation_grammar_and_capture_mapping_are_loaded_from_trigger_json() {
    let pack_json = r#"{
      "name": "Editable event source",
      "triggers": [{
        "id": "system/test/alternate-loot",
        "name": "Alternate loot",
        "pattern": "^REWARD (?P<item>.+) x(?P<quantity>\\d+) via (?P<source>.+)$",
        "enabled": true,
        "default_enabled": true,
        "source": "curated",
        "actions": [{"ObserveWatch": {
          "kind": "loot",
          "name": "${item}",
          "quantity": "${quantity}",
          "context": {"corpse": "${source}"}
        }}]
      }]
    }"#;
    let pack: eqlog_triggers::TriggerPack = serde_json::from_str(pack_json).unwrap();
    let mut engine = TriggerEngine::new(pack.triggers, "Nyasha");
    let mut sink = RecordingSink::default();

    engine.process(
        &line(100, "REWARD Large Sky Sapphire x2 via Eye of Veeshan"),
        &mut sink,
    );

    assert_eq!(sink.observations.len(), 1);
    let observation = &sink.observations[0];
    assert_eq!(observation.kind, eqlog_triggers::WatchObservationKind::Loot);
    assert_eq!(observation.name, "Large Sky Sapphire");
    assert_eq!(observation.quantity.as_deref(), Some("2"));
    assert_eq!(
        observation.context.get("corpse").map(String::as_str),
        Some("Eye of Veeshan")
    );
}

#[test]
fn shipped_event_source_pack_defines_watch_eligibility_as_data() {
    let pack: eqlog_triggers::TriggerPack =
        serde_json::from_str(include_str!("../../../triggers/curated/event-sources.json")).unwrap();
    let mut engine = TriggerEngine::new(pack.triggers, "Nyasha");
    let mut sink = RecordingSink::default();
    for message in [
        "--You have looted 2 Bone Chips from a greater skeleton's corpse.--",
        "You looted a Flame Agate from a Teir`Dal ranger's corpse and stored it in your tradeskill depot",
        "You looted a Copper Ring +2 from Gynok Moltor's corpse to create a Copper Ring +3",
        "You looted a Rusty Axe from a skeleton's corpse and sold it for 2 silver.",
        "Friend has looted a Backpack from a skeleton's corpse.",
        "You have slain Eye of Veeshan!",
        "a splitpaw assassin has been slain by Konartik!",
    ] {
        engine.process(&line(100, message), &mut sink);
    }

    assert_eq!(sink.observations.len(), 5);
    assert_eq!(sink.observations[0].name, "Bone Chips");
    assert_eq!(sink.observations[0].quantity.as_deref(), Some("2"));
    assert_eq!(sink.observations[1].name, "Flame Agate");
    assert_eq!(sink.observations[2].name, "Copper Ring +2");
    assert_eq!(sink.observations[3].name, "Eye of Veeshan");
    assert_eq!(sink.observations[4].name, "a splitpaw assassin");
}

#[test]
fn structured_watch_triggers_cannot_emit_another_watch_observation() {
    let mut trigger = Trigger::new("No recursive observe", "", Vec::new());
    trigger.event = Some(TriggerEvent::WatchedLoot);
    trigger.actions = vec![Action::ObserveWatch {
        kind: eqlog_triggers::WatchObservationKind::Loot,
        name: "${item}".into(),
        quantity: None,
        context: Default::default(),
    }];
    let mut engine = TriggerEngine::new(vec![trigger], "Nyasha");
    let mut sink = RecordingSink::default();
    engine.process_signal_traced(
        &TriggerSignal::new(
            TriggerEvent::WatchedLoot,
            100,
            [("item".into(), "Large Sky Sapphire".into())].into(),
        ),
        &mut sink,
    );
    assert!(sink.observations.is_empty());
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

fn start_timer_action(
    name: &str,
    duration_secs: u64,
    mode: Option<TimerStartMode>,
    repeat_secs: Option<u64>,
) -> Action {
    Action::StartTimer {
        name: name.into(),
        duration_secs,
        warn_at_secs: None,
        duration_formula: None,
        duration_cap_ticks: None,
        cast_time_secs: None,
        rank_variants: Default::default(),
        mode,
        repeat_secs,
        stopwatch: false,
        warn_text: None,
        expire_text: None,
        warn_sound: None,
        expire_sound: None,
        lane: None,
    }
}

#[test]
fn ranked_timer_uses_exact_variant_and_loadout_override_without_duplicate_triggers() {
    let mut trigger = Trigger::new(
        "Heat Blood timer",
        r"^You begin casting Heat Blood(?: (?P<rank>[IVXLCDM]+))?\.$",
        vec![Action::StartTimer {
            name: "Heat Blood".into(),
            duration_secs: 180,
            warn_at_secs: None,
            duration_formula: None,
            duration_cap_ticks: None,
            lane: Some(TimerLane::Enemy),
            cast_time_secs: Some(3),
            rank_variants: [
                (
                    "II".into(),
                    TimerTiming {
                        duration_secs: Some(192),
                        cast_time_secs: Some(2),
                    },
                ),
                (
                    "IV".into(),
                    TimerTiming {
                        duration_secs: Some(216),
                        cast_time_secs: None,
                    },
                ),
            ]
            .into(),
            mode: None,
            repeat_secs: None,
            stopwatch: false,
            warn_text: None,
            expire_text: None,
            warn_sound: None,
            expire_sound: None,
        }],
    );
    trigger.id = Some("debuffs/necromancer/cast/heat-blood".into());
    let mut profile = CharacterProfile::new("Nyasha");
    profile.active_loadout_mut().timing_overrides.insert(
        trigger.effective_id(),
        [(
            "iv".into(),
            TimerTiming {
                duration_secs: None,
                cast_time_secs: Some(1),
            },
        )]
        .into(),
    );
    let mut engine = TriggerEngine::new_with_profile(vec![trigger], "Nyasha", &profile);
    let mut sink = RecordingSink::default();

    engine.process(&line(100, "You begin casting Heat Blood."), &mut sink);
    engine.process(&line(200, "You begin casting Heat Blood II."), &mut sink);
    engine.process(&line(300, "You begin casting Heat Blood IV."), &mut sink);

    assert_eq!(sink.timers[0].1, 183); // base duration + base cast
    assert_eq!(sink.timers[1].1, 194); // exact II duration + cast
    assert_eq!(sink.timers[2].1, 217); // library IV duration + manual cast
    assert_eq!(engine.active_trigger_count(), 1);
}

#[test]
fn character_token_with_regex_metachars_matches_literally() {
    // A pathological character name full of regex metacharacters must be
    // escaped by {C} expansion, not interpreted.
    let trigger = Trigger::new(
        "gratz",
        "^{C} has reached level {N}",
        vec![Action::Speak {
            template: "{C} dinged ${N}".into(),
        }],
    );
    let mut engine = TriggerEngine::new(vec![trigger], "Ny(a.*)+sha");
    assert!(engine.warnings().is_empty(), "{:?}", engine.warnings());

    let mut sink = RecordingSink::default();
    engine.process(&line(0, "Ny(a.*)+sha has reached level 16!"), &mut sink);
    assert_eq!(sink.spoken, vec!["Ny(a.*)+sha dinged 16"]);

    // The literal name is required — a regex-ish variation must NOT match.
    let mut sink2 = RecordingSink::default();
    engine.process(&line(0, "Nyaaasha has reached level 16!"), &mut sink2);
    assert_eq!(sink2.total_calls(), 0);
}

#[test]
fn numeric_token_conditions_gate_matches() {
    let trigger = Trigger::new(
        "big hit",
        "^You were hit for {N>=100} damage\\.$",
        vec![Action::DisplayText {
            template: "big ${N}".into(),
        }],
    );
    let mut engine = TriggerEngine::new(vec![trigger], "Nyasha");
    let mut sink = RecordingSink::default();
    engine.process(&line(1, "You were hit for 99 damage."), &mut sink);
    assert!(sink.displayed.is_empty());
    engine.process(&line(2, "You were hit for 100 damage."), &mut sink);
    assert_eq!(sink.displayed, vec!["big 100"]);
}

#[test]
fn suppress_trigger_stops_later_generic_matches() {
    let mut suppress = Trigger::new("ignore merchant", "^That'll be.*", Vec::new());
    suppress.priority = 10;
    suppress.suppress = true;
    let generic = Trigger::new(
        "generic",
        "^(.+)$",
        vec![Action::DisplayText {
            template: "generic".into(),
        }],
    );
    let mut engine = TriggerEngine::new(vec![generic, suppress], "Nyasha");
    let mut sink = RecordingSink::default();
    engine.process(&line(1, "That'll be 5 gold."), &mut sink);
    assert_eq!(sink.total_calls(), 0);
}

#[test]
fn timer_start_modes_ignore_or_create_instances() {
    let ignore = Trigger::new(
        "ignore",
        "^start ignore$",
        vec![start_timer_action(
            "Recast",
            30,
            Some(TimerStartMode::IgnoreIfRunning),
            None,
        )],
    );
    let multi = Trigger::new(
        "multi",
        "^start multi$",
        vec![start_timer_action(
            "DoT",
            30,
            Some(TimerStartMode::StartNewInstance),
            None,
        )],
    );
    let mut engine = TriggerEngine::new(vec![ignore, multi], "Nyasha");
    let mut sink = RecordingSink::default();
    engine.process(&line(1, "start ignore"), &mut sink);
    engine.process(&line(2, "start ignore"), &mut sink);
    engine.process(&line(3, "start multi"), &mut sink);
    engine.process(&line(4, "start multi"), &mut sink);
    assert_eq!(
        sink.timers.iter().map(|t| t.0.as_str()).collect::<Vec<_>>(),
        vec!["Recast", "DoT", "DoT (2)"]
    );
}

#[test]
fn repeating_timer_reschedules_after_expiry() {
    let trigger = Trigger::new(
        "repeat",
        "^pulse$",
        vec![start_timer_action("Pulse", 10, None, Some(10))],
    );
    let mut engine = TriggerEngine::new(vec![trigger], "Nyasha");
    let mut sink = RecordingSink::default();
    engine.process(&line(100, "pulse"), &mut sink);
    let fires = engine.due(110);
    // Expiry PLUS a Restarted fire carrying the next cycle's length, so the
    // sink can draw a replacement bar (the UI prunes bars after "expired").
    assert_eq!(fires.len(), 2);
    assert_eq!(fires[0].kind, TimerFireKind::Expire);
    assert_eq!(fires[1].kind, TimerFireKind::Restarted);
    assert_eq!(fires[1].duration_secs, Some(10));
    assert_eq!(engine.active_timers(110), vec![("Pulse".to_string(), 10)]);
}

#[test]
fn timer_snapshots_capture_elapsed_for_ui_resync() {
    // P3: a running timer must survive a window reload. The snapshot reports
    // duration + elapsed (durations, not timestamps) so the frontend rebuilds
    // the countdown from its own wall clock; expired timers are omitted.
    let trigger = Trigger::new(
        "recast",
        "^start$",
        vec![start_timer_action("Recast", 30, None, None)],
    );
    let mut engine = TriggerEngine::new(vec![trigger], "Nyasha");
    let mut sink = RecordingSink::default();
    engine.process(&line(100, "start"), &mut sink);

    // Immediately after start: the full duration remains.
    let snap = engine.timer_snapshots(100);
    assert_eq!(snap.len(), 1);
    assert_eq!(snap[0].name, "Recast");
    assert_eq!(snap[0].duration_secs, 30);
    assert_eq!(snap[0].elapsed_secs, 0);
    assert_eq!(snap[0].pending_secs, 0);

    // Partway through: elapsed advances, timer still live.
    assert_eq!(engine.timer_snapshots(112)[0].elapsed_secs, 12);

    // At and past expiry: nothing to restore.
    assert!(engine.timer_snapshots(130).is_empty());
    assert!(engine.timer_snapshots(131).is_empty());
}

#[test]
fn captures_substitute_into_speak_text() {
    let trigger = Trigger::new(
        "tell",
        r"^(\w+) tells you, '(?P<S1>.+)'",
        vec![Action::Speak {
            template: "tell from ${1}: ${S1}".into(),
        }],
    );
    let mut engine = TriggerEngine::new(vec![trigger], "Nyasha");
    let mut sink = RecordingSink::default();
    engine.process(&line(0, "Torvin tells you, 'inc 3 mobs'"), &mut sink);
    assert_eq!(sink.spoken, vec!["tell from Torvin: inc 3 mobs"]);
}

#[test]
fn gina_tokens_expand_and_capture() {
    let trigger = Trigger::new(
        "slain",
        "^{S1} has been slain by {S2}!",
        vec![Action::DisplayText {
            template: "${S2} killed ${S1}".into(),
        }],
    );
    let mut engine = TriggerEngine::new(vec![trigger], "Nyasha");
    let mut sink = RecordingSink::default();
    // Real fixture line — backtick mob name.
    engine.process(
        &line(0, "A Teir`Dal ranger has been slain by Vibarn!"),
        &mut sink,
    );
    assert_eq!(sink.displayed, vec!["Vibarn killed A Teir`Dal ranger"]);
}

#[test]
fn fast_path_nonmatching_line_touches_no_sink() {
    let triggers = vec![
        Trigger::new(
            "a",
            "^You are stunned!",
            vec![Action::Speak {
                template: "s".into(),
            }],
        ),
        Trigger::new(
            "b",
            "^You died\\.",
            vec![Action::Speak {
                template: "d".into(),
            }],
        ),
    ];
    let mut engine = TriggerEngine::new(triggers, "Nyasha");
    let mut sink = RecordingSink::default();
    engine.process(
        &line(0, "You crush a Teir`Dal rogue for 22 points of damage."),
        &mut sink,
    );
    assert_eq!(sink.total_calls(), 0);
}

#[test]
fn disabled_and_broken_triggers_are_skipped() {
    let mut off = Trigger::new(
        "off",
        "^You died\\.",
        vec![Action::Speak {
            template: "x".into(),
        }],
    );
    off.enabled = false;
    let broken = Trigger::new("broken", "([unclosed", vec![]);
    let engine = TriggerEngine::new(vec![off, broken], "Nyasha");
    assert_eq!(engine.active_trigger_count(), 0);
    assert_eq!(engine.warnings().len(), 1);
    assert!(engine.warnings()[0].contains("broken"));
}

#[test]
fn case_insensitive_by_default_and_opt_out() {
    let sensitive = Trigger {
        case_insensitive: false,
        ..Trigger::new(
            "cs",
            "^you are stunned!",
            vec![Action::Speak {
                template: "x".into(),
            }],
        )
    };
    let mut engine = TriggerEngine::new(vec![sensitive], "Nyasha");
    let mut sink = RecordingSink::default();
    engine.process(&line(0, "You are stunned!"), &mut sink);
    assert_eq!(
        sink.total_calls(),
        0,
        "case-sensitive trigger must not match"
    );

    let insensitive = Trigger::new(
        "ci",
        "^you are stunned!",
        vec![Action::Speak {
            template: "x".into(),
        }],
    );
    let mut engine = TriggerEngine::new(vec![insensitive], "Nyasha");
    engine.process(&line(0, "You are stunned!"), &mut sink);
    assert_eq!(sink.spoken, vec!["x"]);
}

#[test]
fn timer_warn_then_expire_ordering() {
    let trigger = Trigger::new(
        "mez",
        "^You begin casting Walking Sleep\\.",
        vec![Action::StartTimer {
            name: "Walking Sleep".into(),
            duration_secs: 48,
            warn_at_secs: Some(6),
            duration_formula: None,
            duration_cap_ticks: None,
            cast_time_secs: None,
            rank_variants: Default::default(),
            mode: None,
            repeat_secs: None,
            stopwatch: false,
            warn_text: None,
            expire_text: None,
            warn_sound: None,
            expire_sound: None,
            lane: None,
        }],
    );
    let mut engine = TriggerEngine::new(vec![trigger], "Nyasha");
    let mut sink = RecordingSink::default();
    let t0 = 1_000_000;
    engine.process(&line(t0, "You begin casting Walking Sleep."), &mut sink);
    assert_eq!(
        sink.timers,
        vec![("Walking Sleep".to_string(), 48, Some(6), TimerLane::Other)]
    );

    // Nothing due before the warn threshold (t0+42).
    assert!(engine.due(t0 + 41).is_empty());

    // Warn fires exactly once.
    let fires = engine.due(t0 + 42);
    assert_eq!(fires.len(), 1);
    assert_eq!(fires[0].name, "Walking Sleep");
    assert_eq!(fires[0].kind, TimerFireKind::Warn);
    assert!(engine.due(t0 + 43).is_empty(), "warn must not repeat");

    // Expire fires at t0+48 and the timer is gone afterwards.
    let fires = engine.due(t0 + 48);
    assert_eq!(fires.len(), 1);
    assert_eq!(fires[0].kind, TimerFireKind::Expire);
    assert!(engine.due(t0 + 60).is_empty());
}

#[test]
fn timer_big_jump_yields_warn_before_expire() {
    let trigger = Trigger::new(
        "t",
        "^GO$",
        vec![Action::StartTimer {
            name: "T".into(),
            duration_secs: 10,
            warn_at_secs: Some(3),
            duration_formula: None,
            duration_cap_ticks: None,
            cast_time_secs: None,
            rank_variants: Default::default(),
            mode: None,
            repeat_secs: None,
            stopwatch: false,
            warn_text: None,
            expire_text: None,
            warn_sound: None,
            expire_sound: None,
            lane: None,
        }],
    );
    let mut engine = TriggerEngine::new(vec![trigger], "Nyasha");
    let mut sink = RecordingSink::default();
    engine.process(&line(100, "GO"), &mut sink);
    // Jump straight past both thresholds: Warn must precede Expire.
    let fires = engine.due(200);
    let kinds: Vec<TimerFireKind> = fires.iter().map(|f| f.kind).collect();
    assert_eq!(kinds, vec![TimerFireKind::Warn, TimerFireKind::Expire]);
}

#[test]
fn rematch_restarts_same_named_timer() {
    let trigger = Trigger::new(
        "mez",
        "^You begin casting Walking Sleep\\.",
        vec![Action::StartTimer {
            name: "Walking Sleep".into(),
            duration_secs: 48,
            warn_at_secs: Some(6),
            duration_formula: None,
            duration_cap_ticks: None,
            cast_time_secs: None,
            rank_variants: Default::default(),
            mode: None,
            repeat_secs: None,
            stopwatch: false,
            warn_text: None,
            expire_text: None,
            warn_sound: None,
            expire_sound: None,
            lane: None,
        }],
    );
    let mut engine = TriggerEngine::new(vec![trigger], "Nyasha");
    let mut sink = RecordingSink::default();
    let t0 = 500;
    engine.process(&line(t0, "You begin casting Walking Sleep."), &mut sink);
    // Recast 30s later — old expiry (t0+48) must be discarded.
    engine.process(
        &line(t0 + 30, "You begin casting Walking Sleep."),
        &mut sink,
    );
    assert!(
        engine.due(t0 + 50).is_empty(),
        "restarted timer must not fire at the original expiry"
    );
    // New warn threshold: t0 + 30 + 42 = t0 + 72.
    let fires = engine.due(t0 + 72);
    assert_eq!(fires.len(), 1);
    assert_eq!(fires[0].kind, TimerFireKind::Warn);
    let fires = engine.due(t0 + 78);
    assert_eq!(fires.len(), 1);
    assert_eq!(fires[0].kind, TimerFireKind::Expire);
}

#[test]
fn cancel_timer_end_to_end() {
    // Cast starts the timer; the wear-off line cancels it by captured name,
    // so no warn/expire ever fires.
    let start = Trigger::new(
        "buff cast",
        r"^You begin casting (.+)\.$",
        vec![Action::StartTimer {
            name: "${1}".into(),
            duration_secs: 60,
            warn_at_secs: Some(6),
            duration_formula: None,
            duration_cap_ticks: None,
            cast_time_secs: None,
            rank_variants: Default::default(),
            mode: None,
            repeat_secs: None,
            stopwatch: false,
            warn_text: None,
            expire_text: None,
            warn_sound: None,
            expire_sound: None,
            lane: None,
        }],
    );
    let cancel = Trigger::new(
        "buff gone",
        r"^Your (.+) spell has worn off\.$",
        vec![Action::CancelTimer {
            name: "${1}".into(),
        }],
    );
    let mut engine = TriggerEngine::new(vec![start, cancel], "Nyasha");
    assert!(engine.warnings().is_empty(), "{:?}", engine.warnings());
    let mut sink = RecordingSink::default();

    let t0 = 1_000;
    engine.process(&line(t0, "You begin casting Spirit of Wolf."), &mut sink);
    assert_eq!(
        sink.timers,
        vec![("Spirit of Wolf".to_string(), 60, Some(6), TimerLane::Other)]
    );
    assert_eq!(engine.active_timers(t0).len(), 1);

    // Early wear-off: template-expanded cancel removes the active timer.
    engine.process(
        &line(t0 + 10, "Your Spirit of Wolf spell has worn off."),
        &mut sink,
    );
    assert_eq!(sink.cancels, vec!["Spirit of Wolf"]);
    assert!(engine.active_timers(t0 + 10).is_empty());
    assert!(
        engine.due(t0 + 120).is_empty(),
        "cancelled timer must never warn or expire"
    );

    // A second, differently-named timer survives an unrelated cancel.
    engine.process(&line(t0 + 20, "You begin casting Clarity."), &mut sink);
    engine.process(
        &line(t0 + 21, "Your Spirit of Wolf spell has worn off."),
        &mut sink,
    );
    assert_eq!(
        engine.active_timers(t0 + 21),
        vec![("Clarity".to_string(), 59)]
    );
}

#[test]
fn timer_lanes_flow_from_action_or_category_to_sink_and_fires() {
    // Explicit lane on the action wins.
    let mut buff = Trigger::new(
        "buff",
        r"^You begin casting Talisman of Altuna\.$",
        vec![Action::StartTimer {
            name: "Talisman of Altuna".into(),
            duration_secs: 100,
            warn_at_secs: Some(10),
            duration_formula: None,
            duration_cap_ticks: None,
            cast_time_secs: None,
            rank_variants: Default::default(),
            mode: None,
            repeat_secs: None,
            stopwatch: false,
            warn_text: None,
            expire_text: None,
            warn_sound: None,
            expire_sound: None,
            lane: Some(TimerLane::Buff),
        }],
    );
    // Deliberately misleading category: the explicit lane must still win.
    buff.category = Some("Enemy Casts/Whatever".into());
    // No lane on the action: inferred from the Crowd Control category.
    let mut mez = Trigger::new(
        "mez",
        r"^You begin casting Enthrall\.$",
        vec![Action::StartTimer {
            name: "Mez (Enthrall)".into(),
            duration_secs: 48,
            warn_at_secs: Some(6),
            duration_formula: None,
            duration_cap_ticks: None,
            cast_time_secs: None,
            rank_variants: Default::default(),
            mode: None,
            repeat_secs: None,
            stopwatch: false,
            warn_text: None,
            expire_text: None,
            warn_sound: None,
            expire_sound: None,
            lane: None,
        }],
    );
    mez.category = Some("Class/Enchanter/Crowd Control".into());
    // No lane, neutral category: lands in "other".
    let mut recast = Trigger::new(
        "recast",
        r"^You begin casting Lay on Hands\.$",
        vec![Action::StartTimer {
            name: "Lay on Hands".into(),
            duration_secs: 30,
            warn_at_secs: None,
            duration_formula: None,
            duration_cap_ticks: None,
            cast_time_secs: None,
            rank_variants: Default::default(),
            mode: None,
            repeat_secs: None,
            stopwatch: false,
            warn_text: None,
            expire_text: None,
            warn_sound: None,
            expire_sound: None,
            lane: None,
        }],
    );
    recast.category = Some("Class/Paladin/Abilities".into());

    let mut engine = TriggerEngine::new(vec![buff, mez, recast], "Nyasha");
    let mut sink = RecordingSink::default();
    let t0 = 1_000;
    engine.process(
        &line(t0, "You begin casting Talisman of Altuna."),
        &mut sink,
    );
    engine.process(&line(t0, "You begin casting Enthrall."), &mut sink);
    engine.process(&line(t0, "You begin casting Lay on Hands."), &mut sink);
    assert_eq!(
        sink.timers,
        vec![
            (
                "Talisman of Altuna".to_string(),
                100,
                Some(10),
                TimerLane::Buff
            ),
            ("Mez (Enthrall)".to_string(), 48, Some(6), TimerLane::Enemy),
            ("Lay on Hands".to_string(), 30, None, TimerLane::Other),
        ]
    );

    // Warn and expire fires carry the lane through. At t0+42 the mez warn
    // (t0+42) and the Lay on Hands expiry (t0+30) are both due.
    let fires = engine.due(t0 + 42);
    assert!(fires.iter().any(|f| f.name == "Mez (Enthrall)"
        && f.kind == TimerFireKind::Warn
        && f.lane == TimerLane::Enemy));
    assert!(fires.iter().any(|f| f.name == "Lay on Hands"
        && f.kind == TimerFireKind::Expire
        && f.lane == TimerLane::Other));
    let fires = engine.due(t0 + 200);
    assert!(fires.iter().any(|f| f.name == "Talisman of Altuna"
        && f.kind == TimerFireKind::Expire
        && f.lane == TimerLane::Buff));
}

#[test]
fn cancel_timer_on_missing_timer_is_a_noop() {
    let cancel = Trigger::new(
        "gone",
        r"^GO$",
        vec![Action::CancelTimer {
            name: "Nope".into(),
        }],
    );
    let mut engine = TriggerEngine::new(vec![cancel], "Nyasha");
    let mut sink = RecordingSink::default();
    engine.process(&line(0, "GO"), &mut sink);
    // The sink is still told (idempotent removal for host UIs) and nothing
    // else happens.
    assert_eq!(sink.cancels, vec!["Nope"]);
    assert!(engine.due(10_000).is_empty());
}

#[test]
fn oversized_pack_falls_back_to_per_trigger_matching() {
    // Each of these patterns compiles fine on its own, but the combined
    // RegexSet blows regex's cumulative compiled-size limit. The engine
    // must not go silently deaf: it warns and keeps matching per-trigger.
    let mut triggers: Vec<Trigger> = (0..600)
        .map(|i| {
            Trigger::new(
                format!("big{i}"),
                r"[a-z]{1,90}[0-9]{1,90}[A-Z]{1,90}",
                vec![],
            )
        })
        .collect();
    triggers.push(Trigger::new(
        "hello",
        "hello world",
        vec![Action::Speak {
            template: "hi".into(),
        }],
    ));
    let count = triggers.len();
    let mut engine = TriggerEngine::new(triggers, "Nyasha");
    assert_eq!(engine.active_trigger_count(), count);
    assert!(
        engine
            .warnings()
            .iter()
            .any(|w| w.contains("per-trigger matching")),
        "the fallback must be surfaced as a warning: {:?}",
        engine.warnings()
    );

    let mut sink = RecordingSink::default();
    engine.process(&line(0, "you said hello world to Torvin"), &mut sink);
    assert_eq!(sink.spoken, vec!["hi"], "triggers must still fire");

    let mut sink2 = RecordingSink::default();
    engine.process(&line(0, "no match here"), &mut sink2);
    assert_eq!(sink2.total_calls(), 0);
}

// --- profile-level timer scaling ---------------------------------------------

#[test]
fn profile_level_scales_generated_timer_durations() {
    let generated = || {
        Trigger::new(
            "Buff timer: Spirit of Wolf",
            r"^You begin casting Spirit of Wolf\.$",
            vec![Action::StartTimer {
                name: "Spirit of Wolf".into(),
                duration_secs: 2160, // baked at level 50 by the generator
                warn_at_secs: Some(10),
                duration_formula: Some(3), // level * 30 ticks
                duration_cap_ticks: Some(360),
                cast_time_secs: None,
                rank_variants: Default::default(),
                mode: None,
                repeat_secs: None,
                stopwatch: false,
                warn_text: None,
                expire_text: None,
                warn_sound: None,
                expire_sound: None,
                lane: None,
            }],
        )
    };
    let curated = || {
        Trigger::new(
            "Root landed",
            r"^GO$",
            vec![Action::StartTimer {
                name: "Root".into(),
                duration_secs: 48, // hand-tuned: no formula metadata
                warn_at_secs: Some(10),
                duration_formula: None,
                duration_cap_ticks: None,
                cast_time_secs: None,
                rank_variants: Default::default(),
                mode: None,
                repeat_secs: None,
                stopwatch: false,
                warn_text: None,
                expire_text: None,
                warn_sound: None,
                expire_sound: None,
                lane: None,
            }],
        )
    };
    let run_at_level = |level: u32| {
        let mut profile = CharacterProfile::new("Nyasha");
        profile.level = level;
        let mut engine =
            TriggerEngine::new_with_profile(vec![generated(), curated()], "Nyasha", &profile);
        let mut sink = RecordingSink::default();
        engine.process(&line(0, "You begin casting Spirit of Wolf."), &mut sink);
        engine.process(&line(0, "GO"), &mut sink);
        sink.timers
    };

    // Level 10: formula 3 gives 10*30 = 300 ticks = 1800 s (under the cap);
    // the curated timer is untouched.
    assert_eq!(
        run_at_level(10),
        vec![
            (
                "Spirit of Wolf".to_string(),
                1800,
                Some(10),
                TimerLane::Other
            ),
            ("Root".to_string(), 48, Some(10), TimerLane::Other),
        ]
    );
    // Level 50: the 360-tick cap reproduces the baked duration exactly.
    assert_eq!(
        run_at_level(50),
        vec![
            (
                "Spirit of Wolf".to_string(),
                2160,
                Some(10),
                TimerLane::Other
            ),
            ("Root".to_string(), 48, Some(10), TimerLane::Other),
        ]
    );
}

#[test]
fn scaled_short_durations_clamp_the_warning_lead() {
    // Walking Sleep-style timer: formula 6 cap 35 -> 48 s at level 16; a
    // 10 s warn on a 48 s timer is clamped to 15% (7 s) so the warning
    // doesn't fire almost immediately on short low-level buffs.
    let trigger = Trigger::new(
        "mez",
        r"^You begin casting Walking Sleep\.",
        vec![Action::StartTimer {
            name: "Mez".into(),
            duration_secs: 150,
            warn_at_secs: Some(10),
            duration_formula: Some(6),
            duration_cap_ticks: Some(35),
            cast_time_secs: None,
            rank_variants: Default::default(),
            mode: None,
            repeat_secs: None,
            stopwatch: false,
            warn_text: None,
            expire_text: None,
            warn_sound: None,
            expire_sound: None,
            lane: None,
        }],
    );
    let mut profile = CharacterProfile::new("Nyasha");
    profile.level = 16;
    let mut engine = TriggerEngine::new_with_profile(vec![trigger], "Nyasha", &profile);
    let mut sink = RecordingSink::default();
    engine.process(&line(0, "You begin casting Walking Sleep."), &mut sink);
    assert_eq!(
        sink.timers,
        vec![("Mez".to_string(), 48, Some(7), TimerLane::Other)]
    );
}

#[test]
fn invis_buffs_share_one_timer_that_clears_on_drop() {
    // Every classic invis is random-duration, so the generated invis buffs all
    // drive ONE shared "Invisibility" bar that clears on the actual drop line
    // rather than running a per-spell countdown that lies.
    let mut profile = CharacterProfile::new("Nyasha");
    profile.active_loadout_mut().classes = vec!["Necromancer".into()];
    profile.level = 20;
    let mut engine = TriggerEngine::new_with_profile(load_library(), "Nyasha", &profile);
    let mut sink = RecordingSink::default();

    // Casting Gather Shadows (necro invis) starts the shared bar.
    engine.process(&line(0, "You begin casting Gather Shadows."), &mut sink);
    assert!(
        engine
            .active_timers(1)
            .iter()
            .any(|(n, _)| n == "Invisibility"),
        "invis cast should start the shared Invisibility bar: {:?}",
        engine.active_timers(1)
    );

    // Its wear-off line ("Your shadows fade.") clears the shared bar — even
    // though that message differs from the universal "You appear." line.
    engine.process(&line(2, "Your shadows fade."), &mut sink);
    assert!(
        !engine
            .active_timers(3)
            .iter()
            .any(|(n, _)| n == "Invisibility"),
        "the Invisibility bar must clear when invis drops: {:?}",
        engine.active_timers(3)
    );
    assert!(sink.cancels.contains(&"Invisibility".to_string()));
}

#[test]
fn invis_early_warning_is_large_loud_and_enabled_by_default() {
    let profile = CharacterProfile::new("Nyasha");
    let mut engine = TriggerEngine::new_with_profile(load_library(), "Nyasha", &profile);
    let mut sink = RecordingSink::default();

    engine.process(&line(0, "You feel yourself starting to appear."), &mut sink);

    assert_eq!(sink.sounds, vec!["danger.wav"]);
    assert!(sink.cancels.contains(&"Invisibility".to_string()));
    let (overlay, fields, config) = sink
        .overlays
        .iter()
        .find(|(_, fields, _)| fields.get("text").map(String::as_str) == Some("INVIS DROPPING"))
        .expect("default invis warning should emit a large Alerts overlay action");
    assert_eq!(overlay, "alerts");
    assert_eq!(fields.get("icon").map(String::as_str), Some("!"));
    assert_eq!(config.get("severity"), Some(&serde_json::json!("alarm")));
    assert_eq!(config.get("fontSize"), Some(&serde_json::json!(64)));
    assert_eq!(config.get("durationMs"), Some(&serde_json::json!(8000)));
}

// --- real-fixture pass with the shipped trigger library ----------------------

fn load_library() -> Vec<Trigger> {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../triggers");
    let loaded = eqlog_triggers::load_packs(std::path::Path::new(dir)).expect("triggers/ loads");
    assert!(
        loaded.warnings.is_empty(),
        "library must load without warnings: {:?}",
        loaded.warnings
    );
    loaded.triggers
}

#[test]
fn library_packs_parse_and_all_patterns_compile() {
    let triggers = load_library();
    assert!(
        triggers.len() > 1000,
        "the v2 library is ~1.1k triggers, got {}",
        triggers.len()
    );
    let engine = TriggerEngine::new(triggers.clone(), "Nyasha");
    assert!(
        engine.warnings().is_empty(),
        "all library patterns must compile: {:?}",
        engine.warnings()
    );
    assert!(triggers.iter().all(|t| t.category.is_some()));
}

#[test]
fn shipped_slay_undead_trigger_captures_target_damage_and_presentation() {
    let profile = CharacterProfile::new("Nyasha");
    let mut engine = TriggerEngine::new_with_profile(load_library(), "Nyasha", &profile);
    let mut sink = RecordingSink::default();

    engine.process(
        &line(
            1000,
            "You slash a ghoul for 213 points of damage. (Slay Undead)",
        ),
        &mut sink,
    );

    let (overlay, fields, config) = sink
        .overlays
        .iter()
        .find(|(overlay, fields, _)| {
            overlay == "impact" && fields.get("headline").map(String::as_str) == Some("SLAY UNDEAD")
        })
        .expect("Slay Undead should emit its configured Impact action");
    assert_eq!(overlay, "impact");
    assert_eq!(fields.get("big").map(String::as_str), Some("213"));
    assert_eq!(
        fields.get("sub").map(String::as_str),
        Some("Purged: a ghoul")
    );
    assert_eq!(config.get("style"), Some(&serde_json::json!("slay-undead")));
    assert_eq!(config.get("durationMs"), Some(&serde_json::json!(3200)));
    assert!(sink.sounds.contains(&"holy-strike.wav".to_string()));
}

#[test]
fn shipped_damage_skills_each_emit_one_named_alert_with_damage() {
    let mut profile = CharacterProfile::new("Nyasha");
    profile.active_loadout_mut().classes = vec!["Rogue".into(), "Monk".into(), "Warrior".into()];
    let mut engine = TriggerEngine::new_with_profile(load_library(), "Nyasha", &profile);
    let mut sink = RecordingSink::default();

    let cases = [
        ("Kick", "kick", "11", ""),
        ("Bash", "bash", "12", ""),
        ("Slam", "slam", "13", ""),
        ("Cleave", "cleave", "14", ""),
        ("Backstab", "backstab", "49", ""),
        ("Eagle Strike", "eagle strike", "16", ""),
        ("Tiger Claw", "tiger claw", "17", ""),
        ("Dragon Punch", "dragon punch", "18", ""),
        ("Tail Rake", "tail rake", "19", ""),
        ("Flying Kick", "flying kick", "20", ""),
        ("Round Kick", "round kick", "21", ""),
        ("Frenzy", "frenzy on", "22", " (Critical)"),
        ("Smite", "smite", "23", " (Finishing Blow)"),
        ("Reave", "reave", "24", " (Slay Undead)"),
    ];

    for (name, verb, damage, rider) in cases {
        let before = sink
            .overlays
            .iter()
            .filter(|(overlay, _, _)| overlay == "alerts")
            .count();
        engine.process(
            &line(
                1000,
                &format!("You {verb} a training dummy for {damage} points of damage.{rider}"),
            ),
            &mut sink,
        );
        let skill_alerts: Vec<_> = sink
            .overlays
            .iter()
            .filter(|(overlay, _, _)| overlay == "alerts")
            .collect();
        assert_eq!(
            skill_alerts.len(),
            before + 1,
            "{name} must add exactly one damage alert"
        );
        let (_, fields, config) = skill_alerts.last().expect("new skill alert");
        assert_eq!(fields.get("text").map(String::as_str), Some(name));
        assert_eq!(fields.get("value").map(String::as_str), Some(damage));
        assert_eq!(config.get("severity"), Some(&serde_json::json!("info")));
    }

    assert!(
        sink.displayed.is_empty(),
        "legacy class-specific skill alerts must not duplicate the shared overlay: {:?}",
        sink.displayed
    );
}

#[test]
fn shipped_enchanter_mez_and_slow_timers_accept_ranked_casts() {
    let triggers = load_library();

    for (id, expected_formula, expected_cap) in [
        ("class/enchanter/cc/mesmerize-timer", 7, 4),
        ("class/enchanter/cc/enthrall-timer", 8, 8),
        ("class/enchanter/cc/entrance-timer", 9, 12),
    ] {
        let trigger = triggers
            .iter()
            .find(|trigger| trigger.effective_id() == id)
            .unwrap_or_else(|| panic!("missing shipped timer {id}"));
        let action = trigger
            .actions
            .iter()
            .find_map(|action| match action {
                Action::StartTimer {
                    duration_formula,
                    duration_cap_ticks,
                    cast_time_secs,
                    lane,
                    ..
                } => Some((
                    *duration_formula,
                    *duration_cap_ticks,
                    *cast_time_secs,
                    *lane,
                )),
                _ => None,
            })
            .expect("Enchanter control trigger should own a timer action");
        assert_eq!(
            action,
            (
                Some(expected_formula),
                Some(expected_cap),
                Some(3),
                Some(TimerLane::Enemy),
            ),
            "{id} must expose rank-trainable timing metadata"
        );
    }

    let mut profile = CharacterProfile::new("Nyasha");
    profile.active_loadout_mut().classes = vec!["Enchanter".into()];
    let mut engine = TriggerEngine::new_with_profile(triggers, "Nyasha", &profile);
    let mut sink = RecordingSink::default();

    for (ts, message) in [
        (1000, "You begin casting Mesmerize VII."),
        (1001, "You begin casting Enthrall VI."),
        (1002, "You begin casting Entrance VII."),
        (1003, "You begin casting Tepid Deeds VII."),
        (1004, "You begin casting Dazzle VII."),
    ] {
        engine.process(&line(ts, message), &mut sink);
    }

    for expected in [
        ("Mesmerize", 27),
        ("Enthrall", 51),
        ("Entrance", 75),
        ("Tepid Deeds", 154),
        ("Dazzle", 99),
    ] {
        assert!(
            sink.timers
                .iter()
                .any(|(name, duration, _, lane)| name == expected.0
                    && *duration == expected.1
                    && *lane == TimerLane::Enemy),
            "ranked Enchanter timer missing for {expected:?}: {:?}",
            sink.timers
        );
    }
}

#[test]
fn shipped_ranked_mez_wear_off_clears_the_spell_timer() {
    let mut profile = CharacterProfile::new("Nyasha");
    profile.active_loadout_mut().classes = vec!["Enchanter".into()];
    let mut engine = TriggerEngine::new_with_profile(load_library(), "Nyasha", &profile);
    let mut sink = RecordingSink::default();

    engine.process(&line(1000, "You begin casting Enthrall VII."), &mut sink);
    assert!(engine
        .active_timers(1001)
        .iter()
        .any(|(name, _)| name == "Enthrall"));

    engine.process(
        &line(
            1002,
            "Your Enthrall VII spell has worn off of a ghoul wizard.",
        ),
        &mut sink,
    );

    assert!(sink.cancels.contains(&"Enthrall".to_string()));
    assert!(sink
        .displayed
        .contains(&"mez off a ghoul wizard".to_string()));
    assert!(!engine
        .active_timers(1002)
        .iter()
        .any(|(name, _)| name.starts_with("Enthrall")));
}

#[test]
fn debuff_packs_carry_enemy_lanes_and_cancel_companions() {
    // Lint over the generated debuffs-<class>.json family: every cast-start
    // timer is lane "enemy", every timer has a wear-off CancelTimer
    // companion, and the buff packs stay in the "buff" lane.
    let triggers = load_library();
    let mut debuff_timer_names: Vec<String> = Vec::new();
    let mut cancel_names: Vec<String> = Vec::new();
    let mut buff_casts = 0usize;
    for t in &triggers {
        let id = t.effective_id();
        for action in &t.actions {
            match action {
                Action::StartTimer { name, lane, .. } if id.starts_with("debuffs/") => {
                    assert_eq!(
                        *lane,
                        Some(TimerLane::Enemy),
                        "debuff timer {id} must be lane enemy"
                    );
                    debuff_timer_names.push(name.clone());
                }
                Action::StartTimer { lane, .. } if id.starts_with("buffs/") => {
                    assert_eq!(
                        *lane,
                        Some(TimerLane::Buff),
                        "buff timer {id} must be lane buff"
                    );
                    buff_casts += 1;
                }
                Action::CancelTimer { name } if id.starts_with("debuffs/worn/") => {
                    cancel_names.push(name.clone());
                }
                _ => {}
            }
        }
    }
    assert!(
        debuff_timer_names.len() > 200,
        "expected a substantial debuff pack family, got {}",
        debuff_timer_names.len()
    );
    assert!(
        buff_casts > 500,
        "buff cast timers missing lanes? {buff_casts}"
    );
    for name in &debuff_timer_names {
        assert!(
            cancel_names.contains(name),
            "debuff timer '{name}' has no wear-off CancelTimer companion"
        );
    }
}

#[test]
fn library_fires_on_real_fixture_lines_for_a_profile() {
    // The fixture character is a level-16 Shaman/Necromancer.
    let mut profile = CharacterProfile::new("Nyasha");
    profile.active_loadout_mut().classes = vec!["Shaman".into(), "Necromancer".into()];
    profile.level = 16;
    let mut engine = TriggerEngine::new_with_profile(load_library(), "Nyasha", &profile);
    assert!(engine.warnings().is_empty(), "{:?}", engine.warnings());

    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/unique_patterns.txt"
    );
    let text = std::fs::read_to_string(path).expect("fixture exists");
    let mut sink = RecordingSink::default();
    for (i, raw) in text.lines().enumerate() {
        let raw = raw.trim_end_matches('\r');
        // Fixed 27-char timestamp prefix: "[Thu Jul 02 23:32:46 2026] ".
        if raw.len() < 27 {
            continue;
        }
        engine.process(&line(i as i64, &raw[27..]), &mut sink);
    }
    // Default TTS policy: buff-ending, resist, enemy-cast dangers, and CC
    // on YOU (root/snare/mez/fear/charm, throttled by cooldowns) speak.
    // Stuns stay overlay-only regardless of source: melee bash stuns are far
    // too frequent to speak (152 fires in this fixture even with a 10 s
    // cooldown), and SPELL stuns fire 97 times here too — speaking them would
    // push spoken alerts from ~19 to ~34/hour, over the alert-fatigue budget.
    // Other survival/progress lines (encumbered, level-up "ding") also stay
    // overlay-only.
    assert!(sink.displayed.contains(&"stunned".to_string()));
    assert!(!sink.spoken.contains(&"stunned".to_string()));
    assert!(sink.displayed.contains(&"SPELL STUNNED".to_string()));
    assert!(!sink.spoken.contains(&"spell stunned".to_string()));
    assert!(sink.displayed.contains(&"encumbered".to_string()));
    assert!(!sink.spoken.contains(&"encumbered".to_string()));
    assert!(sink.displayed.contains(&"ding".to_string()));
    assert!(!sink.spoken.contains(&"ding".to_string()));
    // Player deaths show; mob-kill spam does not.
    assert!(sink
        .displayed
        .contains(&"Raesel slain by a greater skeleton".to_string()));
    assert!(sink
        .displayed
        .contains(&"Cutha slain by Trooper Tygin".to_string()));
    assert!(!sink.displayed.iter().any(|d| d.contains("orc raider")));
    // Shaman mez: level-scaled Walking Sleep timer (48 s at 16) + wear-off.
    // Mez wear-off is your-CC-breaking: speaks "mez off" AND shows the target
    // (user opted these back into speech; "you died"/"slain by" stay silent).
    assert!(sink.timers.contains(&(
        "Mez (Walking Sleep)".to_string(),
        48,
        Some(7),
        TimerLane::Enemy
    )));
    assert!(sink.displayed.iter().any(|s| s.starts_with("mez off")));
    assert!(sink.spoken.contains(&"mez off".to_string()));
    // Trash-mob enemy casts must stay quiet: minor heals, Harm Touch,
    // Tainted Breath and Cancelling of Life are all tier-2/off.
    assert!(!sink.spoken.iter().any(|s| s.contains("Healing")));
    assert!(!sink.spoken.iter().any(|s| s.contains("Harm Touch")));
    assert!(!sink.spoken.iter().any(|s| s.contains("Tainted Breath")));
    assert!(!sink.spoken.iter().any(|s| s.contains("Cancelling of Life")));
}

#[test]
fn friendly_casters_do_not_fire_enemy_cast_triggers() {
    let mut t = Trigger::new(
        "Enemy lifetap",
        r"^(.+) begins casting (Lifespike|Cancelling of Life)\.$",
        vec![Action::Speak {
            template: "${2} incoming".into(),
        }],
    );
    t.category = Some("Enemy Casts/Lifetap".into());
    let mut engine = TriggerEngine::new(vec![t], "Nyasha");
    engine.add_friendly_names(["Vibarn"]);
    let mut sink = RecordingSink::default();

    let cast = |caster: Entity, msg: &str| ParsedLine {
        line: LogLine {
            timestamp: 1000,
            message: msg.to_string(),
        },
        event: Event::CastBegin {
            caster,
            spell: "Lifespike".into(),
        },
    };

    // Own pet (possessive, both apostrophe styles), named pet, and self:
    // all suppressed.
    engine.process(
        &cast(
            Entity::Named("Nyasha's Pet".into()),
            "Nyasha's Pet begins casting Lifespike.",
        ),
        &mut sink,
    );
    engine.process(
        &cast(
            Entity::Named("Nyasha`s warder".into()),
            "Nyasha`s warder begins casting Lifespike.",
        ),
        &mut sink,
    );
    engine.process(
        &cast(
            Entity::Named("Vibarn".into()),
            "Vibarn begins casting Lifespike.",
        ),
        &mut sink,
    );
    assert_eq!(sink.total_calls(), 0, "friendly casts must not alert");

    // A real mob cast still fires.
    engine.process(
        &cast(
            Entity::Named("A Teir`Dal shadowknight".into()),
            "A Teir`Dal shadowknight begins casting Cancelling of Life.",
        ),
        &mut sink,
    );
    assert_eq!(sink.spoken, vec!["Cancelling of Life incoming".to_string()]);
}

#[test]
fn renamed_pet_learned_from_leader_say() {
    let mut t = Trigger::new(
        "Enemy cast",
        r"^(.+) begins casting (.+)\.$",
        vec![Action::Speak {
            template: "${2} incoming".into(),
        }],
    );
    t.category = Some("Enemy Casts/Other".into());
    let mut engine = TriggerEngine::new(vec![t], "Nyasha");
    let mut sink = RecordingSink::default();

    // Renamed pet "Fluffy" — unknown, so its cast alerts at first.
    let fluffy_cast = ParsedLine {
        line: LogLine {
            timestamp: 1000,
            message: "Fluffy begins casting Lifespike.".into(),
        },
        event: Event::CastBegin {
            caster: Entity::Named("Fluffy".into()),
            spell: "Lifespike".into(),
        },
    };
    engine.process(&fluffy_cast, &mut sink);
    assert_eq!(sink.spoken.len(), 1, "unknown caster alerts");

    // /pet leader: "Fluffy says, 'My leader is Nyasha.'" teaches the engine.
    engine.process(
        &ParsedLine {
            line: LogLine {
                timestamp: 1001,
                message: "Fluffy says, 'My leader is Nyasha.'".into(),
            },
            event: Event::Chat {
                channel: ChatChannel::Say,
                speaker: Entity::Named("Fluffy".into()),
                text: "My leader is Nyasha.".into(),
            },
        },
        &mut sink,
    );
    engine.process(&fluffy_cast, &mut sink);
    assert_eq!(sink.spoken.len(), 1, "learned pet no longer alerts");
}

fn enemy_dot_trigger(name: &str, pattern: &str) -> Trigger {
    Trigger::new(
        name,
        pattern,
        vec![Action::StartTimer {
            name: name.into(),
            duration_secs: 60,
            warn_at_secs: None,
            duration_formula: None,
            duration_cap_ticks: None,
            cast_time_secs: None,
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
    )
}

#[test]
fn failed_recast_spares_a_bound_dot_on_another_mob() {
    // P17: a fizzle cancels only the bare timer the failed cast started — a
    // "Spell — T" DoT already ticking on another mob must survive (a failed
    // cast dealt no damage, so it never bound one).
    let mut engine = TriggerEngine::new(
        vec![enemy_dot_trigger(
            "Boil Blood",
            r"^You begin casting Boil Blood\.$",
        )],
        "Nyasha",
    );
    let mut sink = RecordingSink::default();
    let line = |ts: i64, msg: &str, event: Event| ParsedLine {
        line: LogLine {
            timestamp: ts,
            message: msg.into(),
        },
        event,
    };

    // Cast on a rat and let it tick -> bound bar "Boil Blood — a rat".
    engine.process(
        &line(
            1000,
            "You begin casting Boil Blood.",
            Event::CastBegin {
                caster: Entity::You,
                spell: "Boil Blood".into(),
            },
        ),
        &mut sink,
    );
    engine.process(
        &line(
            1006,
            "a rat has taken 8 damage from Boil Blood by Nyasha.",
            Event::SpellDamageTaken {
                target: Entity::Named("a rat".into()),
                source: Entity::Named("Nyasha".into()),
                spell: "Boil Blood".into(),
                amount: 8,
            },
        ),
        &mut sink,
    );

    // Recast (a fresh bare timer) then fizzle it.
    engine.process(
        &line(
            1010,
            "You begin casting Boil Blood.",
            Event::CastBegin {
                caster: Entity::You,
                spell: "Boil Blood".into(),
            },
        ),
        &mut sink,
    );
    engine.process(
        &line(
            1012,
            "Your Boil Blood spell fizzles.",
            Event::CastFizzled {
                caster: Entity::You,
                spell: Some("Boil Blood".into()),
            },
        ),
        &mut sink,
    );

    let names: Vec<String> = engine
        .active_timers(1012)
        .into_iter()
        .map(|(n, _)| n)
        .collect();
    assert_eq!(
        names,
        vec!["Boil Blood — a rat".to_string()],
        "the bound DoT on the other mob must survive the fizzle"
    );
}

#[test]
fn zoning_reaps_enemy_timers_but_keeps_buffs() {
    // P17: entering a new zone leaves every mob behind, so enemy-lane DoT/CC
    // bars are stale and must be reaped. Buff-lane timers (your own buffs)
    // persist across the zone line.
    let mut buff = enemy_dot_trigger("Shield of Words", r"^You begin casting Shield of Words\.$");
    if let Action::StartTimer { lane, .. } = &mut buff.actions[0] {
        *lane = Some(TimerLane::Buff);
    }
    let mut engine = TriggerEngine::new(
        vec![
            enemy_dot_trigger("Boil Blood", r"^You begin casting Boil Blood\.$"),
            buff,
        ],
        "Nyasha",
    );
    let mut sink = RecordingSink::default();
    let line = |ts: i64, msg: &str, event: Event| ParsedLine {
        line: LogLine {
            timestamp: ts,
            message: msg.into(),
        },
        event,
    };

    engine.process(
        &line(
            1000,
            "You begin casting Boil Blood.",
            Event::CastBegin {
                caster: Entity::You,
                spell: "Boil Blood".into(),
            },
        ),
        &mut sink,
    );
    engine.process(
        &line(
            1001,
            "You begin casting Shield of Words.",
            Event::CastBegin {
                caster: Entity::You,
                spell: "Shield of Words".into(),
            },
        ),
        &mut sink,
    );
    assert_eq!(engine.active_timers(1001).len(), 2);

    engine.process(
        &line(
            1005,
            "You have entered West Karana.",
            Event::ZoneEnter {
                zone: "West Karana".into(),
            },
        ),
        &mut sink,
    );
    let names: Vec<String> = engine
        .active_timers(1005)
        .into_iter()
        .map(|(n, _)| n)
        .collect();
    assert_eq!(names, vec!["Shield of Words".to_string()]);
    assert!(sink.cancels.contains(&"Boil Blood".to_string()));
}

#[test]
fn failed_casts_cancel_their_dot_timers() {
    let mut t = Trigger::new(
        "Boil Blood timer",
        r"^You begin casting Boil Blood\.$",
        vec![Action::StartTimer {
            name: "Boil Blood".into(),
            duration_secs: 42,
            warn_at_secs: None,
            duration_formula: None,
            duration_cap_ticks: None,
            cast_time_secs: None,
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
    t.category = Some("Class/Necromancer/DoTs".into());
    t.icon = Some("spell:51".into());
    let mut engine = TriggerEngine::new(vec![t], "Nyasha");
    let mut sink = RecordingSink::default();

    let cast = ParsedLine {
        line: LogLine {
            timestamp: 1000,
            message: "You begin casting Boil Blood.".into(),
        },
        event: Event::CastBegin {
            caster: Entity::You,
            spell: "Boil Blood".into(),
        },
    };
    engine.process(&cast, &mut sink);
    assert_eq!(engine.active_timers(1000).len(), 1, "timer started on cast");

    // Interrupted: timer must vanish and the sink must hear about it.
    engine.process(
        &ParsedLine {
            line: LogLine {
                timestamp: 1002,
                message: "Your Boil Blood spell is interrupted.".into(),
            },
            event: Event::CastInterrupted {
                caster: Entity::You,
                spell: Some("Boil Blood".into()),
            },
        },
        &mut sink,
    );
    assert!(
        engine.active_timers(1002).is_empty(),
        "interrupt cancels timer"
    );
    assert_eq!(sink.cancels, vec!["Boil Blood".to_string()]);

    // Resisted: same story.
    engine.process(&cast, &mut sink);
    engine.process(
        &ParsedLine {
            line: LogLine {
                timestamp: 1010,
                message: "A zol ghoul knight resisted your Boil Blood!".into(),
            },
            event: Event::Resisted {
                target: Entity::Named("A zol ghoul knight".into()),
                caster: Entity::You,
                spell: "Boil Blood".into(),
            },
        },
        &mut sink,
    );
    assert!(
        engine.active_timers(1010).is_empty(),
        "resist cancels timer"
    );

    // Someone ELSE's interrupt must not touch our timers.
    engine.process(&cast, &mut sink);
    engine.process(
        &ParsedLine {
            line: LogLine {
                timestamp: 1020,
                message: "Torvin's Frost Dagger spell is interrupted.".into(),
            },
            event: Event::CastInterrupted {
                caster: Entity::Named("Torvin".into()),
                spell: Some("Frost Dagger".into()),
            },
        },
        &mut sink,
    );
    assert_eq!(
        engine.active_timers(1020).len(),
        1,
        "other casters don't cancel ours"
    );
}

#[test]
fn nested_enemy_casts_category_is_suppressed_for_pets() {
    // The starter/user pack nests the category ("Combat/Enemy Casts") —
    // suppression must match by containment, not prefix.
    let mut t = Trigger::new(
        "Dangerous enemy cast",
        r"^(.+) begins casting (Cancelling of Life)\.$",
        vec![Action::Speak {
            template: "${2} incoming".into(),
        }],
    );
    t.category = Some("Combat/Enemy Casts".into());
    let mut engine = TriggerEngine::new(vec![t], "Nyasha");
    let mut sink = RecordingSink::default();
    engine.process(
        &ParsedLine {
            line: LogLine {
                timestamp: 1000,
                message: "Nyasha`s pet begins casting Cancelling of Life.".into(),
            },
            event: Event::CastBegin {
                caster: Entity::Named("Nyasha`s pet".into()),
                spell: "Cancelling of Life".into(),
            },
        },
        &mut sink,
    );
    assert!(
        sink.spoken.is_empty(),
        "pet cast must not alert in nested category"
    );
}

#[test]
fn shipped_resist_trigger_clears_target_timer_and_resolves_spell_icon() {
    let mut profile = CharacterProfile::new("Nyasha");
    profile.active_loadout_mut().classes = vec!["Necromancer".into()];
    profile.level = 36;
    let mut engine = TriggerEngine::new_with_profile(load_library(), "Nyasha", &profile);
    let mut sink = RecordingSink::default();

    engine.process(
        &line(1000, "You begin casting Cascading Darkness."),
        &mut sink,
    );
    engine.process(
        &ParsedLine {
            line: LogLine {
                timestamp: 1004,
                message:
                    "Sister of the Spire has taken 20 damage from Cascading Darkness by Nyasha."
                        .into(),
            },
            event: Event::SpellDamageTaken {
                target: Entity::Named("Sister of the Spire".into()),
                source: Entity::Named("Nyasha".into()),
                spell: "Cascading Darkness".into(),
                amount: 20,
            },
        },
        &mut sink,
    );
    assert!(engine
        .active_timers(1004)
        .iter()
        .any(|(name, _)| name == "Cascading Darkness — Sister of the Spire"));

    engine.process(
        &line(
            1010,
            "Sister of the Spire resisted your Cascading Darkness!",
        ),
        &mut sink,
    );

    assert!(
        engine.active_timers(1010).is_empty(),
        "the configured resist actions clear bare and target-bound timers"
    );
    let alert = sink
        .overlays
        .iter()
        .find(|(overlay, fields, _)| {
            overlay == "alerts" && fields.get("text").is_some_and(|v| v.contains("Resisted"))
        })
        .expect("resist alert");
    assert_eq!(alert.1["icon"], "spell-name:Cascading Darkness");
}

#[test]
fn ranked_resist_clears_base_timer_without_cancelling_an_earlier_target() {
    let mut profile = CharacterProfile::new("Nyasha");
    profile.active_loadout_mut().classes = vec!["Shaman".into()];
    profile.level = 60;
    let mut engine = TriggerEngine::new_with_profile(load_library(), "Nyasha", &profile);
    let mut sink = RecordingSink::default();

    // Preserve a successfully landed Odium on another target.
    engine.process(&line(1000, "You begin casting Odium."), &mut sink);
    engine.process(
        &ParsedLine {
            line: LogLine {
                timestamp: 1004,
                message: "A frost giant has taken 20 damage from Odium by Nyasha.".into(),
            },
            event: Event::SpellDamageTaken {
                target: Entity::Named("A frost giant".into()),
                source: Entity::Named("Nyasha".into()),
                spell: "Odium".into(),
                amount: 20,
            },
        },
        &mut sink,
    );

    // Ranked casts still use the trigger's base display name for their timer.
    engine.process(&line(1010, "You begin casting Odium VI."), &mut sink);
    let names: Vec<String> = engine
        .active_timers(1010)
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    assert!(names.contains(&"Odium".to_string()));
    assert!(names.contains(&"Odium — A frost giant".to_string()));

    engine.process(
        &ParsedLine {
            line: LogLine {
                timestamp: 1014,
                message: "Bzzzt resisted your Odium VI!".into(),
            },
            event: Event::Resisted {
                target: Entity::Named("Bzzzt".into()),
                caster: Entity::You,
                spell: "Odium VI".into(),
            },
        },
        &mut sink,
    );

    let names: Vec<String> = engine
        .active_timers(1014)
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    assert_eq!(names, vec!["Odium — A frost giant".to_string()]);
    assert!(sink.cancels.contains(&"Odium".to_string()));
}

#[test]
fn dot_timers_bind_to_tick_target_and_die_with_it() {
    let mut t = Trigger::new(
        "Boil Blood timer",
        r"^You begin casting Boil Blood\.$",
        vec![Action::StartTimer {
            name: "Boil Blood".into(),
            duration_secs: 42,
            warn_at_secs: None,
            duration_formula: None,
            duration_cap_ticks: None,
            cast_time_secs: None,
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
    t.category = Some("Class/Necromancer/DoTs".into());
    t.icon = Some("spell:51".into());
    let mut engine = TriggerEngine::new(vec![t], "Nyasha");
    let mut sink = RecordingSink::default();

    let line = |ts: i64, msg: &str, event: Event| ParsedLine {
        line: LogLine {
            timestamp: ts,
            message: msg.into(),
        },
        event,
    };

    engine.process(
        &line(
            1000,
            "You begin casting Boil Blood.",
            Event::CastBegin {
                caster: Entity::You,
                spell: "Boil Blood".into(),
            },
        ),
        &mut sink,
    );
    // First tick binds the bar to the target.
    engine.process(
        &line(
            1006,
            "A zol ghoul knight has taken 8 damage from Boil Blood by Nyasha.",
            Event::SpellDamageTaken {
                target: Entity::Named("A zol ghoul knight".into()),
                source: Entity::Named("Nyasha".into()),
                spell: "Boil Blood".into(),
                amount: 8,
            },
        ),
        &mut sink,
    );
    let names: Vec<String> = engine
        .active_timers(1006)
        .into_iter()
        .map(|(n, _)| n)
        .collect();
    assert_eq!(names, vec!["Boil Blood — A zol ghoul knight".to_string()]);
    assert!(sink.timer_icons.contains(&(
        "Boil Blood — A zol ghoul knight".to_string(),
        Some("spell:51".to_string()),
    )));

    // Target dies -> bar vanishes.
    engine.process(
        &line(
            1010,
            "You have slain a zol ghoul knight!",
            Event::Slain {
                victim: Entity::Named("A zol ghoul knight".into()),
                killer: Some(Entity::You),
            },
        ),
        &mut sink,
    );
    assert!(
        engine.active_timers(1010).is_empty(),
        "death reaps its timers"
    );

    // Your own death clears everything.
    engine.process(
        &line(
            1020,
            "You begin casting Boil Blood.",
            Event::CastBegin {
                caster: Entity::You,
                spell: "Boil Blood".into(),
            },
        ),
        &mut sink,
    );
    engine.process(
        &line(
            1025,
            "You died.",
            Event::Slain {
                victim: Entity::You,
                killer: None,
            },
        ),
        &mut sink,
    );
    assert!(
        engine.active_timers(1025).is_empty(),
        "your death clears all timers"
    );
}

/// The log does not carry a unique mob ID. When the same DoT lands again on
/// the same visible name, treat it as a refresh instead of inventing a
/// numbered target group that can split one mob across the overlay.
#[test]
fn redotting_same_visible_target_refreshes_the_existing_bar() {
    let mut t = Trigger::new(
        "Boil Blood timer",
        r"^You begin casting Boil Blood\.$",
        vec![Action::StartTimer {
            name: "Boil Blood".into(),
            duration_secs: 42,
            warn_at_secs: None,
            duration_formula: None,
            duration_cap_ticks: None,
            cast_time_secs: None,
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
    t.category = Some("Class/Necromancer/DoTs".into());
    let mut engine = TriggerEngine::new(vec![t], "Nyasha");
    let mut sink = RecordingSink::default();

    let line = |ts: i64, msg: &str, event: Event| ParsedLine {
        line: LogLine {
            timestamp: ts,
            message: msg.into(),
        },
        event,
    };
    let cast = |ts| {
        line(
            ts,
            "You begin casting Boil Blood.",
            Event::CastBegin {
                caster: Entity::You,
                spell: "Boil Blood".into(),
            },
        )
    };
    let tick = |ts| {
        line(
            ts,
            "A zol ghoul knight has taken 8 damage from Boil Blood by Nyasha.",
            Event::SpellDamageTaken {
                target: Entity::Named("A zol ghoul knight".into()),
                source: Entity::Named("Nyasha".into()),
                spell: "Boil Blood".into(),
                amount: 8,
            },
        )
    };

    // First cast binds the base instance.
    engine.process(&cast(1000), &mut sink);
    engine.process(&tick(1006), &mut sink);
    // Recasting on the same visible name refreshes the existing bar.
    engine.process(&cast(1010), &mut sink);
    engine.process(&tick(1016), &mut sink);

    let names: Vec<String> = engine
        .active_timers(1016)
        .into_iter()
        .map(|(n, _)| n)
        .collect();
    assert_eq!(names, vec!["Boil Blood — A zol ghoul knight".to_string()]);
    let remaining: Vec<i64> = engine
        .active_timers(1016)
        .into_iter()
        .map(|(_, r)| r)
        .collect();
    assert_eq!(remaining, vec![1010 + 42 - 1016]);
    assert!(sink
        .cancels
        .contains(&"Boil Blood — A zol ghoul knight".to_string()));

    // The mob dies: the visible-name bar clears.
    engine.process(
        &line(
            1020,
            "You have slain a zol ghoul knight!",
            Event::Slain {
                victim: Entity::Named("A zol ghoul knight".into()),
                killer: Some(Entity::You),
            },
        ),
        &mut sink,
    );
    assert!(
        engine.active_timers(1020).is_empty(),
        "death clears every instance bound to the name"
    );
    assert!(
        sink.cancels
            .contains(&"Boil Blood — A zol ghoul knight".to_string()),
        "sink told to clear Boil Blood: {:?}",
        sink.cancels
    );
}

#[test]
fn mixed_case_target_binds_reuse_the_first_seen_casing() {
    // The log capitalizes the same mob differently by sentence position;
    // a second bind must reuse the casing of the already-bound timer so
    // the mob doesn't split into two overlay groups.
    let dot = |spell: &str| {
        let mut t = Trigger::new(
            format!("{spell} timer"),
            format!(r"^You begin casting {spell}\.$"),
            vec![Action::StartTimer {
                name: spell.into(),
                duration_secs: 60,
                warn_at_secs: None,
                duration_formula: None,
                duration_cap_ticks: None,
                cast_time_secs: None,
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
        t.category = Some("Class/Necromancer/DoTs".into());
        t
    };
    let mut engine = TriggerEngine::new(
        vec![dot("Venom of the Snake"), dot("Dooming Darkness")],
        "Nyasha",
    );
    let mut sink = RecordingSink::default();
    let line = |ts: i64, msg: &str, event: Event| ParsedLine {
        line: LogLine {
            timestamp: ts,
            message: msg.into(),
        },
        event,
    };
    // First DoT binds with the line-start capitalization.
    engine.process(
        &line(
            1000,
            "You begin casting Venom of the Snake.",
            Event::CastBegin {
                caster: Entity::You,
                spell: "Venom of the Snake".into(),
            },
        ),
        &mut sink,
    );
    engine.process(
        &line(
            1003,
            "A kor ghoul wizard has taken 9 damage from Venom of the Snake by Nyasha.",
            Event::SpellDamageTaken {
                target: Entity::Named("A kor ghoul wizard".into()),
                source: Entity::You,
                spell: "Venom of the Snake".into(),
                amount: 9,
            },
        ),
        &mut sink,
    );
    // Second DoT's tick names the mob in lowercase (mid-sentence form).
    engine.process(
        &line(
            1010,
            "You begin casting Dooming Darkness.",
            Event::CastBegin {
                caster: Entity::You,
                spell: "Dooming Darkness".into(),
            },
        ),
        &mut sink,
    );
    engine.process(
        &line(
            1013,
            "a kor ghoul wizard has taken 4 damage from Dooming Darkness by Nyasha.",
            Event::SpellDamageTaken {
                target: Entity::Named("a kor ghoul wizard".into()),
                source: Entity::You,
                spell: "Dooming Darkness".into(),
                amount: 4,
            },
        ),
        &mut sink,
    );
    let mut names: Vec<String> = engine
        .active_timers(1013)
        .into_iter()
        .map(|(n, _)| n)
        .collect();
    names.sort();
    assert_eq!(
        names,
        vec![
            "Dooming Darkness — A kor ghoul wizard".to_string(),
            "Venom of the Snake — A kor ghoul wizard".to_string(),
        ],
        "second bind reuses the first bind's casing"
    );
}

#[test]
fn targeted_wear_off_clears_refreshed_visible_target_bar() {
    let mut t = Trigger::new(
        "Heat Blood timer",
        r"^You begin casting Heat Blood\.$",
        vec![Action::StartTimer {
            name: "Heat Blood".into(),
            duration_secs: 60,
            warn_at_secs: None,
            duration_formula: None,
            duration_cap_ticks: None,
            cast_time_secs: None,
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
    t.category = Some("Class/Necromancer/DoTs".into());
    let mut engine = TriggerEngine::new(vec![t], "Nyasha");
    let mut sink = RecordingSink::default();

    let line = |ts: i64, msg: &str, event: Event| ParsedLine {
        line: LogLine {
            timestamp: ts,
            message: msg.into(),
        },
        event,
    };
    for ts in [1000, 1010] {
        engine.process(
            &line(
                ts,
                "You begin casting Heat Blood.",
                Event::CastBegin {
                    caster: Entity::You,
                    spell: "Heat Blood".into(),
                },
            ),
            &mut sink,
        );
        engine.process(
            &line(
                ts + 6,
                "A froglok has taken 12 damage from Heat Blood by Nyasha.",
                Event::SpellDamageTaken {
                    target: Entity::Named("A froglok".into()),
                    source: Entity::You,
                    spell: "Heat Blood".into(),
                    amount: 12,
                },
            ),
            &mut sink,
        );
    }
    let names: Vec<String> = engine
        .active_timers(1016)
        .into_iter()
        .map(|(n, _)| n)
        .collect();
    assert_eq!(names, vec!["Heat Blood — A froglok".to_string()]);

    // "Your Heat Blood spell has worn off of A froglok." clears the bar.
    engine.process(
        &line(
            1040,
            "Your Heat Blood spell has worn off of A froglok.",
            Event::WornOff {
                spell: "Heat Blood".into(),
                owner: Some(Entity::Named("A froglok".into())),
            },
        ),
        &mut sink,
    );
    let names: Vec<String> = engine
        .active_timers(1040)
        .into_iter()
        .map(|(n, _)| n)
        .collect();
    assert!(names.is_empty(), "{names:?}");
    assert!(sink.cancels.contains(&"Heat Blood — A froglok".to_string()));
}

#[test]
fn death_clears_every_spell_bound_to_the_victim() {
    // Two different DoTs bound to one visible name: one death clears every
    // spell bound to that name.
    let dot = |spell: &str| {
        let mut t = Trigger::new(
            format!("{spell} timer"),
            format!(r"^You begin casting {spell}\.$"),
            vec![Action::StartTimer {
                name: spell.into(),
                duration_secs: 90,
                warn_at_secs: None,
                duration_formula: None,
                duration_cap_ticks: None,
                cast_time_secs: None,
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
        t.category = Some("Class/Necromancer/DoTs".into());
        t
    };
    let mut engine = TriggerEngine::new(vec![dot("Boil Blood"), dot("Heat Blood")], "Nyasha");
    let mut sink = RecordingSink::default();

    let line = |ts: i64, msg: &str, event: Event| ParsedLine {
        line: LogLine {
            timestamp: ts,
            message: msg.into(),
        },
        event,
    };
    let mut ts = 1000;
    for spell in ["Boil Blood", "Heat Blood"] {
        engine.process(
            &line(
                ts,
                &format!("You begin casting {spell}."),
                Event::CastBegin {
                    caster: Entity::You,
                    spell: spell.into(),
                },
            ),
            &mut sink,
        );
        engine.process(
            &line(
                ts + 3,
                &format!("A gnoll has taken 5 damage from {spell} by Nyasha."),
                Event::SpellDamageTaken {
                    target: Entity::Named("A gnoll".into()),
                    source: Entity::You,
                    spell: spell.into(),
                    amount: 5,
                },
            ),
            &mut sink,
        );
        ts += 5;
    }
    assert_eq!(engine.active_timers(ts).len(), 2);

    engine.process(
        &line(
            ts,
            "A gnoll has been slain by Nyasha!",
            Event::Slain {
                victim: Entity::Named("A gnoll".into()),
                killer: Some(Entity::Named("Nyasha".into())),
            },
        ),
        &mut sink,
    );
    assert!(
        engine.active_timers(ts).is_empty(),
        "one death clears every spell bound to the name"
    );
    for name in ["Boil Blood — A gnoll", "Heat Blood — A gnoll"] {
        assert!(
            sink.cancels.contains(&name.to_string()),
            "sink told to clear {name}: {:?}",
            sink.cancels
        );
    }
}

#[test]
fn cast_time_leads_the_timer_so_expiry_matches_landing() {
    let t = Trigger::new(
        "SoW timer",
        r"^You begin casting Spirit of Wolf\.$",
        vec![Action::StartTimer {
            name: "Spirit of Wolf".into(),
            duration_secs: 30,
            warn_at_secs: None,
            duration_formula: None,
            duration_cap_ticks: None,
            cast_time_secs: Some(5),
            rank_variants: Default::default(),
            mode: None,
            repeat_secs: None,
            stopwatch: false,
            warn_text: None,
            expire_text: None,
            warn_sound: None,
            expire_sound: None,
            lane: Some(TimerLane::Buff),
        }],
    );
    let mut engine = TriggerEngine::new(vec![t], "Nyasha");
    let mut sink = RecordingSink::default();
    engine.process(
        &ParsedLine {
            line: LogLine {
                timestamp: 1000,
                message: "You begin casting Spirit of Wolf.".into(),
            },
            event: Event::CastBegin {
                caster: Entity::You,
                spell: "Spirit of Wolf".into(),
            },
        },
        &mut sink,
    );
    // Bar shows cast time + duration; expiry = landing + duration.
    assert_eq!(
        sink.timers,
        vec![("Spirit of Wolf".into(), 35u64, None, TimerLane::Buff)]
    );
    let timers = engine.active_timers(1000);
    // active_timers reports REMAINING seconds: expiry is at 1035, so 35
    // remain at cast start (cast time + duration).
    assert_eq!(
        timers[0].1, 35,
        "expires at cast-start + cast time + duration"
    );
}

/// Regression: the real parser names the same mob with different
/// capitalization by sentence position — the binding tick line starts with
/// "A hill giant has taken…" (capital A) while the kill/wear-off lines name
/// it mid-sentence ("You have slain a hill giant!", "…worn off of a hill
/// giant."). Timer reaping must match case-insensitively or DoT bars linger
/// after the mob dies (the "timers sometimes don't clear" report).
#[test]
fn dot_reaping_survives_log_case_differences() {
    let mut t = Trigger::new(
        "Boil Blood timer",
        r"^You begin casting Boil Blood\.$",
        vec![Action::StartTimer {
            name: "Boil Blood".into(),
            duration_secs: 42,
            warn_at_secs: None,
            duration_formula: None,
            duration_cap_ticks: None,
            cast_time_secs: None,
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
    t.category = Some("Class/Necromancer/DoTs".into());

    let line = |ts: i64, msg: &str, event: Event| ParsedLine {
        line: LogLine {
            timestamp: ts,
            message: msg.into(),
        },
        event,
    };
    let cast = |ts| {
        line(
            ts,
            "You begin casting Boil Blood.",
            Event::CastBegin {
                caster: Entity::You,
                spell: "Boil Blood".into(),
            },
        )
    };
    // Binding tick: line-initial name is capitalized.
    let tick = |ts| {
        line(
            ts,
            "A hill giant has taken 8 damage from Boil Blood by Nyasha.",
            Event::SpellDamageTaken {
                target: Entity::Named("A hill giant".into()),
                source: Entity::You,
                spell: "Boil Blood".into(),
                amount: 8,
            },
        )
    };

    // Case 1: player lands the killing blow — the victim arrives lowercase.
    let mut engine = TriggerEngine::new(vec![t.clone()], "Nyasha");
    let mut sink = RecordingSink::default();
    engine.process(&cast(1000), &mut sink);
    engine.process(&tick(1006), &mut sink);
    let names: Vec<String> = engine
        .active_timers(1006)
        .into_iter()
        .map(|(n, _)| n)
        .collect();
    assert_eq!(names, vec!["Boil Blood — A hill giant".to_string()]);
    engine.process(
        &line(
            1010,
            "You have slain a hill giant!",
            Event::Slain {
                victim: Entity::Named("a hill giant".into()),
                killer: Some(Entity::You),
            },
        ),
        &mut sink,
    );
    assert!(
        engine.active_timers(1010).is_empty(),
        "lowercase kill line must reap the capitalized-bound bar: {:?}",
        engine.active_timers(1010)
    );
    assert!(sink
        .cancels
        .contains(&"Boil Blood — A hill giant".to_string()));

    // Case 2: targeted wear-off also names the mob lowercase mid-sentence.
    let mut engine = TriggerEngine::new(vec![t], "Nyasha");
    let mut sink = RecordingSink::default();
    engine.process(&cast(2000), &mut sink);
    engine.process(&tick(2006), &mut sink);
    engine.process(
        &line(
            2020,
            "Your Boil Blood spell has worn off of a hill giant.",
            Event::WornOff {
                spell: "Boil Blood".into(),
                owner: Some(Entity::Named("a hill giant".into())),
            },
        ),
        &mut sink,
    );
    assert!(
        engine.active_timers(2020).is_empty(),
        "lowercase wear-off must reap the capitalized-bound bar: {:?}",
        engine.active_timers(2020)
    );
}

/// Per-trigger refire cooldown: a matching line inside the window is
/// silent, the window is measured from the last FIRE (throttled matches
/// don't slide it), and triggers without a cooldown are unaffected.
#[test]
fn refire_cooldown_throttles_matches() {
    let throttled = Trigger {
        cooldown_secs: Some(10),
        ..Trigger::new(
            "hit taken",
            r"slashes YOU for \d+ points of damage",
            vec![Action::Speak {
                template: "big hit".into(),
            }],
        )
    };
    let free = Trigger::new(
        "always",
        r"^You are stunned!",
        vec![Action::Speak {
            template: "stunned".into(),
        }],
    );
    let mut engine = TriggerEngine::new(vec![throttled, free], "Nyasha");
    let mut sink = RecordingSink::default();

    let hit = |ts: i64| ParsedLine {
        line: LogLine {
            timestamp: ts,
            message: "a hill giant slashes YOU for 112 points of damage.".into(),
        },
        event: Event::Unclassified,
    };

    engine.process(&hit(1000), &mut sink); // fires
    engine.process(&hit(1003), &mut sink); // throttled
    engine.process(&hit(1009), &mut sink); // still throttled
    engine.process(&hit(1010), &mut sink); // window over -> fires
    engine.process(&hit(1012), &mut sink); // throttled (window from 1010)
    assert_eq!(
        sink.spoken,
        vec!["big hit".to_string(), "big hit".to_string()],
        "cooldown fires at 1000 and 1010 only: {:?}",
        sink.spoken
    );

    // A cooldown-free trigger is untouched by the throttle machinery.
    for ts in [2000, 2001, 2002] {
        engine.process(
            &ParsedLine {
                line: LogLine {
                    timestamp: ts,
                    message: "You are stunned!".into(),
                },
                event: Event::Unclassified,
            },
            &mut sink,
        );
    }
    assert_eq!(
        sink.spoken.iter().filter(|s| *s == "stunned").count(),
        3,
        "no-cooldown trigger fires every match"
    );
}

// ---- per-trigger channel (TTS / alert) overrides ----------------------------

#[test]
fn channel_override_silences_a_speaking_trigger() {
    // A bundled trigger that speaks by default; the user turns its TTS chip off.
    let trigger = Trigger {
        id: Some("universal/survival/stunned".into()),
        ..Trigger::new(
            "Stunned",
            "^You are stunned",
            vec![Action::Speak {
                template: "stunned".into(),
            }],
        )
    };
    let mut profile = CharacterProfile::new("Nyasha");
    profile.active_loadout_mut().channel_overrides.insert(
        "universal/survival/stunned".into(),
        ChannelOverride {
            speak: Some(false),
            alert: None,
        },
    );
    let mut engine = TriggerEngine::new_with_profile(vec![trigger], "Nyasha", &profile);
    let mut sink = RecordingSink::default();
    engine.process(&line(0, "You are stunned!"), &mut sink);
    assert!(
        sink.spoken.is_empty(),
        "TTS override off must silence the trigger"
    );
    assert_eq!(sink.total_calls(), 0, "no other channel added");
}

#[test]
fn channel_override_adds_speech_to_a_silent_trigger() {
    // An overlay-only trigger; the user turns its TTS chip on.
    let trigger = Trigger {
        id: Some("universal/progress/level-up".into()),
        ..Trigger::new(
            "Level up",
            "^You have gained a level",
            vec![Action::DisplayText {
                template: "ding".into(),
            }],
        )
    };
    let mut profile = CharacterProfile::new("Nyasha");
    profile.active_loadout_mut().channel_overrides.insert(
        "universal/progress/level-up".into(),
        ChannelOverride {
            speak: Some(true),
            alert: None,
        },
    );
    let mut engine = TriggerEngine::new_with_profile(vec![trigger], "Nyasha", &profile);
    let mut sink = RecordingSink::default();
    engine.process(&line(0, "You have gained a level!"), &mut sink);
    // Synthesized Speak template = trigger name, lower-cased.
    assert_eq!(sink.spoken, vec!["level up"]);
    // Alert override was None, so the existing DisplayText is untouched.
    assert_eq!(sink.displayed, vec!["ding"]);
}

#[test]
fn channel_override_toggles_tts_and_alert_independently() {
    // Speak off + alert on in one override: both channels flip, independently.
    let trigger = Trigger {
        id: Some("universal/combat/resist-out".into()),
        ..Trigger::new(
            "Your spell resisted",
            "resisted your (.+)!",
            vec![Action::Speak {
                template: "resisted".into(),
            }],
        )
    };
    let mut profile = CharacterProfile::new("Nyasha");
    profile.active_loadout_mut().channel_overrides.insert(
        "universal/combat/resist-out".into(),
        ChannelOverride {
            speak: Some(false),
            alert: Some(true),
        },
    );
    let mut engine = TriggerEngine::new_with_profile(vec![trigger], "Nyasha", &profile);
    let mut sink = RecordingSink::default();
    engine.process(
        &line(0, "A willowisp resisted your Vampiric Embrace!"),
        &mut sink,
    );
    assert!(sink.spoken.is_empty(), "speak channel forced off");
    // A missing alert channel is synthesized using the generic overlay path.
    assert!(sink.displayed.is_empty());
    assert_eq!(sink.overlays.len(), 1);
    assert_eq!(sink.overlays[0].0, "alerts");
    assert_eq!(sink.overlays[0].1["text"], "Your spell resisted");
}

#[test]
fn channel_override_alert_off_removes_legacy_and_generic_alerts_only() {
    use std::collections::BTreeMap;

    let trigger = Trigger {
        id: Some("universal/mixed-overlays".into()),
        ..Trigger::new(
            "Mixed overlays",
            "^mixed$",
            vec![
                Action::DisplayText {
                    template: "legacy".into(),
                },
                Action::Overlay {
                    overlay: "alerts".into(),
                    fields: BTreeMap::from([("text".into(), "generic".into())]),
                    config: BTreeMap::new(),
                },
                Action::Overlay {
                    overlay: "impact".into(),
                    fields: BTreeMap::from([("headline".into(), "kept".into())]),
                    config: BTreeMap::new(),
                },
            ],
        )
    };
    let mut profile = CharacterProfile::new("Nyasha");
    profile.active_loadout_mut().channel_overrides.insert(
        "universal/mixed-overlays".into(),
        ChannelOverride {
            speak: None,
            alert: Some(false),
        },
    );
    let mut engine = TriggerEngine::new_with_profile(vec![trigger], "Nyasha", &profile);
    let mut sink = RecordingSink::default();

    engine.process(&line(0, "mixed"), &mut sink);

    assert!(sink.displayed.is_empty());
    assert_eq!(sink.overlays.len(), 1);
    assert_eq!(sink.overlays[0].0, "impact");
}

// ---- "On others" buff mini-bars: per-target binding in the on-others lane ----

/// A Spirit of Wolf cast-start timer (buff lane), as the generated buff packs
/// emit it. Its land-on-other suffix (" is surrounded by a brief lupine
/// aura.") comes from the generated buff_lands table.
fn sow_trigger() -> Trigger {
    let mut trigger = Trigger::new(
        "SoW",
        r"^You begin casting Spirit of Wolf\.$",
        vec![Action::StartTimer {
            name: "Spirit of Wolf".into(),
            duration_secs: 1800,
            warn_at_secs: Some(30),
            duration_formula: None,
            duration_cap_ticks: None,
            cast_time_secs: None,
            rank_variants: Default::default(),
            mode: None,
            repeat_secs: None,
            stopwatch: false,
            warn_text: None,
            expire_text: None,
            warn_sound: None,
            expire_sound: None,
            lane: Some(TimerLane::Buff),
        }],
    );
    trigger.icon = Some("spell:10".into());
    trigger
}

#[test]
fn buff_on_two_targets_makes_two_independent_bars() {
    let mut engine = TriggerEngine::new(vec![sow_trigger()], "Nyasha");
    let mut sink = RecordingSink::default();
    engine.process(&line(0, "You begin casting Spirit of Wolf."), &mut sink);
    engine.process(
        &line(1, "Torvin is surrounded by a brief lupine aura."),
        &mut sink,
    );
    engine.process(&line(2, "You begin casting Spirit of Wolf."), &mut sink);
    engine.process(
        &line(3, "Ellara is surrounded by a brief lupine aura."),
        &mut sink,
    );

    let names: Vec<String> = engine
        .active_timers(3)
        .into_iter()
        .map(|(n, _)| n)
        .collect();
    assert!(
        names.contains(&"Spirit of Wolf — Torvin".to_string()),
        "{names:?}"
    );
    assert!(
        names.contains(&"Spirit of Wolf — Ellara".to_string()),
        "{names:?}"
    );
    assert!(!names.iter().any(|n| n == "Spirit of Wolf"), "{names:?}");
    let on_others = sink
        .timers
        .iter()
        .filter(|(_, _, _, lane)| *lane == TimerLane::OnOthers)
        .count();
    assert_eq!(on_others, 2, "{:?}", sink.timers);
    assert!(sink.timer_icons.contains(&(
        "Spirit of Wolf — Torvin".to_string(),
        Some("spell:10".to_string()),
    )));
}

#[test]
fn non_damaging_debuff_binds_on_land_line_and_dies_with_the_mob() {
    // Togor's Insects (a slow) never deals damage, so the damage-tick DoT
    // binder can't attach it to a mob. Its land emote ("<mob> yawns.")
    // binds the bar instead — target header on the overlay, and the mob's
    // death reaps it.
    let mut t = Trigger::new(
        "Togor's Insects timer",
        r"^You begin casting Togor's Insects\.$",
        vec![Action::StartTimer {
            name: "Togor's Insects".into(),
            duration_secs: 150,
            warn_at_secs: None,
            duration_formula: None,
            duration_cap_ticks: None,
            cast_time_secs: None,
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
    t.category = Some("Class/Shaman/Debuffs".into());
    t.icon = Some("spell:17".into());
    let mut engine = TriggerEngine::new(vec![t], "Nyasha");
    let mut sink = RecordingSink::default();

    engine.process(&line(1000, "You begin casting Togor's Insects."), &mut sink);
    // Land emote binds the bare enemy timer to the mob, lane unchanged.
    engine.process(&line(1003, "A dar ghoul knight yawns."), &mut sink);
    let names: Vec<String> = engine
        .active_timers(1003)
        .into_iter()
        .map(|(n, _)| n)
        .collect();
    assert_eq!(
        names,
        vec!["Togor's Insects — A dar ghoul knight".to_string()],
        "land line binds the slow to its target"
    );
    assert!(
        sink.timers.iter().any(
            |(n, _, _, lane)| n == "Togor's Insects — A dar ghoul knight"
                && *lane == TimerLane::Enemy
        ),
        "bound bar stays in the enemy lane: {:?}",
        sink.timers
    );
    assert!(sink.timer_icons.contains(&(
        "Togor's Insects — A dar ghoul knight".to_string(),
        Some("spell:17".to_string()),
    )));

    // The mob dies -> the slow bar dies with it.
    engine.process(
        &ParsedLine {
            line: LogLine {
                timestamp: 1010,
                message: "You have slain a dar ghoul knight!".into(),
            },
            event: Event::Slain {
                victim: Entity::Named("A dar ghoul knight".into()),
                killer: Some(Entity::You),
            },
        },
        &mut sink,
    );
    assert!(
        engine.active_timers(1010).is_empty(),
        "death reaps the land-bound debuff bar"
    );
}

#[test]
fn generated_insect_slow_casts_accept_backtick_possessives() {
    let mut profile = CharacterProfile::new("Nyasha");
    profile.active_loadout_mut().classes = vec!["Shaman".into()];
    profile.level = 50;
    let mut engine = TriggerEngine::new_with_profile(load_library(), "Nyasha", &profile);
    assert!(engine.warnings().is_empty(), "{:?}", engine.warnings());
    let mut sink = RecordingSink::default();

    engine.process(
        &line(1000, "You begin casting Togor's Insects VII."),
        &mut sink,
    );
    engine.process(&line(1005, "A dar ghoul knight yawns."), &mut sink);

    let names: Vec<String> = engine
        .active_timers(1005)
        .into_iter()
        .map(|(n, _)| n)
        .collect();
    assert!(
        names.contains(&"Togor's Insects — A dar ghoul knight".to_string()),
        "backtick spell name should start and bind the generated Togor timer: {names:?}"
    );
}

#[test]
fn observed_area_mez_tracks_every_target_outside_selected_classes() {
    // The game can retain/rank abilities outside the app's manually selected
    // loadout. An exact player cast is definitive, and one area cast emits a
    // separate landing line for each affected mob.
    let mut profile = CharacterProfile::new("Nyasha");
    profile.active_loadout_mut().classes =
        vec!["Necromancer".into(), "Shaman".into(), "Monk".into()];
    profile.level = 50;
    let mut engine = TriggerEngine::new_with_profile(load_library(), "Nyasha", &profile);
    assert!(engine.warnings().is_empty(), "{:?}", engine.warnings());
    let mut sink = RecordingSink::default();

    engine.process(&line(1000, "You begin casting Mesmerization."), &mut sink);
    engine.process(&line(1001, "a ghoul has been mesmerized."), &mut sink);
    engine.process(
        &line(1001, "a lurking mummy has been mesmerized."),
        &mut sink,
    );
    engine.process(
        &line(1001, "a dark boned skeleton has been mesmerized."),
        &mut sink,
    );

    let names: Vec<String> = engine
        .active_timers(1001)
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    assert_eq!(
        names,
        vec![
            "Mesmerization — a ghoul".to_string(),
            "Mesmerization — a lurking mummy".to_string(),
            "Mesmerization — a dark boned skeleton".to_string(),
        ]
    );
    assert!(sink.timer_icons.iter().all(|(name, icon)| {
        !name.starts_with("Mesmerization — ") || icon.as_deref() == Some("spell:35")
    }));
}

#[test]
fn reapplying_land_bound_enemy_debuff_replaces_same_visible_target() {
    let mut t = Trigger::new(
        "Togor's Insects timer",
        r"^You begin casting Togor's Insects\.$",
        vec![Action::StartTimer {
            name: "Togor's Insects".into(),
            duration_secs: 150,
            warn_at_secs: None,
            duration_formula: None,
            duration_cap_ticks: None,
            cast_time_secs: None,
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
    t.category = Some("Class/Shaman/Debuffs".into());
    let mut engine = TriggerEngine::new(vec![t], "Nyasha");
    let mut sink = RecordingSink::default();

    engine.process(&line(1000, "You begin casting Togor's Insects."), &mut sink);
    engine.process(&line(1003, "A dar ghoul knight yawns."), &mut sink);
    engine.process(&line(1010, "You begin casting Togor's Insects."), &mut sink);
    engine.process(&line(1013, "A dar ghoul knight yawns."), &mut sink);

    let names: Vec<String> = engine
        .active_timers(1013)
        .into_iter()
        .map(|(n, _)| n)
        .collect();
    assert_eq!(
        names,
        vec!["Togor's Insects — A dar ghoul knight".to_string()],
        "same land-bound debuff on the same visible target should refresh, not create (2)"
    );
    assert!(
        sink.cancels
            .contains(&"Togor's Insects — A dar ghoul knight".to_string()),
        "the old bound bar should be explicitly cancelled before the refreshed bar"
    );
}

#[test]
fn rebuffing_same_target_replaces_the_bar_instead_of_numbering() {
    let mut engine = TriggerEngine::new(vec![sow_trigger()], "Nyasha");
    let mut sink = RecordingSink::default();
    // First SoW on Torvin binds the on-others bar.
    engine.process(&line(0, "You begin casting Spirit of Wolf."), &mut sink);
    engine.process(
        &line(1, "Torvin is surrounded by a brief lupine aura."),
        &mut sink,
    );
    // Re-buff the SAME target 600 s later: the old bar is replaced — same
    // base name, fresh duration, no "Spirit of Wolf — Torvin (2)".
    engine.process(&line(600, "You begin casting Spirit of Wolf."), &mut sink);
    engine.process(
        &line(601, "Torvin is surrounded by a brief lupine aura."),
        &mut sink,
    );

    let timers = engine.active_timers(601);
    let names: Vec<&str> = timers.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(
        names,
        vec!["Spirit of Wolf — Torvin"],
        "one bar, base name, no numbered duplicate"
    );
    // The bar carries the SECOND cast's expiry, not the first's.
    assert_eq!(timers[0].1, 600 + 1800 - 601);
    assert!(
        sink.cancels
            .contains(&"Spirit of Wolf — Torvin".to_string()),
        "old bar cancelled on replace: {:?}",
        sink.cancels
    );
    assert!(
        !sink.timers.iter().any(|(n, _, _, _)| n.contains("(2)")),
        "no numbered instance ever started: {:?}",
        sink.timers
    );
}

#[test]
fn buff_wear_off_reaps_only_that_target_bar() {
    let mut engine = TriggerEngine::new(vec![sow_trigger()], "Nyasha");
    let mut sink = RecordingSink::default();
    engine.process(&line(0, "You begin casting Spirit of Wolf."), &mut sink);
    engine.process(
        &line(1, "Torvin is surrounded by a brief lupine aura."),
        &mut sink,
    );
    engine.process(&line(2, "You begin casting Spirit of Wolf."), &mut sink);
    engine.process(
        &line(3, "Ellara is surrounded by a brief lupine aura."),
        &mut sink,
    );
    engine.process(
        &ParsedLine {
            line: LogLine {
                timestamp: 100,
                message: "Your Spirit of Wolf spell has worn off of Torvin.".into(),
            },
            event: Event::WornOff {
                spell: "Spirit of Wolf".into(),
                owner: Some(Entity::Named("Torvin".into())),
            },
        },
        &mut sink,
    );
    let names: Vec<String> = engine
        .active_timers(100)
        .into_iter()
        .map(|(n, _)| n)
        .collect();
    assert!(
        !names.iter().any(|n| n == "Spirit of Wolf — Torvin"),
        "Torvin reaped: {names:?}"
    );
    assert!(
        names.contains(&"Spirit of Wolf — Ellara".to_string()),
        "Ellara kept: {names:?}"
    );
    assert!(sink
        .cancels
        .contains(&"Spirit of Wolf — Torvin".to_string()));
}

#[test]
fn self_buff_stays_in_buff_lane_not_on_others() {
    let mut engine = TriggerEngine::new(vec![sow_trigger()], "Nyasha");
    let mut sink = RecordingSink::default();
    engine.process(&line(0, "You begin casting Spirit of Wolf."), &mut sink);
    // Self-cast prints CASTEDMETXT, not a land-on-other suffix.
    engine.process(
        &line(1, "You feel the spirit of wolf enter you."),
        &mut sink,
    );
    let names: Vec<String> = engine
        .active_timers(1)
        .into_iter()
        .map(|(n, _)| n)
        .collect();
    assert_eq!(
        names,
        vec!["Spirit of Wolf".to_string()],
        "stays bare in the buff lane"
    );
    assert!(!sink
        .timers
        .iter()
        .any(|(_, _, _, lane)| *lane == TimerLane::OnOthers));
    assert!(sink
        .timers
        .iter()
        .any(|(n, _, _, lane)| n == "Spirit of Wolf" && *lane == TimerLane::Buff));
}

#[test]
fn unrelated_land_line_does_not_misbind_a_pending_buff() {
    let mut engine = TriggerEngine::new(vec![sow_trigger()], "Nyasha");
    let mut sink = RecordingSink::default();
    engine.process(&line(0, "You begin casting Spirit of Wolf."), &mut sink);
    // "looks stronger" is the Strength buff's phrase, not SoW's.
    engine.process(&line(1, "Torvin looks stronger."), &mut sink);
    let names: Vec<String> = engine
        .active_timers(1)
        .into_iter()
        .map(|(n, _)| n)
        .collect();
    assert_eq!(
        names,
        vec!["Spirit of Wolf".to_string()],
        "not misbound: {names:?}"
    );
    assert!(!sink
        .timers
        .iter()
        .any(|(_, _, _, lane)| *lane == TimerLane::OnOthers));
}

#[test]
fn ambiguous_land_line_binds_nothing() {
    // Spirit of Wolf and Pack Spirit share the lupine-aura phrase; a
    // lupine-aura land line with both pending is ambiguous → no bar.
    let pack_spirit = Trigger::new(
        "PS",
        r"^You begin casting Pack Spirit\.$",
        vec![Action::StartTimer {
            name: "Pack Spirit".into(),
            duration_secs: 1800,
            warn_at_secs: None,
            duration_formula: None,
            duration_cap_ticks: None,
            cast_time_secs: None,
            rank_variants: Default::default(),
            mode: None,
            repeat_secs: None,
            stopwatch: false,
            warn_text: None,
            expire_text: None,
            warn_sound: None,
            expire_sound: None,
            lane: Some(TimerLane::Buff),
        }],
    );
    let mut engine = TriggerEngine::new(vec![sow_trigger(), pack_spirit], "Nyasha");
    let mut sink = RecordingSink::default();
    engine.process(&line(0, "You begin casting Spirit of Wolf."), &mut sink);
    engine.process(&line(1, "You begin casting Pack Spirit."), &mut sink);
    engine.process(
        &line(2, "Torvin is surrounded by a brief lupine aura."),
        &mut sink,
    );
    let names: Vec<String> = engine
        .active_timers(2)
        .into_iter()
        .map(|(n, _)| n)
        .collect();
    assert!(
        !names.iter().any(|n| n.contains(" — ")),
        "no bar bound: {names:?}"
    );
    assert!(!sink
        .timers
        .iter()
        .any(|(_, _, _, lane)| *lane == TimerLane::OnOthers));
}

// ---------------------------------------------------------------------------
// Zone-conditional trigger activation (P??): a trigger with a non-empty `zones`
// scope fires only while the current zone (learned from "You have entered …"
// lines) matches, and never before the location is known.
// ---------------------------------------------------------------------------

/// A speak trigger scoped to `zones` that matches the fixed line below.
fn zone_scoped_trigger(zones: &[&str]) -> Trigger {
    let mut t = Trigger::new(
        "sebilis-emote",
        "^A froglok croaks",
        vec![Action::Speak {
            template: "croak".into(),
        }],
    );
    t.id = Some("zone/test/croak".into());
    t.category = Some("Zone/Test".into());
    t.zones = zones.iter().map(|z| z.to_string()).collect();
    t
}

fn zone_enter(ts: i64, zone: &str) -> ParsedLine {
    ParsedLine {
        line: LogLine {
            timestamp: ts,
            message: format!("You have entered {zone}."),
        },
        event: Event::ZoneEnter {
            zone: zone.to_string(),
        },
    }
}

#[test]
fn zone_scoped_trigger_stays_quiet_before_any_zone_line() {
    let mut engine = TriggerEngine::new(vec![zone_scoped_trigger(&["Sebilis"])], "Nyasha");
    assert_eq!(engine.current_zone(), None);
    let mut sink = RecordingSink::default();
    engine.process(&line(10, "A froglok croaks menacingly."), &mut sink);
    assert!(
        sink.spoken.is_empty(),
        "zone-scoped trigger fired with unknown location: {:?}",
        sink.spoken
    );
}

#[test]
fn zone_scoped_trigger_fires_only_in_matching_zone() {
    let mut engine = TriggerEngine::new(vec![zone_scoped_trigger(&["Sebilis"])], "Nyasha");
    let mut sink = RecordingSink::default();

    // Wrong zone: substring "Sebilis" is not in "West Karana" → silent.
    engine.process(&zone_enter(100, "West Karana"), &mut sink);
    engine.process(&line(101, "A froglok croaks menacingly."), &mut sink);
    assert!(
        sink.spoken.is_empty(),
        "fired in wrong zone: {:?}",
        sink.spoken
    );

    // Right zone: the log's full name "New Sebilis Expedition" contains the
    // configured substring "Sebilis" (case-insensitive) → fires.
    engine.process(&zone_enter(200, "New Sebilis Expedition"), &mut sink);
    assert_eq!(engine.current_zone(), Some("new sebilis expedition"));
    engine.process(&line(201, "A froglok croaks menacingly."), &mut sink);
    assert_eq!(sink.spoken, vec!["croak".to_string()]);

    // Zone out again → silent once more.
    engine.process(&zone_enter(300, "Trakanon's Teeth"), &mut sink);
    engine.process(&line(301, "A froglok croaks menacingly."), &mut sink);
    assert_eq!(
        sink.spoken,
        vec!["croak".to_string()],
        "leaked after zoning out"
    );
}

#[test]
fn unscoped_trigger_fires_in_every_zone() {
    let mut t = zone_scoped_trigger(&[]); // empty scope = everywhere
    t.zones.clear();
    let mut engine = TriggerEngine::new(vec![t], "Nyasha");
    let mut sink = RecordingSink::default();
    // Fires before any zone line …
    engine.process(&line(1, "A froglok croaks menacingly."), &mut sink);
    // … and after zoning anywhere.
    engine.process(&zone_enter(2, "West Karana"), &mut sink);
    engine.process(&line(3, "A froglok croaks menacingly."), &mut sink);
    assert_eq!(sink.spoken.len(), 2);
}

#[test]
fn loadout_zone_scope_overrides_pack_zones() {
    use eqlog_triggers::Loadout;

    // Pack ships the trigger scoped to Sebilis; the user's loadout re-scopes
    // the whole "Zone/Test" branch to Guk instead.
    let pack_trigger = zone_scoped_trigger(&["Sebilis"]);
    let mut loadout = Loadout::new("Default");
    loadout
        .zone_scopes
        .insert("Zone/Test".into(), vec!["Guk".into()]);
    let mut profile = CharacterProfile::new("Nyasha");
    profile.loadouts = vec![loadout];
    profile.active_loadout = "Default".into();

    let mut engine = TriggerEngine::new_with_profile(vec![pack_trigger], "Nyasha", &profile);
    let mut sink = RecordingSink::default();

    // Sebilis no longer counts — the loadout replaced the scope.
    engine.process(&zone_enter(100, "New Sebilis Expedition"), &mut sink);
    engine.process(&line(101, "A froglok croaks menacingly."), &mut sink);
    assert!(
        sink.spoken.is_empty(),
        "pack scope not overridden: {:?}",
        sink.spoken
    );

    // Guk now activates it.
    engine.process(&zone_enter(200, "Lower Guk"), &mut sink);
    engine.process(&line(201, "A froglok croaks menacingly."), &mut sink);
    assert_eq!(sink.spoken, vec!["croak".to_string()]);
}

// ---------------------------------------------------------------------------
// PostWebhook action: fires the sink's post_webhook with the expanded template
// and the (optional) named webhook. URLs never reach the engine.
// ---------------------------------------------------------------------------

#[test]
fn post_webhook_action_expands_template_and_targets_named_webhook() {
    let named = Trigger::new(
        "batphone",
        "^{C} tells the guild, '(?P<msg>.+)'",
        vec![Action::PostWebhook {
            template: "Batphone: ${msg}".into(),
            webhook: Some("raid".into()),
        }],
    );
    let default_hook = Trigger::new(
        "named-up",
        "^(?P<mob>.+) begins to cast a spell",
        vec![Action::PostWebhook {
            template: "${mob} is up".into(),
            webhook: None,
        }],
    );
    let mut engine = TriggerEngine::new(vec![named, default_hook], "Nyasha");
    assert!(engine.warnings().is_empty(), "{:?}", engine.warnings());
    let mut sink = RecordingSink::default();

    engine.process(
        &line(1, "Nyasha tells the guild, 'inc trak, up now'"),
        &mut sink,
    );
    engine.process(&line(2, "Trakanon begins to cast a spell."), &mut sink);

    assert_eq!(
        sink.webhooks,
        vec![
            (
                Some("raid".to_string()),
                "Batphone: inc trak, up now".to_string()
            ),
            (None, "Trakanon is up".to_string()),
        ]
    );
    // A webhook action speaks/shows nothing on its own.
    assert!(sink.spoken.is_empty() && sink.displayed.is_empty());
}

#[test]
fn generic_overlays_fan_out_with_tts_and_explicit_attribution() {
    use std::collections::BTreeMap;

    let overlay = |destination: &str, field: (&str, &str), color: &str| Action::Overlay {
        overlay: destination.into(),
        fields: BTreeMap::from([(field.0.into(), field.1.into())]),
        config: BTreeMap::from([("color".into(), serde_json::json!(color))]),
    };
    let trigger = Trigger::new(
        "root warning",
        "^(?P<target>.+) has been rooted by {C}\\.$",
        vec![
            overlay("alerts", ("text", "${target} rooted"), "#ffcc00"),
            overlay("target", ("status", "ROOT: ${target}"), "red"),
            Action::Speak {
                template: "${target} rooted".into(),
            },
        ],
    );
    let trigger_id = trigger.effective_id();
    let mut engine = TriggerEngine::new(vec![trigger], "Nyasha");
    let mut sink = RecordingSink::default();

    engine.process(&line(42, "a froglok has been rooted by Nyasha."), &mut sink);

    assert_eq!(sink.spoken, ["a froglok rooted"]);
    assert_eq!(sink.overlays.len(), 2);
    assert_eq!(sink.overlays[0].0, "alerts");
    assert_eq!(sink.overlays[0].1["text"], "a froglok rooted");
    assert_eq!(sink.overlays[0].2["color"], serde_json::json!("#ffcc00"));
    assert_eq!(sink.overlays[1].0, "target");
    assert_eq!(sink.overlays[1].1["status"], "ROOT: a froglok");
    assert_eq!(
        sink.attributed_calls,
        vec![
            ("overlay".into(), Some(trigger_id.clone())),
            ("overlay".into(), Some(trigger_id.clone())),
            ("speak".into(), Some(trigger_id)),
        ]
    );
    assert!(sink.current_trigger.is_none());
}

#[test]
fn trigger_icon_flows_to_overlays_and_timer_lifecycle() {
    use std::collections::BTreeMap;

    let mut trigger = Trigger::new(
        "Root timer",
        "^rooted$",
        vec![
            Action::Overlay {
                overlay: "alerts".into(),
                fields: BTreeMap::from([("text".into(), "Rooted".into())]),
                config: BTreeMap::new(),
            },
            start_timer_action("Root", 12, None, None),
        ],
    );
    trigger.icon = Some("spell:10".into());
    let mut engine = TriggerEngine::new(vec![trigger], "Nyasha");
    let mut sink = RecordingSink::default();

    assert_eq!(
        engine.timer_icons().get("Root").map(String::as_str),
        Some("spell:10")
    );
    let fired = engine.process_traced(&line(100, "rooted"), &mut sink);
    assert_eq!(fired[0].icon.as_deref(), Some("spell:10"));
    assert_eq!(sink.overlays[0].1["icon"], "spell:10");
    assert_eq!(
        engine.timer_snapshots(101)[0].icon.as_deref(),
        Some("spell:10")
    );
    assert_eq!(engine.due(112)[0].icon.as_deref(), Some("spell:10"));
}

#[test]
fn skipped_action_does_not_shift_attribution_to_the_previous_trigger() {
    let mut timer = Trigger::new(
        "conditional timer",
        "^go(?:)$",
        vec![start_timer_action(
            "Once",
            30,
            Some(TimerStartMode::IgnoreIfRunning),
            None,
        )],
    );
    timer.priority = 10;
    let speaker = Trigger::new(
        "always speaks",
        "^go$",
        vec![Action::Speak {
            template: "go".into(),
        }],
    );
    let timer_id = timer.effective_id();
    let speaker_id = speaker.effective_id();
    let mut engine = TriggerEngine::new(vec![timer, speaker], "Nyasha");
    let mut sink = RecordingSink::default();

    engine.process(&line(1, "go"), &mut sink);
    engine.process(&line(2, "go"), &mut sink);

    assert_eq!(
        sink.attributed_calls,
        vec![
            ("timer".into(), Some(timer_id)),
            ("speak".into(), Some(speaker_id.clone())),
            // The timer's second action is skipped, so only this call exists.
            ("speak".into(), Some(speaker_id)),
        ]
    );
}

#[test]
fn structured_signal_expands_fields_through_normal_actions() {
    use std::collections::BTreeMap;

    let mut trigger = Trigger::new(
        "Watched item looted",
        "([invalid raw regex",
        vec![
            Action::Overlay {
                overlay: "impact".into(),
                fields: BTreeMap::from([
                    ("headline".into(), "YOU LOOTED".into()),
                    ("big".into(), "${item}".into()),
                    (
                        "sub".into(),
                        "${quantity} from ${corpse}; ${remaining} left for ${quests}".into(),
                    ),
                ]),
                config: BTreeMap::from([("style".into(), serde_json::json!("loot-chest"))]),
            },
            Action::Speak {
                template: "You looted ${item}".into(),
            },
        ],
    );
    trigger.id = Some("system/watched-loot".into());
    trigger.event = Some(TriggerEvent::WatchedLoot);
    let mut engine = TriggerEngine::new(vec![trigger], "Nyasha");
    assert!(
        engine.warnings().is_empty(),
        "typed pattern must not compile"
    );

    let mut sink = RecordingSink::default();
    let signal = TriggerSignal::new(
        TriggerEvent::WatchedLoot,
        100,
        BTreeMap::from([
            ("item".into(), "Silvery Ring".into()),
            ("quantity".into(), "1".into()),
            ("corpse".into(), "a spider".into()),
            ("remaining".into(), "2".into()),
            ("quests".into(), "Test of Smash".into()),
        ]),
    );
    let fired = engine.process_signal_traced(&signal, &mut sink);

    assert_eq!(fired.len(), 1);
    assert_eq!(fired[0].id, "system/watched-loot");
    assert_eq!(sink.spoken, ["You looted Silvery Ring"]);
    assert_eq!(sink.overlays.len(), 1);
    assert_eq!(sink.overlays[0].0, "impact");
    assert_eq!(sink.overlays[0].1["big"], "Silvery Ring");
    assert_eq!(
        sink.overlays[0].1["sub"],
        "1 from a spider; 2 left for Test of Smash"
    );
    assert_eq!(sink.overlays[0].2["style"], "loot-chest");
    assert_eq!(
        sink.attributed_calls,
        vec![
            ("overlay".into(), Some("system/watched-loot".into())),
            ("speak".into(), Some("system/watched-loot".into())),
        ]
    );
}

#[test]
fn watched_kill_signal_uses_trigger_owned_impact_presentation() {
    use std::collections::BTreeMap;

    let mut trigger = Trigger::new(
        "Watched mob killed",
        "",
        vec![Action::Overlay {
            overlay: "impact".into(),
            fields: BTreeMap::from([
                ("headline".into(), "RIP".into()),
                ("big".into(), "${mob}".into()),
                ("sub".into(), "${remaining} remaining for ${quests}".into()),
            ]),
            config: BTreeMap::from([("style".into(), serde_json::json!("monster-rip"))]),
        }],
    );
    trigger.id = Some("system/watched-kill".into());
    trigger.event = Some(TriggerEvent::WatchedKill);
    let mut engine = TriggerEngine::new(vec![trigger], "Nyasha");
    let mut sink = RecordingSink::default();

    engine.process_signal_traced(
        &TriggerSignal::new(
            TriggerEvent::WatchedKill,
            100,
            BTreeMap::from([
                ("mob".into(), "Splitpaw assassin".into()),
                ("remaining".into(), "3".into()),
                ("quests".into(), "Hollow Skull Quest".into()),
            ]),
        ),
        &mut sink,
    );

    assert_eq!(sink.overlays.len(), 1);
    assert_eq!(sink.overlays[0].0, "impact");
    assert_eq!(sink.overlays[0].1["big"], "Splitpaw assassin");
    assert_eq!(sink.overlays[0].2["style"], "monster-rip");
}

#[test]
fn structured_triggers_are_separate_from_line_matching_and_share_cooldowns() {
    use std::collections::BTreeMap;

    let mut signal_trigger = Trigger::new(
        "watched",
        "",
        vec![Action::Speak {
            template: "${item}".into(),
        }],
    );
    signal_trigger.event = Some(TriggerEvent::WatchedLoot);
    signal_trigger.cooldown_secs = Some(10);
    let line_trigger = Trigger::new(
        "line",
        "^rooted$",
        vec![Action::Speak {
            template: "line fired".into(),
        }],
    );
    let mut engine = TriggerEngine::new(vec![signal_trigger, line_trigger], "Nyasha");
    let mut sink = RecordingSink::default();

    engine.process(&line(90, "anything at all"), &mut sink);
    engine.process(&line(91, "rooted"), &mut sink);
    assert_eq!(sink.spoken, ["line fired"]);

    for ts in [100, 105, 110] {
        engine.process_signal_traced(
            &TriggerSignal::new(
                TriggerEvent::WatchedLoot,
                ts,
                BTreeMap::from([("item".into(), format!("item {ts}"))]),
            ),
            &mut sink,
        );
    }
    assert_eq!(sink.spoken, ["line fired", "item 100", "item 110"]);
}

#[test]
fn profile_can_disable_a_structured_trigger() {
    use std::collections::BTreeMap;

    let mut trigger = Trigger::new(
        "watched",
        "",
        vec![Action::Speak {
            template: "${item}".into(),
        }],
    );
    trigger.id = Some("system/watched-loot".into());
    trigger.event = Some(TriggerEvent::WatchedLoot);
    let mut profile = CharacterProfile::new("Nyasha");
    profile
        .active_loadout_mut()
        .overrides
        .insert("system/watched-loot".into(), false);
    let mut engine = TriggerEngine::new_with_profile(vec![trigger], "Nyasha", &profile);
    let mut sink = RecordingSink::default();

    let fired = engine.process_signal_traced(
        &TriggerSignal::new(
            TriggerEvent::WatchedLoot,
            100,
            BTreeMap::from([("item".into(), "Silvery Ring".into())]),
        ),
        &mut sink,
    );
    assert!(fired.is_empty());
    assert_eq!(sink.total_calls(), 0);
}
