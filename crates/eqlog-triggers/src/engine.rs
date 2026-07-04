//! Trigger matching engine. Runs on every parsed log line: a `RegexSet`
//! fast-reject pass over all enabled patterns, then per-trigger `Regex`
//! capture extraction for the (rare) matches. Timers are driven purely by
//! line timestamps so replayed logs behave identically to live tailing.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::OnceLock;

use regex::{Captures, Regex, RegexSet};

use crate::model::{
    duration_ticks_at_level, infer_timer_lane, Action, ChannelOverride, CharacterProfile,
    TimerLane, Trigger,
};
use crate::profile::effective_enabled;
use eqlog_core::events::{Entity, Event, ParsedLine};

/// Host-implemented sink that performs actions (TTS, sound, overlay text).
pub trait ActionSink {
    fn speak(&mut self, text: &str);
    fn play_sound(&mut self, path: &str);
    fn display_text(&mut self, text: &str);
    /// A countdown began. `lane` is the resolved overlay lane (the action's
    /// explicit lane, else inferred from the trigger's category/id).
    /// `pending_secs` is the cast-time lead-in: the first `pending_secs`
    /// seconds of the countdown are a "casting…" phase (the effect does not
    /// exist yet); a [`TimerFireKind::Landed`] fire marks the flip to a real
    /// running timer. `0` = starts landed.
    fn start_timer(
        &mut self,
        name: &str,
        duration_secs: u64,
        warn_at_secs: Option<u64>,
        lane: TimerLane,
        pending_secs: u64,
    );
    /// A `CancelTimer` action fired: any timer with this (already-expanded)
    /// name was removed. Default no-op so existing sinks keep compiling.
    fn cancel_timer(&mut self, name: &str) {
        let _ = name;
    }
}

/// Why a timer fired.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimerFireKind {
    /// The cast-time lead-in elapsed: the pending ("casting…") phase is over
    /// and the effect now actually exists. Emitted once, only for timers
    /// started with a non-zero `pending_secs`.
    Landed,
    /// The "ending soon" warning threshold was crossed.
    Warn,
    /// The timer reached its expiry.
    Expire,
}

/// A timer event returned from [`TriggerEngine::due`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimerFire {
    pub name: String,
    pub kind: TimerFireKind,
    /// Overlay lane of the timer that fired (see [`TimerLane`]).
    pub lane: TimerLane,
}

/// Identity of a trigger that fired on a line, returned by
/// [`TriggerEngine::process_traced`] so replay tools (e.g. the CLI spam
/// auditor) can attribute fires to triggers and categories.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TriggerFireInfo {
    /// The trigger's effective id (see [`Trigger::effective_id`]).
    pub id: String,
    pub name: String,
    pub category: Option<String>,
}

struct ActiveTimer {
    name: String,
    expires_at: i64,
    warn_at: Option<i64>,
    warned: bool,
    lane: TimerLane,
    /// When the cast completes and the pending phase ends; `None` once
    /// landed (or when the timer never had a cast-time lead-in).
    lands_at: Option<i64>,
}

struct CompiledTrigger {
    trigger: Trigger,
    regex: Regex,
    /// Fire-dedupe group: triggers with an identical expanded pattern share a
    /// key, and at most one of them fires per line (the first).
    dedupe_key: usize,
}

pub struct TriggerEngine {
    character: String,
    /// Fast-reject set over all compiled patterns. `None` when the combined
    /// set failed to build (e.g. the cumulative compiled-size limit on huge
    /// imports) — every trigger's own regex is consulted per line instead,
    /// so triggers keep firing, just without the fast-reject pass.
    set: Option<RegexSet>,
    compiled: Vec<CompiledTrigger>,
    timers: Vec<ActiveTimer>,
    warnings: Vec<String>,
    /// Extra friendly caster names (lowercased), e.g. configured pet names.
    /// The character's own possessive pets ("<char>'s pet", "<char>`s
    /// warder") are recognized automatically.
    friendly: Vec<String>,
    /// Line-timestamp of each compiled trigger's last fire (parallel to
    /// `compiled`), for the per-trigger refire cooldown. Resets on reload.
    last_fired: Vec<Option<i64>>,
}

/// Expand GINA-style tokens in a trigger *pattern* before regex compilation:
/// `{C}` becomes the (regex-escaped) character name; `{S}`/`{S1}`/… become
/// `(?P<S1>.+)` named wildcards; `{N}`/`{N2}`/… become `(?P<N2>\d+)`. Tokens
/// are case-insensitive (`{c}`, `{s1}` also work); a repeated token expands
/// to a non-capturing wildcard so the pattern still compiles.
pub fn expand_pattern(pattern: &str, character: &str) -> String {
    // Tokens: {C}, {S}, {S<digits>}, {N}, {N<digits>}, any case.
    static TOKEN: &str = r"\{([CcSsNn]\d*)\}";
    let token_re = Regex::new(TOKEN).expect("token regex is valid");
    let mut seen: HashSet<String> = HashSet::new();
    token_re
        .replace_all(pattern, |caps: &Captures| {
            let raw = &caps[1];
            let upper = raw.to_ascii_uppercase();
            match upper.as_bytes()[0] {
                b'C' => regex::escape(character),
                b'S' => {
                    if seen.insert(upper.clone()) {
                        format!("(?P<{upper}>.+)")
                    } else {
                        "(?:.+)".to_string()
                    }
                }
                _ => {
                    if seen.insert(upper.clone()) {
                        format!(r"(?P<{upper}>\d+)")
                    } else {
                        r"(?:\d+)".to_string()
                    }
                }
            }
        })
        .into_owned()
}

