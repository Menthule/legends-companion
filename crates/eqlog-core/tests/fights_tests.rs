//! Integration tests for the fight tracker. Events are hand-built (the
//! parser is a separate module with its own tests); scenarios mirror the
//! real log: Nyasha (character) with pet Vibarn, groupmates Torvin (pet
//! "Torvin`s warder" — backtick possessive) and Ellara.

use std::collections::HashMap;

use eqlog_core::events::{Entity, Event, HitFlags, LogLine, MissKind, ParsedLine};
use eqlog_core::fights::{FightConfig, FightSummary, FightTracker, OVERALL_TARGET, UNATTRIBUTED};

fn pl(ts: i64, event: Event) -> ParsedLine {
    ParsedLine {
        line: LogLine {
            timestamp: ts,
            message: String::new(),
        },
        event,
    }
}

fn crit() -> HitFlags {
    HitFlags {
        critical: true,
        ..HitFlags::default()
    }
}

fn named(n: &str) -> Entity {
    Entity::Named(n.to_string())
}

fn melee(attacker: Entity, target: Entity, amount: u64, flags: HitFlags) -> Event {
    Event::MeleeHit {
        attacker,
        target,
        verb: "crush".to_string(),
        amount,
        flags,
    }
}

fn config() -> FightConfig {
    let mut cfg = FightConfig::new("Nyasha");
    cfg.pet_owners = HashMap::from([("Vibarn".to_string(), "Nyasha".to_string())]);
    cfg
}

fn row<'a>(summary: &'a FightSummary, name: &str) -> &'a eqlog_core::fights::CombatantRow {
    summary
        .rows
        .iter()
        .find(|r| r.name == name)
        .unwrap_or_else(|| panic!("no row named {name:?} in {:?}", summary.rows))
}

fn enemy_row<'a>(summary: &'a FightSummary, name: &str) -> &'a eqlog_core::fights::CombatantRow {
    summary
        .enemy_rows
        .iter()
        .find(|r| r.name == name)
        .unwrap_or_else(|| panic!("no enemy row named {name:?} in {:?}", summary.enemy_rows))
}

#[test]
fn defaults_match_contract() {
    let cfg = FightConfig::default();
    assert_eq!(cfg.idle_timeout_secs, 12);
    assert!(cfg.auto_attribute_possessive_pets);
    assert!(cfg.pet_owners.is_empty());
}

#[test]
fn slain_closes_fight() {
    let mut t = FightTracker::new(config());
    t.ingest(&pl(
        100,
        melee(Entity::You, named("a gnoll pup"), 20, crit()),
    ));
    t.ingest(&pl(
        103,
        melee(
            named("Vibarn"),
            named("a gnoll pup"),
            10,
            HitFlags::default(),
        ),
    ));
    assert_eq!(t.active_fights().len(), 1);

    t.ingest(&pl(
        105,
        Event::Slain {
            victim: named("a gnoll pup"),
            killer: Some(Entity::You),
        },
    ));

    assert!(t.active_fights().is_empty());
    let done = t.completed_fights();
    assert_eq!(done.len(), 1);
    let f = &done[0];
    assert_eq!(f.target, "a gnoll pup");
    assert!(f.target_slain);
    assert_eq!(f.start_ts, 100);
    assert_eq!(f.end_ts, 105);
    assert_eq!(f.duration_secs, 5);
    assert_eq!(f.total_damage, 30);

    // Vibarn folds into Nyasha; pet contribution is noted separately.
    assert_eq!(f.rows.len(), 1);
    let r = row(f, "Nyasha");
    assert_eq!(r.damage, 30);
    assert_eq!(r.pet_damage, 10);
    assert_eq!(r.hits, 2);
    assert_eq!(r.crits, 1);
    assert_eq!(r.max_hit, 20);
    assert_eq!(r.percent, 100.0);
}

#[test]
fn same_mob_after_slain_starts_new_fight() {
    let mut t = FightTracker::new(config());
    t.ingest(&pl(
        0,
        melee(Entity::You, named("a gnoll"), 10, HitFlags::default()),
    ));
    t.ingest(&pl(
        1,
        Event::Slain {
            victim: named("a gnoll"),
            killer: Some(Entity::You),
        },
    ));
    t.ingest(&pl(
        2,
        melee(Entity::You, named("a gnoll"), 5, HitFlags::default()),
    ));

    let done = t.completed_fights();
    assert_eq!(done.len(), 1);
    assert_eq!(done[0].total_damage, 10);

    let active = t.active_fights();
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].start_ts, 2);
    assert_eq!(active[0].total_damage, 5);
}

