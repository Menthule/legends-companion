//! Integration tests for the line parser, driven by real fixture lines.

use std::collections::HashMap;
use std::fs;

use eqlog_core::events::{ChatChannel, Entity, Event, HitFlags, MissKind};
use eqlog_core::parser::Parser;

fn fixture(name: &str) -> String {
    let path = format!("{}/../../fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {path}: {e}"))
}

fn parse(raw: &str) -> Event {
    Parser::new()
        .parse_line(raw)
        .unwrap_or_else(|| panic!("line failed timestamp parse: {raw}"))
        .event
}

fn you() -> Entity {
    Entity::You
}

fn named(n: &str) -> Entity {
    Entity::Named(n.to_string())
}

fn crit() -> HitFlags {
    HitFlags {
        critical: true,
        ..Default::default()
    }
}

// ---------------------------------------------------------------------------
// Timestamp
// ---------------------------------------------------------------------------

#[test]
fn timestamp_epoch_hand_verified() {
    // 2026-07-03 is day 20637 since epoch (2026-01-01 = 20454, +183 days
    // through Jul 3 in a non-leap year). 20637*86400 + 11*3600 + 37*60 + 14
    // = 1783078634. Cross-checked with `date -u -d "2026-07-03 11:37:14" +%s`.
    let p = Parser::new();
    let parsed = p
        .parse_line("[Fri Jul 03 11:37:14 2026] You gain experience! (2.429%)")
        .unwrap();
    assert_eq!(parsed.line.timestamp, 1_783_078_634);
    assert_eq!(parsed.line.message, "You gain experience! (2.429%)");
}

#[test]
fn timestamp_crlf_and_space_padded_day() {
    let p = Parser::new();
    let parsed = p
        .parse_line("[Fri Jul  3 11:37:14 2026] Auto attack is on.\r\n")
        .unwrap();
    assert_eq!(parsed.line.timestamp, 1_783_078_634);
    assert_eq!(parsed.line.message, "Auto attack is on.");
    assert_eq!(parsed.event, Event::System);
}

#[test]
fn invalid_prefix_returns_none() {
    let p = Parser::new();
    assert!(p.parse_line("no timestamp here").is_none());
    assert!(p.parse_line("").is_none());
    assert!(p.parse_line("[Fri Jul 03 11:37:14 20").is_none());
    assert!(p
        .parse_line("[Fri Xxx 03 11:37:14 2026] bad month")
        .is_none());
}

// ---------------------------------------------------------------------------
// Melee
// ---------------------------------------------------------------------------

#[test]
fn melee_hit_third_person() {
    assert_eq!(
        parse(
            "[Fri Jul 03 11:37:14 2026] Baron Telyx V`Zher slashes Torvin for 31 points of damage."
        ),
        Event::MeleeHit {
            attacker: named("Baron Telyx V`Zher"),
            target: named("Torvin"),
            verb: "slashes".into(),
            amount: 31,
            flags: HitFlags::default(),
        }
    );
}

#[test]
fn melee_hit_on_you() {
    assert_eq!(
        parse(
            "[Fri Jul 03 12:10:13 2026] A Teir`Dal priestess crushes YOU for 24 points of damage."
        ),
        Event::MeleeHit {
            attacker: named("A Teir`Dal priestess"),
            target: you(),
            verb: "crushes".into(),
            amount: 24,
            flags: HitFlags::default(),
        }
    );
}

#[test]
fn melee_hit_by_you() {
    assert_eq!(
        parse("[Fri Jul 03 11:37:30 2026] You crush Baron Telyx V`Zher for 20 points of damage."),
        Event::MeleeHit {
            attacker: you(),
            target: named("Baron Telyx V`Zher"),
            verb: "crush".into(),
            amount: 20,
            flags: HitFlags::default(),
        }
    );
}

#[test]
fn melee_hit_critical_flag() {
    assert_eq!(
        parse("[Fri Jul 03 11:37:39 2026] Torvin kicks Baron Telyx V`Zher for 42 points of damage. (Critical)"),
        Event::MeleeHit {
            attacker: named("Torvin"),
            target: named("Baron Telyx V`Zher"),
            verb: "kicks".into(),
            amount: 42,
            flags: crit(),
        }
    );
}

