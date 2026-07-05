//! `eqlog triggers <logfile> [--classes A,B,C] [--level N] [--top N]` —
//! the spam auditor: replay a log through the full default-enabled trigger
//! library under a character profile and report fire volume — total fires,
//! per-trigger and per-category counts, timer activity, and estimated spoken
//! alerts per active hour.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

use anyhow::{bail, Context};

use eqlog_core::parser::Parser;
use eqlog_triggers::{ActionSink, CharacterProfile, TimerFireKind, TriggerEngine};

use crate::util::{BOLD, CYAN, DIM, GREEN, RESET};
use crate::{cmd_detect, triggerlib, util};

/// Gaps between lines longer than this don't count as active play time.
const IDLE_GAP_SECS: i64 = 300;

struct Args {
    file: PathBuf,
    character: String,
    classes: Option<Vec<String>>,
    level: u32,
    top: usize,
    triggers: Option<PathBuf>,
    spells: PathBuf,
}

fn parse_args(args: &[String]) -> anyhow::Result<Args> {
    let mut file: Option<PathBuf> = None;
    let mut character = "Nyasha".to_string();
    let mut classes: Option<Vec<String>> = None;
    let mut level: u32 = 50;
    let mut top: usize = 30;
    let mut triggers: Option<PathBuf> = None;
    let mut spells = PathBuf::from(triggerlib::DEFAULT_SPELL_SUMMARY);

    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--char" => {
                character = it
                    .next()
                    .context("triggers: --char requires a value")?
                    .clone();
            }
            "--classes" => {
                let value = it.next().context("triggers: --classes requires a value")?;
                classes = Some(triggerlib::parse_classes(value)?);
            }
            "--level" => {
                let value = it.next().context("triggers: --level requires a value")?;
                level = value
                    .parse()
                    .with_context(|| format!("triggers: bad --level `{value}`"))?;
            }
            "--top" => {
                let value = it.next().context("triggers: --top requires a value")?;
                top = value
                    .parse()
                    .with_context(|| format!("triggers: bad --top `{value}`"))?;
            }
            "--triggers" => {
                triggers = Some(PathBuf::from(
                    it.next().context("triggers: --triggers requires a path")?,
                ));
            }
            "--spells" => {
                spells = PathBuf::from(it.next().context("triggers: --spells requires a path")?);
            }
            other if other.starts_with("--") => bail!("triggers: unknown flag `{other}`"),
            other => {
                if file.replace(PathBuf::from(other)).is_some() {
                    bail!("triggers: more than one <logfile> given");
                }
            }
        }
    }
    let file = file.context("triggers: missing <logfile> argument")?;
    Ok(Args {
        file,
        character,
        classes,
        level,
        top,
        triggers,
        spells,
    })
}

/// Action sink that only counts what would have been performed.
#[derive(Default)]
struct CountingSink {
    speaks: u64,
    sounds: u64,
    texts: u64,
    timer_starts: u64,
}

impl ActionSink for CountingSink {
    fn speak(&mut self, _text: &str) {
        self.speaks += 1;
    }
    fn play_sound(&mut self, _path: &str) {
        self.sounds += 1;
    }
    fn display_text(&mut self, _text: &str) {
        self.texts += 1;
    }
    fn start_timer(
        &mut self,
        _name: &str,
        _duration_secs: u64,
        _warn_at_secs: Option<u64>,
        _lane: eqlog_triggers::TimerLane,
        _pending_secs: u64,
    ) {
        self.timer_starts += 1;
    }
}