#[test]
fn idle_timeout_splits_into_two_fights() {
    let mut t = FightTracker::new(config());
    t.ingest(&pl(
        0,
        melee(Entity::You, named("a rat"), 5, HitFlags::default()),
    ));
    t.ingest(&pl(
        5,
        melee(Entity::You, named("a rat"), 7, HitFlags::default()),
    ));
    // 95 seconds of silence for "a rat" >> 12s timeout; evaluated lazily on
    // the next ingest — no wall clock involved.
    t.ingest(&pl(
        100,
        melee(Entity::You, named("a rat"), 9, HitFlags::default()),
    ));

    let done = t.completed_fights();
    assert_eq!(done.len(), 1);
    let first = &done[0];
    assert_eq!(first.target, "a rat");
    assert!(!first.target_slain);
    assert_eq!(first.start_ts, 0);
    assert_eq!(first.end_ts, 5); // last activity, not the closing ingest ts
    assert_eq!(first.duration_secs, 5);
    assert_eq!(first.total_damage, 12);

    let active = t.active_fights();
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].start_ts, 100);
    assert_eq!(active[0].total_damage, 9);

    // completed_fights drains.
    assert!(t.completed_fights().is_empty());
}

#[test]
fn events_within_timeout_keep_one_fight() {
    let mut t = FightTracker::new(config());
    t.ingest(&pl(
        0,
        melee(Entity::You, named("a rat"), 5, HitFlags::default()),
    ));
    t.ingest(&pl(
        12,
        melee(Entity::You, named("a rat"), 5, HitFlags::default()),
    ));
    t.ingest(&pl(
        24,
        melee(Entity::You, named("a rat"), 5, HitFlags::default()),
    ));
    assert!(t.completed_fights().is_empty());
    let active = t.active_fights();
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].total_damage, 15);
}

#[test]
fn explicit_and_possessive_pet_attribution() {
    let mut t = FightTracker::new(config());
    let mob = || named("a Teir`Dal ranger");
    t.ingest(&pl(0, melee(Entity::You, mob(), 20, HitFlags::default())));
    // Explicit map: Vibarn -> Nyasha.
    t.ingest(&pl(
        1,
        melee(named("Vibarn"), mob(), 10, HitFlags::default()),
    ));
    // Backtick possessive: Torvin`s warder -> Torvin (never seen otherwise).
    t.ingest(&pl(
        2,
        melee(named("Torvin`s warder"), mob(), 15, HitFlags::default()),
    ));
    // Spell damage from the pet folds too.
    t.ingest(&pl(
        3,
        Event::SpellDamage {
            caster: named("Vibarn"),
            target: mob(),
            amount: 12,
            spell: Some("Lifespike".to_string()),
            flags: HitFlags::default(),
        },
    ));

    let active = t.active_fights();
    assert_eq!(active.len(), 1);
    let f = &active[0];
    assert_eq!(f.rows.len(), 2);

    let nyasha = row(f, "Nyasha");
    assert_eq!(nyasha.damage, 42);
    assert_eq!(nyasha.pet_damage, 22);
    assert_eq!(nyasha.hits, 3);

    let torvin = row(f, "Torvin");
    assert_eq!(torvin.damage, 15);
    assert_eq!(torvin.pet_damage, 15);

    // Rows sorted by damage desc with percent-of-total.
    assert_eq!(f.rows[0].name, "Nyasha");
    assert_eq!(f.rows[1].name, "Torvin");
    assert_eq!(f.total_damage, 57);
    assert!((nyasha.percent - 42.0 * 100.0 / 57.0).abs() < 1e-9);
    assert!((torvin.percent - 15.0 * 100.0 / 57.0).abs() < 1e-9);
}

#[test]
fn possessive_attribution_can_be_disabled() {
    let mut cfg = config();
    cfg.auto_attribute_possessive_pets = false;
    let mut t = FightTracker::new(cfg);

    // Fight must be opened by a known friendly first: with auto-attribution
    // off, the warder is just some unknown combatant.
    t.ingest(&pl(
        0,
        melee(Entity::You, named("a gnoll"), 10, HitFlags::default()),
    ));
    t.ingest(&pl(
        1,
        melee(
            named("Torvin`s warder"),
            named("a gnoll"),
            15,
            HitFlags::default(),
        ),
    ));

    let active = t.active_fights();
    let f = &active[0];
    let warder = row(f, "Torvin`s warder");
    assert_eq!(warder.damage, 15);
    assert_eq!(warder.pet_damage, 0);
    assert!(f.rows.iter().all(|r| r.name != "Torvin"));
}

#[test]
fn overheal_math() {
    let mut t = FightTracker::new(config());
    t.ingest(&pl(
        0,
        melee(Entity::You, named("a gnoll"), 10, HitFlags::default()),
    ));
    // actual (potential) overheal syntax: healed for 50 of a possible 80.
    t.ingest(&pl(
        1,
        Event::Heal {
            healer: Entity::You,
            target: named("Torvin"),
            amount: 50,
            potential: Some(80),
            over_time: false,
            spell: Some("Light Healing".to_string()),
            flags: HitFlags::default(),
        },
    ));
    // No potential figure -> no overheal contribution.
    t.ingest(&pl(
        2,
        Event::Heal {
            healer: named("Ellara"),
            target: Entity::You,
            amount: 40,
            potential: None,
            over_time: false,
            spell: None,
            flags: HitFlags::default(),
        },
    ));
    // Pet self-heal folds into the owner.
    t.ingest(&pl(
        3,
        Event::Heal {
            healer: named("Vibarn"),
            target: named("Vibarn"),
            amount: 12,
            potential: Some(14),
            over_time: false,
            spell: Some("Lifespike".to_string()),
            flags: HitFlags::default(),
        },
    ));

    let active = t.active_fights();
    let f = &active[0];
    let nyasha = row(f, "Nyasha");
    assert_eq!(nyasha.healing, 62);
    assert_eq!(nyasha.overheal, 30 + 2);
    let ellara = row(f, "Ellara");
    assert_eq!(ellara.healing, 40);
    assert_eq!(ellara.overheal, 0);
}

