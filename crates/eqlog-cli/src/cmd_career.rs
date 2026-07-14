//! `eqlog career import|stats|reset` — the career database + log-history
//! backfill (docs/career-db-design.md §5). Fold whole EQ log files into the
//! per-character career tables of the store DB, print the career summary, or
//! reset one character's career data.

use std::io::{BufWriter, Write};
use std::path::PathBuf;

use anyhow::{bail, Context};
use eqlog_store::career::{CareerStore, ImportOptions, ImportReport, DEFAULT_GAP_SECS};

use crate::util;

const DEFAULT_DB: &str = "./fights.sqlite";

pub fn run(args: &[String]) -> anyhow::Result<()> {
    let Some((sub, rest)) = args.split_first() else {
        bail!("career: expected a subcommand: import | stats | reset");
    };
    match sub.as_str() {
        "import" => run_import(rest),
        "stats" => run_stats(rest),
        "reset" => run_reset(rest),
        other => bail!("career: unknown subcommand `{other}` (expected import | stats | reset)"),
    }
}

// ---------------------------------------------------------------------------
// career import
// ---------------------------------------------------------------------------

struct ImportArgs {
    files: Vec<PathBuf>,
    db: PathBuf,
    character: Option<String>,
    server: Option<String>,
    gap_secs: i64,
    dry_run: bool,
    json: bool,
}

fn parse_import_args(args: &[String]) -> anyhow::Result<ImportArgs> {
    let mut out = ImportArgs {
        files: Vec::new(),
        db: PathBuf::from(DEFAULT_DB),
        character: None,
        server: None,
        gap_secs: DEFAULT_GAP_SECS,
        dry_run: false,
        json: false,
    };
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--db" => {
                out.db = PathBuf::from(it.next().context("career import: --db requires a path")?);
            }
            "--character" => {
                out.character = Some(
                    it.next()
                        .context("career import: --character requires a value")?
                        .clone(),
                );
            }
            "--server" => {
                out.server = Some(
                    it.next()
                        .context("career import: --server requires a value")?
                        .clone(),
                );
            }
            "--gap-mins" => {
                let v = it
                    .next()
                    .context("career import: --gap-mins requires a number")?;
                let mins: i64 = v
                    .parse()
                    .with_context(|| format!("career import: --gap-mins `{v}` is not a number"))?;
                if mins <= 0 {
                    bail!("career import: --gap-mins must be positive");
                }
                out.gap_secs = mins * 60;
            }
            "--dry-run" => out.dry_run = true,
            "--json" => out.json = true,
            other if other.starts_with("--") => bail!("career import: unknown flag `{other}`"),
            other => out.files.push(PathBuf::from(other)),
        }
    }
    if out.files.is_empty() {
        bail!("career import: missing <logfile> argument(s)");
    }
    Ok(out)
}

fn run_import(args: &[String]) -> anyhow::Result<()> {
    let args = parse_import_args(args)?;
    let mut store = CareerStore::open(&args.db)
        .with_context(|| format!("opening career store {}", args.db.display()))?;
    let opts = ImportOptions {
        character: args.character.clone(),
        server: args.server.clone(),
        gap_secs: args.gap_secs,
        dry_run: args.dry_run,
    };

    let stdout = std::io::stdout();
    let mut out = BufWriter::new(stdout.lock());
    let mut failed = false;
    for file in &args.files {
        let result = store.import_file(file, &opts, &mut |_| {});
        match result {
            Ok(report) => {
                if args.json {
                    writeln!(out, "{}", serde_json::to_string(&report)?)?;
                } else {
                    print_report(&mut out, &report, args.dry_run)?;
                }
            }
            Err(err) => {
                // Keep going: one bad archive should not abort a batch, but
                // the exit code must say something failed.
                failed = true;
                out.flush()?;
                eprintln!("eqlog: career import {}: {err:#}", file.display());
            }
        }
    }
    out.flush()?;
    if failed {
        bail!("one or more files failed to import");
    }
    Ok(())
}

