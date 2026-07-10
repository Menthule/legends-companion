//! Live meter selection: turns `FightTracker` state into the "fight-update"
//! event payload. The tracker owns segmentation and pet→owner attribution;
//! this module just picks which fight to show (the most recently active open
//! fight, else the last completed one) and shapes the rows for the UI.

use eqlog_core::fights::{FightSummary, FightTracker};
use serde::Serialize;

/// One damage source under a meter row (post-sprint item 15): melee verb,
/// spell name, or "<effect> (damage shield)"; pet sources carry a "(pet)"
/// suffix. Mirrors `eqlog_core::fights::SourceRow`, camelCased for the UI.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MeterSourceRow {
    pub name: String,
    pub total: u64,
    pub hits: u64,
    pub crits: u64,
    pub max_hit: u64,
    /// Failed melee attempts on this source (drives the Acc% column).
    pub misses: u64,
    /// Times this spell source was cast (drives the per-cast readout).
    pub casts: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MeterRow {
    pub name: String,
    pub total: u64,
    pub pet_damage: u64,
    pub dps: f64,
    pub pct: f64,
    /// Actual healing done by this combatant while the fight was active
    /// (X2 healing mode). Zero for pure-DPS rows.
    pub healing: u64,
    /// Potential-minus-actual healing when overheal syntax was present.
    pub overheal: u64,
    /// Damage received from the fight target (X2 taken mode).
    pub damage_taken: u64,
    /// Per-source breakdown, total descending (expandable rows in the UI).
    pub sources: Vec<MeterSourceRow>,
}

/// Payload of the "fight-update" event.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FightUpdate {
    pub target: String,
    pub duration_secs: u64,
    pub total_damage: u64,
    pub active: bool,
    pub rows: Vec<MeterRow>,
}

/// The contributing rows of a summary, shaped for the UI. Shared by the live
/// meter and the fight-history commands so both render identically. Rows are
/// kept when they dealt damage, healed, or took damage (X2): a pure healer or
/// pure tank must survive into the healing / taken meter modes. Order is the
/// summary's damage-descending order; the frontend re-sorts per mode.
pub fn damage_rows(summary: &FightSummary) -> Vec<MeterRow> {
    summary
        .rows
        .iter()
        .filter(|r| r.damage > 0 || r.healing > 0 || r.damage_taken > 0)
        .map(|r| MeterRow {
            name: r.name.clone(),
            total: r.damage,
            pet_damage: r.pet_damage,
            dps: r.dps,
            pct: r.percent,
            healing: r.healing,
            overheal: r.overheal,
            damage_taken: r.damage_taken,
            sources: r
                .sources
                .iter()
                .map(|s| MeterSourceRow {
                    name: s.name.clone(),
                    total: s.total,
                    hits: s.hits,
                    crits: s.crits,
                    max_hit: s.max_hit,
                    misses: s.misses,
                    casts: s.casts,
                })
                .collect(),
        })
        .collect()
}

fn to_update(summary: &FightSummary, active: bool) -> FightUpdate {
    FightUpdate {
        target: summary.target.clone(),
        duration_secs: summary.duration_secs,
        total_damage: summary.total_damage,
        active,
        rows: damage_rows(summary),
    }
}

/// Remembers the last completed fight so the meter keeps showing it between
/// pulls.
#[derive(Default)]
pub struct LiveMeter {
    last_completed: Option<FightSummary>,
}

impl LiveMeter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Produce the current meter payload: the open fight with the latest
    /// activity, else the last completed one. `newly_completed` is the batch
    /// the caller just drained via `FightTracker::completed_fights` — the
    /// session loop persists ALL of them to the fight store (the old code
    /// drained here and kept only one, silently discarding AE-pull fights)
    /// and hands them over so the meter can keep showing the latest.
    pub fn update(
        &mut self,
        tracker: &FightTracker,
        newly_completed: &[FightSummary],
    ) -> Option<FightUpdate> {
        if let Some(last) = newly_completed.last() {
            self.last_completed = Some(last.clone());
        }
        let mut open = tracker.active_fights();
        match open.len() {
            0 => self.last_completed.as_ref().map(|s| to_update(s, false)),
            1 => Some(to_update(&open[0], true)),
            // Multi-mob pull: merge every active fight per combatant so
            // nobody blinks in and out as events alternate between mobs
            // (a single-fight pick flips with each mob's latest event).
            _ => {
                open.sort_by_key(|f| std::cmp::Reverse(f.end_ts));
                Some(merge_pull(&open))
            }
        }
    }
}