#[test]
fn heal_with_no_active_fight_is_dropped() {
    let mut t = FightTracker::new(config());
    t.ingest(&pl(
        0,
        Event::Heal {
            healer: Entity::You,
            target: Entity::You,
            amount: 100,
            potential: Some(120),
            over_time: false,
            spell: None,
            flags: HitFlags::default(),
        },
    ));
    assert!(t.active_fights().is_empty());
    assert!(t.overall_summary().rows.is_empty());
}

#[test]
fn dps_divides_by_shared_encounter_window() {
    // Regression (P1): every combatant's DPS divides by the encounter window
    // (fight start->end), not their own first->last-hit span. A one-shot burst
    // combatant must not read as if the whole fight lasted a single second.
    let mut t = FightTracker::new(config());
    let mob = || named("a gnoll champion");
    // Encounter runs t=0..10 (a 10 s window).
    // Nyasha: 100 at t=0 and 100 at t=10 -> 200 dmg / 10 s = 20.
    t.ingest(&pl(0, melee(Entity::You, mob(), 100, HitFlags::default())));
    // Torvin`s warder lands one 50 hit at t=5 (personal span clamps to ~1 s).
    // DPS must still divide by the 10 s encounter window -> 50 / 10 = 5. Before
    // the fix this read as 50 (divided by the clamped personal window).
    t.ingest(&pl(
        5,
        melee(named("Torvin`s warder"), mob(), 50, HitFlags::default()),
    ));
    t.ingest(&pl(10, melee(Entity::You, mob(), 100, HitFlags::default())));
    t.ingest(&pl(
        10,
        Event::Slain {
            victim: mob(),
            killer: Some(Entity::You),
        },
    ));

    let done = t.completed_fights();
    let f = &done[0];
    let nyasha = row(f, "Nyasha");
    assert_eq!(nyasha.damage, 200);
    assert!((nyasha.dps - 20.0).abs() < 1e-9);
    let torvin = row(f, "Torvin");
    assert!(
        (torvin.dps - 5.0).abs() < 1e-9,
        "one-shot combatant must divide by the encounter window, got {}",
        torvin.dps
    );
    // Per-combatant DPS sums to the encounter DPS (250 dmg / 10 s = 25).
    assert!(((nyasha.dps + torvin.dps) - 25.0).abs() < 1e-9);
}

#[test]
fn damage_taken_tally() {
    let mut t = FightTracker::new(config());
    let mob = || named("a Teir`Dal shadowknight");
    // Incoming damage opens the fight (mob aggroed first).
    t.ingest(&pl(0, melee(mob(), Entity::You, 12, HitFlags::default())));
    t.ingest(&pl(
        1,
        Event::CastBegin {
            caster: mob(),
            spell: "Cancelling of Life".to_string(),
        },
    ));
    t.ingest(&pl(
        2,
        Event::SpellDamageTaken {
            target: Entity::You,
            source: mob(),
            spell: "Cancelling of Life".to_string(),
            amount: 8,
        },
    ));
    // Pet damage-taken folds into the owner row.
    t.ingest(&pl(
        3,
        melee(mob(), named("Vibarn"), 5, HitFlags::default()),
    ));
    // Non-melee incoming (mob's thorns) counts too.
    t.ingest(&pl(
        4,
        Event::NonMeleeDamage {
            source: Some(mob()),
            target: Entity::You,
            effect: "thorns".to_string(),
            amount: 3,
        },
    ));

    let active = t.active_fights();
    assert_eq!(active.len(), 1);
    let f = &active[0];
    assert_eq!(f.target, "a Teir`Dal shadowknight");
    assert_eq!(f.start_ts, 0);
    let nyasha = row(f, "Nyasha");
    assert_eq!(nyasha.damage_taken, 12 + 8 + 5 + 3);
    assert_eq!(nyasha.damage, 0);
    assert_eq!(f.total_damage, 0);
    assert_eq!(nyasha.percent, 0.0); // no div-by-zero on zero total
    assert_eq!(f.total_enemy_damage, 12 + 8 + 5 + 3);
    let enemy = enemy_row(f, "a Teir`Dal shadowknight");
    assert_eq!(enemy.damage, f.total_enemy_damage);
    assert_eq!(source(enemy, "crush").total, 12 + 5);
    assert_eq!(source(enemy, "Cancelling of Life").total, 8);
    assert_eq!(source(enemy, "Cancelling of Life").casts, 1);
    assert_eq!(source(enemy, "thorns (damage shield)").total, 3);
}