pub fn run(args: &[String]) -> anyhow::Result<()> {
    let args = parse_args(args)?;

    // Profile: explicit classes, else auto-detect from the log itself.
    let classes = match &args.classes {
        Some(classes) => classes.clone(),
        None => cmd_detect::detect_or_empty(&args.file, &args.spells, "triggers"),
    };
    let mut profile = CharacterProfile::new(args.character.clone());
    profile.active_loadout_mut().classes = classes.clone();
    profile.level = args.level;

    let (all_triggers, warnings) = triggerlib::load_library(args.triggers.as_deref())?;
    triggerlib::print_warnings("library", &warnings);
    let library_total = all_triggers.len();

    let mut engine = TriggerEngine::new_with_profile(all_triggers, &args.character, &profile);
    triggerlib::print_warnings("engine", engine.warnings());

    let profile_desc = if classes.is_empty() {
        "no classes (class-tagged triggers off)".to_string()
    } else {
        classes.join(", ")
    };
    println!(
        "{BOLD}profile:{RESET} {} — {} — level {}",
        args.character, profile_desc, args.level
    );
    println!(
        "{BOLD}library:{RESET} {library_total} triggers loaded, {} active for this profile",
        engine.active_trigger_count()
    );

    // ---- replay ------------------------------------------------------------
    let parser = Parser::new();
    let mut sink = CountingSink::default();

    let mut lines_total: u64 = 0;
    let mut lines_parsed: u64 = 0;
    let mut total_fires: u64 = 0;
    let mut per_trigger: HashMap<String, (String, u64)> = HashMap::new();
    let mut per_category: BTreeMap<String, u64> = BTreeMap::new();
    let mut warns: u64 = 0;
    let mut expires: u64 = 0;

    let mut first_ts: Option<i64> = None;
    let mut last_ts: Option<i64> = None;
    let mut active_secs: i64 = 0;

    util::for_each_line(&args.file, |raw| {
        lines_total += 1;
        let Some(parsed) = parser.parse_line(raw) else {
            return Ok(());
        };
        lines_parsed += 1;
        let ts = parsed.line.timestamp;
        first_ts.get_or_insert(ts);
        if let Some(prev) = last_ts {
            let gap = ts - prev;
            if gap > 0 && gap <= IDLE_GAP_SECS {
                active_secs += gap;
            }
        }
        last_ts = Some(ts);

        for fire in engine.process_traced(&parsed, &mut sink) {
            total_fires += 1;
            let entry = per_trigger.entry(fire.id).or_insert_with(|| (fire.name, 0));
            entry.1 += 1;
            *per_category
                .entry(fire.category.unwrap_or_default())
                .or_insert(0) += 1;
        }
        for timer_fire in engine.due(ts) {
            match timer_fire.kind {
                // Landed = the cast-time lead-in ended; a silent overlay
                // state flip, not an alert — irrelevant to the spam audit.
                TimerFireKind::Landed => {}
                TimerFireKind::Warn => warns += 1,
                TimerFireKind::Expire => expires += 1,
                // Repeat restarts are visual-only (no audio) — not audited.
                TimerFireKind::Restarted => {}
            }
        }
        Ok(())
    })?;

    let still_running = last_ts
        .map(|ts| engine.active_timers(ts).len())
        .unwrap_or(0);

    // ---- report ------------------------------------------------------------
    let span_secs = match (first_ts, last_ts) {
        (Some(a), Some(b)) if b >= a => (b - a) as u64,
        _ => 0,
    };
    println!(
        "{BOLD}replayed:{RESET} {lines_total} lines ({lines_parsed} parsed) spanning {} — active time {}",
        util::fmt_duration(span_secs),
        util::fmt_duration(active_secs.max(0) as u64)
    );
    println!(
        "{BOLD}fires:{RESET} {total_fires} trigger fires — actions: {} speak, {} sound, {} text, {} timer start",
        sink.speaks, sink.sounds, sink.texts, sink.timer_starts
    );
    println!(
        "{BOLD}timers:{RESET} {} started, {warns} warn(s), {expires} expiration(s), {still_running} still running at end of log",
        sink.timer_starts
    );

    // Spoken-alert estimate: Speak actions only. Timer warn/expire events
    // are overlay countdowns in the app (EmitSink emits them without TTS),
    // so they are reported separately rather than counted as speech.
    let spoken_total = sink.speaks;
    if active_secs > 0 {
        let hours = active_secs as f64 / 3600.0;
        println!(
            "{BOLD}est. spoken alerts:{RESET} {GREEN}{:.1}/active hour{RESET} \
             ({spoken_total} speak over {:.2} active hours; plus {warns} timer warn + \
             {expires} expire shown on the overlay)",
            spoken_total as f64 / hours,
            hours
        );
    } else {
        println!(
            "{BOLD}est. spoken alerts:{RESET} n/a (no active time) — {spoken_total} spoken total"
        );
    }

    // Top-N triggers by fires (count desc, then id for determinism).
    let mut ranked: Vec<(&String, &(String, u64))> = per_trigger.iter().collect();
    ranked.sort_by(|a, b| b.1 .1.cmp(&a.1 .1).then_with(|| a.0.cmp(b.0)));
    println!(
        "\n{BOLD}top {} triggers by fires{RESET} {DIM}(of {} that fired){RESET}:",
        args.top.min(ranked.len()),
        ranked.len()
    );
    for (id, (name, count)) in ranked.iter().take(args.top) {
        println!("  {count:>6}  {name}  {DIM}[{id}]{RESET}");
    }

    println!("\n{BOLD}fires per category{RESET}:");
    let mut categories: Vec<(&String, &u64)> = per_category.iter().collect();
    categories.sort_by(|a, b| b.1.cmp(a.1).then_with(|| a.0.cmp(b.0)));
    for (category, count) in categories {
        let label = if category.is_empty() {
            "(uncategorized)"
        } else {
            category
        };
        println!("  {count:>6}  {CYAN}{label}{RESET}");
    }
    Ok(())
}
