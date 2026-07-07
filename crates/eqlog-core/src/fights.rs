//! Fight tracker: consumes the [`ParsedLine`] stream, segments fights by NPC
//! target, and aggregates damage/heal/tank tables with pet→owner attribution.
//!
//! Segmentation rules:
//! - A fight is keyed by the NPC target's name. It opens on the first damage
//!   event involving that target: a friendly damaging it, it damaging a
//!   friendly, or (X3) a player-shaped combatant damaging an NPC-shaped target
//!   even before the log owner engages, so a groupmate's opening burst counts.
//! - It closes on `Slain { victim == target }`, or lazily when a later
//!   ingested event's timestamp shows the idle timeout elapsed with no
//!   target-involving events (no wall clock — batch replay works).
//! - Concurrent fights are allowed; the same mob name after a close starts a
//!   brand-new fight.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::events::{Entity, Event, ParsedLine};

/// Combatant row name used for `NonMeleeDamage` with no attributable source
/// landing on an NPC target (e.g. an unowned damage shield).
pub const UNATTRIBUTED: &str = "(unattributed)";

/// Target name used by the overall (all-fights) summary.
pub const OVERALL_TARGET: &str = "(overall)";

/// Case-folded fight key. EQ capitalizes a mob's leading article by sentence
/// position ("A Teir`Dal ranger slashes YOU" vs "You crush a Teir`Dal
/// ranger"), so the raw name would split one encounter into two case-variant
/// fights. Folding the whole name keeps one fight per mob.
fn fight_key(name: &str) -> String {
    name.to_lowercase()
}

/// Display form of a mob name: undo sentence-start capitalization of the
/// leading article ("A Teir`Dal ranger" -> "a Teir`Dal ranger") so a fight
/// opened by an incoming line reports the same name as one opened by an
/// outgoing line.
fn display_name(name: &str) -> String {
    for (capitalized, lower) in [("A ", "a "), ("An ", "an ")] {
        if let Some(rest) = name.strip_prefix(capitalized) {
            return format!("{lower}{rest}");
        }
    }
    name.to_string()
}

/// Source label as it lands in the owner's breakdown: pets fold under their
/// owner, so their sources are suffixed " (pet)" to stay distinguishable.
fn pet_label(label: &str, is_pet: bool) -> String {
    if is_pet {
        format!("{label} (pet)")
    } else {
        label.to_string()
    }
}

/// Player names are a single capitalized word; NPC names carry a leading
/// lowercase article ("a Teir`Dal ranger") or multiple words ("Baron Telyx
/// V`Zher", "Korven Nisere"). Used to keep NPC healers out of the friendly
/// healing meter.
fn looks_like_player_name(name: &str) -> bool {
    !name.contains(' ') && name.chars().next().is_some_and(char::is_uppercase)
}

/// Configuration for a [`FightTracker`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FightConfig {
    /// The player character's name; `Entity::You` resolves to this.
    pub character_name: String,
    /// Explicit pet → owner mapping, e.g. `"Vibarn" -> "Nyasha"`.
    pub pet_owners: HashMap<String, String>,
    /// A fight closes when this many seconds pass (per event timestamps)
    /// with no events involving its target. Default 12.
    pub idle_timeout_secs: u64,
    /// When true (default), entity names of the form ``X`s warder`` or
    /// ``X`s pet`` (backtick possessive) attribute to `X`.
    pub auto_attribute_possessive_pets: bool,
}

impl FightConfig {
    pub fn new(character_name: impl Into<String>) -> Self {
        FightConfig {
            character_name: character_name.into(),
            pet_owners: HashMap::new(),
            idle_timeout_secs: 12,
            auto_attribute_possessive_pets: true,
        }
    }
}

impl Default for FightConfig {
    fn default() -> Self {
        Self::new("")
    }
}