#[test]
fn two_concurrent_mobs_are_separated() {
    let mut t = FightTracker::new(config());
    let a = || named("a gnoll");
    let b = || named("a mangy rat");
    t.ingest(&pl(0, melee(Entity::You, a(), 10, HitFlags::default())));
    t.ingest(&pl(1, melee(named("Vibarn"), b(), 20, HitFlags::default())));
    t.ingest(&pl(2, melee(a(), Entity::You, 4, HitFlags::default())));
    t.ingest(&pl(3, melee(Entity::You, b(), 6, HitFlags::default())));

    let active = t.active_fights();
    assert_eq!(active.len(), 2);
    assert_eq!(active[0].target, "a gnoll"); // started first
    assert_eq!(active[1].target, "a mangy rat");
    assert_eq!(active[0].total_damage, 10);
    assert_eq!(active[1].total_damage, 26);
    assert_eq!(row(&active[0], "Nyasha").damage_taken, 4);
    assert_eq!(row(&active[1], "Nyasha").damage_taken, 0);

    // Killing A leaves B untouched and active.
    t.ingest(&pl(
        4,
        Event::Slain {
            victim: a(),
            killer: Some(Entity::You),
        },
    ));
    let done = t.completed_fights();
    assert_eq!(done.len(), 1);
    assert_eq!(done[0].target, "a gnoll");
    let active = t.active_fights();
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].target, "a mangy rat");
}

#[test]
fn unattributed_non_melee_damage() {
    let mut t = FightTracker::new(config());
    let mob = || named("a gnoll");
    t.ingest(&pl(0, melee(Entity::You, mob(), 10, HitFlags::default())));
    t.ingest(&pl(
        1,
        Event::NonMeleeDamage {
            source: None,
            target: mob(),
            effect: "frost".to_string(),
            amount: 9,
        },
    ));
    t.ingest(&pl(
        2,
        Event::NonMeleeDamage {
            source: Some(Entity::You),
            target: mob(),
            effect: "frost".to_string(),
            amount: 5,
        },
    ));

    let active = t.active_fights();
    let f = &active[0];
    assert_eq!(row(f, UNATTRIBUTED).damage, 9);
    assert_eq!(row(f, "Nyasha").damage, 15);
    assert_eq!(f.total_damage, 24);
}

#[test]
fn misses_are_counted_but_do_not_open_fights() {
    let mut t = FightTracker::new(config());
    let mob = || named("a gnoll");
    let miss = |attacker: Entity| Event::MeleeMiss {
        attacker,
        target: mob(),
        verb: "pierce".to_string(),
        kind: MissKind::Dodge,
    };
    t.ingest(&pl(0, miss(Entity::You)));
    assert!(t.active_fights().is_empty()); // a miss is not a damage event

    t.ingest(&pl(1, melee(Entity::You, mob(), 10, HitFlags::default())));
    t.ingest(&pl(2, miss(named("Vibarn"))));
    let active = t.active_fights();
    let r = row(&active[0], "Nyasha");
    assert_eq!(r.hits, 1);
    assert_eq!(r.misses, 1);
}

#[test]
fn overall_summary_spans_drained_fights() {
    let mut t = FightTracker::new(config());
    t.ingest(&pl(
        0,
        melee(Entity::You, named("a gnoll"), 30, HitFlags::default()),
    ));
    t.ingest(&pl(
        1,
        Event::Slain {
            victim: named("a gnoll"),
            killer: Some(Entity::You),
        },
    ));
    assert_eq!(t.completed_fights().len(), 1); // drained away

    t.ingest(&pl(
        50,
        melee(Entity::You, named("a rat"), 20, HitFlags::default()),
    ));
    t.ingest(&pl(
        52,
        melee(named("a rat"), Entity::You, 7, HitFlags::default()),
    ));

    let overall = t.overall_summary();
    assert_eq!(overall.target, OVERALL_TARGET);
    assert_eq!(overall.start_ts, 0);
    assert_eq!(overall.end_ts, 52);
    assert_eq!(overall.total_damage, 50);
    let r = row(&overall, "Nyasha");
    assert_eq!(r.damage, 50);
    assert_eq!(r.hits, 2);
    assert_eq!(r.damage_taken, 7);
    assert_eq!(r.max_hit, 30);
}

#[test]
fn close_all_flushes_active_fights() {
    let mut t = FightTracker::new(config());
    t.ingest(&pl(
        0,
        melee(Entity::You, named("a gnoll"), 10, HitFlags::default()),
    ));
    t.ingest(&pl(
        1,
        melee(Entity::You, named("a rat"), 5, HitFlags::default()),
    ));
    t.close_all();
    assert!(t.active_fights().is_empty());
    let done = t.completed_fights();
    assert_eq!(done.len(), 2);
    assert!(done.iter().all(|f| !f.target_slain));
}

#[test]
fn summaries_serialize_to_json() {
    let mut t = FightTracker::new(config());
    t.ingest(&pl(0, melee(Entity::You, named("a gnoll"), 10, crit())));
    t.ingest(&pl(
        1,
        Event::Slain {
            victim: named("a gnoll"),
            killer: Some(Entity::You),
        },
    ));
    let done = t.completed_fights();
    let json = serde_json::to_string(&done[0]).expect("summary serializes");
    assert!(json.contains("\"target\":\"a gnoll\""));
    let back: FightSummary = serde_json::from_str(&json).expect("summary deserializes");
    assert_eq!(back, done[0]);
}

