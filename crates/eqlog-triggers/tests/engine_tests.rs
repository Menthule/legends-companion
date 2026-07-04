//! Integration tests for the trigger engine: token expansion, capture
//! substitution, the fast-reject path, timer semantics and profile-level
//! timer scaling — plus a pass over the real fixture log with the shipped
//! trigger library.

use eqlog_core::events::{ChatChannel, Entity, Event, LogLine, ParsedLine};
use eqlog_triggers::{
    Action, ActionSink, ChannelOverride, CharacterProfile, TimerFireKind, TimerLane, Trigger,
    TriggerEngine,
};

/// Records every sink call for assertions.
#[derive(Default)]
struct RecordingSink {
    spoken: Vec<String>,
    sounds: Vec<String>,
    displayed: Vec<String>,
    timers: Vec<(String, u64, Option<u64>, TimerLane)>,
    cancels: Vec<String>,
}

impl ActionSink for RecordingSink {
    fn speak(&mut self, text: &str) {
        self.spoken.push(text.to_string());
    }
    fn play_sound(&mut self, path: &str) {
        self.sounds.push(path.to_string());
    }
    fn display_text(&mut self, text: &str) {
        self.displayed.push(text.to_string());
    }
    fn start_timer(
        &mut self,
        name: &str,
        duration_secs: u64,
        warn_at_secs: Option<u64>,
        lane: TimerLane,
        _pending_secs: u64,
    ) {
        self.timers
            .push((name.to_string(), duration_secs, warn_at_secs, lane));
    }
    fn cancel_timer(&mut self, name: &str) {
        self.cancels.push(name.to_string());
    }
}

impl RecordingSink {
    fn total_calls(&self) -> usize {
        self.spoken.len()
            + self.sounds.len()
            + self.displayed.len()
            + self.timers.len()
            + self.cancels.len()
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
    // Default TTS policy: only buff-ending, resist, and enemy-cast dangers
    // speak. Universal survival/progress (stun, encumbered, level-up "ding")
    // show text but no longer speak.
    assert!(sink.displayed.contains(&"stunned".to_string()));
    assert!(!sink.spoken.contains(&"stunned".to_string()));
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
            lane: Some(TimerLane::Enemy),
        }],
    );
    t.category = Some("Class/Necromancer/DoTs".into());
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

/// Multi-instance DoT tracking (NOW-sprint item 3): the same spell landing
/// on two identically named mobs gets numbered instance bars, each with its
/// own cast-order expiry, and pops FIFO on wear-off/death. Encodes the
/// twin-attribution approximation documented on `bind_and_reap_timers`.
#[test]
fn overlapping_casts_on_identical_names_get_numbered_instances() {
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

    // Cast on twin #1; first tick binds the base instance.
    engine.process(&cast(1000), &mut sink);
    engine.process(&tick(1006), &mut sink);
    // Cast on twin #2 (identical name); its tick takes instance (2).
    engine.process(&cast(1010), &mut sink);
    engine.process(&tick(1016), &mut sink);

    let names: Vec<String> = engine
        .active_timers(1016)
        .into_iter()
        .map(|(n, _)| n)
        .collect();
    assert_eq!(
        names,
        vec![
            "Boil Blood — A zol ghoul knight".to_string(),
            "Boil Blood — A zol ghoul knight (2)".to_string(),
        ]
    );
    // Each instance keeps its own cast-order expiry.
    let remaining: Vec<i64> = engine
        .active_timers(1016)
        .into_iter()
        .map(|(_, r)| r)
        .collect();
    assert_eq!(remaining, vec![1000 + 42 - 1016, 1010 + 42 - 1016]);

    // Twin #1 dies: only the OLDEST instance pops; (2) keeps running.
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
    let names: Vec<String> = engine
        .active_timers(1020)
        .into_iter()
        .map(|(n, _)| n)
        .collect();
    assert_eq!(
        names,
        vec!["Boil Blood — A zol ghoul knight (2)".to_string()]
    );
    assert!(
        sink.cancels
            .contains(&"Boil Blood — A zol ghoul knight".to_string()),
        "sink told to clear the popped oldest instance: {:?}",
        sink.cancels
    );

    // Twin #2 dies: the remaining instance pops too.
    engine.process(
        &line(
            1024,
            "You have slain a zol ghoul knight!",
            Event::Slain {
                victim: Entity::Named("A zol ghoul knight".into()),
                killer: Some(Entity::You),
            },
        ),
        &mut sink,
    );
    assert!(engine.active_timers(1024).is_empty());
}

#[test]
fn targeted_wear_off_pops_oldest_instance_fifo() {
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
    assert_eq!(
        names,
        vec![
            "Heat Blood — A froglok".to_string(),
            "Heat Blood — A froglok (2)".to_string(),
        ]
    );

    // "Your Heat Blood spell has worn off of A froglok." — oldest pops.
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
    assert_eq!(names, vec!["Heat Blood — A froglok (2)".to_string()]);
    assert!(sink.cancels.contains(&"Heat Blood — A froglok".to_string()));
}

#[test]
fn death_pops_oldest_instance_of_every_spell_bound_to_the_victim() {
    // Two different DoTs, each cast twice on identically named twins: one
    // death pops exactly the oldest instance of EACH spell (the dead mob
    // carried both), leaving the younger twin's pair running.
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
    for _twin in 0..2 {
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
    }
    assert_eq!(engine.active_timers(ts).len(), 4);

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
    let mut names: Vec<String> = engine
        .active_timers(ts)
        .into_iter()
        .map(|(n, _)| n)
        .collect();
    names.sort();
    assert_eq!(
        names,
        vec![
            "Boil Blood — A gnoll (2)".to_string(),
            "Heat Blood — A gnoll (2)".to_string(),
        ],
        "one death pops the oldest instance of every spell bound to the name"
    );
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
    // Synthesized alert template = trigger name.
    assert_eq!(sink.displayed, vec!["Your spell resisted"]);
}

// ---- "On others" buff mini-bars: per-target binding in the on-others lane ----

/// A Spirit of Wolf cast-start timer (buff lane), as the generated buff packs
/// emit it. Its land-on-other suffix (" is surrounded by a brief lupine
/// aura.") comes from the generated buff_lands table.
fn sow_trigger() -> Trigger {
    Trigger::new(
        "SoW",
        r"^You begin casting Spirit of Wolf\.$",
        vec![Action::StartTimer {
            name: "Spirit of Wolf".into(),
            duration_secs: 1800,
            warn_at_secs: Some(30),
            duration_formula: None,
            duration_cap_ticks: None,
            cast_time_secs: None,
            lane: Some(TimerLane::Buff),
        }],
    )
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