fn print_report(
    out: &mut impl Write,
    report: &ImportReport,
    dry_run: bool,
) -> anyhow::Result<()> {
    let who = if report.server.is_empty() {
        report.character.clone()
    } else {
        format!("{} @ {}", report.character, report.server)
    };
    if report.skipped {
        writeln!(
            out,
            "{}: skipped ({}) — {who}",
            report.file,
            report.skip_reason.as_deref().unwrap_or("no-op"),
        )?;
        return Ok(());
    }
    let tag = if dry_run { " [dry-run]" } else { "" };
    writeln!(out, "{}: {who}{tag}", report.file)?;
    writeln!(
        out,
        "  {} lines read ({} skipped as already-imported)",
        report.lines_read, report.lines_skipped
    )?;
    writeln!(
        out,
        "  sessions +{} (updated {}) · kills +{} · loot +{} · level-ups +{}",
        report.sessions_added,
        report.sessions_updated,
        report.kills_added,
        report.loot_added,
        report.level_ups_added,
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// career stats
// ---------------------------------------------------------------------------

struct StatsArgs {
    db: PathBuf,
    character: Option<String>,
    server: Option<String>,
    sessions: u32,
    json: bool,
}

fn parse_stats_args(args: &[String]) -> anyhow::Result<StatsArgs> {
    let mut out = StatsArgs {
        db: PathBuf::from(DEFAULT_DB),
        character: None,
        server: None,
        sessions: 10,
        json: false,
    };
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--db" => {
                out.db = PathBuf::from(it.next().context("career stats: --db requires a path")?);
            }
            "--character" => {
                out.character = Some(
                    it.next()
                        .context("career stats: --character requires a value")?
                        .clone(),
                );
            }
            "--server" => {
                out.server = Some(
                    it.next()
                        .context("career stats: --server requires a value")?
                        .clone(),
                );
            }
            "--sessions" => {
                let v = it
                    .next()
                    .context("career stats: --sessions requires a number")?;
                out.sessions = v
                    .parse()
                    .with_context(|| format!("career stats: --sessions `{v}` is not a number"))?;
            }
            "--json" => out.json = true,
            other => bail!("career stats: unknown argument `{other}`"),
        }
    }
    Ok(out)
}