#[test]
fn leading_article_case_variants_are_one_fight() {
    // EQ capitalizes the leading article by sentence position: incoming
    // lines say "A Teir`Dal ranger slashes YOU", outgoing say "You crush a
    // Teir`Dal ranger". Both must land in ONE fight.
    let mut t = FightTracker::new(config());
    t.ingest(&pl(
        0,
        melee(
            named("A Teir`Dal ranger"),
            Entity::You,
            22,
            HitFlags::default(),
        ),
    ));
    t.ingest(&pl(
        1,
        melee(
            Entity::You,
            named("a Teir`Dal ranger"),
            40,
            HitFlags::default(),
        ),
    ));
    let active = t.active_fights();
    assert_eq!(active.len(), 1, "case variants must not split the fight");
    // The mid-sentence (lowercase-article) form is the display name even
    // though the uppercase variant opened the fight.
    assert_eq!(active[0].target, "a Teir`Dal ranger");

    // A slain line carrying the sentence-start capitalization closes it too.
    t.ingest(&pl(
        2,
        Event::Slain {
            victim: named("A Teir`Dal ranger"),
            killer: Some(named("Torvin")),
        },
    ));
    assert!(t.active_fights().is_empty());
    let done = t.completed_fights();
    assert_eq!(done.len(), 1);
    let f = &done[0];
    assert_eq!(f.target, "a Teir`Dal ranger");
    assert!(f.target_slain);
    assert_eq!(f.total_damage, 40);
    assert_eq!(row(f, "Nyasha").damage_taken, 22);
}

#[test]
fn enemy_heals_are_not_counted() {
    let mut t = FightTracker::new(config());
    // Open the fight from the incoming (capitalized-article) side.
    t.ingest(&pl(
        0,
        melee(
            named("A Teir`Dal ranger"),
            Entity::You,
            10,
            HitFlags::default(),
        ),
    ));
    let heal = |healer: Entity, target: Entity| Event::Heal {
        healer,
        target,
        amount: 65,
        potential: None,
        over_time: false,
        spell: Some("Light Healing".to_string()),
        flags: HitFlags::default(),
    };
    // Mob self-heal, logged with the mid-sentence lowercase article — a
    // case variant of the open fight's key.
    t.ingest(&pl(
        1,
        heal(named("a Teir`Dal ranger"), named("a Teir`Dal ranger")),
    ));
    // An un-engaged NPC healer (multi-word name) healing the fight target.
    t.ingest(&pl(
        2,
        heal(named("Baron Telyx V`Zher"), named("a Teir`Dal ranger")),
    ));
    // A player healing the ENEMY (charmed pet gone rogue, etc.): not HPS.
    t.ingest(&pl(3, heal(named("Ellara"), named("A Teir`Dal ranger"))));

    let active = t.active_fights();
    let f = &active[0];
    assert!(
        f.rows.iter().all(|r| r.healing == 0),
        "no enemy/enemy-directed healing may reach the meter: {:?}",
        f.rows
    );
    assert!(t.overall_summary().rows.iter().all(|r| r.healing == 0));

    // A groupmate healing a friendly still counts (single capitalized word
    // = player-shaped name, even though Ellara is not in the pet map).
    t.ingest(&pl(4, heal(named("Ellara"), Entity::You)));
    let active = t.active_fights();
    assert_eq!(row(&active[0], "Ellara").healing, 65);
}

#[test]
fn unattributed_incoming_damage_lands_in_most_recent_fight() {
    // "Vibarn has taken 29 damage by Searing Arrow." parses as
    // NonMeleeDamage { source: None } on a friendly — it must still count
    // as damage taken instead of vanishing.
    let mut t = FightTracker::new(config());
    t.ingest(&pl(
        0,
        melee(
            Entity::You,
            named("a Teir`Dal ranger"),
            10,
            HitFlags::default(),
        ),
    ));
    t.ingest(&pl(
        1,
        Event::NonMeleeDamage {
            source: None,
            target: named("Vibarn"),
            effect: "Searing Arrow".to_string(),
            amount: 29,
        },
    ));
    let active = t.active_fights();
    let r = row(&active[0], "Nyasha"); // pet folds into owner
    assert_eq!(r.damage_taken, 29);
    assert_eq!(row(&t.overall_summary(), "Nyasha").damage_taken, 29);
}

