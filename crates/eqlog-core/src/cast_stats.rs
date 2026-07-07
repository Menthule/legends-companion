//! Per-caster / per-spell casting-outcome tallies — the data behind a caster
//! efficiency view (fizzle / interrupt / resist / inferred land rate). Folded
//! from the same [`ParsedLine`] stream the fight tracker consumes, so it costs
//! nothing new to parse (P45 caster analytics).
//!
//! The log has no explicit "your spell landed" line for most spells, so a land
//! is INFERRED: `attempts - observed failures`. `attempts` is the number of
//! `CastBegin` lines, floored to the failure count so a fizzle/resist whose
//! begin line was never seen (catch-up starting mid-cast) still yields a sane
//! ratio instead of dividing by zero.

use std::collections::HashMap;

use crate::events::{Entity, Event, ParsedLine};

/// One caster+spell's outcome tallies over a session.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CastRow {
    pub caster: String,
    pub spell: String,
    /// `CastBegin` lines seen for this caster+spell (attempts).
    pub casts: u32,
    pub fizzles: u32,
    pub interrupts: u32,
    pub resists: u32,
}

impl CastRow {
    /// Observed failures: fizzle + interrupt + resist.
    pub fn failures(&self) -> u32 {
        self.fizzles + self.interrupts + self.resists
    }

    /// Denominator for the rates. Normally the `CastBegin` count, but never
    /// below the failure count — a failure without a matching begin (mid-cast
    /// catch-up, a dropped begin line) still counts as an attempt.
    pub fn attempts(&self) -> u32 {
        self.casts.max(self.failures())
    }

    /// Attempts not observed to fail (inferred land count).
    pub fn landed(&self) -> u32 {
        self.attempts().saturating_sub(self.failures())
    }

    /// Inferred land rate, percent. 0 when there were no attempts.
    pub fn land_pct(&self) -> f64 {
        pct(self.landed(), self.attempts())
    }

    pub fn fizzle_pct(&self) -> f64 {
        pct(self.fizzles, self.attempts())
    }

    pub fn resist_pct(&self) -> f64 {
        pct(self.resists, self.attempts())
    }
}

fn pct(n: u32, d: u32) -> f64 {
    if d == 0 {
        0.0
    } else {
        n as f64 / d as f64 * 100.0
    }
}

/// Accumulates cast outcomes keyed by (caster, spell) across a session.
#[derive(Debug, Clone, Default)]
pub struct CastStats {
    you: String,
    rows: HashMap<(String, String), CastRow>,
}

impl CastStats {
    /// `you` is the player display name used to resolve [`Entity::You`].
    pub fn new(you: impl Into<String>) -> Self {
        Self {
            you: you.into(),
            rows: HashMap::new(),
        }
    }

    fn name(&self, e: &Entity) -> String {
        e.name(&self.you).to_string()
    }

    fn row(&mut self, caster: String, spell: String) -> &mut CastRow {
        self.rows
            .entry((caster.clone(), spell.clone()))
            .or_insert(CastRow {
                caster,
                spell,
                ..Default::default()
            })
    }

    /// Fold one parsed line's cast outcome into the tallies. Outcomes with no
    /// named spell (`CastFizzled`/`CastInterrupted` carry `Option<String>`)
    /// can't be attributed to a spell row and are ignored.
    pub fn ingest(&mut self, parsed: &ParsedLine) {
        match &parsed.event {
            Event::CastBegin { caster, spell } => {
                let c = self.name(caster);
                self.row(c, spell.clone()).casts += 1;
            }
            Event::CastFizzled {
                caster,
                spell: Some(spell),
            } => {
                let c = self.name(caster);
                self.row(c, spell.clone()).fizzles += 1;
            }
            Event::CastInterrupted {
                caster,
                spell: Some(spell),
            } => {
                let c = self.name(caster);
                self.row(c, spell.clone()).interrupts += 1;
            }
            Event::Resisted { caster, spell, .. } => {
                let c = self.name(caster);
                self.row(c, spell.clone()).resists += 1;
            }
            _ => {}
        }
    }