/// One damage source's aggregated line inside a combatant row: keyed by the
/// melee verb ("crush"), spell name ("Lifespike"), or damage-shield effect
/// ("frost (damage shield)"). A pet's sources fold under its owner with a
/// " (pet)" suffix when attribution is on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SourceRow {
    pub name: String,
    /// Total damage dealt via this source.
    pub total: u64,
    /// Number of successful hits via this source.
    pub hits: u64,
    /// Number of critical hits via this source.
    pub crits: u64,
    /// Largest single hit via this source.
    pub max_hit: u64,
    /// Failed melee attempts on this source (miss/dodge/parry/…), keyed by the
    /// same verb label as the hits. Zero for spells and damage shields.
    /// Additive: summaries persisted before this field default to 0.
    #[serde(default)]
    pub misses: u64,
    /// Number of times this source was cast (spells only): every `CastBegin`
    /// during an open fight, keyed by spell name — so a cast that dealt no
    /// damage (resist, debuff, heal) still surfaces. Zero for melee/DS.
    /// Additive: summaries persisted before this field default to 0.
    #[serde(default)]
    pub casts: u64,
}

/// One combatant's aggregated line in a fight (or in the overall summary).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CombatantRow {
    /// Attributed name (pets fold into their owner when attribution is on).
    pub name: String,
    /// Total damage dealt to the fight target (melee + spell + non-melee).
    pub damage: u64,
    /// Portion of `damage` contributed by this combatant's pets.
    pub pet_damage: u64,
    /// Number of successful damaging hits (melee, spell, non-melee).
    pub hits: u64,
    /// Number of failed melee attempts (miss/dodge/parry/…).
    pub misses: u64,
    /// Number of critical hits.
    pub crits: u64,
    /// Largest single hit.
    pub max_hit: u64,
    /// Damage received from the fight target (pets fold into owner).
    pub damage_taken: u64,
    /// Actual healing done while this fight was the active one.
    pub healing: u64,
    /// Potential-minus-actual healing, when overheal syntax was present.
    pub overheal: u64,
    /// `damage / max(1, last_event_ts - first_event_ts)` within the fight.
    pub dps: f64,
    /// This row's share of the fight's total damage, in percent (0–100).
    pub percent: f64,
    /// Per-source damage breakdown, sorted by total descending. Additive:
    /// summaries persisted before this field exist without it (default
    /// empty).
    #[serde(default)]
    pub sources: Vec<SourceRow>,
}

/// A serializable snapshot of one fight (or of the overall aggregate).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FightSummary {
    /// NPC target name ([`OVERALL_TARGET`] for the overall summary).
    pub target: String,
    /// Timestamp of the first event of the fight (Unix seconds).
    pub start_ts: i64,
    /// Timestamp of the closing event (Slain / last activity on timeout).
    pub end_ts: i64,
    /// `end_ts - start_ts`, saturating at zero.
    pub duration_secs: u64,
    /// Sum of all combatants' damage to the target.
    pub total_damage: u64,
    /// Whether the fight ended with the target slain.
    pub target_slain: bool,
    /// Combatant rows, sorted by damage descending.
    pub rows: Vec<CombatantRow>,
}

/// Running totals for one damage source of one combatant.
#[derive(Debug, Clone, Default)]
struct SourceAgg {
    total: u64,
    hits: u64,
    crits: u64,
    max_hit: u64,
    misses: u64,
    casts: u64,
}

/// Per-combatant running totals inside an open fight.
#[derive(Debug, Clone, Default)]
struct Combatant {
    damage: u64,
    pet_damage: u64,
    hits: u64,
    misses: u64,
    crits: u64,
    max_hit: u64,
    damage_taken: u64,
    healing: u64,
    overheal: u64,
    first_ts: i64,
    last_ts: i64,
    seen: bool,
    /// Damage keyed by source label (melee verb / spell / DS effect).
    sources: HashMap<String, SourceAgg>,
}

impl Combatant {
    fn touch(&mut self, ts: i64) {
        if !self.seen {
            self.seen = true;
            self.first_ts = ts;
            self.last_ts = ts;
        } else {
            self.first_ts = self.first_ts.min(ts);
            self.last_ts = self.last_ts.max(ts);
        }
    }