#[test]
fn fixture_replay_has_no_case_split_fights_and_no_enemy_healing() {
    use eqlog_core::parser::Parser;

    let path = format!(
        "{}/../../fixtures/sample_session.txt",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = std::fs::read_to_string(&path).expect("fixture exists");
    let parser = Parser::new();
    let mut t = FightTracker::new(config());
    for raw in text.lines() {
        if let Some(parsed) = parser.parse_line(raw) {
            t.ingest(&parsed);
        }
    }
    t.close_all();
    let done = t.completed_fights();
    assert!(!done.is_empty());

    // No two fights against the same (case-folded) mob may overlap in time:
    // pre-fix, incoming lines ("A Teir`Dal ranger") and outgoing lines
    // ("a Teir`Dal ranger") ran as two concurrent case-variant fights.
    for (i, a) in done.iter().enumerate() {
        for b in &done[i + 1..] {
            if a.target.to_lowercase() == b.target.to_lowercase() {
                assert!(
                    a.end_ts < b.start_ts || b.end_ts < a.start_ts,
                    "overlapping fights vs the same mob: {a:?} vs {b:?}"
                );
            }
        }
    }

    // Enemy healers ("a Teir`Dal ranger healed herself ...") must never
    // appear as healing rows in any fight.
    for f in &done {
        for r in &f.rows {
            assert!(
                !(r.healing > 0 && r.name.contains('`') && r.name.starts_with(char::is_lowercase)),
                "enemy healing row {:?} leaked into fight vs {:?}",
                r.name,
                f.target
            );
        }
    }

    // The Teir`Dal ranger encounters merged: damage dealt and taken live in
    // the same fights, and at least one such fight ends slain.
    let rangers: Vec<_> = done
        .iter()
        .filter(|f| f.target == "a Teir`Dal ranger")
        .collect();
    assert!(!rangers.is_empty(), "fixture has Teir`Dal ranger fights");
    assert!(
        done.iter().all(|f| f.target != "A Teir`Dal ranger"),
        "no fight may keep the sentence-start capitalized display name \
         once outgoing damage names it in lowercase"
    );
    assert!(rangers.iter().any(|f| f.target_slain));
    assert!(rangers
        .iter()
        .any(|f| f.total_damage > 0 && f.rows.iter().any(|r| r.damage_taken > 0)));
}

#[test]
fn apostrophe_names_are_not_treated_as_pets() {
    // Regular-apostrophe possessives (zone/mob flavor names) must not be
    // auto-attributed; only backtick forms are pets.
    let mut t = FightTracker::new(config());
    t.ingest(&pl(
        0,
        melee(
            Entity::You,
            named("Dagnor's Cauldron guardian"),
            10,
            HitFlags::default(),
        ),
    ));
    let active = t.active_fights();
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].target, "Dagnor's Cauldron guardian");
}

// ---------------------------------------------------------------------------
// Per-source damage breakdown (post-sprint item 15)
// ---------------------------------------------------------------------------

fn source<'a>(
    r: &'a eqlog_core::fights::CombatantRow,
    name: &str,
) -> &'a eqlog_core::fights::SourceRow {
    r.sources
        .iter()
        .find(|s| s.name == name)
        .unwrap_or_else(|| panic!("no source named {name:?} in {:?}", r.sources))
}

#[test]
fn sources_aggregate_per_verb_spell_and_effect() {
    let mut t = FightTracker::new(FightConfig::new("Nyasha"));
    let gnoll = || named("a gnoll pup");
    // Two crushes (one crit), one slash, one spell, one DoT tick, one DS.
    t.ingest(&pl(
        100,
        melee(Entity::You, gnoll(), 20, HitFlags::default()),
    ));
    t.ingest(&pl(101, melee(Entity::You, gnoll(), 40, crit())));
    t.ingest(&pl(
        102,
        Event::MeleeHit {
            attacker: Entity::You,
            target: gnoll(),
            verb: "slash".to_string(),
            amount: 15,
            flags: HitFlags::default(),
        },
    ));
    t.ingest(&pl(
        103,
        Event::SpellDamage {
            caster: Entity::You,
            target: gnoll(),
            amount: 50,
            spell: Some("Lifespike".to_string()),
            flags: HitFlags::default(),
        },
    ));
    t.ingest(&pl(
        104,
        Event::SpellDamageTaken {
            target: gnoll(),
            source: Entity::You,
            spell: "Boil Blood".to_string(),
            amount: 11,
        },
    ));
    t.ingest(&pl(
        105,
        Event::NonMeleeDamage {
            source: Some(Entity::You),
            target: gnoll(),
            effect: "frost".to_string(),
            amount: 9,
        },
    ));

    let f = &t.active_fights()[0];
    let r = row(f, "Nyasha");
    assert_eq!(r.damage, 145);
    assert_eq!(r.sources.len(), 5);

    let crush = source(r, "crush");
    assert_eq!(
        (crush.total, crush.hits, crush.crits, crush.max_hit),
        (60, 2, 1, 40)
    );
    let slash = source(r, "slash");
    assert_eq!(
        (slash.total, slash.hits, slash.crits, slash.max_hit),
        (15, 1, 0, 15)
    );
    assert_eq!(source(r, "Lifespike").total, 50);
    assert_eq!(source(r, "Boil Blood").total, 11);
    // Damage-shield effects carry the disambiguating suffix.
    assert_eq!(source(r, "frost (damage shield)").total, 9);

    // Sources are sorted by total descending and sum to the row's damage.
    let totals: Vec<u64> = r.sources.iter().map(|s| s.total).collect();
    assert!(totals.windows(2).all(|w| w[0] >= w[1]), "{totals:?}");
    assert_eq!(totals.iter().sum::<u64>(), r.damage);
}