/// Resolve which (character, server) the command targets: explicit flags win;
/// otherwise the DB must hold exactly one character.
fn resolve_identity(
    store: &CareerStore,
    character: &Option<String>,
    server: &Option<String>,
) -> anyhow::Result<(String, String)> {
    let known = store.characters()?;
    match character {
        Some(c) => {
            let server = match server {
                Some(s) => s.clone(),
                None => {
                    // Unambiguous single-server character: default its server.
                    let matches: Vec<&(String, String)> = known
                        .iter()
                        .filter(|(kc, _)| kc.eq_ignore_ascii_case(c))
                        .collect();
                    match matches.as_slice() {
                        [one] => one.1.clone(),
                        [] => String::new(),
                        _ => bail!(
                            "career: `{c}` exists on multiple servers ({}); pass --server",
                            matches
                                .iter()
                                .map(|(_, s)| s.as_str())
                                .collect::<Vec<_>>()
                                .join(", ")
                        ),
                    }
                }
            };
            Ok((c.clone(), server))
        }
        None => match known.as_slice() {
            [] => bail!("career: no career data in this database — run `eqlog career import` first"),
            [(c, s)] => Ok((c.clone(), s.clone())),
            many => bail!(
                "career: multiple characters in this database ({}); pass --character",
                many.iter()
                    .map(|(c, s)| if s.is_empty() {
                        c.clone()
                    } else {
                        format!("{c}@{s}")
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        },
    }
}

/// Copper total → "1p 2g 3s 4c" (zero denominations omitted; bare "0c" for 0).
fn fmt_coin(copper: i64) -> String {
    let neg = copper < 0;
    let mut c = copper.unsigned_abs();
    let p = c / 1000;
    c %= 1000;
    let g = c / 100;
    c %= 100;
    let s = c / 10;
    c %= 10;
    let mut parts = Vec::new();
    if p > 0 {
        parts.push(format!("{p}p"));
    }
    if g > 0 {
        parts.push(format!("{g}g"));
    }
    if s > 0 {
        parts.push(format!("{s}s"));
    }
    if c > 0 || parts.is_empty() {
        parts.push(format!("{c}c"));
    }
    format!("{}{}", if neg { "-" } else { "" }, parts.join(" "))
}

/// Log-domain epoch seconds → `YYYY-MM-DD HH:MM` (naive; the log's own local
/// clock — do NOT add timezone math). Days-from-civil inverse, per the
/// parser's month-lookup convention.
fn fmt_datetime(ts: i64) -> String {
    let days = ts.div_euclid(86_400);
    let secs = ts.rem_euclid(86_400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}",
        secs / 3600,
        (secs % 3600) / 60
    )
}

fn run_stats(args: &[String]) -> anyhow::Result<()> {
    let args = parse_stats_args(args)?;
    let store = CareerStore::open(&args.db)
        .with_context(|| format!("opening career store {}", args.db.display()))?;
    let (character, server) = resolve_identity(&store, &args.character, &args.server)?;
    let Some(summary) = store.summary(&character, &server)? else {
        bail!(
            "career: no career data for {character}{} — run `eqlog career import` first",
            if server.is_empty() {
                String::new()
            } else {
                format!(" @ {server}")
            }
        );
    };
    let (total, sessions) = store.sessions(&character, &server, args.sessions, 0)?;

    let stdout = std::io::stdout();
    let mut out = BufWriter::new(stdout.lock());
    if args.json {
        let doc = serde_json::json!({ "summary": summary, "sessions": sessions });
        writeln!(out, "{}", serde_json::to_string_pretty(&doc)?)?;
        out.flush()?;
        return Ok(());
    }

    let who = if summary.server.is_empty() {
        summary.character.clone()
    } else {
        format!("{} @ {}", summary.character, summary.server)
    };
    writeln!(out, "Career — {who}")?;
    if let (Some(first), Some(last)) = (summary.first_ts, summary.last_ts) {
        writeln!(
            out,
            "  {} sessions · {} played · {} .. {}",
            summary.sessions,
            util::fmt_duration(summary.total_duration_secs.max(0) as u64),
            fmt_datetime(first),
            fmt_datetime(last),
        )?;
    }
    let level = summary
        .end_level
        .map_or_else(|| "-".to_string(), |l| l.to_string());
    writeln!(
        out,
        "  kills {} · deaths {} · xp {:.1}% · level-ups {} (level {level}) · AA {}",
        summary.kills, summary.deaths, summary.xp_percent, summary.level_ups, summary.aa_points,
    )?;
    writeln!(
        out,
        "  loot {} · coin {} · skill-ups {}",
        summary.loot_count,
        fmt_coin(summary.coin_copper),
        summary.skill_ups,
    )?;
    writeln!(out)?;
    writeln!(
        out,
        "Last {} of {} session(s):",
        sessions.len().min(args.sessions as usize),
        total
    )?;
    writeln!(
        out,
        "  {:<16} {:>8} {:>6} {:>7} {:>6} {:>9}  zones",
        "start", "dur", "kills", "xp%", "loot", "coin"
    )?;
    for s in &sessions {
        writeln!(
            out,
            "  {:<16} {:>8} {:>6} {:>7.1} {:>6} {:>9}  {}",
            fmt_datetime(s.start_ts),
            util::fmt_duration(s.duration_secs.max(0) as u64),
            s.kills,
            s.xp_percent,
            s.loot_count,
            fmt_coin(s.coin_copper),
            s.zones.join(", "),
        )?;
    }
    out.flush()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// career reset
// ---------------------------------------------------------------------------

struct ResetArgs {
    db: PathBuf,
    character: String,
    server: Option<String>,
    yes: bool,
}

fn parse_reset_args(args: &[String]) -> anyhow::Result<ResetArgs> {
    let mut db = PathBuf::from(DEFAULT_DB);
    let mut character: Option<String> = None;
    let mut server: Option<String> = None;
    let mut yes = false;
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--db" => {
                db = PathBuf::from(it.next().context("career reset: --db requires a path")?);
            }
            "--character" => {
                character = Some(
                    it.next()
                        .context("career reset: --character requires a value")?
                        .clone(),
                );
            }
            "--server" => {
                server = Some(
                    it.next()
                        .context("career reset: --server requires a value")?
                        .clone(),
                );
            }
            "--yes" => yes = true,
            other => bail!("career reset: unknown argument `{other}`"),
        }
    }
    let character = character.context("career reset: --character NAME is required")?;
    Ok(ResetArgs {
        db,
        character,
        server,
        yes,
    })
}

fn run_reset(args: &[String]) -> anyhow::Result<()> {
    let args = parse_reset_args(args)?;
    let mut store = CareerStore::open(&args.db)
        .with_context(|| format!("opening career store {}", args.db.display()))?;
    let (character, server) =
        resolve_identity(&store, &Some(args.character.clone()), &args.server)?;
    let who = if server.is_empty() {
        character.clone()
    } else {
        format!("{character} @ {server}")
    };
    if !args.yes {
        eprint!("Delete ALL career data and import watermarks for {who}? [y/N] ");
        let mut answer = String::new();
        std::io::stdin()
            .read_line(&mut answer)
            .context("career reset: reading confirmation")?;
        if !matches!(answer.trim(), "y" | "Y" | "yes") {
            println!("aborted; nothing deleted");
            return Ok(());
        }
    }
    let removed = store.reset_character(&character, &server)?;
    println!("removed {removed} career row(s) for {who}");
    Ok(())
}