    /// `window_secs` is the ENCOUNTER window (fight start→end), shared by every
    /// combatant — not each combatant's own first→last-hit span. Dividing by a
    /// personal span inflated burst casters (2 nukes 3 s apart read as if the
    /// whole fight lasted 3 s) and made a combatant's DPS jump when a single
    /// fight got merged into a pull (merge_pull already divides by the pull
    /// window). One denominator keeps per-row DPS believable and summable.
    fn to_row(&self, name: &str, total_damage: u64, window_secs: f64) -> CombatantRow {
        let percent = if total_damage > 0 {
            self.damage as f64 * 100.0 / total_damage as f64
        } else {
            0.0
        };
        let mut sources: Vec<SourceRow> = self
            .sources
            .iter()
            .map(|(label, s)| SourceRow {
                name: label.clone(),
                total: s.total,
                hits: s.hits,
                crits: s.crits,
                max_hit: s.max_hit,
                misses: s.misses,
                casts: s.casts,
            })
            .collect();
        sources.sort_by(|a, b| b.total.cmp(&a.total).then_with(|| a.name.cmp(&b.name)));
        CombatantRow {
            name: name.to_string(),
            damage: self.damage,
            pet_damage: self.pet_damage,
            hits: self.hits,
            misses: self.misses,
            crits: self.crits,
            max_hit: self.max_hit,
            damage_taken: self.damage_taken,
            healing: self.healing,
            overheal: self.overheal,
            dps: self.damage as f64 / window_secs,
            percent,
            sources,
        }
    }
}

/// An open (or overall) fight aggregate.
#[derive(Debug, Clone)]
struct Fight {
    target: String,
    start_ts: i64,
    /// Timestamp of the last event involving the target — drives the idle
    /// timeout and becomes `end_ts` on timeout close. Heals do not extend it.
    last_activity: i64,
    target_slain: bool,
    combatants: HashMap<String, Combatant>,
}

impl Fight {
    fn new(target: String, ts: i64) -> Self {
        Fight {
            target,
            start_ts: ts,
            last_activity: ts,
            target_slain: false,
            combatants: HashMap::new(),
        }
    }

    fn row(&mut self, name: &str) -> &mut Combatant {
        self.combatants.entry(name.to_string()).or_default()
    }

    fn dealt(&mut self, name: &str, is_pet: bool, source: &str, amount: u64, crit: bool, ts: i64) {
        let c = self.row(name);
        c.touch(ts);
        c.damage += amount;
        if is_pet {
            c.pet_damage += amount;
        }
        c.hits += 1;
        if crit {
            c.crits += 1;
        }
        c.max_hit = c.max_hit.max(amount);
        let s = c.sources.entry(source.to_string()).or_default();
        s.total += amount;
        s.hits += 1;
        if crit {
            s.crits += 1;
        }
        s.max_hit = s.max_hit.max(amount);
        self.last_activity = self.last_activity.max(ts);
    }

    fn missed(&mut self, name: &str, source: &str, ts: i64) {
        let c = self.row(name);
        c.touch(ts);
        c.misses += 1;
        // Per-source miss, keyed by the same verb label the hit path uses so
        // hits and misses land on one row (drives the Acc% column).
        c.sources.entry(source.to_string()).or_default().misses += 1;
        self.last_activity = self.last_activity.max(ts);
    }

    fn casted(&mut self, name: &str, source: &str, ts: i64) {
        let c = self.row(name);
        c.touch(ts);
        // Bind the source lazily (a cast with no damage still shows) and bump
        // its cast count. Like heals, a cast is not an event "involving the
        // target", so it must not extend the idle timeout.
        c.sources.entry(source.to_string()).or_default().casts += 1;
    }

    fn taken(&mut self, name: &str, amount: u64, ts: i64) {
        let c = self.row(name);
        c.touch(ts);
        c.damage_taken += amount;
        self.last_activity = self.last_activity.max(ts);
    }

    fn healed(&mut self, name: &str, amount: u64, potential: Option<u64>, ts: i64) {
        let c = self.row(name);
        c.touch(ts);
        c.healing += amount;
        if let Some(p) = potential {
            c.overheal += p.saturating_sub(amount);
        }
        // Deliberately does not bump last_activity: heals are not events
        // "involving the target", so they must not extend the idle timeout.
    }