#[test]
fn melee_hit_you_critical_single_point() {
    assert_eq!(
        parse("[Thu Jul 02 23:44:52 2026] You crush skeleton L`rodd for 39 points of damage. (Critical)"),
        Event::MeleeHit {
            attacker: you(),
            target: named("skeleton L`rodd"),
            verb: "crush".into(),
            amount: 39,
            flags: crit(),
        }
    );
}

#[test]
fn melee_miss_plain() {
    assert_eq!(
        parse("[Fri Jul 03 11:37:15 2026] Vibarn tries to kick Baron Telyx V`Zher, but misses!"),
        Event::MeleeMiss {
            attacker: named("Vibarn"),
            target: named("Baron Telyx V`Zher"),
            verb: "kick".into(),
            kind: MissKind::Miss,
        }
    );
}

#[test]
fn melee_miss_parry() {
    assert_eq!(
        parse(
            "[Fri Jul 03 11:37:19 2026] Baron Telyx V`Zher tries to slash Torvin, but Torvin parries!"
        ),
        Event::MeleeMiss {
            attacker: named("Baron Telyx V`Zher"),
            target: named("Torvin"),
            verb: "slash".into(),
            kind: MissKind::Parry,
        }
    );
}

#[test]
fn melee_miss_you_dodge() {
    assert_eq!(
        parse("[Thu Jul 02 23:44:38 2026] Skeleton L`rodd tries to kick YOU, but YOU dodge!"),
        Event::MeleeMiss {
            attacker: named("Skeleton L`rodd"),
            target: you(),
            verb: "kick".into(),
            kind: MissKind::Dodge,
        }
    );
}

#[test]
fn melee_miss_by_you() {
    assert_eq!(
        parse("[Fri Jul 03 01:08:47 2026] You try to crush Baron Telyx V`Zher, but miss!"),
        Event::MeleeMiss {
            attacker: you(),
            target: named("Baron Telyx V`Zher"),
            verb: "crush".into(),
            kind: MissKind::Miss,
        }
    );
}

#[test]
fn melee_miss_absorb() {
    assert_eq!(
        parse("[Fri Jul 03 00:56:51 2026] Ellara tries to pierce Kahaptra Z`Taj, but Kahaptra Z`Taj's magical skin absorbs the blow!"),
        Event::MeleeMiss {
            attacker: named("Ellara"),
            target: named("Kahaptra Z`Taj"),
            verb: "pierce".into(),
            kind: MissKind::Absorb,
        }
    );
}

#[test]
fn melee_miss_two_word_frenzy_verb() {
    // The hit-side verb lists include the two-word "frenzy on"/"frenzies on";
    // the miss side must not mis-split it into verb "frenzy" + target "on X".
    assert_eq!(
        parse("[Fri Jul 03 12:00:00 2026] A frenzied ghoul tries to frenzy on YOU, but misses!"),
        Event::MeleeMiss {
            attacker: named("A frenzied ghoul"),
            target: you(),
            verb: "frenzy on".into(),
            kind: MissKind::Miss,
        }
    );
    assert_eq!(
        parse("[Fri Jul 03 12:00:01 2026] You try to frenzy on a Teir`Dal ranger, but miss!"),
        Event::MeleeMiss {
            attacker: you(),
            target: named("a Teir`Dal ranger"),
            verb: "frenzy on".into(),
            kind: MissKind::Miss,
        }
    );
}

#[test]
fn melee_miss_with_riposte_annotation() {
    assert_eq!(
        parse("[Fri Jul 03 12:16:53 2026] A Teir`Dal shadowknight tries to slash YOU, but misses! (Riposte)"),
        Event::MeleeMiss {
            attacker: named("A Teir`Dal shadowknight"),
            target: you(),
            verb: "slash".into(),
            kind: MissKind::Miss,
        }
    );
}

// ---------------------------------------------------------------------------
// Spell damage
// ---------------------------------------------------------------------------

#[test]
fn spell_damage_pet_caster() {
    assert_eq!(
        parse("[Fri Jul 03 12:16:33 2026] Vibarn hit a Teir`Dal shadowknight for 12 points of magic damage by Lifespike."),
        Event::SpellDamage {
            caster: named("Vibarn"),
            target: named("a Teir`Dal shadowknight"),
            amount: 12,
            spell: Some("Lifespike".into()),
            flags: HitFlags::default(),
        }
    );
}

