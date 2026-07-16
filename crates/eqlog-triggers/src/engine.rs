//! Trigger matching engine. Runs on every parsed log line: a `RegexSet`
//! fast-reject pass over all enabled patterns, then per-trigger `Regex`
//! capture extraction for the (rare) matches. Timers are driven purely by
//! line timestamps so replayed logs behave identically to live tailing.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::OnceLock;

use regex::{Captures, Regex, RegexSet};

use crate::model::{
    duration_ticks_at_level, infer_timer_lane, Action, ChannelOverride, CharacterProfile,
    TimerLane, TimerStartMode, TimerTiming, Trigger, TriggerEvent,
};
use crate::profile::{effective_enabled, zone_scope_for};
use eqlog_core::events::{Entity, Event, ParsedLine};

/// Host-implemented sink that performs actions (TTS, sound, overlay text).
pub trait ActionSink {
    /// Enter/leave a user-authored trigger's action scope. Hosts can use this
    /// to attach identity directly to each sink call. Engine housekeeping
    /// happens outside a scope and is therefore explicitly unattributed.
    fn begin_trigger(&mut self, trigger: &TriggerFireInfo) {
        let _ = trigger;
    }
    fn end_trigger(&mut self) {}
    fn speak(&mut self, text: &str);
    fn play_sound(&mut self, path: &str);
    fn display_text(&mut self, text: &str);
    /// A countdown began. `icon` is explicit because internal timer rebinding
    /// happens outside trigger scope and must retain the active timer's visual
    /// identity. `lane` is the resolved overlay lane (the action's explicit
    /// lane, else inferred from the trigger's category/id).
    /// `pending_secs` is the cast-time lead-in: the first `pending_secs`
    /// seconds of the countdown are a "casting…" phase (the effect does not
    /// exist yet); a [`TimerFireKind::Landed`] fire marks the flip to a real
    /// running timer. `0` = starts landed.
    fn start_timer(
        &mut self,
        name: &str,
        icon: Option<&str>,
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
    /// A `PostWebhook` action fired: send `text` (already template-expanded) to
    /// a user-configured webhook. `name` selects a *named* webhook from the
    /// host's settings (`None` = the default webhook). The engine never handles
    /// URLs — the host resolves the name and performs the HTTP POST — so shared
    /// trigger packs carry only the harmless name, never anyone's secret URL.
    /// Default no-op so non-networked sinks (CLI, tests) ignore it.
    fn post_webhook(&mut self, name: Option<&str>, text: &str) {
        let _ = (name, text);
    }
    /// An `Impact` action fired: show a big animated moment on the Impact
    /// overlay. All text fields are already template-expanded. Default no-op so
    /// sinks without an Impact overlay (CLI, tests) ignore it.
    fn impact(&mut self, spec: ImpactFire<'_>) {
        let _ = spec;
    }
    /// A generic overlay action fired. All fields are template-expanded;
    /// configuration is opaque to the engine and interpreted by the overlay.
    fn overlay(&mut self, spec: OverlayFire<'_>) {
        let _ = spec;
    }
    /// A raw-line trigger observed loot or a kill that may advance a watch.
    /// Structured-event triggers never invoke this callback, preventing an
    /// observation -> watched signal -> observation recursion loop.
    fn observe_watch(&mut self, observation: WatchObservation) {
        let _ = observation;
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct OverlayFire<'a> {
    pub overlay: &'a str,
    pub fields: BTreeMap<String, String>,
    pub config: &'a BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchObservation {
    pub kind: crate::model::WatchObservationKind,
    pub name: String,
    pub quantity: Option<String>,
    pub context: BTreeMap<String, String>,
}

/// A fired `Impact` action, fully expanded and ready for the Impact overlay.
/// Borrowed `style`/`glyph`/`color` come straight from the trigger; the text
/// lines are owned because they were template-expanded from the match.
#[derive(Debug, Clone, PartialEq)]
pub struct ImpactFire<'a> {
    pub style: &'a str,
    pub headline: Option<String>,
    pub big: Option<String>,
    pub sub: Option<String>,
    pub glyph: Option<&'a str>,
    pub color: Option<&'a str>,
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
    /// A repeating timer began its next cycle: the sink must show a fresh
    /// bar (the frontend prunes a bar shortly after its "expired" event,
    /// so without this the audio keeps cycling with no visible timer).
    Restarted,
}

/// A timer event returned from [`TriggerEngine::due`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimerFire {
    pub name: String,
    pub icon: Option<String>,
    pub kind: TimerFireKind,
    /// Overlay lane of the timer that fired (see [`TimerLane`]).
    pub lane: TimerLane,
    /// Optional custom text from the timer definition.
    pub text: Option<String>,
    /// Optional custom sound from the timer definition.
    pub sound: Option<String>,
    /// [`TimerFireKind::Restarted`] only: the new cycle's length, so the
    /// sink can draw the replacement bar.
    pub duration_secs: Option<u64>,
    /// [`TimerFireKind::Restarted`] only: the new cycle's warn lead.
    pub warn_secs: Option<u64>,
}

/// A running timer captured by [`TriggerEngine::timer_snapshots`] for UI
/// resync after a reload. All fields are durations (seconds), not timestamps,
/// so they survive a log-vs-wall timezone mismatch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimerSnapshot {
    pub name: String,
    pub icon: Option<String>,
    pub duration_secs: u64,
    /// Seconds already elapsed; the frontend derives remaining = duration
    /// − elapsed and rebuilds its countdown from its own clock.
    pub elapsed_secs: u64,
    pub warn_at_secs: Option<u64>,
    pub lane: TimerLane,
    /// Remaining cast-time lead-in ("casting…"); 0 once the effect has landed.
    pub pending_secs: u64,
}

/// Identity of a trigger that fired on a line, returned by
/// [`TriggerEngine::process_traced`] so replay tools (e.g. the CLI spam
/// auditor) can attribute fires to triggers and categories.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TriggerFireInfo {
    /// The trigger's effective id (see [`Trigger::effective_id`]).
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub category: Option<String>,
}

/// A host-approved structured event submitted to the trigger engine. The
/// host owns event-specific eligibility; the engine owns profile resolution,
/// cooldowns, template expansion, action execution, and attribution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TriggerSignal {
    pub event: TriggerEvent,
    pub timestamp: i64,
    /// Named template values, referenced as `${item}`, `${quantity}`, etc.
    pub fields: BTreeMap<String, String>,
}

