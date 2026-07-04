//! `eqlog detect <logfile> [--spells PATH]` — class auto-detect: scan the
//! log's "You begin casting X." lines, look each spell up in the spell→classes
//! map, and print ranked class guesses.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context};

use crate::triggerlib;
use crate::util::{BOLD, DIM, GREEN, RESET};

struct Args {
    file: PathBuf,
    spells: PathBuf,
}

fn parse_args(args: &[String]) -> anyhow::Result<Args> {
    let mut file: Option<PathBuf> = None;
    let mut spells = PathBuf::from(triggerlib::DEFAULT_SPELL_SUMMARY);

    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--spells" => {
                spells = PathBuf::from(it.next().context("detect: --spells requires a path")?);
            }
            other if other.starts_with("--") => bail!("detect: unknown flag `{other}`"),
            other => {
                if file.replace(PathBuf::from(other)).is_some() {
                    bail!("detect: more than one <logfile> given");
                }
            }
        }
    }
    let file = file.context("detect: missing <logfile> argument")?;
    Ok(Args { file, spells })
}

pub fn run(args: &[String]) -> anyhow::Result<()> {
    let args = parse_args(args)?;
    if !args.spells.exists() {
        bail!(
            "detect: spell data not found at {} (pass --spells PATH)",
            args.spells.display()
        );
    }

    let map = triggerlib::load_spell_classes(&args.spells)
        .with_context(|| format!("loading spell data from {}", args.spells.display()))?;
    let cast = triggerlib::cast_spells_in_log(&args.file)?;
    let refs: Vec<&str> = cast.iter().map(String::as_str).collect();
    let detection = eqlog_triggers::detect_classes(&refs, &map);
    let known = cast
        .iter()
        .filter(|name| map.keys().any(|k| k.eq_ignore_ascii_case(name)))
        .count();

    println!(
        "{BOLD}{}{RESET}: {} distinct spells cast ({} known to spell data)",
        args.file.display(),
        cast.len(),
        known
    );
    if detection.classes.is_empty() {
        println!("no classes detected (no known cast spells found)");
        return Ok(());
    }

    println!(
        "{BOLD}detected classes:{RESET} {GREEN}{}{RESET}  (explains {:.0}% of known casts)",
        detection.classes.join(", "),
        detection.confidence * 100.0
    );
    println!("{BOLD}ranked votes{RESET} {DIM}(distinct known spells castable by class){RESET}:");
    for (class, votes) in &detection.ranked {
        let marker = if detection
            .classes
            .iter()
            .any(|c| c.eq_ignore_ascii_case(class))
        {
            format!("{GREEN}*{RESET}")
        } else {
            " ".to_string()
        };
        println!("  {marker} {class:<14} {votes:>3}");
    }
    Ok(())
}

/// Detect classes for another subcommand's default profile: returns the
/// detected class list, or an empty list (with a stderr note) when the spell
/// data or log can't be used. `what` names the caller for the message.
pub fn detect_or_empty(log: &Path, spells: &Path, what: &str) -> Vec<String> {
    if !spells.exists() {
        eprintln!(
            "{what}: spell data not found at {} — no classes auto-detected (pass --classes)",
            spells.display()
        );
        return Vec::new();
    }
    match triggerlib::detect_from_log(log, spells) {
        Ok((_, detection)) => {
            if detection.classes.is_empty() {
                eprintln!("{what}: no classes auto-detected from {}", log.display());
            } else {
                eprintln!(
                    "{what}: auto-detected classes {} ({:.0}% of known casts explained)",
                    detection.classes.join(", "),
                    detection.confidence * 100.0
                );
            }
            detection.classes
        }
        Err(err) => {
            eprintln!("{what}: class auto-detect failed: {err:#}");
            Vec::new()
        }
    }
}