#[test]
fn spell_damage_by_you() {
    assert_eq!(
        parse("[Thu Jul 02 23:46:01 2026] You hit Asaka L`Rei for 107 points of magic damage by Lifedraw."),
        Event::SpellDamage {
            caster: you(),
            target: named("Asaka L`Rei"),
            amount: 107,
            spell: Some("Lifedraw".into()),
            flags: HitFlags::default(),
        }
    );
}

#[test]
fn spell_damage_on_you_lowercase_pronoun() {
    assert_eq!(
        parse("[Thu Jul 02 23:45:53 2026] Asaka L`Rei hit you for 13 points of magic damage by Lifespike."),
        Event::SpellDamage {
            caster: named("Asaka L`Rei"),
            target: you(),
            amount: 13,
            spell: Some("Lifespike".into()),
            flags: HitFlags::default(),
        }
    );
}

#[test]
fn spell_damage_taken_by_you() {
    assert_eq!(
        parse("[Thu Jul 02 23:55:00 2026] You have taken 11 damage from Cancelling of Life by a necro acolyte."),
        Event::SpellDamageTaken {
            target: you(),
            source: named("a necro acolyte"),
            spell: "Cancelling of Life".into(),
            amount: 11,
        }
    );
}

#[test]
fn spell_damage_taken_dot_tick_third_person() {
    assert_eq!(
        parse("[Fri Jul 03 11:37:25 2026] Baron Telyx V`Zher has taken 8 damage from Clinging Darkness by Vibarn."),
        Event::SpellDamageTaken {
            target: named("Baron Telyx V`Zher"),
            source: named("Vibarn"),
            spell: "Clinging Darkness".into(),
            amount: 8,
        }
    );
}

#[test]
fn spell_damage_taken_from_your_dot() {
    assert_eq!(
        parse("[Fri Jul 03 11:37:37 2026] Baron Telyx V`Zher has taken 31 damage from your Affliction."),
        Event::SpellDamageTaken {
            target: named("Baron Telyx V`Zher"),
            source: you(),
            spell: "Affliction".into(),
            amount: 31,
        }
    );
}

#[test]
fn spell_damage_taken_critical_tick_still_parses() {
    assert_eq!(
        parse("[Fri Jul 03 12:18:43 2026] Baron Telyx V`Zher has taken 19 damage from your Leech. (Critical)"),
        Event::SpellDamageTaken {
            target: named("Baron Telyx V`Zher"),
            source: you(),
            spell: "Leech".into(),
            amount: 19,
        }
    );
}

// ---------------------------------------------------------------------------
// Non-melee (DoT / damage shield)
// ---------------------------------------------------------------------------

#[test]
fn non_melee_your_effect() {
    assert_eq!(
        parse("[Thu Jul 02 23:45:06 2026] A large plague rat is tormented by YOUR frost for 8 points of non-melee damage."),
        Event::NonMeleeDamage {
            source: Some(you()),
            target: named("A large plague rat"),
            effect: "frost".into(),
            amount: 8,
        }
    );
}

#[test]
fn non_melee_possessive_owner_single_point() {
    assert_eq!(
        parse("[Fri Jul 03 11:37:14 2026] Baron Telyx V`Zher is pierced by Torvin's thorns for 1 point of non-melee damage."),
        Event::NonMeleeDamage {
            source: Some(named("Torvin")),
            target: named("Baron Telyx V`Zher"),
            effect: "thorns".into(),
            amount: 1,
        }
    );
}

#[test]
fn non_melee_on_you() {
    assert_eq!(
        parse("[Fri Jul 03 11:37:55 2026] YOU are pierced by a Teir`Dal ranger's thorns for 6 points of non-melee damage!"),
        Event::NonMeleeDamage {
            source: Some(named("a Teir`Dal ranger")),
            target: you(),
            effect: "thorns".into(),
            amount: 6,
        }
    );
}

// ---------------------------------------------------------------------------
// Heals
// ---------------------------------------------------------------------------