#[test]
fn pet_sources_fold_under_owner_with_pet_suffix() {
    let mut t = FightTracker::new(config()); // Vibarn -> Nyasha
    let gnoll = || named("a gnoll pup");
    t.ingest(&pl(
        100,
        melee(Entity::You, gnoll(), 30, HitFlags::default()),
    ));
    t.ingest(&pl(
        101,
        Event::MeleeHit {
            attacker: named("Vibarn"),
            target: gnoll(),
            verb: "crush".to_string(),
            amount: 12,
            flags: crit(),
        },
    ));
    t.ingest(&pl(
        102,
        Event::SpellDamage {
            caster: named("Vibarn"),
            target: gnoll(),
            amount: 8,
            spell: Some("Lifespike".to_string()),
            flags: HitFlags::default(),
        },
    ));

    let f = &t.active_fights()[0];
    assert_eq!(f.rows.len(), 1, "pet folds into the owner row");
    let r = row(f, "Nyasha");
    assert_eq!(r.damage, 50);
    assert_eq!(r.pet_damage, 20);
    // The owner's own crush and the pet's crush stay separate sources.
    assert_eq!(source(r, "crush").total, 30);
    let pet_crush = source(r, "crush (pet)");
    assert_eq!(
        (pet_crush.total, pet_crush.hits, pet_crush.crits),
        (12, 1, 1)
    );
    assert_eq!(source(r, "Lifespike (pet)").total, 8);
    assert_eq!(r.sources.iter().map(|s| s.total).sum::<u64>(), r.damage);
}

#[test]
fn unattributed_pet_keeps_unsuffixed_sources() {
    // Attribution off: the pet is its own combatant, no "(pet)" suffix.
    let mut cfg = FightConfig::new("Nyasha");
    cfg.auto_attribute_possessive_pets = false;
    let mut t = FightTracker::new(cfg);
    let gnoll = || named("a gnoll pup");
    t.ingest(&pl(
        100,
        melee(Entity::You, gnoll(), 5, HitFlags::default()),
    ));
    t.ingest(&pl(
        101,
        Event::MeleeHit {
            attacker: named("Nyasha`s warder"),
            target: gnoll(),
            verb: "claw".to_string(),
            amount: 7,
            flags: HitFlags::default(),
        },
    ));
    let f = &t.active_fights()[0];
    let warder = row(f, "Nyasha`s warder");
    assert_eq!(source(warder, "claw").total, 7);
    assert!(warder.sources.iter().all(|s| !s.name.ends_with(" (pet)")));
}

#[test]
fn combatant_row_without_sources_field_still_deserializes() {
    // Fight summaries persisted before item 15 lack `sources` on their rows;
    // the store must keep reading them (serde default = empty).
    let json = r#"{
        "name": "Nyasha", "damage": 10, "pet_damage": 0, "hits": 1,
        "misses": 0, "crits": 0, "max_hit": 10, "damage_taken": 0,
        "healing": 0, "overheal": 0, "dps": 1.0, "percent": 100.0
    }"#;
    let r: eqlog_core::fights::CombatantRow = serde_json::from_str(json).unwrap();
    assert!(r.sources.is_empty());
}

// ---------------------------------------------------------------------------
// X3: open fights on any-combatant involvement (raid-meter bias fix)
// ---------------------------------------------------------------------------

#[test]
fn groupmate_opens_fight_before_owner_engages() {
    let mut t = FightTracker::new(config());
    // Torvin (a groupmate — not the log owner, not a pet) lands the opening
    // burst on a fresh NPC before Nyasha swings. Previously this vanished
    // until the owner engaged, biasing rankings toward the log owner.
    t.ingest(&pl(
        100,
        melee(
            named("Torvin"),
            named("a gnoll pup"),
            30,
            HitFlags::default(),
        ),
    ));
    t.ingest(&pl(
        101,
        melee(
            named("Torvin"),
            named("a gnoll pup"),
            25,
            HitFlags::default(),
        ),
    ));
    // The owner engages only now.
    t.ingest(&pl(
        102,
        melee(Entity::You, named("a gnoll pup"), 40, HitFlags::default()),
    ));

    let f = &t.active_fights()[0];
    assert_eq!(f.target, "a gnoll pup");
    // Torvin's pre-owner damage is credited in full, not dropped.
    assert_eq!(row(f, "Torvin").damage, 55);
    assert_eq!(row(f, "Nyasha").damage, 40);
}

#[test]
fn player_duel_does_not_open_a_fight() {
    let mut t = FightTracker::new(config());
    // Two out-of-group players trading blows: both names are player-shaped,
    // so the target is not an NPC and no fight may open (noise guard).
    t.ingest(&pl(
        100,
        melee(named("Torvin"), named("Vheden"), 30, HitFlags::default()),
    ));
    assert!(t.active_fights().is_empty());
}

#[test]
fn mob_vs_mob_does_not_open_a_fight() {
    let mut t = FightTracker::new(config());
    // Ambient mob-on-mob (or a charmed pet on a mob) with no friendly present
    // and no open fight: the source is NPC-shaped, so nothing opens.
    t.ingest(&pl(
        100,
        melee(
            named("a decaying skeleton"),
            named("a gnoll pup"),
            15,
            HitFlags::default(),
        ),
    ));
    assert!(t.active_fights().is_empty());
}