impl TriggerSignal {
    pub fn new(event: TriggerEvent, timestamp: i64, fields: BTreeMap<String, String>) -> Self {
        Self {
            event,
            timestamp,
            fields,
        }
    }
}

/// Convert parser-owned facts that map directly to structured trigger events.
/// This adapter contains no log grammar or presentation policy: the parser
/// determines the fact and trigger data determines the resulting actions.
pub fn signal_from_event(event: &Event, timestamp: i64) -> Option<TriggerSignal> {
    match event {
        Event::Achievement { who, name } => {
            let (event, player) = match who {
                Entity::You => (TriggerEvent::AchievementSelf, "You".to_string()),
                Entity::Named(player) => (TriggerEvent::AchievementOther, player.clone()),
            };
            Some(TriggerSignal::new(
                event,
                timestamp,
                [
                    ("achievement".to_string(), name.clone()),
                    ("player".to_string(), player),
                ]
                .into(),
            ))
        }
        _ => None,
    }
}

#[derive(Clone)]
struct ActiveTimer {
    name: String,
    icon: Option<String>,
    duration_secs: u64,
    expires_at: i64,
    warn_at_secs: Option<u64>,
    warn_at: Option<i64>,
    warned: bool,
    lane: TimerLane,
    /// When the cast completes and the pending phase ends; `None` once
    /// landed (or when the timer never had a cast-time lead-in).
    lands_at: Option<i64>,
    repeat_secs: Option<u64>,
    stopwatch: bool,
    warn_text: Option<String>,
    expire_text: Option<String>,
    warn_sound: Option<String>,
    expire_sound: Option<String>,
}

struct CompiledTrigger {
    trigger: Trigger,
    /// Present for raw-line triggers; absent for structured event triggers.
    regex: Option<Regex>,
    numeric_constraints: Vec<NumericConstraint>,
    /// Fire-dedupe group: triggers with an identical expanded pattern share a
    /// key, and at most one of them fires per line (the first).
    dedupe_key: usize,
    /// Effective zone scope, lowercased. Empty = fires everywhere. Non-empty =
    /// fires only while [`TriggerEngine::current_zone`] contains one of these
    /// substrings. Resolved once at compile from the trigger's own
    /// [`Trigger::zones`] (or a loadout override in [`TriggerEngine::new_with_profile`]).
    zones: Vec<String>,
}

/// Whether a compiled trigger's zone `scope` (lowercased) permits firing in
/// `current` (already lowercased). An empty scope permits every zone; a
/// non-empty scope permits only when `current` is known and contains one of
/// the scope substrings.
fn zone_scope_allows(scope: &[String], current: Option<&str>) -> bool {
    if scope.is_empty() {
        return true;
    }
    match current {
        None => false,
        Some(zone) => scope.iter().any(|s| zone.contains(s.as_str())),
    }
}

pub struct TriggerEngine {
    character: String,
    /// Fast-reject set over all compiled patterns. `None` when the combined
    /// set failed to build (e.g. the cumulative compiled-size limit on huge
    /// imports) — every trigger's own regex is consulted per line instead,
    /// so triggers keep firing, just without the fast-reject pass.
    set: Option<RegexSet>,
    compiled: Vec<CompiledTrigger>,
    /// `RegexSet` match positions map through this list because structured
    /// event triggers live in `compiled` but have no regex-set entry.
    line_indices: Vec<usize>,
    timers: Vec<ActiveTimer>,
    warnings: Vec<String>,
    /// Extra friendly caster names (lowercased), e.g. configured pet names.
    /// The character's own possessive pets ("<char>'s pet", "<char>`s
    /// warder") are recognized automatically.
    friendly: Vec<String>,
    /// Line-timestamp of each compiled trigger's last fire (parallel to
    /// `compiled`), for the per-trigger refire cooldown. Resets on reload.
    last_fired: Vec<Option<i64>>,
    /// Current zone (lowercased), learned from `You have entered …` lines, used
    /// to gate zone-scoped triggers. `None` until the first zone line is seen —
    /// zone-scoped triggers stay quiet while the location is unknown. Catch-up
    /// replay on session start re-establishes it from the recent log tail.
    current_zone: Option<String>,
}