#[test]
fn heal_plain() {
    assert_eq!(
        parse("[Fri Jul 03 08:53:58 2026] Brakis healed Corvane for 15 hit points by Courage."),
        Event::Heal {
            healer: named("Brakis"),
            target: named("Corvane"),
            amount: 15,
            potential: None,
            over_time: false,
            spell: Some("Courage".into()),
            flags: HitFlags::default(),
        }
    );
}

#[test]
fn heal_overheal_reflexive() {
    assert_eq!(
        parse(
            "[Fri Jul 03 11:37:27 2026] Vibarn healed itself for 0 (12) hit points by Lifespike."
        ),
        Event::Heal {
            healer: named("Vibarn"),
            target: named("Vibarn"),
            amount: 0,
            potential: Some(12),
            over_time: false,
            spell: Some("Lifespike".into()),
            flags: HitFlags::default(),
        }
    );
}

#[test]
fn heal_over_time_reflexive() {
    assert_eq!(
        parse("[Fri Jul 03 09:23:21 2026] a Teir`Dal priest healed himself over time for 55 hit points by Echoing Light."),
        Event::Heal {
            healer: named("a Teir`Dal priest"),
            target: named("a Teir`Dal priest"),
            amount: 55,
            potential: None,
            over_time: true,
            spell: Some("Echoing Light".into()),
            flags: HitFlags::default(),
        }
    );
}

// ---------------------------------------------------------------------------
// Casting / resists / buffs
// ---------------------------------------------------------------------------

#[test]
fn cast_begin_you() {
    assert_eq!(
        parse("[Fri Jul 03 11:37:18 2026] You begin casting Negation of Life."),
        Event::CastBegin {
            caster: you(),
            spell: "Negation of Life".into()
        }
    );
}

#[test]
fn cast_begin_other() {
    assert_eq!(
        parse("[Fri Jul 03 11:37:18 2026] Vibarn begins casting Clinging Darkness."),
        Event::CastBegin {
            caster: named("Vibarn"),
            spell: "Clinging Darkness".into()
        }
    );
}

#[test]
fn cast_interrupted_yours_and_others() {
    assert_eq!(
        parse("[Fri Jul 03 11:37:26 2026] Your Affliction spell is interrupted."),
        Event::CastInterrupted {
            caster: you(),
            spell: Some("Affliction".into())
        }
    );
    assert_eq!(
        parse("[Fri Jul 03 01:49:47 2026] Leitho's Lifespike spell is interrupted."),
        Event::CastInterrupted {
            caster: named("Leitho"),
            spell: Some("Lifespike".into()),
        }
    );
}

#[test]
fn cast_fizzles() {
    assert_eq!(
        parse("[Thu Jul 02 23:50:42 2026] Your Spirit Strike spell fizzles!"),
        Event::CastFizzled {
            caster: you(),
            spell: Some("Spirit Strike".into())
        }
    );
    assert_eq!(
        parse("[Fri Jul 03 09:31:11 2026] Torvin's Flame Lick spell fizzles!"),
        Event::CastFizzled {
            caster: named("Torvin"),
            spell: Some("Flame Lick".into()),
        }
    );
}

#[test]
fn cast_begin_bard_song() {
    assert_eq!(
        parse("[Fri Jul 03 09:17:03 2026] Torvin begins singing Kelin's Lugubrious Lament."),
        Event::CastBegin {
            caster: named("Torvin"),
            spell: "Kelin's Lugubrious Lament".into(),
        }
    );
}

#[test]
fn stun_lockout_is_system_not_interrupt() {
    assert_eq!(
        parse("[Fri Jul 03 11:37:14 2026] You can't cast spells while stunned!"),
        Event::System
    );
}

#[test]
fn resists() {
    assert_eq!(
        parse("[Fri Jul 03 12:09:39 2026] A Teir`Dal ranger resisted your Engulfing Darkness!"),
        Event::Resisted {
            target: named("A Teir`Dal ranger"),
            caster: you(),
            spell: "Engulfing Darkness".into(),
        }
    );
    assert_eq!(
        parse(
            "[Fri Jul 03 10:23:03 2026] A Teir`Dal priestess resisted Vibarn's Clinging Darkness!"
        ),
        Event::Resisted {
            target: named("A Teir`Dal priestess"),
            caster: named("Vibarn"),
            spell: "Clinging Darkness".into(),
        }
    );
    assert_eq!(
        parse("[Fri Jul 03 00:22:51 2026] You resist a necro acolyte pet's Disease Cloud!"),
        Event::Resisted {
            target: you(),
            caster: named("a necro acolyte pet"),
            spell: "Disease Cloud".into(),
        }
    );
}