    fn summary(&self, end_ts: i64) -> FightSummary {
        let total_damage: u64 = self.combatants.values().map(|c| c.damage).sum();
        // Shared encounter window for every combatant's DPS (see to_row).
        let window = (end_ts - self.start_ts).max(1) as f64;
        let mut rows: Vec<CombatantRow> = self
            .combatants
            .iter()
            .map(|(name, c)| c.to_row(name, total_damage, window))
            .collect();
        rows.sort_by(|a, b| b.damage.cmp(&a.damage).then_with(|| a.name.cmp(&b.name)));
        FightSummary {
            target: self.target.clone(),
            start_ts: self.start_ts,
            end_ts,
            duration_secs: (end_ts - self.start_ts).max(0) as u64,
            total_damage,
            target_slain: self.target_slain,
            rows,
        }
    }
}

/// Streaming fight tracker. Feed it every [`ParsedLine`]; poll
/// [`FightTracker::active_fights`], drain [`FightTracker::completed_fights`],
/// and read [`FightTracker::overall_summary`] for the cross-fight aggregate.
pub struct FightTracker {
    config: FightConfig,
    /// Open fights keyed by NPC target name (one open fight per name).
    active: HashMap<String, Fight>,
    completed: Vec<FightSummary>,
    overall: Fight,
    overall_seen: bool,
    /// Fight-key → timestamp a target was last slain. Guards the X3
    /// any-combatant open path: trailing DoT/DS ticks landing on a corpse in
    /// the same instant must not spawn a groupmate "fight" against the dead
    /// mob. Pruned to the idle window. The friendly re-engage path is not
    /// guarded, so a respawn the owner pulls still opens a fresh fight.
    recently_slain: HashMap<String, i64>,
}

impl FightTracker {
    pub fn new(config: FightConfig) -> Self {
        FightTracker {
            config,
            active: HashMap::new(),
            completed: Vec::new(),
            overall: Fight::new(OVERALL_TARGET.to_string(), 0),
            overall_seen: false,
            recently_slain: HashMap::new(),
        }
    }

    pub fn config(&self) -> &FightConfig {
        &self.config
    }

    /// Ingest one parsed line, expiring idle fights first (evaluated from the
    /// event timestamp, never the wall clock).
    pub fn ingest(&mut self, parsed: &ParsedLine) {
        let ts = parsed.line.timestamp;
        self.expire_idle(ts);

        match &parsed.event {
            Event::MeleeHit {
                attacker,
                target,
                verb,
                amount,
                flags,
            } => self.damage(Some(attacker), target, *amount, flags.critical, ts, verb),
            Event::SpellDamage {
                caster,
                target,
                amount,
                spell,
                flags,
            } => self.damage(
                Some(caster),
                target,
                *amount,
                flags.critical,
                ts,
                spell.as_deref().unwrap_or("(spell)"),
            ),
            Event::SpellDamageTaken {
                target,
                source,
                spell,
                amount,
            } => self.damage(Some(source), target, *amount, false, ts, spell),
            Event::NonMeleeDamage {
                source,
                target,
                effect,
                amount,
            } => {
                // Damage-shield / proc effects get a disambiguating suffix so
                // "frost (damage shield)" never merges with a "Frost" spell.
                let label = format!("{effect} (damage shield)");
                self.damage(source.as_ref(), target, *amount, false, ts, &label)
            }
            Event::MeleeMiss {
                attacker,
                target,
                verb,
                ..
            } => self.miss(attacker, target, verb, ts),
            Event::CastBegin { caster, spell } => self.cast(caster, spell, ts),
            Event::Heal {
                healer,
                target,
                amount,
                potential,
                ..
            } => self.heal(healer, target, *amount, *potential, ts),
            Event::Slain { victim, .. } => self.slain(victim, ts),
            _ => {}
        }
    }