    /// All rows, sorted by attempts descending, then caster, then spell — the
    /// busiest spells first, stable across runs.
    pub fn rows(&self) -> Vec<CastRow> {
        let mut out: Vec<CastRow> = self.rows.values().cloned().collect();
        out.sort_by(|a, b| {
            b.attempts()
                .cmp(&a.attempts())
                .then_with(|| a.caster.cmp(&b.caster))
                .then_with(|| a.spell.cmp(&b.spell))
        });
        out
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::LogLine;

    fn pl(event: Event) -> ParsedLine {
        ParsedLine {
            line: LogLine {
                timestamp: 0,
                message: String::new(),
            },
            event,
        }
    }

    fn begin(caster: Entity, spell: &str) -> Event {
        Event::CastBegin {
            caster,
            spell: spell.to_string(),
        }
    }

    #[test]
    fn tallies_and_infers_land_rate() {
        let mut s = CastStats::new("Nyasha");
        for _ in 0..10 {
            s.ingest(&pl(begin(Entity::You, "Shock of Fire")));
        }
        s.ingest(&pl(Event::CastFizzled {
            caster: Entity::You,
            spell: Some("Shock of Fire".to_string()),
        }));
        s.ingest(&pl(Event::CastFizzled {
            caster: Entity::You,
            spell: Some("Shock of Fire".to_string()),
        }));
        s.ingest(&pl(Event::Resisted {
            target: Entity::Named("a kobold".to_string()),
            caster: Entity::You,
            spell: "Shock of Fire".to_string(),
        }));

        let rows = s.rows();
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert_eq!(r.caster, "Nyasha");
        assert_eq!(r.spell, "Shock of Fire");
        assert_eq!(r.casts, 10);
        assert_eq!(r.fizzles, 2);
        assert_eq!(r.resists, 1);
        assert_eq!(r.failures(), 3);
        assert_eq!(r.landed(), 7);
        assert_eq!(r.land_pct(), 70.0);
        assert_eq!(r.fizzle_pct(), 20.0);
        assert_eq!(r.resist_pct(), 10.0);
    }

    #[test]
    fn failure_without_a_begin_still_counts_as_an_attempt() {
        // Catch-up can start mid-cast: a resist with no CastBegin seen. Must
        // not divide by zero or report a nonsensical land rate.
        let mut s = CastStats::new("Nyasha");
        s.ingest(&pl(Event::Resisted {
            target: Entity::Named("a kobold".to_string()),
            caster: Entity::Named("Torvin".to_string()),
            spell: "Mesmerize".to_string(),
        }));
        let r = &s.rows()[0];
        assert_eq!(r.caster, "Torvin");
        assert_eq!(r.casts, 0);
        assert_eq!(r.attempts(), 1);
        assert_eq!(r.landed(), 0);
        assert_eq!(r.land_pct(), 0.0);
        assert_eq!(r.resist_pct(), 100.0);
    }

    #[test]
    fn separates_casters_and_sorts_by_attempts() {
        let mut s = CastStats::new("Nyasha");
        s.ingest(&pl(begin(Entity::You, "Clarity")));
        for _ in 0..3 {
            s.ingest(&pl(begin(Entity::Named("Torvin".to_string()), "Ice Comet")));
        }
        let rows = s.rows();
        assert_eq!(rows.len(), 2);
        // Torvin's 3 attempts sort ahead of Nyasha's 1.
        assert_eq!(rows[0].caster, "Torvin");
        assert_eq!(rows[0].attempts(), 3);
        assert_eq!(rows[1].caster, "Nyasha");
    }

    #[test]
    fn ignores_unnamed_and_unrelated_events() {
        let mut s = CastStats::new("Nyasha");
        s.ingest(&pl(Event::CastFizzled {
            caster: Entity::You,
            spell: None,
        }));
        s.ingest(&pl(Event::Slain {
            victim: Entity::Named("a rat".to_string()),
            killer: None,
        }));
        assert!(s.is_empty());
    }
}