#[test]
fn worn_off() {
    assert_eq!(
        parse("[Fri Jul 03 11:38:15 2026] Your pet's Tangling Weeds spell has worn off."),
        Event::WornOff {
            spell: "Tangling Weeds".into(),
            owner: Some(named("your pet")),
        }
    );
    assert_eq!(
        parse("[Fri Jul 03 00:20:00 2026] Your Heat Blood spell has worn off of Gynok Moltor."),
        Event::WornOff {
            spell: "Heat Blood".into(),
            owner: Some(named("Gynok Moltor")),
        }
    );
}

// ---------------------------------------------------------------------------
// Deaths / loot / rolls
// ---------------------------------------------------------------------------

#[test]
fn slain_variants() {
    assert_eq!(
        parse("[Fri Jul 03 10:04:38 2026] A Teir`Dal ranger has been slain by Torvin`s warder!"),
        Event::Slain {
            victim: named("A Teir`Dal ranger"),
            killer: Some(named("Torvin`s warder")),
        }
    );
    assert_eq!(
        parse("[Fri Jul 03 11:38:54 2026] You have slain Korven Nisere!"),
        Event::Slain {
            victim: named("Korven Nisere"),
            killer: Some(you())
        }
    );
    assert_eq!(
        parse("[Fri Jul 03 00:27:42 2026] A necro initiate died."),
        Event::Slain {
            victim: named("A necro initiate"),
            killer: None
        }
    );
    assert_eq!(
        parse("[Fri Jul 03 00:27:42 2026] You died."),
        Event::Slain {
            victim: you(),
            killer: None
        }
    );
}

#[test]
fn loot_with_quantity() {
    assert_eq!(
        parse("[Thu Jul 02 23:51:32 2026] --You have looted 2 Bone Chips from a greater skeleton's corpse.--"),
        Event::Loot {
            looter: you(),
            item: "Bone Chips".into(),
            quantity: 2,
            corpse: Some("a greater skeleton".into()),
        }
    );
}

#[test]
fn loot_single_item_with_article() {
    assert_eq!(
        parse("[Thu Jul 02 23:45:00 2026] --You have looted a Pristine Studded Leather Boots +2 from skeleton L`rodd's corpse.--"),
        Event::Loot {
            looter: you(),
            item: "Pristine Studded Leather Boots +2".into(),
            quantity: 1,
            corpse: Some("skeleton L`rodd".into()),
        }
    );
}

#[test]
fn loot_stored_in_depot() {
    assert_eq!(
        parse("[Fri Jul 03 01:06:14 2026] You looted a Flame Agate from a Teir`Dal ranger's corpse and stored it in your tradeskill depot"),
        Event::Loot {
            looter: you(),
            item: "Flame Agate".into(),
            quantity: 1,
            corpse: Some("a Teir`Dal ranger".into()),
        }
    );
}

