//! `eqlog tail <file> [--char NAME] [--triggers PATH] [--profile PATH |
//! --classes A,B,C] [--level N]` — live-tail a log, print classified events
//! with ANSI color, and fire triggers to the console. Loads the full trigger
//! library (`triggers/` + curated/ + generated/) filtered through a character
//! profile; without an explicit profile the classes are auto-detected from
//! the log's own "You begin casting" history.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::{bail, Context};
use crossbeam_channel::RecvTimeoutError;
use eqlog_core::events::{ChatChannel, Entity, Event, ParsedLine};
use eqlog_core::parser::Parser;
use eqlog_core::tail::{Tailer, TailerConfig};
use eqlog_triggers::{ActionSink, CharacterProfile, TimerFireKind, TriggerEngine};

use crate::util;
use crate::util::{BLUE, BOLD, CYAN, DIM, GREEN, MAGENTA, RED, RESET, YELLOW};
use crate::{cmd_detect, triggerlib};

struct Args {
    file: PathBuf,
    /// `--char`, when given (wins over the profile file's character).
    character: Option<String>,
    triggers: Option<PathBuf>,
    profile: Option<PathBuf>,
    classes: Option<Vec<String>>,
    level: Option<u32>,
    spells: PathBuf,
}

fn parse_args(args: &[String]) -> anyhow::Result<Args> {
    let mut file: Option<PathBuf> = None;
    let mut character: Option<String> = None;
    let mut triggers: Option<PathBuf> = None;
    let mut profile: Option<PathBuf> = None;
    let mut classes: Option<Vec<String>> = None;
    let mut level: Option<u32> = None;
    let mut spells = PathBuf::from(triggerlib::DEFAULT_SPELL_SUMMARY);

    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--char" => {
                character = Some(it.next().context("tail: --char requires a value")?.clone());
            }
            "--triggers" => {
                triggers = Some(PathBuf::from(
                    it.next().context("tail: --triggers requires a path")?,
                ));
            }
            "--profile" => {
                profile = Some(PathBuf::from(
                    it.next().context("tail: --profile requires a path")?,
                ));
            }
            "--classes" => {
                let value = it.next().context("tail: --classes requires a value")?;
                classes = Some(triggerlib::parse_classes(value)?);
            }
            "--level" => {
                let value = it.next().context("tail: --level requires a value")?;
                level = Some(
                    value
                        .parse()
                        .with_context(|| format!("tail: bad --level `{value}`"))?,
                );
            }
            "--spells" => {
                spells = PathBuf::from(it.next().context("tail: --spells requires a path")?);
            }
            other if other.starts_with("--") => bail!("tail: unknown flag `{other}`"),
            other => {
                if file.replace(PathBuf::from(other)).is_some() {
                    bail!("tail: more than one <file> given");
                }
            }
        }
    }
    let file = file.context("tail: missing <file> argument")?;
    if profile.is_some() && classes.is_some() {
        bail!("tail: --profile and --classes are mutually exclusive");
    }
    Ok(Args {
        file,
        character,
        triggers,
        profile,
        classes,
        level,
        spells,
    })
}

/// Build the effective character profile: `--profile` file > ad-hoc
/// `--classes`/`--level` > default Nyasha with classes auto-detected from the
/// log's existing content. `--char` and `--level` override the result.
fn resolve_profile(args: &Args) -> anyhow::Result<CharacterProfile> {
    let mut profile = match (&args.profile, &args.classes) {
        (Some(path), _) => CharacterProfile::load(path)
            .with_context(|| format!("loading profile {}", path.display()))?,
        (None, Some(classes)) => {
            let mut p =
                CharacterProfile::new(args.character.clone().unwrap_or_else(|| "Nyasha".into()));
            p.active_loadout_mut().classes = classes.clone();
            p
        }
        (None, None) => {
            let mut p =
                CharacterProfile::new(args.character.clone().unwrap_or_else(|| "Nyasha".into()));
            p.active_loadout_mut().classes =
                cmd_detect::detect_or_empty(&args.file, &args.spells, "tail");
            p
        }
    };
    if let Some(character) = &args.character {
        profile.character = character.clone();
    }
    if let Some(level) = args.level {
        profile.level = level;
    }
    Ok(profile)
}

/// Console action sink: prints one bracketed line per fired action.
struct ConsoleSink;

impl ActionSink for ConsoleSink {
    fn speak(&mut self, text: &str) {
        println!("{MAGENTA}{BOLD}[TTS]{RESET} {text}");
    }
    fn play_sound(&mut self, path: &str) {
        println!("{MAGENTA}{BOLD}[SOUND]{RESET} {path}");
    }
    fn display_text(&mut self, text: &str) {
        println!("{MAGENTA}{BOLD}[TEXT]{RESET} {text}");
    }
    fn start_timer(
        &mut self,
        name: &str,
        duration_secs: u64,
        warn_at_secs: Option<u64>,
        lane: eqlog_triggers::TimerLane,
        pending_secs: u64,
    ) {
        let warn = warn_at_secs
            .map(|w| format!(", warn at {w}s left"))
            .unwrap_or_default();
        let pending = if pending_secs > 0 {
            format!(", casting {pending_secs}s")
        } else {
            String::new()
        };
        println!(
            "{MAGENTA}{BOLD}[TIMER]{RESET} start `{name}` ({duration_secs}s{warn}{pending}, lane {})",
            lane.as_str()
        );
    }
    fn cancel_timer(&mut self, name: &str) {
        println!("{MAGENTA}{BOLD}[TIMER CANCEL]{RESET} `{name}`");
    }
}