    /// Snapshots of all currently open fights, start-time ascending.
    /// `end_ts` is the last target activity seen so far.
    pub fn active_fights(&self) -> Vec<FightSummary> {
        let mut fights: Vec<FightSummary> = self
            .active
            .values()
            .map(|f| f.summary(f.last_activity))
            .collect();
        fights.sort_by(|a, b| {
            a.start_ts
                .cmp(&b.start_ts)
                .then_with(|| a.target.cmp(&b.target))
        });
        fights
    }

    /// Drains and returns fights closed since the last call, in close order.
    pub fn completed_fights(&mut self) -> Vec<FightSummary> {
        std::mem::take(&mut self.completed)
    }

    /// Aggregate across every fight ever ingested (including drained ones).
    pub fn overall_summary(&self) -> FightSummary {
        self.overall.summary(self.overall.last_activity)
    }

    /// Force-close every open fight (e.g. at end of a batch replay). The
    /// closed fights land in the completed queue.
    pub fn close_all(&mut self) {
        let mut fights: Vec<Fight> = self.active.drain().map(|(_, f)| f).collect();
        fights.sort_by(|a, b| {
            a.last_activity
                .cmp(&b.last_activity)
                .then_with(|| a.target.cmp(&b.target))
        });
        for f in fights {
            let end = f.last_activity;
            self.completed.push(f.summary(end));
        }
    }

    // ---- internals -------------------------------------------------------

    fn expire_idle(&mut self, now_ts: i64) {
        let timeout = self.config.idle_timeout_secs as i64;
        // Drop stale slain markers so the guard map stays bounded.
        self.recently_slain
            .retain(|_, &mut slain_ts| now_ts - slain_ts <= timeout);
        let expired: Vec<String> = self
            .active
            .iter()
            .filter(|(_, f)| now_ts - f.last_activity > timeout)
            .map(|(k, _)| k.clone())
            .collect();
        let mut closed: Vec<Fight> = expired
            .into_iter()
            .filter_map(|k| self.active.remove(&k))
            .collect();
        closed.sort_by(|a, b| {
            a.last_activity
                .cmp(&b.last_activity)
                .then_with(|| a.target.cmp(&b.target))
        });
        for f in closed {
            let end = f.last_activity;
            self.completed.push(f.summary(end));
        }
    }

    fn entity_name<'a>(&'a self, e: &'a Entity) -> &'a str {
        e.name(&self.config.character_name)
    }