/// True when `name` is `base` itself or a numbered instance of it —
/// `"{base} (2)"`, `"{base} (3)"`, … (see multi-instance DoT binding in
/// [`TriggerEngine`]).
///
/// Comparison is ASCII-case-insensitive: the log renders the same mob name
/// with different capitalization by sentence position ("A hill giant has
/// taken…" binding at line start vs "You have slain a hill giant!" /
/// "…worn off of a hill giant." mid-sentence), so exact matching left DoT
/// bars running after article-named mobs died.
fn is_instance_of(name: &str, base: &str) -> bool {
    if name.eq_ignore_ascii_case(base) {
        return true;
    }
    if name.len() <= base.len() || !name.is_char_boundary(base.len()) {
        return false;
    }
    let (head, rest) = name.split_at(base.len());
    head.eq_ignore_ascii_case(base)
        && rest
            .strip_prefix(" (")
            .and_then(|r| r.strip_suffix(')'))
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// ASCII-case-insensitive `ends_with` (same log-casing rationale as
/// [`is_instance_of`]).
fn ends_with_ci(haystack: &str, suffix: &str) -> bool {
    haystack.len() >= suffix.len()
        && haystack.is_char_boundary(haystack.len() - suffix.len())
        && haystack[haystack.len() - suffix.len()..].eq_ignore_ascii_case(suffix)
}

/// Lazily-built lookup of buff spell name → its land-on-other message suffix
/// (from the generated [`crate::buff_lands::BUFF_LAND_SUFFIXES`] table).
fn buff_land_map() -> &'static HashMap<&'static str, &'static str> {
    static MAP: OnceLock<HashMap<&'static str, &'static str>> = OnceLock::new();
    MAP.get_or_init(|| {
        crate::buff_lands::BUFF_LAND_SUFFIXES
            .iter()
            .copied()
            .collect()
    })
}

/// Strip a trailing `" (n)"` instance suffix, returning the family base
/// name; names without one are returned unchanged.
fn instance_base(name: &str) -> &str {
    if let Some(open) = name.rfind(" (") {
        if let Some(digits) = name[open + 2..].strip_suffix(')') {
            if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
                return &name[..open];
            }
        }
    }
    name
}