#[test]
fn roll_magic_die() {
    // Not present in the fixtures; format per classic EQ /random output.
    assert_eq!(
        parse("[Fri Jul 03 11:00:00 2026] **A Magic Die is rolled by Nyasha. It could have been any number from 1 to 100, but this time it turned up a 42."),
        Event::Roll { roller: "Nyasha".into(), min: 1, max: 100, result: 42 }
    );
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

#[test]
fn chat_numbered_channels() {
    assert_eq!(
        parse("[Thu Jul 02 23:33:54 2026] Vheden tells NewPlayers:1, 'Anyone know what to do with Troll Raider's Head'"),
        Event::Chat {
            channel: ChatChannel::Numbered { name: "NewPlayers".into(), number: 1 },
            speaker: named("Vheden"),
            text: "Anyone know what to do with Troll Raider's Head".into(),
        }
    );
    assert_eq!(
        parse("[Fri Jul 03 08:45:48 2026] Zyolus tells General1:2, 'what are 2 classes that are good to combo with a BST?'"),
        Event::Chat {
            channel: ChatChannel::Numbered { name: "General1".into(), number: 2 },
            speaker: named("Zyolus"),
            text: "what are 2 classes that are good to combo with a BST?".into(),
        }
    );
}

#[test]
fn chat_group_say_ooc() {
    assert_eq!(
        parse("[Fri Jul 03 09:45:03 2026] You tell your party, 'test'"),
        Event::Chat {
            channel: ChatChannel::Group,
            speaker: you(),
            text: "test".into()
        }
    );
    assert_eq!(
        parse("[Thu Jul 02 23:44:36 2026] Skeleton L`rodd says, 'Run! Leave this place at once!'"),
        Event::Chat {
            channel: ChatChannel::Say,
            speaker: named("Skeleton L`rodd"),
            text: "Run! Leave this place at once!".into(),
        }
    );
    assert_eq!(
        parse("[Fri Jul 03 16:40:44 2026] Gloldus says out of character, 'WTS Enchanted Fine Steel Morning Star +4 10p'"),
        Event::Chat {
            channel: ChatChannel::Ooc,
            speaker: named("Gloldus"),
            text: "WTS Enchanted Fine Steel Morning Star +4 10p".into(),
        }
    );
}

// ---------------------------------------------------------------------------
// Progress / world state
// ---------------------------------------------------------------------------

#[test]
fn xp_level_faction() {
    assert_eq!(
        parse("[Fri Jul 03 12:09:51 2026] You gain experience! (2.429%)"),
        Event::XpGain {
            percent: 2.429,
            party: false
        }
    );
    assert_eq!(
        parse("[Fri Jul 03 09:01:45 2026] You gain party experience! (0.083%)"),
        Event::XpGain {
            percent: 0.083,
            party: true
        }
    );
    assert_eq!(
        parse("[Thu Jul 02 23:59:03 2026] You have gained a level! Welcome to level 16!"),
        Event::LevelUp { level: 16 }
    );
    assert_eq!(
        parse("[Thu Jul 02 23:45:26 2026] Your faction standing with Burning Dead has been adjusted by -2."),
        Event::Faction { faction: "Burning Dead".into(), delta: -2 }
    );
}

#[test]
fn zone_loading_stun_location() {
    assert_eq!(
        parse("[Thu Jul 02 23:32:51 2026] You have entered Dagnor's Cauldron."),
        Event::ZoneEnter {
            zone: "Dagnor's Cauldron".into()
        }
    );
    assert_eq!(
        parse("[Fri Jul 03 12:20:05 2026] LOADING, PLEASE WAIT..."),
        Event::Loading
    );
    assert_eq!(
        parse("[Thu Jul 02 23:50:02 2026] You are stunned!"),
        Event::Stunned { active: true }
    );
    assert_eq!(
        parse("[Fri Jul 03 11:37:18 2026] You are no longer stunned."),
        Event::Stunned { active: false }
    );
    assert_eq!(
        parse("[Thu Jul 02 23:33:15 2026] Your Location is -2006.63, -622.13, 93.81"),
        Event::Location {
            x: -2006.63,
            y: -622.13,
            z: 93.81
        }
    );
}

#[test]
fn recognized_system_noise() {
    for line in [
        "[Fri Jul 03 11:37:55 2026] Auto attack is on.",
        "[Thu Jul 02 23:34:24 2026] You are encumbered!",
    ] {
        assert_eq!(parse(line), Event::System, "{line}");
    }
}

// ---------------------------------------------------------------------------
// Coverage over the real fixtures
// ---------------------------------------------------------------------------

fn digit_shape(msg: &str) -> String {
    let mut out = String::with_capacity(msg.len());
    let mut in_num = false;
    for ch in msg.chars() {
        if ch.is_ascii_digit() {
            if !in_num {
                out.push('N');
                in_num = true;
            }
        } else {
            in_num = false;
            out.push(ch);
        }
    }
    out
}

/// Parse a fixture; returns (total, unclassified, top unclassified shapes).
fn coverage(text: &str) -> (usize, usize, Vec<(String, usize)>) {
    let parser = Parser::new();
    let mut total = 0usize;
    let mut unclassified = 0usize;
    let mut shapes: HashMap<String, usize> = HashMap::new();
    for raw in text.lines() {
        if raw.trim().is_empty() {
            continue;
        }
        let parsed = parser
            .parse_line(raw)
            .unwrap_or_else(|| panic!("fixture line failed timestamp parse: {raw}"));
        total += 1;
        if parsed.event == Event::Unclassified {
            unclassified += 1;
            *shapes.entry(digit_shape(&parsed.line.message)).or_default() += 1;
        }
    }
    let mut top: Vec<(String, usize)> = shapes.into_iter().collect();
    top.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    top.truncate(30);
    (total, unclassified, top)
}

#[test]
fn sample_session_coverage_at_least_97_percent() {
    let text = fixture("sample_session.txt");
    let (total, unclassified, top) = coverage(&text);
    let classified_pct = 100.0 * (total - unclassified) as f64 / total as f64;
    println!(
        "sample_session.txt: {}/{} classified ({classified_pct:.2}%)",
        total - unclassified,
        total
    );
    if classified_pct < 97.0 {
        eprintln!("top unclassified shapes:");
        for (shape, n) in &top {
            eprintln!("{n:>6}  {shape}");
        }
        panic!("coverage {classified_pct:.2}% < 97% ({unclassified}/{total} unclassified)");
    }
}

#[test]
fn full_log_coverage_stat_if_present() {
    // Heavy check over the gitignored 84k-line real log; skipped when the
    // local fixture is absent (e.g. CI). Non-failing: prints the stat.
    let path = format!(
        "{}/../../fixtures/local/eqlog_full.txt",
        env!("CARGO_MANIFEST_DIR")
    );
    let Ok(text) = fs::read_to_string(&path) else {
        println!("fixtures/local/eqlog_full.txt not present; skipping");
        return;
    };
    let (total, unclassified, top) = coverage(&text);
    let classified_pct = 100.0 * (total - unclassified) as f64 / total as f64;
    println!(
        "eqlog_full.txt: {}/{} classified ({classified_pct:.2}%)",
        total - unclassified,
        total
    );
    println!("top unclassified shapes:");
    for (shape, n) in &top {
        println!("{n:>6}  {shape}");
    }
}

#[test]
fn unique_patterns_coverage_stat() {
    // Non-failing: unique_patterns.txt holds one line per distinct message
    // shape ever seen, so open-ended flavor text drags the ratio down by
    // design. Print the stat for tracking.
    let text = fixture("unique_patterns.txt");
    let (total, unclassified, top) = coverage(&text);
    let classified_pct = 100.0 * (total - unclassified) as f64 / total as f64;
    println!(
        "unique_patterns.txt: {}/{} classified ({classified_pct:.2}%)",
        total - unclassified,
        total
    );
    println!("top unclassified shapes:");
    for (shape, n) in &top {
        println!("{n:>6}  {shape}");
    }
}

// ---------------------------------------------------------------------------
// Buff blocked (stacking conflict) — P11
// ---------------------------------------------------------------------------

#[test]
fn buff_blocked_self_form() {
    let ev = parse(
        "[Fri Jul 03 09:33:40 2026] Your Protect spell did not take hold. (Blocked by Spirit Armor.)",
    );
    assert_eq!(
        ev,
        Event::BuffBlocked {
            spell: "Protect".to_string(),
            blocker: "Spirit Armor".to_string(),
            target: you(),
        }
    );
}

#[test]
fn buff_blocked_on_other_form() {
    let ev = parse(
        "[Fri Jul 03 09:33:40 2026] Your Protect spell did not take hold on Vibarn. (Blocked by Spirit Armor.)",
    );
    assert_eq!(
        ev,
        Event::BuffBlocked {
            spell: "Protect".to_string(),
            blocker: "Spirit Armor".to_string(),
            target: named("Vibarn"),
        }
    );
}

#[test]
fn buff_blocked_on_other_with_possessive_target() {
    // "Sliq`s warder" (a pet) as the on-other target must not swallow the
    // blocker clause.
    let ev = parse(
        "[Fri Jul 03 09:33:40 2026] Your Protect spell did not take hold on Sliq`s warder. (Blocked by Spirit Armor.)",
    );
    assert_eq!(
        ev,
        Event::BuffBlocked {
            spell: "Protect".to_string(),
            blocker: "Spirit Armor".to_string(),
            target: named("Sliq`s warder"),
        }
    );
}
