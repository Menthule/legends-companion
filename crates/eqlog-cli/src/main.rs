//! eqlog CLI — batch-parse, live-tail, and trigger-audit EQ Legends logs
//! from the terminal.
//!
//! Subcommands:
//!   eqlog parse <file> [--json]
//!   eqlog fights <file> [--char NAME] [--pet PET=OWNER]... [--db PATH] [--sources]
//!   eqlog casts <file> [--char NAME] [--min N] [--mine]
//!   eqlog tail <file> [--char NAME] [--triggers PATH] [--profile PATH | --classes A,B,C] [--level N]
//!   eqlog triggers <logfile> [--classes A,B,C] [--level N] [--top N]
//!   eqlog detect <logfile> [--spells PATH]
//!   eqlog share export <pack.json> [--name LABEL] [--version V] [--author WHO] [--notes TEXT] [--gtp OUT.gtp]
//!   eqlog share import <STRING|FILE> [--out PACK.json]

mod cmd_casts;
mod cmd_detect;
mod cmd_fights;
mod cmd_parse;
mod cmd_share;
mod cmd_tail;
mod cmd_triggers;
mod triggerlib;
mod util;

use std::process::ExitCode;

const USAGE: &str = "\
eqlog — EverQuest Legends log companion CLI

USAGE:
    eqlog parse <file> [--json]
        Batch-parse a log file. Default output is a summary (line count,
        classification coverage, event histogram, top unclassified shapes);
        --json emits one ParsedLine JSON object per line (NDJSON).

    eqlog fights <file> [--char NAME] [--pet PET=OWNER]... [--db PATH] [--sources]
        Replay a log through the fight tracker and print per-fight damage
        tables plus overall totals. Defaults: --char Nyasha --pet Vibarn=Nyasha.
        --db also persists every completed fight into a SQLite fight-store
        file (created if missing), the same store the app's Fights history
        reads.

    eqlog casts <file> [--char NAME] [--min N] [--mine]
        Replay a log through the cast-outcome aggregator and print per-caster,
        per-spell attempts, fizzles, resists, interrupts, and an inferred land
        rate (attempts minus observed failures). --min hides spells cast fewer
        than N times (default 1); --mine restricts output to the character's
        own casts. Default character Nyasha.

    eqlog tail <file> [--char NAME] [--triggers PATH]
               [--profile PATH | --classes A,B,C] [--level N] [--spells PATH]
        Live-tail a log from its current end, printing classified events and
        firing triggers. Loads the full trigger library (triggers/ +
        triggers/curated/ + triggers/generated/) filtered by the character
        profile; default profile is Nyasha with classes auto-detected from
        the log. --triggers replaces the library with a single pack file.

    eqlog triggers <logfile> [--char NAME] [--classes A,B,C] [--level N]
                   [--top N] [--triggers PATH] [--spells PATH]
        Spam auditor: replay a log through the full default-enabled library
        and report total fires, fires per trigger (top N, default 30), fires
        per category, timer activity, and estimated spoken alerts per active
        hour. Classes default to auto-detect from the log.

    eqlog detect <logfile> [--spells PATH]
        Class auto-detect: scan the log's \"You begin casting\" lines against
        the spell data (default fixtures/local/spell_summary.json) and print
        ranked class guesses.

    eqlog share export <pack.json> [--name LABEL] [--version V] [--author WHO] [--notes TEXT] [--gtp OUT.gtp]
        Print an LCS1: share string for a trigger pack file (TriggerPack
        JSON or bare trigger array). --gtp additionally writes a
        GINA-compatible .gtp archive for cross-tool sharing.

    eqlog share import <STRING|FILE> [--out PACK.json]
        Decode an LCS1: share string (inline, or a file containing one)
        into a trigger pack, deduping trigger-id collisions against the
        local trigger library. Writes pack JSON to stdout or --out.
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some((cmd, rest)) = args.split_first() else {
        eprint!("{USAGE}");
        return ExitCode::FAILURE;
    };

    let result = match cmd.as_str() {
        "parse" => cmd_parse::run(rest),
        "fights" => cmd_fights::run(rest),
        "casts" => cmd_casts::run(rest),
        "tail" => cmd_tail::run(rest),
        "triggers" => cmd_triggers::run(rest),
        "detect" => cmd_detect::run(rest),
        "share" => cmd_share::run(rest),
        "help" | "--help" | "-h" => {
            print!("{USAGE}");
            Ok(())
        }
        other => Err(anyhow::anyhow!("unknown subcommand `{other}`\n\n{USAGE}")),
    };

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("eqlog: {err:#}");
            ExitCode::FAILURE
        }
    }
}