fn entity(e: &Entity, you: &str) -> String {
    e.name(you).to_string()
}

fn channel_name(c: &ChatChannel) -> String {
    match c {
        ChatChannel::Say => "say".into(),
        ChatChannel::Tell => "tell".into(),
        ChatChannel::Group => "group".into(),
        ChatChannel::Guild => "guild".into(),
        ChatChannel::Shout => "shout".into(),
        ChatChannel::Ooc => "ooc".into(),
        ChatChannel::Auction => "auction".into(),
        ChatChannel::Numbered { name, number } => format!("{name}:{number}"),
    }
}

/// One-line colored rendering of a classified event; `None` for lines not
/// worth echoing (Unclassified).
fn render(parsed: &ParsedLine, you: &str) -> Option<String> {
    let kind = util::event_kind(&parsed.event);
    let (color, body) = match &parsed.event {
        Event::MeleeHit {
            attacker,
            target,
            verb,
            amount,
            flags,
        } => {
            let crit = if flags.critical { " (crit)" } else { "" };
            let color = if *attacker == Entity::You { GREEN } else { RED };
            (
                color,
                format!(
                    "{} {verb} {} for {amount}{crit}",
                    entity(attacker, you),
                    entity(target, you)
                ),
            )
        }
        Event::MeleeMiss {
            attacker,
            target,
            verb,
            kind,
        } => (
            DIM,
            format!(
                "{} tries to {verb} {}: {kind:?}",
                entity(attacker, you),
                entity(target, you)
            ),
        ),
        Event::SpellDamage {
            caster,
            target,
            amount,
            spell,
            ..
        } => {
            let spell = spell.as_deref().unwrap_or("spell");
            let color = if *caster == Entity::You { GREEN } else { RED };
            (
                color,
                format!(
                    "{} hit {} for {amount} ({spell})",
                    entity(caster, you),
                    entity(target, you)
                ),
            )
        }
        Event::SpellDamageTaken {
            target,
            source,
            spell,
            amount,
        } => (
            RED,
            format!(
                "{} took {amount} from {spell} by {}",
                entity(target, you),
                entity(source, you)
            ),
        ),
        Event::NonMeleeDamage {
            source,
            target,
            effect,
            amount,
        } => {
            let src = source
                .as_ref()
                .map(|s| entity(s, you))
                .unwrap_or_else(|| "?".into());
            (
                YELLOW,
                format!(
                    "{} takes {amount} non-melee ({effect}) from {src}",
                    entity(target, you)
                ),
            )
        }
        Event::Heal {
            healer,
            target,
            amount,
            potential,
            spell,
            ..
        } => {
            let pot = potential.map(|p| format!(" ({p})")).unwrap_or_default();
            let sp = spell
                .as_deref()
                .map(|s| format!(" by {s}"))
                .unwrap_or_default();
            (
                CYAN,
                format!(
                    "{} healed {} for {amount}{pot}{sp}",
                    entity(healer, you),
                    entity(target, you)
                ),
            )
        }
        Event::CastBegin { caster, spell } => (
            BLUE,
            format!("{} begins casting {spell}", entity(caster, you)),
        ),
        Event::CastInterrupted { caster, spell } => (
            YELLOW,
            format!(
                "{}'s {} interrupted",
                entity(caster, you),
                spell.as_deref().unwrap_or("cast")
            ),
        ),
        Event::CastFizzled { caster, spell } => (
            YELLOW,
            format!(
                "{}'s {} fizzles",
                entity(caster, you),
                spell.as_deref().unwrap_or("spell")
            ),
        ),
        Event::Resisted {
            target,
            caster,
            spell,
        } => (
            YELLOW,
            format!(
                "{} resisted {}'s {spell}",
                entity(target, you),
                entity(caster, you)
            ),
        ),
        Event::WornOff { spell, owner } => {
            let who = owner
                .as_ref()
                .map(|o| format!(" ({})", entity(o, you)))
                .unwrap_or_default();
            (DIM, format!("{spell} worn off{who}"))
        }
        Event::Slain { victim, killer } => {
            let by = killer
                .as_ref()
                .map(|k| format!(" by {}", entity(k, you)))
                .unwrap_or_default();
            (MAGENTA, format!("{} slain{by}", entity(victim, you)))
        }
        Event::Loot {
            looter,
            item,
            quantity,
            corpse,
        } => {
            let qty = if *quantity > 1 {
                format!(" x{quantity}")
            } else {
                String::new()
            };
            let from = corpse
                .as_deref()
                .map(|c| format!(" from {c}"))
                .unwrap_or_default();
            (
                GREEN,
                format!("{} looted {item}{qty}{from}", entity(looter, you)),
            )
        }
        Event::Roll {
            roller,
            min,
            max,
            result,
        } => (CYAN, format!("{roller} rolled {result} ({min}-{max})")),
        Event::Chat {
            channel,
            speaker,
            text,
        } => (
            YELLOW,
            format!(
                "[{}] {}: {text}",
                channel_name(channel),
                entity(speaker, you)
            ),
        ),
        Event::XpGain { percent, party } => {
            let p = if *party { " (party)" } else { "" };
            (GREEN, format!("+{percent}% xp{p}"))
        }
        Event::LevelUp { level } => (GREEN, format!("LEVEL UP -> {level}")),
        Event::Faction { faction, delta } => (BLUE, format!("{faction} {delta:+}")),
        Event::ZoneEnter { zone } => (BLUE, format!("entered {zone}")),
        Event::Consider {
            target,
            rare,
            level,
        } => {
            let lvl = level.map(|l| format!(" L{l}")).unwrap_or_default();
            let tag = if *rare { " [rare]" } else { "" };
            (BLUE, format!("con {target}{lvl}{tag}"))
        }
        Event::Loading => (DIM, "loading...".into()),
        Event::Stunned { active } => (
            RED,
            if *active {
                "STUNNED".into()
            } else {
                "no longer stunned".into()
            },
        ),
        Event::Location { x, y, z } => (DIM, format!("loc {x:.2}, {y:.2}, {z:.2}")),
        Event::System => (DIM, parsed.line.message.clone()),
        Event::Unclassified => return None,
    };
    Some(format!(
        "{DIM}{}{RESET} {color}{kind:<16}{RESET} {color}{body}{RESET}",
        util::fmt_clock(parsed.line.timestamp)
    ))
}