/// The lowest free instance name for `base` among `timers`: `base` when no
/// timer holds it, else `"{base} (2)"`, `"{base} (3)"`, … — first gap wins.
fn next_instance_name(timers: &[ActiveTimer], base: &str) -> String {
    if !timers.iter().any(|t| t.name == base) {
        return base.to_string();
    }
    let mut n: u32 = 2;
    loop {
        let candidate = format!("{base} ({n})");
        if !timers.iter().any(|t| t.name == candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// Layer a [`ChannelOverride`] onto a trigger's actions in place: force the
/// Speak (TTS) and/or DisplayText (alert) channels on or off. `None` for a
/// channel leaves that channel exactly as the trigger defines it. Enabling a
/// missing channel synthesizes a default template (the trigger name, lower-
/// cased for speech); disabling removes every action of that kind. This is how
/// the Triggers-tab TTS/Alert chips reconfigure even read-only bundled
/// triggers without editing the pack file.
pub fn apply_channel_override(t: &mut Trigger, ov: &ChannelOverride) {
    if let Some(speak) = ov.speak {
        let has = t.actions.iter().any(|a| matches!(a, Action::Speak { .. }));
        if speak && !has {
            t.actions.push(Action::Speak {
                template: t.name.to_lowercase(),
            });
        } else if !speak && has {
            t.actions.retain(|a| !matches!(a, Action::Speak { .. }));
        }
    }
    if let Some(alert) = ov.alert {
        let has = t
            .actions
            .iter()
            .any(|a| matches!(a, Action::DisplayText { .. }));
        if alert && !has {
            t.actions.push(Action::DisplayText {
                template: t.name.clone(),
            });
        } else if !alert && has {
            t.actions
                .retain(|a| !matches!(a, Action::DisplayText { .. }));
        }
    }
}

/// Expand an action *template* after a match: `${1}` positional captures,
/// `${name}` named captures, `{C}` character name, `{TS}` the line's
/// timestamp as `HH:MM:SS`. Unknown/unmatched references expand to "".
fn expand_template(template: &str, caps: &Captures, character: &str, timestamp: i64) -> String {
    let mut out = String::with_capacity(template.len());
    let bytes = template.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let rest = &template[i..];
        if rest.starts_with("${") {
            if let Some(close) = rest.find('}') {
                let key = &rest[2..close];
                if !key.is_empty() {
                    let value = if key.chars().all(|c| c.is_ascii_digit()) {
                        key.parse::<usize>()
                            .ok()
                            .and_then(|n| caps.get(n))
                            .map(|m| m.as_str())
                    } else {
                        caps.name(key)
                            .map(|m| m.as_str())
                            // GINA templates reference {S1} tokens by their
                            // lowercase form too.
                            .or_else(|| caps.name(&key.to_ascii_uppercase()).map(|m| m.as_str()))
                    };
                    out.push_str(value.unwrap_or(""));
                    i += close + 1;
                    continue;
                }
            }
        } else if rest.starts_with("{C}") || rest.starts_with("{c}") {
            out.push_str(character);
            i += 3;
            continue;
        } else if rest.starts_with("{TS}") || rest.starts_with("{ts}") {
            let secs = timestamp.rem_euclid(86_400);
            out.push_str(&format!(
                "{:02}:{:02}:{:02}",
                secs / 3600,
                (secs / 60) % 60,
                secs % 60
            ));
            i += 4;
            continue;
        }
        // Advance one full UTF-8 character.
        let ch = rest.chars().next().expect("in-bounds");
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Rescale every `StartTimer` action that carries duration-formula metadata
/// to `level`: `duration_secs` becomes the formula's tick count at that level
/// (1 tick = 6 s, clamped to the cap), and the warning lead is clamped to the
/// generator's policy ceiling of 15% of the new duration so short low-level
/// buffs don't warn the moment they start. Actions without metadata (curated
/// hand-tuned or GINA timers) are left untouched, as is the baked duration
/// when the formula yields zero ticks at this level.
fn scale_timer_durations(trigger: &mut Trigger, level: u32) {
    for action in &mut trigger.actions {
        if let Action::StartTimer {
            duration_secs,
            warn_at_secs,
            duration_formula: Some(formula),
            duration_cap_ticks,
            ..
        } = action
        {
            let ticks = duration_ticks_at_level(*formula, duration_cap_ticks.unwrap_or(0), level);
            let secs = u64::from(ticks) * 6;
            if secs == 0 {
                continue;
            }
            *duration_secs = secs;
            *warn_at_secs = warn_at_secs
                .map(|w| w.min(secs * 15 / 100))
                .filter(|w| *w > 0);
        }
    }
}

impl TriggerEngine {
    /// Compile `triggers` for `character_name`. Disabled triggers are
    /// skipped; triggers whose pattern fails to compile are skipped with a
    /// warning (see [`TriggerEngine::warnings`]).
    pub fn new(triggers: Vec<Trigger>, character_name: &str) -> Self {
        let mut compiled = Vec::new();
        let mut patterns = Vec::new();
        let mut warnings = Vec::new();
        let mut dedupe_keys: HashMap<String, usize> = HashMap::new();
        for trigger in triggers.into_iter().filter(|t| t.enabled) {
            let mut expanded = expand_pattern(&trigger.pattern, character_name);
            if trigger.case_insensitive {
                expanded = format!("(?i){expanded}");
            }
            match Regex::new(&expanded) {
                Ok(regex) => {
                    let next_key = dedupe_keys.len();
                    let dedupe_key = *dedupe_keys.entry(expanded.clone()).or_insert(next_key);
                    patterns.push(expanded);
                    compiled.push(CompiledTrigger {
                        trigger,
                        regex,
                        dedupe_key,
                    });
                }
                Err(e) => warnings.push(format!(
                    "trigger '{}' skipped: pattern failed to compile: {e}",
                    trigger.name
                )),
            }
        }
        // Every pattern compiled individually, but the combined set can
        // still fail (its size limit is cumulative). Never disable matching
        // silently: warn and fall back to per-trigger matching.
        let set = match RegexSet::new(&patterns) {
            Ok(set) => Some(set),
            Err(e) => {
                warnings.push(format!(
                    "fast-reject set failed to build ({e}); \
                     falling back to per-trigger matching"
                ));
                None
            }
        };
        let last_fired = vec![None; compiled.len()];
        TriggerEngine {
            character: character_name.to_string(),
            set,
            compiled,
            timers: Vec::new(),
            warnings,
            friendly: Vec::new(),
            last_fired,
        }
    }

    /// Register additional friendly caster names (pets, charmed mobs) whose
    /// casts must not fire "Enemy Casts" triggers.
    pub fn add_friendly_names<I, S>(&mut self, names: I)
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        self.friendly
            .extend(names.into_iter().map(|n| n.as_ref().to_lowercase()));
    }

    /// Learn pet ownership from the log itself: `/pet leader` makes a pet
    /// say "My leader is <owner>." — mobs never say this, so any speaker of
    /// that line is somebody's pet (renamed pets included) and must not
    /// read as a hostile caster.
    fn learn_friendly_from(&mut self, parsed: &ParsedLine) {
        if let Event::Chat {
            speaker: Entity::Named(name),
            text,
            ..
        } = &parsed.event
        {
            if text.trim().starts_with("My leader is ") {
                let lower = name.to_lowercase();
                if !self.friendly.contains(&lower) {
                    self.friendly.push(lower);
                }
            }
        }
    }

    /// A failed cast must not leave a phantom timer: the cast-start line
    /// already (re)started the spell's timer, so when the same cast then
    /// interrupts, fizzles, or gets resisted, drop timers named after the
    /// spell (bare "Spell" and per-target "Spell — X" forms). The sink is
    /// told so overlays clear the bar. Approximation note: with shared-name
    /// timers, an earlier still-running application of the same spell on
    /// another target is dropped too — its remaining time was already lost
    /// to the restart at cast-start.
    fn cancel_failed_cast_timers(&mut self, parsed: &ParsedLine, sink: &mut dyn ActionSink) {
        let spell: Option<&str> = match &parsed.event {
            Event::CastInterrupted {
                caster: Entity::You,
                spell,
            }
            | Event::CastFizzled {
                caster: Entity::You,
                spell,
            } => spell.as_deref(),
            Event::Resisted {
                caster: Entity::You,
                spell,
                ..
            } => Some(spell.as_str()),
            _ => None,
        };
        let Some(spell) = spell else { return };
        let prefix = format!("{spell} — ");
        let mut cancelled: Vec<String> = Vec::new();
        self.timers.retain(|t| {
            if t.name == spell || t.name.starts_with(&prefix) {
                cancelled.push(t.name.clone());
                false
            } else {
                true
            }
        });
        for name in cancelled {
            sink.cancel_timer(&name);
        }
    }

    /// Bind DoT timers to their real target, number same-name instances, and
    /// clear them on wear-off/death:
    /// - First damage tick ("T has taken N damage from S by <me>."):
    ///   a bare enemy-lane timer named `S` is renamed `S — T`; when that
    ///   name is already running (a second cast landing on an identically
    ///   named mob), the new binding takes the lowest free instance suffix —
    ///   `S — T (2)`, `S — T (3)`, … — so every application keeps its own
    ///   expiry, in cast order.
    /// - "Your S spell has worn off of T.": the OLDEST instance of `S — T`
    ///   is popped (FIFO).
    /// - `T` slain: the OLDEST instance of EVERY spell bound to `T` is
    ///   popped; younger instances (same-named twins still alive) keep
    ///   running.
    /// - You die: all timers clear (death strips buffs; fights are over).
    ///
    /// TWIN-ATTRIBUTION APPROXIMATION: the log names mobs but does not
    /// identify them. With two identically named mobs each carrying your
    /// DoT, ticks/wear-offs/deaths cannot be matched to a specific mob, so
    /// instances form a FIFO queue per (spell, name): the first bound is
    /// assumed to be the first to wear off or die (you dotted it first, so
    /// it has been taking damage longest). A tick from the *first* mob
    /// arriving right after a fresh cast can be the one that binds the new
    /// bare timer — indistinguishable in the log, and harmless: because the
    /// names are identical, the instance set and its FIFO order come out
    /// the same either way.
    fn bind_and_reap_timers(&mut self, parsed: &ParsedLine, sink: &mut dyn ActionSink) {
        match &parsed.event {
            Event::SpellDamageTaken {
                target: Entity::Named(target),
                source,
                spell,
                ..
            } => {
                let mine = matches!(source, Entity::You)
                    || matches!(source, Entity::Named(n) if n.eq_ignore_ascii_case(&self.character));
                if !mine {
                    return;
                }
                let now = parsed.line.timestamp;
                let Some(idx) = self
                    .timers
                    .iter()
                    .position(|t| t.lane == TimerLane::Enemy && t.name == *spell)
                else {
                    return;
                };
                let base = format!("{spell} — {target}");
                let new_name = next_instance_name(&self.timers, &base);
                let t = &mut self.timers[idx];
                let old = std::mem::replace(&mut t.name, new_name.clone());
                // A damage tick proves the spell landed — the pending
                // ("casting…") phase, if any, is over.
                t.lands_at = None;
                let remaining = (t.expires_at - now).max(1) as u64;
                let warn_left = t
                    .warn_at
                    .filter(|w| *w > now && !t.warned)
                    .map(|w| (t.expires_at - w).max(0) as u64);
                let lane = t.lane;
                sink.cancel_timer(&old);
                sink.start_timer(&new_name, remaining, warn_left, lane, 0);
            }
            Event::WornOff {
                spell,
                owner: Some(Entity::Named(target)),
            } => {
                // Targeted wear-off: pop the oldest instance of (spell, T).
                // `timers` is in start order, so the first match is oldest.
                let base = format!("{spell} — {target}");
                if let Some(idx) = self
                    .timers
                    .iter()
                    .position(|t| is_instance_of(&t.name, &base))
                {
                    let popped = self.timers.remove(idx);
                    sink.cancel_timer(&popped.name);
                }
            }
            Event::Slain { victim, .. } => {
                let mut cancelled: Vec<String> = Vec::new();
                match victim {
                    Entity::You => {
                        cancelled.extend(self.timers.drain(..).map(|t| t.name));
                    }
                    Entity::Named(name) => {
                        // One mob died: pop the oldest instance of every
                        // spell bound to that name (the dead mob's dots were
                        // the oldest — see the twin approximation above).
                        let suffix = format!(" — {name}");
                        let mut popped_families: HashSet<String> = HashSet::new();
                        let mut i = 0;
                        while i < self.timers.len() {
                            let family = instance_base(&self.timers[i].name);
                            // Case-insensitive: "You have slain a hill
                            // giant!" names the mob in lowercase while the
                            // binding tick capitalized it at line start.
                            if ends_with_ci(family, &suffix)
                                && popped_families.insert(family.to_ascii_lowercase())
                            {
                                cancelled.push(self.timers.remove(i).name);
                            } else {
                                i += 1;
                            }
                        }
                    }
                }
                for name in cancelled {
                    sink.cancel_timer(&name);
                }
            }
            _ => {}
        }
    }

    /// Bind a buff you cast on someone ELSE to a per-target bar in the
    /// on-others lane. The land line is `<target>` + the spell's
    /// CASTEDOTHERTXT suffix, e.g. `Torvin is surrounded by a brief lupine
    /// aura.` (Spirit of Wolf). Neither that line nor the cast line
    /// (`You begin casting Spirit of Wolf.`) carries both spell AND target, so
    /// we only rebind a spell we have a pending BARE buff-lane timer for: that
    /// proves *I* cast it and pins the exact spell name (which the wear-off
    /// line will later match to reap the bar). Self-casts print a different
    /// ("You feel…") message and never match, so they stay in the buff lane.
    /// If two pending buffs would match the same land line, none is bound — no
    /// mislabel.
    fn bind_buff_on_other(&mut self, parsed: &ParsedLine, sink: &mut dyn ActionSink) {
        let msg = parsed.line.message.as_str();
        let map = buff_land_map();
        let mut hit: Option<(usize, String)> = None;
        for (idx, t) in self.timers.iter().enumerate() {
            // Only unbound (bare) buff-lane timers can be promoted; a bound
            // name already contains the " — <target>" separator.
            if t.lane != TimerLane::Buff || t.name.contains(" — ") {
                continue;
            }
            let Some(&suffix) = map.get(t.name.as_str()) else {
                continue;
            };
            if let Some(prefix) = msg.strip_suffix(suffix) {
                let target = prefix.trim();
                if target.is_empty() {
                    continue;
                }
                if hit.is_some() {
                    return; // ambiguous: two pending buffs match this line
                }
                hit = Some((idx, target.to_string()));
            }
        }
        let Some((idx, target)) = hit else { return };
        let now = parsed.line.timestamp;
        let spell = self.timers[idx].name.clone();
        let base = format!("{spell} — {target}");
        let new_name = next_instance_name(&self.timers, &base);
        let t = &mut self.timers[idx];
        let old = std::mem::replace(&mut t.name, new_name.clone());
        t.lane = TimerLane::OnOthers;
        t.lands_at = None;
        let remaining = (t.expires_at - now).max(1) as u64;
        let warn_left = t
            .warn_at
            .filter(|w| *w > now && !t.warned)
            .map(|w| (t.expires_at - w).max(0) as u64);
        sink.cancel_timer(&old);
        sink.start_timer(&new_name, remaining, warn_left, TimerLane::OnOthers, 0);
    }

    /// You, your configured pets, and your possessive pets ("nyasha's pet",
    /// "nyasha`s warder") are friendly casters.
    fn is_friendly_caster(&self, caster: &Entity) -> bool {
        let name = match caster {
            Entity::You => return true,
            Entity::Named(n) => n.to_lowercase(),
        };
        let me = self.character.to_lowercase();
        if name == me || self.friendly.contains(&name) {
            return true;
        }
        if let Some(rest) = name.strip_prefix(&me) {
            let rest = rest
                .strip_prefix("'s ")
                .or_else(|| rest.strip_prefix("`s "));
            if matches!(rest, Some("pet") | Some("warder") | Some("familiar")) {
                return true;
            }
        }
        false
    }

    /// Like [`TriggerEngine::new`], but with per-character profile resolution
    /// (against the profile's *active loadout*) layered on top of the
    /// pack-level `enabled` switch: only triggers with `enabled` AND
    /// [`effective_enabled`] (id/prefix overrides, then `default_enabled` +
    /// class intersection) are compiled. Timer durations
    /// carrying spell-formula metadata are rescaled to the profile's level
    /// (generated packs bake level-50 durations; see TRIGGERS_PLAN section C).
    pub fn new_with_profile(
        triggers: Vec<Trigger>,
        character_name: &str,
        profile: &CharacterProfile,
    ) -> Self {
        let level = profile.level;
        let channel_overrides = &profile.active_loadout().channel_overrides;
        let selected: Vec<Trigger> = triggers
            .into_iter()
            .filter(|t| t.enabled && effective_enabled(t, profile))
            .map(|mut t| {
                scale_timer_durations(&mut t, level);
                if let Some(ov) = channel_overrides.get(&t.effective_id()) {
                    apply_channel_override(&mut t, ov);
                }
                t
            })
            .collect();
        Self::new(selected, character_name)
    }

    /// Triggers that were dropped during compilation, with reasons.
    pub fn warnings(&self) -> &[String] {
        &self.warnings
    }

    /// Number of active (compiled, enabled) triggers.
    pub fn active_trigger_count(&self) -> usize {
        self.compiled.len()
    }

    /// Active trigger count per category path (for UI group counts). Triggers
    /// without a category are keyed under `""`. Sorted by category for stable
    /// display order.
    pub fn trigger_count_by_category(&self) -> BTreeMap<String, usize> {
        let mut counts = BTreeMap::new();
        for ct in &self.compiled {
            let key = ct.trigger.category.clone().unwrap_or_default();
            *counts.entry(key).or_insert(0) += 1;
        }
        counts
    }

    /// Match `parsed.line.message` against all triggers; on match, expand
    /// action templates and invoke the sink. Timer expiries are registered
    /// from the line timestamp (never wall clock) so replays are faithful.
    pub fn process(&mut self, parsed: &ParsedLine, sink: &mut dyn ActionSink) {
        let _ = self.process_traced(parsed, sink);
    }

    /// Like [`TriggerEngine::process`], but also returns the identity of each
    /// trigger that fired on this line (in compile order, after fire-dedupe),
    /// for replay auditing. The non-match path allocates nothing.
    pub fn process_traced(
        &mut self,
        parsed: &ParsedLine,
        sink: &mut dyn ActionSink,
    ) -> Vec<TriggerFireInfo> {
        // Learn before the fast-reject path — ownership lines ("My leader
        // is X.") rarely match any trigger and would otherwise be skipped.
        self.learn_friendly_from(parsed);
        self.cancel_failed_cast_timers(parsed, sink);
        self.bind_and_reap_timers(parsed, sink);
        self.bind_buff_on_other(parsed, sink);
        let message = &parsed.line.message;
        let candidates: Vec<usize> = match &self.set {
            Some(set) => {
                let matches = set.matches(message);
                if !matches.matched_any() {
                    // Fast-reject path: no per-trigger work, no sink calls.
                    return Vec::new();
                }
                matches.iter().collect()
            }
            // No fast-reject set: every trigger is a candidate; its own
            // regex below decides.
            None => (0..self.compiled.len()).collect(),
        };
        let ts = parsed.line.timestamp;
        // A cast by you or one of your pets must never read as an incoming
        // enemy cast ("Nyasha's Pet begins casting Lifespike." has the same
        // line shape as a mob cast — only the typed event knows the caster).
        let friendly_cast = match &parsed.event {
            Event::CastBegin { caster, .. } => self.is_friendly_caster(caster),
            _ => false,
        };
        let mut fired: Vec<TriggerFireInfo> = Vec::new();
        let mut new_timers: Vec<ActiveTimer> = Vec::new();
        // Fire-dedupe: sibling triggers with identical expanded patterns (e.g.
        // generated wear-off collisions) fire once per line — first one wins.
        let mut fired_keys: HashSet<usize> = HashSet::new();
        for idx in candidates {
            let ct = &self.compiled[idx];
            if fired_keys.contains(&ct.dedupe_key) {
                continue;
            }
            if friendly_cast
                && ct
                    .trigger
                    .category
                    .as_deref()
                    // `contains`, not `starts_with`: user/starter packs nest
                    // it ("Combat/Enemy Casts"), generated packs root it.
                    .is_some_and(|c| c.contains("Enemy Casts"))
            {
                continue;
            }
            let Some(caps) = ct.regex.captures(message) else {
                continue; // set-path: unreachable in practice; fallback: filter
            };
            // Refire cooldown: after a fire, matching lines stay silent for
            // `cooldown_secs` (measured on line timestamps, so replays are
            // faithful). Throttled matches don't slide the window and don't
            // count for fire-dedupe.
            let cooldown = ct.trigger.cooldown_secs.unwrap_or(0);
            if cooldown > 0 {
                if let Some(last) = self.last_fired[idx] {
                    if ts >= last && ts - last < cooldown as i64 {
                        continue;
                    }
                }
            }
            self.last_fired[idx] = Some(ts);
            fired_keys.insert(ct.dedupe_key);
            fired.push(TriggerFireInfo {
                id: ct.trigger.effective_id(),
                name: ct.trigger.name.clone(),
                category: ct.trigger.category.clone(),
            });
            for action in &ct.trigger.actions {
                match action {
                    Action::Speak { template } => {
                        sink.speak(&expand_template(template, &caps, &self.character, ts));
                    }
                    Action::PlaySound { path } => sink.play_sound(path),
                    Action::DisplayText { template } => {
                        sink.display_text(&expand_template(template, &caps, &self.character, ts));
                    }
                    Action::StartTimer {
                        name,
                        duration_secs,
                        warn_at_secs,
                        lane,
                        cast_time_secs,
                        ..
                    } => {
                        let name = expand_template(name, &caps, &self.character, ts);
                        // The trigger fires at cast START; the buff only
                        // exists once the cast completes. Lead the timer in
                        // by the cast time so expiry lands on the truth.
                        let lead_in = cast_time_secs.unwrap_or(0);
                        let shown_duration = *duration_secs + lead_in;
                        let expires_at = ts + shown_duration as i64;
                        let warn_at = warn_at_secs
                            .map(|w| expires_at - w as i64)
                            .filter(|w| *w > ts);
                        // Explicit lane wins; older packs without one fall
                        // back to category/id inference.
                        let lane = lane.unwrap_or_else(|| {
                            infer_timer_lane(
                                ct.trigger.category.as_deref(),
                                &ct.trigger.effective_id(),
                            )
                        });
                        sink.start_timer(&name, shown_duration, *warn_at_secs, lane, lead_in);
                        new_timers.push(ActiveTimer {
                            name,
                            expires_at,
                            warn_at,
                            warned: false,
                            lane,
                            // A cast-time lead-in starts the timer pending
                            // ("casting…"); due() fires Landed once it ends.
                            lands_at: (lead_in > 0).then(|| ts + lead_in as i64),
                        });
                    }
                    Action::CancelTimer { name } => {
                        let name = expand_template(name, &caps, &self.character, ts);
                        // Drop matching active timers, and any started
                        // earlier on this same line, before they register.
                        self.timers.retain(|t| t.name != name);
                        new_timers.retain(|t| t.name != name);
                        sink.cancel_timer(&name);
                    }
                }
            }
        }
        for timer in new_timers {
            // Re-match restarts the same-named timer.
            self.timers.retain(|t| t.name != timer.name);
            self.timers.push(timer);
        }
        fired
    }

    /// Poll for timer events as of `now_ts` (a line timestamp, or the same
    /// clock domain). Returns, per timer: a Landed event once when the
    /// cast-time lead-in ends, warn events once, then expire events; expired
    /// timers are removed. A timer whose landing, warn and expiry are all due
    /// yields Landed before Warn before Expire.
    pub fn due(&mut self, now_ts: i64) -> Vec<TimerFire> {
        let mut fires = Vec::new();
        for timer in &mut self.timers {
            if let Some(lands_at) = timer.lands_at {
                if now_ts >= lands_at {
                    timer.lands_at = None;
                    fires.push(TimerFire {
                        name: timer.name.clone(),
                        kind: TimerFireKind::Landed,
                        lane: timer.lane,
                    });
                }
            }
            if let Some(warn_at) = timer.warn_at {
                if !timer.warned && now_ts >= warn_at {
                    timer.warned = true;
                    fires.push(TimerFire {
                        name: timer.name.clone(),
                        kind: TimerFireKind::Warn,
                        lane: timer.lane,
                    });
                }
            }
            if now_ts >= timer.expires_at {
                fires.push(TimerFire {
                    name: timer.name.clone(),
                    kind: TimerFireKind::Expire,
                    lane: timer.lane,
                });
            }
        }
        self.timers.retain(|t| now_ts < t.expires_at);
        fires
    }

    /// Names and remaining seconds of currently running timers (for UI).
    pub fn active_timers(&self, now_ts: i64) -> Vec<(String, i64)> {
        self.timers
            .iter()
            .map(|t| (t.name.clone(), t.expires_at - now_ts))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_pattern_escapes_character_metachars() {
        let out = expand_pattern("{C} hits", "Ny(a)sha+");
        assert_eq!(out, r"Ny\(a\)sha\+ hits");
        assert!(Regex::new(&out).is_ok());
    }

    #[test]
    fn expand_pattern_tokens() {
        let out = expand_pattern("{S1} tells you, '{S2}' x{N}", "Nyasha");
        assert_eq!(out, r"(?P<S1>.+) tells you, '(?P<S2>.+)' x(?P<N>\d+)");
        assert!(Regex::new(&out).is_ok());
    }

    #[test]
    fn expand_pattern_duplicate_token_still_compiles() {
        let out = expand_pattern("{S} and {S}", "Nyasha");
        assert_eq!(out, "(?P<S>.+) and (?:.+)");
        assert!(Regex::new(&out).is_ok());
    }

    #[test]
    fn expand_pattern_lowercase_tokens() {
        let out = expand_pattern("{c} sees {s1}", "Nyasha");
        assert_eq!(out, "Nyasha sees (?P<S1>.+)");
    }

    #[test]
    fn expand_template_positional_named_and_tokens() {
        let re = Regex::new(r"(?P<S1>\w+) tells you, '(.+)'").unwrap();
        let caps = re.captures("Torvin tells you, 'inc'").unwrap();
        // timestamp 2026-07-02-ish; only HH:MM:SS matters: 90061 % 86400 = 3661 = 01:01:01
        let out = expand_template("[{TS}] {C}: ${S1} said ${2}", &caps, "Nyasha", 90_061);
        assert_eq!(out, "[01:01:01] Nyasha: Torvin said inc");
    }

    #[test]
    fn instance_helpers_match_and_strip_suffixes() {
        assert!(is_instance_of("Boil Blood — a bat", "Boil Blood — a bat"));
        assert!(is_instance_of(
            "Boil Blood — a bat (2)",
            "Boil Blood — a bat"
        ));
        assert!(is_instance_of(
            "Boil Blood — a bat (10)",
            "Boil Blood — a bat"
        ));
        assert!(!is_instance_of(
            "Boil Blood — a bat (x)",
            "Boil Blood — a bat"
        ));
        assert!(!is_instance_of(
            "Boil Blood — a bat ()",
            "Boil Blood — a bat"
        ));
        assert!(!is_instance_of(
            "Boil Blood — a bat 2",
            "Boil Blood — a bat"
        ));
        assert!(!is_instance_of("Boil Blood — a rat", "Boil Blood — a bat"));

        assert_eq!(
            instance_base("Boil Blood — a bat (2)"),
            "Boil Blood — a bat"
        );
        assert_eq!(instance_base("Boil Blood — a bat"), "Boil Blood — a bat");
        // Non-numeric parens are part of the name, not an instance suffix.
        assert_eq!(instance_base("Chant (slow)"), "Chant (slow)");
    }

    #[test]
    fn next_instance_name_takes_lowest_free_slot() {
        let timer = |name: &str| ActiveTimer {
            name: name.to_string(),
            expires_at: 100,
            warn_at: None,
            warned: false,
            lane: TimerLane::Enemy,
            lands_at: None,
        };
        let base = "Boil Blood — a bat";
        assert_eq!(next_instance_name(&[], base), base);
        let timers = vec![timer(base)];
        assert_eq!(next_instance_name(&timers, base), format!("{base} (2)"));
        let timers = vec![timer(base), timer(&format!("{base} (2)"))];
        assert_eq!(next_instance_name(&timers, base), format!("{base} (3)"));
        // Base was popped (oldest died): the bare name frees up again.
        let timers = vec![timer(&format!("{base} (2)"))];
        assert_eq!(next_instance_name(&timers, base), base);
    }

    #[test]
    fn expand_template_missing_group_is_empty() {
        let re = Regex::new(r"(a)(b)?").unwrap();
        let caps = re.captures("a").unwrap();
        assert_eq!(expand_template("<${2}><${nope}>", &caps, "N", 0), "<><>");
    }

    // ---- pending ("casting…") timers -----------------------------------

    /// Sink that records `start_timer` pending lead-ins and nothing else.
    #[derive(Default)]
    struct PendingSink {
        started: Vec<(String, u64, u64)>, // (name, duration, pending)
    }

    impl ActionSink for PendingSink {
        fn speak(&mut self, _t: &str) {}
        fn play_sound(&mut self, _p: &str) {}
        fn display_text(&mut self, _t: &str) {}
        fn start_timer(
            &mut self,
            name: &str,
            duration_secs: u64,
            _warn_at_secs: Option<u64>,
            _lane: TimerLane,
            pending_secs: u64,
        ) {
            self.started
                .push((name.to_string(), duration_secs, pending_secs));
        }
    }

    fn cast_line(ts: i64, message: &str) -> ParsedLine {
        ParsedLine {
            line: eqlog_core::events::LogLine {
                timestamp: ts,
                message: message.to_string(),
            },
            event: Event::Unclassified,
        }
    }

    fn engine_with_cast_timer(cast: u64, duration: u64, warn: Option<u64>) -> TriggerEngine {
        let trigger = Trigger::new(
            "buff timer",
            "^You begin casting Courage\\.",
            vec![Action::StartTimer {
                name: "Courage".into(),
                duration_secs: duration,
                warn_at_secs: warn,
                duration_formula: None,
                duration_cap_ticks: None,
                lane: Some(TimerLane::Buff),
                cast_time_secs: Some(cast),
            }],
        );
        TriggerEngine::new(vec![trigger], "Nyasha")
    }

    #[test]
    fn cast_time_timer_starts_pending_and_lands_once() {
        let mut engine = engine_with_cast_timer(3, 10, None);
        let mut sink = PendingSink::default();
        engine.process(&cast_line(100, "You begin casting Courage."), &mut sink);
        // The sink saw the full cast+duration bar with a 3 s pending lead.
        assert_eq!(sink.started, vec![("Courage".to_string(), 13, 3)]);

        // Before the cast completes: nothing lands.
        assert!(engine.due(102).is_empty());
        // Cast completes: exactly one Landed fire.
        let fires = engine.due(103);
        assert_eq!(fires.len(), 1);
        assert_eq!(fires[0].kind, TimerFireKind::Landed);
        assert_eq!(fires[0].name, "Courage");
        assert_eq!(fires[0].lane, TimerLane::Buff);
        // Landed is emitted once — later polls stay quiet until expiry.
        assert!(engine.due(105).is_empty());
        let fires = engine.due(113);
        assert_eq!(fires.len(), 1);
        assert_eq!(fires[0].kind, TimerFireKind::Expire);
    }

    #[test]
    fn landed_orders_before_warn_before_expire_in_one_poll() {
        // cast 3s + duration 4s => lands at 103, warns at 105, expires 107.
        let mut engine = engine_with_cast_timer(3, 4, Some(2));
        let mut sink = PendingSink::default();
        engine.process(&cast_line(100, "You begin casting Courage."), &mut sink);
        // One poll far past expiry must yield Landed, then Warn, then Expire.
        let kinds: Vec<TimerFireKind> = engine.due(120).into_iter().map(|f| f.kind).collect();
        assert_eq!(
            kinds,
            vec![
                TimerFireKind::Landed,
                TimerFireKind::Warn,
                TimerFireKind::Expire
            ]
        );
    }

    #[test]
    fn zero_cast_time_never_fires_landed() {
        let trigger = Trigger::new(
            "instant timer",
            "^You begin casting Courage\\.",
            vec![Action::StartTimer {
                name: "Courage".into(),
                duration_secs: 10,
                warn_at_secs: None,
                duration_formula: None,
                duration_cap_ticks: None,
                lane: Some(TimerLane::Buff),
                cast_time_secs: None,
            }],
        );
        let mut engine = TriggerEngine::new(vec![trigger], "Nyasha");
        let mut sink = PendingSink::default();
        engine.process(&cast_line(100, "You begin casting Courage."), &mut sink);
        assert_eq!(sink.started, vec![("Courage".to_string(), 10, 0)]);
        assert!(engine.due(105).is_empty());
        let fires = engine.due(110);
        assert_eq!(fires.len(), 1);
        assert_eq!(fires[0].kind, TimerFireKind::Expire);
    }
}