/// Combine concurrently active fights into one "pull" view: rows are summed
/// per combatant (sources merged by name), DPS/percent recomputed over the
/// whole pull window. `fights` must be sorted newest-activity-first — the
/// first entry names the pull.
fn merge_pull(fights: &[FightSummary]) -> FightUpdate {
    use std::collections::HashMap;

    let start = fights.iter().map(|f| f.start_ts).min().unwrap_or(0);
    let end = fights.iter().map(|f| f.end_ts).max().unwrap_or(start);
    let duration = (end - start).max(1) as u64;

    // name -> (total, source-name -> MeterSourceRow), insertion-ordered names.
    // Healing / overheal / damage-taken accumulate per combatant alongside
    // damage so the merged pull view supports every meter mode (X2).
    let mut order: Vec<String> = Vec::new();
    let mut totals: HashMap<String, u64> = HashMap::new();
    let mut pet_totals: HashMap<String, u64> = HashMap::new();
    let mut healing: HashMap<String, u64> = HashMap::new();
    let mut overheal: HashMap<String, u64> = HashMap::new();
    let mut taken: HashMap<String, u64> = HashMap::new();
    let mut sources: HashMap<String, HashMap<String, MeterSourceRow>> = HashMap::new();
    for f in fights {
        for r in f
            .rows
            .iter()
            .filter(|r| r.damage > 0 || r.healing > 0 || r.damage_taken > 0)
        {
            if !totals.contains_key(&r.name) {
                order.push(r.name.clone());
            }
            *totals.entry(r.name.clone()).or_insert(0) += r.damage;
            *pet_totals.entry(r.name.clone()).or_insert(0) += r.pet_damage;
            *healing.entry(r.name.clone()).or_insert(0) += r.healing;
            *overheal.entry(r.name.clone()).or_insert(0) += r.overheal;
            *taken.entry(r.name.clone()).or_insert(0) += r.damage_taken;
            let by_src = sources.entry(r.name.clone()).or_default();
            for s in &r.sources {
                let e = by_src.entry(s.name.clone()).or_insert(MeterSourceRow {
                    name: s.name.clone(),
                    total: 0,
                    hits: 0,
                    crits: 0,
                    max_hit: 0,
                    misses: 0,
                    casts: 0,
                });
                e.total += s.total;
                e.hits += s.hits;
                e.crits += s.crits;
                e.max_hit = e.max_hit.max(s.max_hit);
                e.misses += s.misses;
                e.casts += s.casts;
            }
        }
    }
    let grand: u64 = totals.values().sum();
    let mut rows: Vec<MeterRow> = order
        .into_iter()
        .map(|name| {
            let total = totals[&name];
            let mut srcs: Vec<MeterSourceRow> = sources
                .remove(&name)
                .unwrap_or_default()
                .into_values()
                .collect();
            srcs.sort_by_key(|s| std::cmp::Reverse(s.total));
            MeterRow {
                total,
                pet_damage: pet_totals.get(&name).copied().unwrap_or(0),
                dps: total as f64 / duration as f64,
                pct: if grand > 0 {
                    total as f64 * 100.0 / grand as f64
                } else {
                    0.0
                },
                healing: healing.get(&name).copied().unwrap_or(0),
                overheal: overheal.get(&name).copied().unwrap_or(0),
                damage_taken: taken.get(&name).copied().unwrap_or(0),
                sources: srcs,
                name,
            }
        })
        .collect();
    rows.sort_by_key(|r| std::cmp::Reverse(r.total));

    FightUpdate {
        target: format!("{} +{}", fights[0].target, fights.len() - 1),
        duration_secs: duration,
        total_damage: grand,
        active: true,
        rows,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use eqlog_core::events::{Entity, Event, HitFlags, LogLine, ParsedLine};
    use eqlog_core::fights::FightConfig;
    use eqlog_core::parser::Parser;

    fn line(ts: i64, event: Event) -> ParsedLine {
        ParsedLine {
            line: LogLine {
                timestamp: ts,
                message: String::new(),
            },
            event,
        }
    }

    /// What the session loop does each tick: drain completed fights, then
    /// feed both the tracker and the drained batch to the meter.
    fn tick(meter: &mut LiveMeter, tracker: &mut FightTracker) -> Option<FightUpdate> {
        let completed = tracker.completed_fights();
        meter.update(tracker, &completed)
    }

    #[test]
    fn multi_mob_pull_merges_and_keeps_all_combatants() {
        let mut tracker = FightTracker::new(FightConfig {
            character_name: "Nyasha".into(),
            ..FightConfig::default()
        });
        let mut meter = LiveMeter::new();
        // Nyasha hits mob A; pet-free simple pull: another PC hits mob B.
        tracker.ingest(&melee(100, Entity::You, "a ghoul", 50));
        tracker.ingest(&melee(101, Entity::Named("Torvin".into()), "a rat", 30));
        // Latest event belongs to mob B's fight — Nyasha must still show.
        let up = tick(&mut meter, &mut tracker).expect("update");
        assert!(up.target.ends_with(" +1"), "pull title: {}", up.target);
        let names: Vec<&str> = up.rows.iter().map(|r| r.name.as_str()).collect();
        assert!(names.contains(&"Nyasha"), "rows: {names:?}");
        assert!(names.contains(&"Torvin"), "rows: {names:?}");
        assert_eq!(up.total_damage, 80);
    }

    fn melee(ts: i64, attacker: Entity, target: &str, amount: u64) -> ParsedLine {
        line(
            ts,
            Event::MeleeHit {
                attacker,
                target: Entity::Named(target.into()),
                verb: "crush".into(),
                amount,
                flags: HitFlags::default(),
            },
        )
    }

    #[test]
    fn shows_open_fight_then_keeps_completed_one() {
        let mut tracker = FightTracker::new(FightConfig::new("Nyasha"));
        let mut meter = LiveMeter::new();

        assert!(tick(&mut meter, &mut tracker).is_none());

        tracker.ingest(&melee(100, Entity::You, "a gnoll pup", 25));
        tracker.ingest(&melee(
            103,
            Entity::Named("Vibarn".into()),
            "a gnoll pup",
            10,
        ));
        let up = tick(&mut meter, &mut tracker).expect("open fight");
        assert!(up.active);
        assert_eq!(up.target, "a gnoll pup");
        assert_eq!(up.total_damage, 35);
        assert_eq!(up.rows[0].name, "Nyasha");
        // Vibarn auto-attributes to nothing here (no `s possessive, unknown
        // pet) so it stays its own row.
        assert!(up.rows.iter().any(|r| r.name == "Vibarn"));

        tracker.ingest(&line(
            105,
            Event::Slain {
                victim: Entity::Named("a gnoll pup".into()),
                killer: Some(Entity::You),
            },
        ));
        let up = tick(&mut meter, &mut tracker).expect("completed fight");
        assert!(!up.active);
        assert_eq!(up.target, "a gnoll pup");
        assert_eq!(up.total_damage, 35);

        // Stays on the last completed fight until a new one opens.
        let again = tick(&mut meter, &mut tracker).expect("still shown");
        assert!(!again.active);
    }

    #[test]
    fn pet_with_backtick_possessive_folds_into_owner() {
        let mut tracker = FightTracker::new(FightConfig::new("Nyasha"));
        let mut meter = LiveMeter::new();
        // You open the fight; then a groupmate and their backtick-possessive
        // pet contribute (other players only count in already-open fights).
        tracker.ingest(&melee(9, Entity::You, "a Teir`Dal ranger", 5));
        tracker.ingest(&melee(
            10,
            Entity::Named("Torvin".into()),
            "a Teir`Dal ranger",
            20,
        ));
        tracker.ingest(&melee(
            11,
            Entity::Named("Torvin`s warder".into()),
            "a Teir`Dal ranger",
            15,
        ));
        let up = tick(&mut meter, &mut tracker).expect("open fight");
        let torvin = up
            .rows
            .iter()
            .find(|r| r.name == "Torvin")
            .expect("Torvin row");
        assert_eq!(torvin.total, 35);
        assert!(!up.rows.iter().any(|r| r.name == "Torvin`s warder"));
        assert_eq!(up.total_damage, 40);
    }

    #[test]
    fn real_fixture_produces_damage_rows() {
        let fixture = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/sample_session.txt"
        );
        let text = std::fs::read_to_string(fixture).expect("fixture exists");
        let parser = Parser::new();
        let mut tracker = FightTracker::new(FightConfig::new("Nyasha"));
        let mut meter = LiveMeter::new();
        let mut saw_update = false;
        for raw in text.lines() {
            if let Some(parsed) = parser.parse_line(raw) {
                tracker.ingest(&parsed);
            }
        }
        if let Some(up) = tick(&mut meter, &mut tracker) {
            saw_update = true;
            assert!(!up.rows.is_empty(), "combat-heavy fixture must yield rows");
            assert!(up.rows.iter().all(|r| r.total > 0));
            assert!(up.rows.windows(2).all(|w| w[0].total >= w[1].total));
        }
        assert!(saw_update, "4000 combat-heavy lines must produce a fight");
    }
}
