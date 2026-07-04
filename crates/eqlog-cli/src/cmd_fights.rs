//! `eqlog fights <file> [--char NAME] [--pet PET=OWNER]... [--db PATH]
//! [--sources]` — replay a log through the fight tracker and print per-fight
//! damage tables; `--sources` adds each combatant's per-source breakdown
//! (melee verbs, spells, damage-shield effects; pet sources fold under the
//! owner with a "(pet)" suffix); `--db` also persists every completed fight
//! into a SQLite fight-store file (the same store the app's Fights history
//! reads).

use std::io::{BufWriter, Write};
use std::path::PathBuf;

use anyhow::{bail, Context};
use eqlog_core::fights::{FightConfig, FightSummary, FightTracker};
use eqlog_core::parser::Parser;
use eqlog_store::FightStore;

use crate::util;

struct Args {
    file: PathBuf,
    character: String,
    pets: Vec<(String, String)>,
    db: Option<PathBuf>,
    sources: bool,
}

fn parse_args(args: &[String]) -> anyhow::Result<Args> {
    let mut file: Option<PathBuf> = None;
    let mut character = "Nyasha".to_string();
    let mut pets: Vec<(String, String)> = Vec::new();
    let mut explicit_pets = false;
    let mut db: Option<PathBuf> = None;
    let mut sources = false;

    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--char" => {
                character = it
                    .next()
                    .context("fights: --char requires a value")?
                    .clone();
            }
            "--db" => {
                db = Some(PathBuf::from(
                    it.next().context("fights: --db requires a path")?,
                ));
            }
            "--sources" => {
                sources = true;
            }
            "--pet" => {
                let spec = it.next().context("fights: --pet requires PET=OWNER")?;
                let (pet, owner) = spec
                    .split_once('=')
                    .with_context(|| format!("fights: --pet `{spec}` is not PET=OWNER"))?;
                if pet.is_empty() || owner.is_empty() {
                    bail!("fights: --pet `{spec}` is not PET=OWNER");
                }
                pets.push((pet.to_string(), owner.to_string()));
                explicit_pets = true;
            }
            other if other.starts_with("--") => bail!("fights: unknown flag `{other}`"),
            other => {
                if file.replace(PathBuf::from(other)).is_some() {
                    bail!("fights: more than one <file> given");
                }
            }
        }
    }
    if !explicit_pets && character == "Nyasha" {
        pets.push(("Vibarn".to_string(), "Nyasha".to_string()));
    }
    let file = file.context("fights: missing <file> argument")?;
    Ok(Args {
        file,
        character,
        pets,
        db,
        sources,
    })
}

fn print_fight(out: &mut impl Write, fight: &FightSummary, sources: bool) -> anyhow::Result<()> {
    let slain = if fight.target_slain { " (slain)" } else { "" };
    writeln!(
        out,
        "=== {} — {} .. {} ({}, {} dmg){slain}",
        fight.target,
        util::fmt_clock(fight.start_ts),
        util::fmt_clock(fight.end_ts),
        util::fmt_duration(fight.duration_secs),
        fight.total_damage,
    )?;
    writeln!(
        out,
        "    {:<26} {:>9} {:>8} {:>6}  {:>9} {:>9}",
        "name", "total", "dps", "%", "taken", "healed"
    )?;
    for row in &fight.rows {
        writeln!(
            out,
            "    {:<26} {:>9} {:>8.1} {:>5.1}%  {:>9} {:>9}",
            row.name, row.damage, row.dps, row.percent, row.damage_taken, row.healing
        )?;
        if sources {
            for src in &row.sources {
                let pct = if row.damage > 0 {
                    src.total as f64 * 100.0 / row.damage as f64
                } else {
                    0.0
                };
                writeln!(
                    out,
                    "      - {:<24} {:>9} {:>14.1}%  ({} hits, {} crits, max {})",
                    src.name, src.total, pct, src.hits, src.crits, src.max_hit
                )?;
            }
        }
    }
    Ok(())
}

pub fn run(args: &[String]) -> anyhow::Result<()> {
    let args = parse_args(args)?;

    let mut config = FightConfig::new(args.character.clone());
    for (pet, owner) in &args.pets {
        config.pet_owners.insert(pet.clone(), owner.clone());
    }
    let mut tracker = FightTracker::new(config);
    let parser = Parser::new();

    util::for_each_line(&args.file, |raw| {
        if let Some(parsed) = parser.parse_line(raw) {
            tracker.ingest(&parsed);
        }
        Ok(())
    })?;
    tracker.close_all();

    let stdout = std::io::stdout();
    let mut out = BufWriter::new(stdout.lock());

    let fights = tracker.completed_fights();
    if fights.is_empty() {
        writeln!(out, "no fights found in {}", args.file.display())?;
        out.flush()?;
        return Ok(());
    }

    for fight in &fights {
        print_fight(&mut out, fight, args.sources)?;
        writeln!(out)?;
    }

    let overall = tracker.overall_summary();
    writeln!(out, "--- overall: {} fights ---", fights.len())?;
    print_fight(&mut out, &overall, args.sources)?;

    if let Some(db_path) = &args.db {
        let mut store = FightStore::open(db_path)
            .with_context(|| format!("opening fight store {}", db_path.display()))?;
        for fight in &fights {
            store
                .insert(fight)
                .with_context(|| format!("storing fight vs {}", fight.target))?;
        }
        writeln!(
            out,
            "stored {} fight(s) in {} ({} total)",
            fights.len(),
            db_path.display(),
            store.count().unwrap_or(0),
        )?;
    }
    out.flush()?;
    Ok(())
}