fn drain_due(engine: &mut TriggerEngine, now_ts: i64) {
    for fire in engine.due(now_ts) {
        match fire.kind {
            TimerFireKind::Landed => {
                println!("{MAGENTA}{BOLD}[TIMER]{RESET} `{}` landed", fire.name);
            }
            TimerFireKind::Warn => {
                println!("{MAGENTA}{BOLD}[TIMER]{RESET} `{}` ending soon", fire.name);
            }
            TimerFireKind::Expire => {
                println!("{MAGENTA}{BOLD}[TIMER]{RESET} `{}` expired", fire.name);
            }
            TimerFireKind::Restarted => {
                println!(
                    "{MAGENTA}{BOLD}[TIMER]{RESET} `{}` repeating ({}s)",
                    fire.name,
                    fire.duration_secs.unwrap_or(0)
                );
            }
        }
    }
}

pub fn run(args: &[String]) -> anyhow::Result<()> {
    let args = parse_args(args)?;
    let profile = resolve_profile(&args)?;
    let character = profile.character.clone();

    // Trigger library: full `triggers/` tree (default.json + curated/ +
    // generated/), or a single pack with `--triggers PATH`.
    let (triggers, warnings) = triggerlib::load_library(args.triggers.as_deref())?;
    triggerlib::print_warnings("library", &warnings);
    let library_total = triggers.len();
    let mut engine = TriggerEngine::new_with_profile(triggers, &character, &profile);
    triggerlib::print_warnings("engine", engine.warnings());
    let loadout_classes = &profile.active_loadout().classes;
    let classes_desc = if loadout_classes.is_empty() {
        "no classes".to_string()
    } else {
        loadout_classes.join("/")
    };
    eprintln!(
        "tailing {} as {} ({classes_desc}, level {}; {} of {library_total} trigger(s) active) — Ctrl-C to stop",
        args.file.display(),
        character,
        profile.level,
        engine.active_trigger_count()
    );

    let tailer = Tailer::spawn(TailerConfig {
        path: args.file.clone(),
        from_start: false,
        poll_interval_ms: 200,
    })
    .with_context(|| format!("tailing {}", args.file.display()))?;

    let parser = Parser::new();
    let mut sink = ConsoleSink;
    // Timer clock: line timestamps, extrapolated by wall time between lines.
    let mut last_line_ts: Option<i64> = None;
    let mut last_line_at = Instant::now();

    loop {
        match tailer.lines.recv_timeout(Duration::from_millis(250)) {
            Ok(raw) => {
                let Some(parsed) = parser.parse_line(&raw) else {
                    continue;
                };
                if let Some(line) = render(&parsed, &character) {
                    println!("{line}");
                }
                engine.process(&parsed, &mut sink);
                last_line_ts = Some(parsed.line.timestamp);
                last_line_at = Instant::now();
                drain_due(&mut engine, parsed.line.timestamp);
            }
            Err(RecvTimeoutError::Timeout) => {
                if let Some(ts) = last_line_ts {
                    let now = ts + last_line_at.elapsed().as_secs() as i64;
                    drain_due(&mut engine, now);
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                eprintln!("tail: log reader stopped");
                return Ok(());
            }
        }
    }
}