// ---------------------------------------------------------------------------
// Per-source misses + casts (efficiency columns)
// ---------------------------------------------------------------------------

#[test]
fn misses_attach_to_the_matching_verb_source() {
    let mut t = FightTracker::new(FightConfig::new("Nyasha"));
    let gnoll = || named("a gnoll pup");
    // Open the fight, land a crush, then miss with crush and miss with slash.
    t.ingest(&pl(
        100,
        melee(Entity::You, gnoll(), 20, HitFlags::default()),
    ));
    t.ingest(&pl(
        101,
        Event::MeleeMiss {
            attacker: Entity::You,
            target: gnoll(),
            verb: "crush".to_string(),
            kind: MissKind::Miss,
        },
    ));
    t.ingest(&pl(
        102,
        Event::MeleeMiss {
            attacker: Entity::You,
            target: gnoll(),
            verb: "slash".to_string(),
            kind: MissKind::Dodge,
        },
    ));

    let f = &t.active_fights()[0];
    let r = row(f, "Nyasha");
    assert_eq!(r.misses, 2);
    // The crush miss lands on the same source row as the crush hit.
    let crush = source(r, "crush");
    assert_eq!((crush.hits, crush.misses), (1, 1));
    // A verb that only ever missed still gets its own source row.
    let slash = source(r, "slash");
    assert_eq!((slash.hits, slash.total, slash.misses), (0, 0, 1));
}

#[test]
fn pet_misses_fold_under_owner_with_pet_suffix() {
    let mut t = FightTracker::new(config()); // Vibarn -> Nyasha
    let gnoll = || named("a gnoll pup");
    t.ingest(&pl(
        100,
        melee(Entity::You, gnoll(), 20, HitFlags::default()),
    ));
    t.ingest(&pl(
        101,
        Event::MeleeMiss {
            attacker: named("Vibarn"),
            target: gnoll(),
            verb: "claw".to_string(),
            kind: MissKind::Parry,
        },
    ));
    let f = &t.active_fights()[0];
    let r = row(f, "Nyasha");
    // Pet misses carry the "(pet)" suffix, matching the pet hit path.
    assert_eq!(source(r, "claw (pet)").misses, 1);
}

#[test]
fn casts_count_per_spell_source_even_with_zero_damage() {
    let mut t = FightTracker::new(FightConfig::new("Nyasha"));
    let gnoll = || named("a gnoll pup");
    // Open the fight, then cast a spell that lands damage and one that never
    // does (a resist / pure debuff).
    t.ingest(&pl(
        100,
        melee(Entity::You, gnoll(), 20, HitFlags::default()),
    ));
    t.ingest(&pl(
        101,
        Event::CastBegin {
            caster: Entity::You,
            spell: "Lifespike".to_string(),
        },
    ));
    t.ingest(&pl(
        102,
        Event::SpellDamage {
            caster: Entity::You,
            target: gnoll(),
            amount: 50,
            spell: Some("Lifespike".to_string()),
            flags: HitFlags::default(),
        },
    ));
    t.ingest(&pl(
        103,
        Event::CastBegin {
            caster: Entity::You,
            spell: "Negation of Life".to_string(),
        },
    ));

    let f = &t.active_fights()[0];
    let r = row(f, "Nyasha");
    // The cast lands on the same source row as the spell's damage.
    let lifespike = source(r, "Lifespike");
    assert_eq!(
        (lifespike.total, lifespike.hits, lifespike.casts),
        (50, 1, 1)
    );
    // A cast that dealt no damage still surfaces as a zero-damage source row.
    let negation = source(r, "Negation of Life");
    assert_eq!((negation.total, negation.hits, negation.casts), (0, 0, 1));
}

#[test]
fn enemy_casts_do_not_pollute_the_meter() {
    let mut t = FightTracker::new(FightConfig::new("Nyasha"));
    let sk = || named("a Teir`Dal shadowknight");
    // Open a fight against the SK, then it begins casting: as our target (and
    // an NPC-shaped name) its cast must not create a combatant row.
    t.ingest(&pl(100, melee(Entity::You, sk(), 20, HitFlags::default())));
    t.ingest(&pl(
        101,
        Event::CastBegin {
            caster: sk(),
            spell: "Cancelling of Life".to_string(),
        },
    ));
    let f = &t.active_fights()[0];
    assert!(f.rows.iter().all(|r| r.name != "a Teir`Dal shadowknight"));
}

#[test]
fn casts_outside_any_fight_are_ignored() {
    let mut t = FightTracker::new(FightConfig::new("Nyasha"));
    // A cast with no open fight (e.g. buffing between pulls) is dropped, not
    // attributed to a phantom fight.
    t.ingest(&pl(
        100,
        Event::CastBegin {
            caster: Entity::You,
            spell: "Spirit of Wolf".to_string(),
        },
    ));
    assert!(t.active_fights().is_empty());
}
