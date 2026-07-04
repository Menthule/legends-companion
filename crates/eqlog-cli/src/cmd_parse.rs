//! `eqlog parse <file> [--json]` — batch parse with coverage summary or
//! NDJSON output.

use std::collections::HashMap;
use std::io::{BufWriter, Write};
use std::path::PathBuf;

use anyhow::{bail, Context};
use eqlog_core::events::Event;
use eqlog_core::parser::Parser;

use crate::util;

struct Args {
    file: PathBuf,
    json: bool,
}

fn parse_args(args: &[String]) -> anyhow::Result<Args> {
    let mut file: Option<PathBuf> = None;
    let mut json = false;
    for arg in args {
        match arg.as_str() {
            "--json" => json = true,
            other if other.starts_with("--") => bail!("parse: unknown flag `{other}`"),
            other => {
                if file.replace(PathBuf::from(other)).is_some() {
                    bail!("parse: more than one <file> given");
                }
            }
        }
    }
    let file = file.context("parse: missing <file> argument")?;
    Ok(Args { file, json })
}

pub fn run(args: &[String]) -> anyhow::Result<()> {
    let args = parse_args(args)?;
    let parser = Parser::new();

    let stdout = std::io::stdout();
    let mut out = BufWriter::new(stdout.lock());

    let mut total: u64 = 0;
    let mut classified: u64 = 0;
    let mut histogram: HashMap<&'static str, u64> = HashMap::new();
    let mut unclassified_shapes: HashMap<String, u64> = HashMap::new();

    util::for_each_line(&args.file, |raw| {
        if raw.is_empty() {
            return Ok(());
        }
        total += 1;
        match parser.parse_line(raw) {
            Some(parsed) => {
                if !matches!(parsed.event, Event::Unclassified) {
                    classified += 1;
                } else {
                    *unclassified_shapes
                        .entry(util::digits_to_n(&parsed.line.message))
                        .or_insert(0) += 1;
                }
                if args.json {
                    serde_json::to_writer(&mut out, &parsed)?;
                    out.write_all(b"\n")?;
                } else {
                    *histogram
                        .entry(util::event_kind(&parsed.event))
                        .or_insert(0) += 1;
                }
            }
            None => {
                // No timestamp prefix: counts against coverage.
                *unclassified_shapes
                    .entry(util::digits_to_n(raw))
                    .or_insert(0) += 1;
                if !args.json {
                    *histogram.entry("NoTimestamp").or_insert(0) += 1;
                }
            }
        }
        Ok(())
    })?;

    if args.json {
        out.flush()?;
        return Ok(());
    }

    let coverage = if total > 0 {
        classified as f64 * 100.0 / total as f64
    } else {
        100.0
    };

    writeln!(out, "file:       {}", args.file.display())?;
    writeln!(out, "lines:      {total}")?;
    writeln!(out, "classified: {classified} ({coverage:.2}%)")?;
    writeln!(out)?;
    writeln!(out, "event histogram:")?;
    let mut kinds: Vec<(&str, u64)> = histogram.into_iter().collect();
    kinds.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    for (kind, count) in &kinds {
        let pct = *count as f64 * 100.0 / total.max(1) as f64;
        writeln!(out, "  {kind:<18} {count:>8}  {pct:>6.2}%")?;
    }

    if !unclassified_shapes.is_empty() {
        writeln!(out)?;
        writeln!(out, "top unclassified shapes (digits -> N):")?;
        let mut shapes: Vec<(String, u64)> = unclassified_shapes.into_iter().collect();
        shapes.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        for (shape, count) in shapes.iter().take(20) {
            writeln!(out, "  {count:>6}  {shape}")?;
        }
    }
    out.flush()?;
    Ok(())
}
