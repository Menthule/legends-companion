//! `eqlog casts <file> [--char NAME] [--min N] [--mine]` — replay a log
//! through the cast-outcome aggregator and print per-caster / per-spell
//! attempts, fizzles, resists, interrupts, and inferred land rate (P45).
//! `--min` hides spells cast fewer than N times; `--mine` restricts output to
//! the character's own casts (default character Nyasha).

use std::io::{BufWriter, Write};
use std::path::PathBuf;

use anyhow::{bail, Context};
use eqlog_core::cast_stats::CastStats;
use eqlog_core::parser::Parser;

use crate::util;

struct Args {
    file: PathBuf,
    character: String,
    min: u32,
    mine: bool,
}

fn parse_args(args: &[String]) -> anyhow::Result<Args> {
    let mut file: Option<PathBuf> = None;
    let mut character = "Nyasha".to_string();
    let mut min: u32 = 1;
    let mut mine = false;

    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--char" => {
                character = it.next().context("casts: --char requires a value")?.clone();
            }
            "--min" => {
                let v = it.next().context("casts: --min requires a number")?;
                min = v
                    .parse()
                    .with_context(|| format!("casts: --min `{v}` is not a number"))?;
            }
            "--mine" => mine = true,
            other if other.starts_with("--") => bail!("casts: unknown flag `{other}`"),
            other => {
                if file.replace(PathBuf::from(other)).is_some() {
                    bail!("casts: more than one <file> given");
                }
            }
        }
    }
    let file = file.context("casts: missing <file> argument")?;
    Ok(Args {
        file,
        character,
        min,
        mine,
    })
}

pub fn run(args: &[String]) -> anyhow::Result<()> {
    let args = parse_args(args)?;

    let mut stats = CastStats::new(args.character.clone());
    let parser = Parser::new();
    util::for_each_line(&args.file, |raw| {
        if let Some(parsed) = parser.parse_line(raw) {
            stats.ingest(&parsed);
        }
        Ok(())
    })?;

    let stdout = std::io::stdout();
    let mut out = BufWriter::new(stdout.lock());

    let mut rows = stats.rows();
    if args.mine {
        rows.retain(|r| r.caster == args.character);
    }
    rows.retain(|r| r.attempts() >= args.min);

    if rows.is_empty() {
        writeln!(out, "no casts found in {}", args.file.display())?;
        out.flush()?;
        return Ok(());
    }

    writeln!(
        out,
        "{:<18} {:<26} {:>5} {:>5} {:>5} {:>5} {:>5} {:>7}",
        "caster", "spell", "cast", "land", "fizl", "rsst", "intr", "land%"
    )?;
    let (mut tot_attempts, mut tot_fizzles, mut tot_resists, mut tot_interrupts) = (0u32, 0u32, 0u32, 0u32);
    for r in &rows {
        writeln!(
            out,
            "{:<18} {:<26} {:>5} {:>5} {:>5} {:>5} {:>5} {:>6.1}%",
            r.caster, r.spell, r.attempts(), r.landed(), r.fizzles, r.resists, r.interrupts, r.land_pct()
        )?;
        tot_attempts += r.attempts();
        tot_fizzles += r.fizzles;
        tot_resists += r.resists;
        tot_interrupts += r.interrupts;
    }

    let tot_failures = tot_fizzles + tot_resists + tot_interrupts;
    let tot_landed = tot_attempts.saturating_sub(tot_failures);
    let land_pct = if tot_attempts == 0 {
        0.0
    } else {
        tot_landed as f64 * 100.0 / tot_attempts as f64
    };
    writeln!(
        out,
        "{:<18} {:<26} {:>5} {:>5} {:>5} {:>5} {:>5} {:>6.1}%",
        format!("— {} rows", rows.len()),
        "TOTAL",
        tot_attempts,
        tot_landed,
        tot_fizzles,
        tot_resists,
        tot_interrupts,
        land_pct
    )?;
    out.flush()?;
    Ok(())
}