    /// Owner name for a backtick-possessive pet ("X`s warder" / "X`s pet").
    fn possessive_owner<'a>(&self, name: &'a str) -> Option<&'a str> {
        if !self.config.auto_attribute_possessive_pets {
            return None;
        }
        name.strip_suffix("`s warder")
            .or_else(|| name.strip_suffix("`s pet"))
            .filter(|owner| !owner.is_empty())
    }

    fn is_friendly(&self, e: &Entity) -> bool {
        match e {
            Entity::You => true,
            Entity::Named(n) => {
                n == &self.config.character_name
                    || self.config.pet_owners.contains_key(n)
                    || self.config.pet_owners.values().any(|owner| owner == n)
                    || self.possessive_owner(n).is_some()
            }
        }
    }

    /// Resolve an entity to its attributed combatant name; `true` when the
    /// entity was a pet folded into its owner.
    fn attribute(&self, e: &Entity) -> (String, bool) {
        let name = self.entity_name(e);
        if let Some(owner) = self.config.pet_owners.get(name) {
            return (owner.clone(), true);
        }
        if let Some(owner) = self.possessive_owner(name) {
            return (owner.to_string(), true);
        }
        (name.to_string(), false)
    }

    fn open_or_get(&mut self, target: &str, ts: i64) -> &mut Fight {
        let fight = self
            .active
            .entry(fight_key(target))
            .or_insert_with(|| Fight::new(display_name(target), ts));
        // Prefer a mid-sentence (lowercase-lead) form as the display name
        // for casing differences beyond the leading article.
        if fight.target != target && target.starts_with(char::is_lowercase) {
            fight.target = target.to_string();
        }
        fight
    }

    fn track_overall(&mut self, ts: i64) {
        if !self.overall_seen {
            self.overall_seen = true;
            self.overall.start_ts = ts;
            self.overall.last_activity = ts;
        } else {
            self.overall.start_ts = self.overall.start_ts.min(ts);
            self.overall.last_activity = self.overall.last_activity.max(ts);
        }
    }

    fn damage(
        &mut self,
        source: Option<&Entity>,
        target: &Entity,
        amount: u64,
        crit: bool,
        ts: i64,
        source_label: &str,
    ) {
        let src_friendly = source.is_some_and(|s| self.is_friendly(s));
        let tgt_friendly = self.is_friendly(target);

        if src_friendly && !tgt_friendly {
            // A friendly damaged something: that something is an NPC target.
            let npc = self.entity_name(target).to_string();
            let (name, is_pet) = self.attribute(source.expect("friendly source present"));
            // Pet damage folds under the owner; its sources carry a "(pet)"
            // suffix so "claw (pet)" stays distinct from the owner's rows.
            let label = pet_label(source_label, is_pet);
            self.open_or_get(&npc, ts)
                .dealt(&name, is_pet, &label, amount, crit, ts);
            self.overall.dealt(&name, is_pet, &label, amount, crit, ts);
            self.track_overall(ts);
        } else if tgt_friendly && !src_friendly {
            // An NPC damaged a friendly: damage-taken in that NPC's fight.
            let (name, _) = self.attribute(target);
            match source {
                Some(src) => {
                    let npc = self.entity_name(src).to_string();
                    self.open_or_get(&npc, ts).taken(&name, amount, ts);
                }
                None => {
                    // Unattributed incoming ("Vibarn has taken 58 damage by
                    // Searing Arrow."): no caster to key a fight by, so the
                    // damage lands in the most recently active fight (if
                    // any) and always in the overall aggregate.
                    if let Some(fight) = self.active.values_mut().max_by_key(|f| f.last_activity) {
                        fight.taken(&name, amount, ts);
                    }
                }
            }
            self.overall.taken(&name, amount, ts);
            self.track_overall(ts);
        } else if !src_friendly && !tgt_friendly {
            // Neither side is a known friendly. Route only through fights we
            // already know about, so unknown-vs-unknown noise is dropped.
            let target_name = self.entity_name(target).to_string();
            if self.active.contains_key(&fight_key(&target_name)) {
                // Someone (another player, or an unattributed effect) hit an
                // NPC we are fighting.
                let (name, is_pet) = match source {
                    Some(s) => self.attribute(s),
                    None => (UNATTRIBUTED.to_string(), false),
                };
                let label = pet_label(source_label, is_pet);
                self.open_or_get(&target_name, ts)
                    .dealt(&name, is_pet, &label, amount, crit, ts);
                self.overall.dealt(&name, is_pet, &label, amount, crit, ts);
                self.track_overall(ts);
            } else if let Some(src) = source {
                let src_name = self.entity_name(src).to_string();
                if self.active.contains_key(&fight_key(&src_name)) {
                    // An NPC we are fighting hit a non-friendly (e.g. an
                    // out-of-group player): still useful tanking data.
                    let (name, _) = self.attribute(target);
                    self.open_or_get(&src_name, ts).taken(&name, amount, ts);
                    self.overall.taken(&name, amount, ts);
                    self.track_overall(ts);
                } else if looks_like_player_name(&src_name)
                    && !looks_like_player_name(&target_name)
                    && !self.recently_slain.contains_key(&fight_key(&target_name))
                {
                    // X3 (raid-meter bias): a groupmate opened on a fresh NPC
                    // before the log owner engaged. Open the fight so their
                    // burst is credited instead of silently dropped. Guarded
                    // to a player-shaped source hitting an NPC-shaped target,
                    // so player-vs-player duels (target is a player name) and
                    // mob-vs-mob noise (source is a mob name) never spawn one.
                    let (name, is_pet) = self.attribute(src);
                    let label = pet_label(source_label, is_pet);
                    self.open_or_get(&target_name, ts)
                        .dealt(&name, is_pet, &label, amount, crit, ts);
                    self.overall.dealt(&name, is_pet, &label, amount, crit, ts);
                    self.track_overall(ts);
                }
            }
        }
        // friendly-vs-friendly (duels, self-damage): ignored.
    }

    fn miss(&mut self, attacker: &Entity, target: &Entity, verb: &str, ts: i64) {
        // Misses never open fights (no damage), but they count and keep an
        // existing fight's target alive.
        if self.is_friendly(attacker) && !self.is_friendly(target) {
            let npc = fight_key(self.entity_name(target));
            let (name, is_pet) = self.attribute(attacker);
            // Same label the hit path uses so hits/misses share a source row.
            let label = pet_label(verb, is_pet);
            if let Some(fight) = self.active.get_mut(&npc) {
                fight.missed(&name, &label, ts);
                self.overall.missed(&name, &label, ts);
                self.track_overall(ts);
            }
        } else if self.is_friendly(target) {
            // The NPC swung at a friendly and missed: target activity only.
            let npc = fight_key(self.entity_name(attacker));
            if let Some(fight) = self.active.get_mut(&npc) {
                fight.last_activity = fight.last_activity.max(ts);
            }
        }
    }

    /// Count a spell cast against the caster's source row (keyed by spell
    /// name) in the most-recently-active fight — the same fight heals attach
    /// to. Only inside an open fight, and never from an enemy (an NPC we're
    /// fighting, or any NPC-shaped name) so enemy casts don't pollute a
    /// friendly combatant's breakdown.
    fn cast(&mut self, caster: &Entity, spell: &str, ts: i64) {
        if self.active.is_empty() {
            return;
        }
        if !self.is_friendly(caster) {
            let caster_name = self.entity_name(caster);
            if self.active.contains_key(&fight_key(caster_name)) {
                return; // an NPC we are fighting
            }
            if !looks_like_player_name(caster_name) {
                return; // NPC-shaped name
            }
        }
        let (name, is_pet) = self.attribute(caster);
        let label = pet_label(spell, is_pet);
        if let Some(fight) = self
            .active
            .values_mut()
            .max_by(|a, b| a.last_activity.cmp(&b.last_activity))
        {
            fight.casted(&name, &label, ts);
            self.overall.casted(&name, &label, ts);
            self.track_overall(ts);
        }
    }

    fn heal(
        &mut self,
        healer: &Entity,
        target: &Entity,
        amount: u64,
        potential: Option<u64>,
        ts: i64,
    ) {
        // Count heals from friendlies and from other players (e.g.
        // out-of-group healers), never from NPCs: an enemy healer must not
        // inflate the friendly HPS meter.
        if !self.is_friendly(healer) {
            let healer_name = self.entity_name(healer);
            if self.active.contains_key(&fight_key(healer_name)) {
                return; // an NPC we are fighting (mob self-heal)
            }
            if !looks_like_player_name(healer_name) {
                return; // NPC-shaped name: leading article or multiple words
            }
        }
        // Healing done TO an enemy target never counts, whoever cast it.
        if self
            .active
            .contains_key(&fight_key(self.entity_name(target)))
        {
            return;
        }
        let (name, _) = self.attribute(healer);
        // Attribute the heal to the most recently active fight.
        if let Some(fight) = self
            .active
            .values_mut()
            .max_by(|a, b| a.last_activity.cmp(&b.last_activity))
        {
            fight.healed(&name, amount, potential, ts);
            self.overall.healed(&name, amount, potential, ts);
            self.track_overall(ts);
        }
    }

    fn slain(&mut self, victim: &Entity, ts: i64) {
        let name = fight_key(self.entity_name(victim));
        if let Some(mut fight) = self.active.remove(&name) {
            fight.target_slain = true;
            fight.last_activity = fight.last_activity.max(ts);
            let end = fight.last_activity;
            self.completed.push(fight.summary(end));
            // Remember the kill so trailing corpse ticks from a groupmate do
            // not re-open the encounter as a fresh fight (X3 noise guard).
            self.recently_slain.insert(name, ts);
        }
    }
}