/// Expand GINA-style tokens in a trigger *pattern* before regex compilation:
/// `{C}` becomes the (regex-escaped) character name; `{S}`/`{S1}`/… become
/// `(?P<S1>.+)` named wildcards; `{N}`/`{N2}`/… become `(?P<N2>\d+)`. Tokens
/// are case-insensitive (`{c}`, `{s1}` also work); a repeated token expands
/// to a non-capturing wildcard so the pattern still compiles.
pub fn expand_pattern(pattern: &str, character: &str) -> String {
    expand_pattern_with_constraints(pattern, character).0
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NumericOp {
    Lt,
    Le,
    Eq,
    Ge,
    Gt,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NumericConstraint {
    name: String,
    op: NumericOp,
    value: i64,
}

fn numeric_constraints_pass(caps: &Captures, constraints: &[NumericConstraint]) -> bool {
    constraints.iter().all(|c| {
        let Some(value) = caps
            .name(&c.name)
            .and_then(|m| m.as_str().parse::<i64>().ok())
        else {
            return false;
        };
        match c.op {
            NumericOp::Lt => value < c.value,
            NumericOp::Le => value <= c.value,
            NumericOp::Eq => value == c.value,
            NumericOp::Ge => value >= c.value,
            NumericOp::Gt => value > c.value,
        }
    })
}

fn expand_pattern_with_constraints(
    pattern: &str,
    character: &str,
) -> (String, Vec<NumericConstraint>) {
    // Tokens: {C}, {S}, {S<digits>}, {N}, {N<digits>}, any case. Compiled once
    // and reused — this expansion runs for every trigger on every engine
    // (re)build, so recompiling the fixed token regex each call was pure waste
    // (P32).
    static TOKEN_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let token_re = TOKEN_RE.get_or_init(|| {
        Regex::new(r"\{([CcSsNn]\d*)(?:(<=|>=|<|>|=)(-?\d+))?\}").expect("token regex is valid")
    });
    let mut seen: HashSet<String> = HashSet::new();
    let mut constraints = Vec::new();
    let expanded = token_re
        .replace_all(pattern, |caps: &Captures| {
            let raw = &caps[1];
            let upper = raw.to_ascii_uppercase();
            match upper.as_bytes()[0] {
                // A numeric-constraint suffix only makes sense on {N} tokens.
                // On {C}/{S} it is a user mistake — keep the raw token text so
                // the pattern FAILS to compile (an unescaped `{` is a regex
                // error) and the trigger surfaces in warnings, instead of
                // silently compiling without the gate.
                b'C' => {
                    if caps.get(2).is_some() {
                        caps[0].to_string()
                    } else {
                        regex::escape(character)
                    }
                }
                b'S' => {
                    if caps.get(2).is_some() {
                        caps[0].to_string()
                    } else if seen.insert(upper.clone()) {
                        format!("(?P<{upper}>.+)")
                    } else {
                        "(?:.+)".to_string()
                    }
                }
                _ => {
                    if let (Some(op), Some(value)) = (caps.get(2), caps.get(3)) {
                        let op = match op.as_str() {
                            "<" => NumericOp::Lt,
                            "<=" => NumericOp::Le,
                            "=" => NumericOp::Eq,
                            ">=" => NumericOp::Ge,
                            ">" => NumericOp::Gt,
                            _ => unreachable!("token regex limits ops"),
                        };
                        // Register the constraint EVEN on a repeated token:
                        // same token = same named group, and the constraint
                        // checks that group's captured value ("{N} of
                        // {N<=20}" gates on the first capture). Dropping it
                        // silently disarmed low-health-style gates.
                        if let Ok(value) = value.as_str().parse::<i64>() {
                            constraints.push(NumericConstraint {
                                name: upper.clone(),
                                op,
                                value,
                            });
                        }
                        if seen.insert(upper.clone()) {
                            return format!(r"(?P<{upper}>\d+)");
                        }
                        return r"(?:\d+)".to_string();
                    }
                    if seen.insert(upper.clone()) {
                        format!(r"(?P<{upper}>\d+)")
                    } else {
                        r"(?:\d+)".to_string()
                    }
                }
            }
        })
        .into_owned();
    (expanded, constraints)
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

/// Same lookup for detrimental spells (their CASTEDOTHERTXT, e.g.
/// `A dar ghoul knight yawns.` for Togor's Insects). Binds bare enemy-lane
/// timers — slows/malos have no damage tick to bind on.
fn debuff_land_map() -> &'static HashMap<&'static str, &'static str> {
    static MAP: OnceLock<HashMap<&'static str, &'static str>> = OnceLock::new();
    MAP.get_or_init(|| {
        crate::buff_lands::DEBUFF_LAND_SUFFIXES
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

fn next_instance_name_among<'a, I>(timers: I, base: &str) -> String
where
    I: IntoIterator<Item = &'a ActiveTimer>,
{
    let names: Vec<&str> = timers.into_iter().map(|t| t.name.as_str()).collect();
    if !names.contains(&base) {
        return base.to_string();
    }
    let mut n: u32 = 2;
    loop {
        let candidate = format!("{base} ({n})");
        if !names.iter().any(|name| *name == candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// Layer a [`ChannelOverride`] onto a trigger's actions in place: force the
/// Speak (TTS) and/or Alerts-overlay channels on or off. Legacy DisplayText
/// actions count as Alerts actions. `None` leaves that channel unchanged.
/// Enabling a missing channel synthesizes a generic Alerts overlay; disabling
/// removes both generic and legacy Alerts actions.
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
        let is_alert = |a: &Action| {
            matches!(a, Action::DisplayText { .. })
                || matches!(a, Action::Overlay { overlay, .. } if overlay == "alerts")
        };
        let has = t.actions.iter().any(is_alert);
        if alert && !has {
            t.actions.push(Action::Overlay {
                overlay: "alerts".into(),
                fields: BTreeMap::from([("text".into(), t.name.clone())]),
                config: BTreeMap::new(),
            });
        } else if !alert && has {
            t.actions.retain(|a| !is_alert(a));
        }
    }
}

enum TemplateValues<'a> {
    Captures(&'a Captures<'a>),
    Fields(&'a BTreeMap<String, String>),
}

impl TemplateValues<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        match self {
            Self::Captures(caps) => {
                if key.chars().all(|c| c.is_ascii_digit()) {
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
                }
            }
            Self::Fields(fields) => fields
                .get(key)
                .or_else(|| fields.get(&key.to_ascii_lowercase()))
                .map(String::as_str),
        }
    }
}

/// Expand an action *template* after a match: `${1}` positional captures,
/// `${name}` named captures or structured signal fields, `{C}` character
/// name, and `{TS}` timestamp as `HH:MM:SS`. Unknown references become "".
fn expand_template_values(
    template: &str,
    values: &TemplateValues<'_>,
    character: &str,
    timestamp: i64,
) -> String {
    let mut out = String::with_capacity(template.len());
    let bytes = template.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let rest = &template[i..];
        if rest.starts_with("${") {
            if let Some(close) = rest.find('}') {
                let key = &rest[2..close];
                if !key.is_empty() {
                    out.push_str(values.get(key).unwrap_or(""));
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

#[cfg(test)]
fn expand_template(template: &str, caps: &Captures, character: &str, timestamp: i64) -> String {
    expand_template_values(
        template,
        &TemplateValues::Captures(caps),
        character,
        timestamp,
    )
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

fn normalize_rank(rank: &str) -> String {
    rank.trim().to_ascii_uppercase()
}

fn spell_base_name(spell: &str) -> &str {
    let spell = spell.trim();
    let Some((base, rank)) = spell.rsplit_once(' ') else {
        return spell;
    };
    if !base.is_empty()
        && !rank.is_empty()
        && rank
            .bytes()
            .all(|byte| matches!(byte, b'I' | b'V' | b'X' | b'L' | b'C' | b'D' | b'M'))
    {
        base
    } else {
        spell
    }
}

/// Merge per-loadout manual timings into the action's library rank table.
/// Manual values win field-by-field, so changing only cast time continues to
/// inherit the library duration.
fn apply_timing_overrides(trigger: &mut Trigger, overrides: &BTreeMap<String, TimerTiming>) {
    for action in &mut trigger.actions {
        let Action::StartTimer { rank_variants, .. } = action else {
            continue;
        };
        for (rank, manual) in overrides {
            let value = rank_variants.entry(normalize_rank(rank)).or_default();
            if manual.duration_secs.is_some() {
                value.duration_secs = manual.duration_secs;
            }
            if manual.cast_time_secs.is_some() {
                value.cast_time_secs = manual.cast_time_secs;
            }
        }
    }
}

fn resolve_rank_timing(
    duration_secs: u64,
    cast_time_secs: Option<u64>,
    rank_variants: &BTreeMap<String, TimerTiming>,
    rank: Option<&str>,
) -> TimerTiming {
    let variant = rank.and_then(|rank| {
        rank_variants
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(rank.trim()))
            .map(|(_, value)| value)
    });
    TimerTiming {
        duration_secs: Some(
            variant
                .and_then(|value| value.duration_secs)
                .unwrap_or(duration_secs),
        ),
        cast_time_secs: variant
            .and_then(|value| value.cast_time_secs)
            .or(cast_time_secs),
    }
}

/// Execute one trigger's normal action list against either regex captures or
/// structured signal fields. Matching, profile gates, cooldowns, and trigger
/// attribution stay with the caller; every output channel shares this path.
fn execute_actions(
    trigger: &Trigger,
    values: &TemplateValues<'_>,
    character: &str,
    ts: i64,
    timers: &mut Vec<ActiveTimer>,
    new_timers: &mut Vec<ActiveTimer>,
    sink: &mut dyn ActionSink,
) {
    let expand = |template: &str| expand_template_values(template, values, character, ts);
    let allow_watch_observation = matches!(values, TemplateValues::Captures(_));
    for action in &trigger.actions {
        match action {
            Action::Speak { template } => sink.speak(&expand(template)),
            Action::PlaySound { path } => sink.play_sound(path),
            Action::DisplayText { template } => sink.display_text(&expand(template)),
            Action::Overlay {
                overlay,
                fields,
                config,
            } => {
                let mut fields: BTreeMap<String, String> = fields
                    .iter()
                    .map(|(key, value)| (key.clone(), expand(value)))
                    .collect();
                if !fields.contains_key("icon") {
                    if let Some(icon) = &trigger.icon {
                        fields.insert("icon".to_string(), icon.clone());
                    }
                }
                sink.overlay(OverlayFire {
                    overlay,
                    fields,
                    config,
                });
            }
            Action::ObserveWatch {
                kind,
                name,
                quantity,
                context,
            } if allow_watch_observation => sink.observe_watch(WatchObservation {
                kind: *kind,
                name: expand(name),
                quantity: quantity.as_deref().map(&expand),
                context: context
                    .iter()
                    .map(|(key, value)| (key.clone(), expand(value)))
                    .collect(),
            }),
            Action::ObserveWatch { .. } => {}
            Action::StartTimer {
                name,
                duration_secs,
                warn_at_secs,
                lane,
                cast_time_secs,
                rank_variants,
                mode,
                repeat_secs,
                stopwatch,
                warn_text,
                expire_text,
                warn_sound,
                expire_sound,
                ..
            } => {
                let mut name = expand(name);
                let timing = resolve_rank_timing(
                    *duration_secs,
                    *cast_time_secs,
                    rank_variants,
                    values.get("rank"),
                );
                let lead_in = timing.cast_time_secs.unwrap_or(0);
                let shown_duration = timing.duration_secs.unwrap_or(*duration_secs) + lead_in;
                let expires_at = ts + shown_duration as i64;
                let warn_at = warn_at_secs
                    .map(|w| expires_at - w as i64)
                    .filter(|w| *w > ts);
                let lane = lane.unwrap_or_else(|| {
                    infer_timer_lane(trigger.category.as_deref(), &trigger.effective_id())
                });
                let mode = mode.unwrap_or_default();
                let exists = timers.iter().any(|t| t.name == name)
                    || new_timers.iter().any(|t| t.name == name);
                if mode == TimerStartMode::IgnoreIfRunning && exists {
                    continue;
                }
                if mode == TimerStartMode::StartNewInstance && exists {
                    name = next_instance_name_among(timers.iter().chain(new_timers.iter()), &name);
                }
                sink.start_timer(
                    &name,
                    trigger.icon.as_deref(),
                    shown_duration,
                    *warn_at_secs,
                    lane,
                    lead_in,
                );
                new_timers.push(ActiveTimer {
                    name,
                    icon: trigger.icon.clone(),
                    duration_secs: shown_duration,
                    expires_at,
                    warn_at_secs: *warn_at_secs,
                    warn_at,
                    warned: false,
                    lane,
                    lands_at: (lead_in > 0).then(|| ts + lead_in as i64),
                    repeat_secs: repeat_secs.filter(|s| *s > 0),
                    stopwatch: *stopwatch,
                    warn_text: warn_text.as_deref().map(&expand),
                    expire_text: expire_text.as_deref().map(&expand),
                    warn_sound: warn_sound.clone(),
                    expire_sound: expire_sound.clone(),
                });
            }
            Action::CancelTimer { name } => {
                let name = expand(name);
                timers.retain(|t| t.name != name);
                new_timers.retain(|t| t.name != name);
                sink.cancel_timer(&name);
            }
            Action::PostWebhook { template, webhook } => {
                sink.post_webhook(webhook.as_deref(), &expand(template));
            }
            Action::Impact {
                style,
                headline,
                big,
                sub,
                glyph,
                color,
            } => {
                let exp = |template: &Option<String>| template.as_deref().map(&expand);
                sink.impact(ImpactFire {
                    style,
                    headline: exp(headline),
                    big: exp(big),
                    sub: exp(sub),
                    glyph: glyph.as_deref(),
                    color: color.as_deref(),
                });
            }
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
        let mut line_indices = Vec::new();
        let mut warnings = Vec::new();
        let mut dedupe_keys: HashMap<String, usize> = HashMap::new();
        let mut triggers: Vec<Trigger> = triggers.into_iter().filter(|t| t.enabled).collect();
        triggers.sort_by(|a, b| {
            b.priority
                .cmp(&a.priority)
                .then_with(|| a.effective_id().cmp(&b.effective_id()))
        });
        for trigger in triggers {
            let zones = trigger
                .zones
                .iter()
                .map(|z| z.trim().to_lowercase())
                .filter(|z| !z.is_empty())
                .collect();
            if trigger.event.is_some() {
                compiled.push(CompiledTrigger {
                    trigger,
                    regex: None,
                    numeric_constraints: Vec::new(),
                    // Structured signals do not participate in line-pattern
                    // dedupe; the value is never observed for them.
                    dedupe_key: usize::MAX,
                    zones,
                });
                continue;
            }
            let (mut expanded, numeric_constraints) =
                expand_pattern_with_constraints(&trigger.pattern, character_name);
            if trigger.case_insensitive {
                expanded = format!("(?i){expanded}");
            }
            match Regex::new(&expanded) {
                Ok(regex) => {
                    let next_key = dedupe_keys.len();
                    let dedupe_key = *dedupe_keys.entry(expanded.clone()).or_insert(next_key);
                    patterns.push(expanded);
                    line_indices.push(compiled.len());
                    compiled.push(CompiledTrigger {
                        trigger,
                        regex: Some(regex),
                        numeric_constraints,
                        dedupe_key,
                        zones,
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
            line_indices,
            timers: Vec::new(),
            warnings,
            friendly: Vec::new(),
            last_fired,
            current_zone: None,
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
    /// already (re)started the spell's *bare* timer, so when the same cast
    /// then interrupts, fizzles, or gets resisted, drop that bare "Spell"
    /// timer and tell the sink to clear its bar. Per-target "Spell — T"
    /// instances are left ALONE (P17): binding only happens on a damage tick,
    /// which a failed cast never produced, so any "Spell — T" belongs to an
    /// earlier successful cast still ticking on another mob — cancelling it
    /// would wipe a live DoT on a bystander.
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
        let base_spell = spell_base_name(spell);
        let mut cancelled: Vec<String> = Vec::new();
        self.timers.retain(|t| {
            if t.name == spell || t.name == base_spell {
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

    /// Zoning leaves every enemy behind, so their DoT/debuff/CC bars are stale
    /// the instant you enter a new zone — reap enemy-lane timers on `ZoneEnter`
    /// (P17). Your own buffs, buffs on others, and ability recasts (the buff /
    /// on-others / other lanes) persist across a zone line, so those keep
    /// running.
    /// Track the current zone from `You have entered …` lines so zone-scoped
    /// triggers can be gated. Stored lowercased for case-insensitive substring
    /// matching against [`Trigger::zones`].
    fn note_zone(&mut self, parsed: &ParsedLine) {
        if let Event::ZoneEnter { zone } = &parsed.event {
            self.current_zone = Some(zone.to_lowercase());
        }
    }

    fn reap_on_zone(&mut self, parsed: &ParsedLine, sink: &mut dyn ActionSink) {
        if !matches!(parsed.event, Event::ZoneEnter { .. }) {
            return;
        }
        let mut cancelled: Vec<String> = Vec::new();
        self.timers.retain(|t| {
            if t.lane == TimerLane::Enemy {
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

    /// Bind DoT timers to their real target and clear them on wear-off/death:
    /// - First damage tick ("T has taken N damage from S by <me>."):
    ///   a bare enemy-lane timer named `S` is renamed `S — T`; when that name
    ///   is already running, the old bar is replaced. The log has no unique
    ///   mob ID, so treating same visible-name recasts as refreshes avoids
    ///   splitting one mob into `T`, `T (2)`, etc. during normal play.
    /// - "Your S spell has worn off of T.": the matching `S — T` bar is
    ///   popped.
    /// - `T` slain: EVERY spell bound to `T` clears — a
    ///   dead mob must never keep a bar counting down. With same-named
    ///   twins this also clears a surviving twin's bars (the log cannot
    ///   say which mob died); re-dotting the survivor starts a fresh bar.
    /// - You die: all timers clear (death strips buffs; fights are over).
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
                let target = self.canonical_target(target);
                let base = format!("{spell} — {target}");
                let new_name = base.clone();
                let mut idx = idx;
                let mut replaced: Vec<String> = Vec::new();
                let mut i = 0;
                while i < self.timers.len() {
                    if i != idx && is_instance_of(&self.timers[i].name, &base) {
                        replaced.push(self.timers.remove(i).name);
                        if i < idx {
                            idx -= 1;
                        }
                    } else {
                        i += 1;
                    }
                }
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
                let icon = t.icon.clone();
                sink.cancel_timer(&old);
                for name in replaced {
                    sink.cancel_timer(&name);
                }
                sink.start_timer(&new_name, icon.as_deref(), remaining, warn_left, lane, 0);
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
                        // One mob died: clear EVERY instance of every spell
                        // bound to that name, so a dead mob never keeps a
                        // bar counting down. With identically named twins
                        // the log cannot say which one died, so a surviving
                        // twin's bar clears too — a missing bar on a live
                        // mob beats a phantom bar on a dead one, and
                        // re-dotting the survivor starts a fresh bar.
                        let suffix = format!(" — {name}");
                        let mut i = 0;
                        while i < self.timers.len() {
                            let family = instance_base(&self.timers[i].name);
                            // Case-insensitive: "You have slain a hill
                            // giant!" names the mob in lowercase while the
                            // binding tick capitalized it at line start.
                            if ends_with_ci(family, &suffix) {
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
    /// If two pending spells would match the same land line, none is bound —
    /// no mislabel. Re-buffing a target who already carries the bar replaces
    /// it (buffs never stack with themselves on one person), so there is at
    /// most one bar per (spell, target) — never a numbered "(2)" duplicate.
    ///
    /// The same pass binds bare ENEMY-lane timers on their detrimental land
    /// line (`A dar ghoul knight yawns.` for Togor's Insects): non-damaging
    /// debuffs — slows, malos — never produce the damage tick the DoT binder
    /// keys on, so without this they'd sit target-less under the "(target)"
    /// group and survive the mob's death. Enemy binds keep their lane and
    /// refresh an existing same-spell visible target bar rather than splitting
    /// one mob into numbered groups.
    fn bind_buff_on_other(&mut self, parsed: &ParsedLine, sink: &mut dyn ActionSink) {
        let msg = parsed.line.message.as_str();
        let mut hit: Option<(usize, String)> = None;
        for (idx, t) in self.timers.iter().enumerate() {
            // Only unbound (bare) buff- or enemy-lane timers can be
            // promoted; a bound name already contains the " — <target>"
            // separator. Buff timers match the beneficial land table,
            // enemy timers the detrimental one.
            if t.name.contains(" — ") {
                continue;
            }
            let map = match t.lane {
                TimerLane::Buff => buff_land_map(),
                TimerLane::Enemy => debuff_land_map(),
                _ => continue,
            };
            let Some(&suffix) = map.get(t.name.as_str()) else {
                continue;
            };
            if let Some(prefix) = msg.strip_suffix(suffix) {
                let target = prefix.trim();
                if target.is_empty() {
                    continue;
                }
                if hit.is_some() {
                    return; // ambiguous: two pending spells match this line
                }
                hit = Some((idx, target.to_string()));
            }
        }
        let now = parsed.line.timestamp;
        let Some((idx, target)) = hit else {
            // Area effects emit one landing line per target after a single
            // cast. The first line consumes the bare timer above; subsequent
            // lines clone that recently-bound timer. Correlation remains
            // entirely data-driven by the spell's configured landing suffix,
            // and ambiguity between two different recent spells is rejected.
            let mut recent: Option<(String, usize, String)> = None;
            for (idx, timer) in self.timers.iter().enumerate() {
                if timer.lane != TimerLane::Enemy {
                    continue;
                }
                let family = instance_base(&timer.name);
                let Some((spell, _bound_target)) = family.split_once(" — ") else {
                    continue;
                };
                let Some(&suffix) = debuff_land_map().get(spell) else {
                    continue;
                };
                let Some(prefix) = msg.strip_suffix(suffix) else {
                    continue;
                };
                let target = prefix.trim();
                if target.is_empty() {
                    continue;
                }
                let started_at = timer.expires_at - timer.duration_secs as i64;
                if now < started_at || now - started_at > 10 {
                    continue;
                }
                match &recent {
                    Some((candidate, _, _)) if candidate != spell => return,
                    Some(_) => {}
                    None => recent = Some((spell.to_string(), idx, target.to_string())),
                }
            }
            let Some((spell, idx, target)) = recent else {
                return;
            };
            let target = self.canonical_target(&target);
            let base = format!("{spell} — {target}");
            let new_name = next_instance_name_among(&self.timers, &base);
            let mut timer = self.timers[idx].clone();
            timer.name = new_name.clone();
            timer.lands_at = None;
            let remaining = (timer.expires_at - now).max(1) as u64;
            let warn_left = timer
                .warn_at
                .filter(|w| *w > now && !timer.warned)
                .map(|w| (timer.expires_at - w).max(0) as u64);
            let icon = timer.icon.clone();
            let lane = timer.lane;
            self.timers.push(timer);
            sink.start_timer(&new_name, icon.as_deref(), remaining, warn_left, lane, 0);
            return;
        };
        let target = self.canonical_target(&target);
        let spell = self.timers[idx].name.clone();
        let base = format!("{spell} — {target}");
        match self.timers[idx].lane {
            TimerLane::Buff => {
                // Re-buffing the same target REPLACES the running buff (a
                // buff never stacks with itself on one person), so drop any
                // bar already bound to this (spell, target) instead of
                // numbering a duplicate instance.
                let mut idx = idx;
                let mut replaced: Vec<String> = Vec::new();
                let mut i = 0;
                while i < self.timers.len() {
                    if i != idx && is_instance_of(&self.timers[i].name, &base) {
                        replaced.push(self.timers.remove(i).name);
                        if i < idx {
                            idx -= 1;
                        }
                    } else {
                        i += 1;
                    }
                }
                let t = &mut self.timers[idx];
                let old = std::mem::replace(&mut t.name, base.clone());
                t.lane = TimerLane::OnOthers;
                t.lands_at = None;
                let remaining = (t.expires_at - now).max(1) as u64;
                let warn_left = t
                    .warn_at
                    .filter(|w| *w > now && !t.warned)
                    .map(|w| (t.expires_at - w).max(0) as u64);
                let icon = t.icon.clone();
                sink.cancel_timer(&old);
                for name in replaced {
                    sink.cancel_timer(&name);
                }
                sink.start_timer(
                    &base,
                    icon.as_deref(),
                    remaining,
                    warn_left,
                    TimerLane::OnOthers,
                    0,
                );
            }
            TimerLane::Enemy => {
                // Enemy lane, land-line-bound debuffs: re-applying the same
                // non-damaging debuff to the same visible target replaces the
                // old bar. These log lines have no unique mob identity, and
                // duplicate same-spell "(2)" bars are more misleading during
                // normal single-target recasts than losing a rare same-named
                // twin distinction.
                let new_name = base.clone();
                let mut idx = idx;
                let mut replaced: Vec<String> = Vec::new();
                let mut i = 0;
                while i < self.timers.len() {
                    if i != idx && is_instance_of(&self.timers[i].name, &base) {
                        replaced.push(self.timers.remove(i).name);
                        if i < idx {
                            idx -= 1;
                        }
                    } else {
                        i += 1;
                    }
                }
                let t = &mut self.timers[idx];
                let old = std::mem::replace(&mut t.name, new_name.clone());
                t.lands_at = None;
                let remaining = (t.expires_at - now).max(1) as u64;
                let warn_left = t
                    .warn_at
                    .filter(|w| *w > now && !t.warned)
                    .map(|w| (t.expires_at - w).max(0) as u64);
                let lane = t.lane;
                let icon = t.icon.clone();
                sink.cancel_timer(&old);
                for name in replaced {
                    sink.cancel_timer(&name);
                }
                sink.start_timer(&new_name, icon.as_deref(), remaining, warn_left, lane, 0);
            }
            _ => {}
        }
    }

    /// The casing an already-bound timer uses for `target`, else `target`
    /// as given. The log capitalizes the same mob differently by sentence
    /// position ("A kor ghoul wizard has taken…" at line start vs "…of
    /// a kor ghoul wizard"), and mixed-case bindings would split the mob
    /// across overlay groups and dodge instance numbering.
    fn canonical_target(&self, target: &str) -> String {
        const SEP: &str = " — ";
        for t in &self.timers {
            let base = instance_base(&t.name);
            if let Some(pos) = base.find(SEP) {
                let existing = &base[pos + SEP.len()..];
                if existing.eq_ignore_ascii_case(target) {
                    return existing.to_string();
                }
            }
        }
        target.to_string()
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
        let loadout = profile.active_loadout();
        let channel_overrides = &loadout.channel_overrides;
        let timing_overrides = &loadout.timing_overrides;
        let selected: Vec<Trigger> = triggers
            .into_iter()
            .filter(|t| t.enabled && effective_enabled(t, profile))
            .map(|mut t| {
                scale_timer_durations(&mut t, level);
                if let Some(ov) = channel_overrides.get(&t.effective_id()) {
                    apply_channel_override(&mut t, ov);
                }
                if let Some(overrides) = timing_overrides
                    .iter()
                    .find(|(id, _)| id.eq_ignore_ascii_case(&t.effective_id()))
                    .map(|(_, value)| value)
                {
                    apply_timing_overrides(&mut t, overrides);
                }
                // A per-loadout zone scope replaces the pack-authored one.
                if let Some(zones) = zone_scope_for(&t, loadout) {
                    t.zones = zones.to_vec();
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

    /// Literal timer names and their configured icons from the active trigger
    /// set. Hosts use this after a hot engine rebuild to refresh existing UI
    /// rows without restarting their countdowns. Dynamic timer-name templates
    /// are omitted because they cannot be matched safely without captures.
    pub fn timer_icons(&self) -> BTreeMap<String, String> {
        let mut icons = BTreeMap::new();
        for compiled in &self.compiled {
            let Some(icon) = &compiled.trigger.icon else {
                continue;
            };
            for action in &compiled.trigger.actions {
                let Action::StartTimer { name, .. } = action else {
                    continue;
                };
                if !name.contains("${") {
                    icons.entry(name.clone()).or_insert_with(|| icon.clone());
                }
            }
        }
        icons
    }

    /// The current zone (lowercased) learned from the log, or `None` before any
    /// `You have entered …` line has been processed. Drives zone-scoped trigger
    /// gating; exposed for UI display and tests.
    pub fn current_zone(&self) -> Option<&str> {
        self.current_zone.as_deref()
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
        self.note_zone(parsed);
        self.reap_on_zone(parsed, sink);
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
                matches.iter().map(|pos| self.line_indices[pos]).collect()
            }
            // No fast-reject set: every line trigger is a candidate; its own
            // regex below decides. Structured triggers are never candidates.
            None => self.line_indices.clone(),
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
            // Zone gate: a zone-scoped trigger only fires while we're in one of
            // its zones (and never before the first zone line is seen).
            if !zone_scope_allows(&ct.zones, self.current_zone.as_deref()) {
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
            let Some(caps) = ct.regex.as_ref().and_then(|regex| regex.captures(message)) else {
                continue; // set-path: unreachable in practice; fallback: filter
            };
            if !numeric_constraints_pass(&caps, &ct.numeric_constraints) {
                continue;
            }
            if ct.trigger.suppress {
                break;
            }
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
            let fire = TriggerFireInfo {
                id: ct.trigger.effective_id(),
                name: ct.trigger.name.clone(),
                icon: ct.trigger.icon.clone(),
                category: ct.trigger.category.clone(),
            };
            fired.push(fire.clone());
            sink.begin_trigger(&fire);
            execute_actions(
                &ct.trigger,
                &TemplateValues::Captures(&caps),
                &self.character,
                ts,
                &mut self.timers,
                &mut new_timers,
                sink,
            );
            sink.end_trigger();
        }
        for timer in new_timers {
            // Re-match restarts the same-named timer unless StartTimer opted
            // into ignore-if-running or start-new-instance above.
            self.timers.retain(|t| t.name != timer.name);
            self.timers.push(timer);
        }
        fired
    }

    /// Fire triggers subscribed to a host-approved structured event. Signal
    /// fields use the same `${name}` template syntax as named regex captures,
    /// and actions travel through the exact same executor as line triggers.
    ///
    /// The host must only submit a signal after its eligibility checks pass.
    /// For watched loot and kills, event-source triggers establish the raw
    /// format/ownership rules and the host establishes watch-list membership;
    /// the engine deliberately knows none of those application policies.
    pub fn process_signal_traced(
        &mut self,
        signal: &TriggerSignal,
        sink: &mut dyn ActionSink,
    ) -> Vec<TriggerFireInfo> {
        let ts = signal.timestamp;
        let mut fired = Vec::new();
        let mut new_timers = Vec::new();
        for idx in 0..self.compiled.len() {
            let ct = &self.compiled[idx];
            if ct.trigger.event != Some(signal.event) {
                continue;
            }
            if !zone_scope_allows(&ct.zones, self.current_zone.as_deref()) {
                continue;
            }
            if ct.trigger.suppress {
                break;
            }
            let cooldown = ct.trigger.cooldown_secs.unwrap_or(0);
            if cooldown > 0 {
                if let Some(last) = self.last_fired[idx] {
                    if ts >= last && ts - last < cooldown as i64 {
                        continue;
                    }
                }
            }
            self.last_fired[idx] = Some(ts);
            let fire = TriggerFireInfo {
                id: ct.trigger.effective_id(),
                name: ct.trigger.name.clone(),
                icon: ct.trigger.icon.clone(),
                category: ct.trigger.category.clone(),
            };
            fired.push(fire.clone());
            sink.begin_trigger(&fire);
            execute_actions(
                &ct.trigger,
                &TemplateValues::Fields(&signal.fields),
                &self.character,
                ts,
                &mut self.timers,
                &mut new_timers,
                sink,
            );
            sink.end_trigger();
        }
        for timer in new_timers {
            self.timers.retain(|t| t.name != timer.name);
            self.timers.push(timer);
        }
        fired
    }

    /// Snapshot every live countdown timer as of `now_ts` (same clock domain
    /// as [`Self::due`]), for rehydrating the UI after a window reload or app
    /// restart — the frontend's timer state lives only in the webview, so
    /// without this a reload silently drops every running buff/DoT/recast
    /// countdown. Durations are domain-independent (elapsed/remaining seconds),
    /// so the frontend rebuilds its own `endsAt` from the wall clock regardless
    /// of the log's timezone. Expired timers and count-up stopwatches are
    /// omitted (a stopwatch has no meaningful remaining to restore).
    pub fn timer_snapshots(&self, now_ts: i64) -> Vec<TimerSnapshot> {
        self.timers
            .iter()
            .filter(|t| !t.stopwatch)
            .filter_map(|t| {
                let remaining = t.expires_at - now_ts;
                if remaining <= 0 {
                    return None;
                }
                Some(TimerSnapshot {
                    name: t.name.clone(),
                    icon: t.icon.clone(),
                    duration_secs: t.duration_secs,
                    elapsed_secs: t.duration_secs.saturating_sub(remaining as u64),
                    warn_at_secs: t.warn_at_secs,
                    lane: t.lane,
                    pending_secs: t.lands_at.map(|l| (l - now_ts).max(0) as u64).unwrap_or(0),
                })
            })
            .collect()
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
                        icon: timer.icon.clone(),
                        kind: TimerFireKind::Landed,
                        lane: timer.lane,
                        duration_secs: None,
                        warn_secs: None,
                        text: None,
                        sound: None,
                    });
                }
            }
            if let Some(warn_at) = timer.warn_at {
                if !timer.warned && now_ts >= warn_at {
                    timer.warned = true;
                    fires.push(TimerFire {
                        name: timer.name.clone(),
                        icon: timer.icon.clone(),
                        kind: TimerFireKind::Warn,
                        lane: timer.lane,
                        duration_secs: None,
                        warn_secs: None,
                        text: timer.warn_text.clone(),
                        sound: timer.warn_sound.clone(),
                    });
                }
            }
            if !timer.stopwatch && now_ts >= timer.expires_at {
                fires.push(TimerFire {
                    name: timer.name.clone(),
                    icon: timer.icon.clone(),
                    kind: TimerFireKind::Expire,
                    lane: timer.lane,
                    text: timer.expire_text.clone(),
                    sound: timer.expire_sound.clone(),
                    duration_secs: None,
                    warn_secs: None,
                });
                if let Some(repeat_secs) = timer.repeat_secs {
                    let step = repeat_secs as i64;
                    while now_ts >= timer.expires_at {
                        timer.expires_at += step;
                    }
                    timer.duration_secs = repeat_secs;
                    timer.warn_at = timer
                        .warn_at_secs
                        .map(|w| timer.expires_at - w as i64)
                        .filter(|w| *w > now_ts);
                    timer.warned = false;
                    fires.push(TimerFire {
                        name: timer.name.clone(),
                        icon: timer.icon.clone(),
                        kind: TimerFireKind::Restarted,
                        lane: timer.lane,
                        text: None,
                        sound: None,
                        duration_secs: Some((timer.expires_at - now_ts).max(1) as u64),
                        warn_secs: timer.warn_at_secs,
                    });
                }
            }
        }
        self.timers
            .retain(|t| t.stopwatch || t.repeat_secs.is_some() || now_ts < t.expires_at);
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
    fn constraint_on_repeated_numeric_token_still_registers() {
        // "{N} of {N<=20}": the second occurrence must register its gate
        // against the shared named group instead of silently dropping it.
        let (expanded, constraints) =
            expand_pattern_with_constraints("You have {N} of {N<=20} hit points", "Nyasha");
        assert!(Regex::new(&expanded).is_ok(), "{expanded}");
        assert_eq!(constraints.len(), 1);
        assert_eq!(constraints[0].name, "N");
        assert_eq!(constraints[0].op, NumericOp::Le);
        assert_eq!(constraints[0].value, 20);
    }

    #[test]
    fn constraint_suffix_on_s_or_c_token_fails_compilation_visibly() {
        // Numeric gates only exist for {N}; on {S}/{C} the raw token is kept
        // so the regex fails to compile and the trigger lands in warnings
        // (the pre-constraint behavior) instead of silently losing the gate.
        for pattern in ["hit for {S>=1000} damage", "{C<5} says"] {
            let (expanded, constraints) = expand_pattern_with_constraints(pattern, "Nyasha");
            assert!(constraints.is_empty());
            assert!(
                Regex::new(&expanded).is_err(),
                "must not compile silently: {expanded}"
            );
        }
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
            _icon: Option<&str>,
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
                rank_variants: BTreeMap::new(),
                mode: None,
                repeat_secs: None,
                stopwatch: false,
                warn_text: None,
                expire_text: None,
                warn_sound: None,
                expire_sound: None,
            }],
        );
        TriggerEngine::new(vec![trigger], "Nyasha")
    }

    #[test]
    fn repeating_timer_reemits_a_bar_each_cycle() {
        let trigger = Trigger::new(
            "pulse",
            "^You begin your pulse\\.",
            vec![Action::StartTimer {
                name: "Pulse".into(),
                duration_secs: 30,
                warn_at_secs: None,
                duration_formula: None,
                duration_cap_ticks: None,
                lane: Some(TimerLane::Other),
                cast_time_secs: None,
                rank_variants: BTreeMap::new(),
                mode: None,
                repeat_secs: Some(30),
                stopwatch: false,
                warn_text: None,
                expire_text: None,
                warn_sound: None,
                expire_sound: None,
            }],
        );
        let mut engine = TriggerEngine::new(vec![trigger], "Nyasha");
        let mut sink = PendingSink::default();
        engine.process(&cast_line(100, "You begin your pulse."), &mut sink);
        // First cycle expires: the fire list must carry BOTH the expiry and
        // a Restarted fire with the next cycle's duration, so the sink can
        // draw a fresh bar (the UI prunes bars after "expired").
        let fires = engine.due(130);
        let kinds: Vec<TimerFireKind> = fires.iter().map(|f| f.kind).collect();
        assert_eq!(kinds, vec![TimerFireKind::Expire, TimerFireKind::Restarted]);
        assert_eq!(fires[1].duration_secs, Some(30));
        // And again next cycle.
        let fires = engine.due(160);
        assert_eq!(fires.len(), 2);
        assert_eq!(fires[1].kind, TimerFireKind::Restarted);
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
                rank_variants: BTreeMap::new(),
                mode: None,
                repeat_secs: None,
                stopwatch: false,
                warn_text: None,
                expire_text: None,
                warn_sound: None,
                expire_sound: None,
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

    #[test]
    fn parser_achievement_fact_maps_to_structured_signal() {
        let signal = signal_from_event(
            &Event::Achievement {
                who: Entity::Named("Daer".into()),
                name: "Befallen Traveler".into(),
            },
            123,
        )
        .unwrap();

        assert_eq!(signal.event, TriggerEvent::AchievementOther);
        assert_eq!(signal.timestamp, 123);
        assert_eq!(
            signal.fields.get("achievement").map(String::as_str),
            Some("Befallen Traveler")
        );
        assert_eq!(
            signal.fields.get("player").map(String::as_str),
            Some("Daer")
        );
    }
}
