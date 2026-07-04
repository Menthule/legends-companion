//! `eqlog share export|import` — sharing v1 from the terminal.
//!
//! - `export <pack.json> [--name LABEL] [--gtp OUT.gtp]` prints an `LCS1:`
//!   share string for a trigger pack file; `--gtp` also writes a
//!   GINA-compatible archive for cross-tool sharing.
//! - `import <STRING|FILE> [--out PACK.json]` decodes a share string
//!   (given inline or as a file containing one) into a trigger pack,
//!   deduping id collisions against the local trigger library.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context};
use eqlog_triggers::{export_gtp, export_string, parse_string, SharePayload, TriggerPack};

use crate::triggerlib;
use crate::util;

pub fn run(args: &[String]) -> anyhow::Result<()> {
    match args.split_first() {
        Some((sub, rest)) if sub == "export" => run_export(rest),
        Some((sub, rest)) if sub == "import" => run_import(rest),
        _ => bail!("share: expected `export <pack.json>` or `import <STRING|FILE>`"),
    }
}

fn run_export(args: &[String]) -> anyhow::Result<()> {
    let mut file: Option<PathBuf> = None;
    let mut name: Option<String> = None;
    let mut gtp: Option<PathBuf> = None;

    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--name" => {
                name = Some(
                    it.next()
                        .context("share export: --name requires a value")?
                        .clone(),
                );
            }
            "--gtp" => {
                gtp = Some(PathBuf::from(
                    it.next().context("share export: --gtp requires a path")?,
                ));
            }
            other if other.starts_with("--") => bail!("share export: unknown flag `{other}`"),
            other => {
                if file.replace(PathBuf::from(other)).is_some() {
                    bail!("share export: more than one <pack.json> given");
                }
            }
        }
    }
    let file = file.context("share export: missing <pack.json> argument")?;

    let triggers = triggerlib::load_pack_file(&file)?;
    if triggers.is_empty() {
        bail!("share export: {} contains no triggers", file.display());
    }
    let name = name
        .or_else(|| pack_name(&file))
        .or_else(|| file.file_stem().map(|s| s.to_string_lossy().into_owned()));

    let payload = SharePayload {
        name: name.clone(),
        triggers,
    };
    println!("{}", export_string(&payload));
    eprintln!(
        "share export: {} trigger(s) from {}",
        payload.triggers.len(),
        file.display()
    );

    if let Some(gtp_path) = gtp {
        let label = name.as_deref().unwrap_or("Legends Companion Export");
        let bytes = export_gtp(label, &payload.triggers)
            .with_context(|| format!("building GINA archive {}", gtp_path.display()))?;
        std::fs::write(&gtp_path, bytes)
            .with_context(|| format!("writing {}", gtp_path.display()))?;
        eprintln!("share export: wrote GINA package {}", gtp_path.display());
    }
    Ok(())
}

/// Pack name from a `TriggerPack {name, triggers}` file (None for the bare
/// `[Trigger, ...]` array shape).
fn pack_name(path: &Path) -> Option<String> {
    let text = util::read_to_string(path).ok()?;
    serde_json::from_str::<TriggerPack>(&text)
        .ok()
        .map(|p| p.name)
        .filter(|n| !n.is_empty())
}

fn run_import(args: &[String]) -> anyhow::Result<()> {
    let mut input: Option<String> = None;
    let mut out: Option<PathBuf> = None;

    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--out" => {
                out = Some(PathBuf::from(
                    it.next().context("share import: --out requires a path")?,
                ));
            }
            other if other.starts_with("--") => bail!("share import: unknown flag `{other}`"),
            other => {
                if input.replace(other.to_string()).is_some() {
                    bail!("share import: more than one <STRING|FILE> given");
                }
            }
        }
    }
    let input = input.context("share import: missing <STRING|FILE> argument")?;

    // Inline share string, or a file containing one.
    let text = if input.trim_start().starts_with(eqlog_triggers::SHARE_PREFIX) {
        input
    } else {
        util::read_to_string(Path::new(&input)).with_context(|| {
            format!("share import: `{input}` is neither an LCS1: string nor a readable file")
        })?
    };

    // Dedupe against the local library's ids when one is present (same
    // collision behavior the app applies on paste-import).
    let existing: HashSet<String> = match triggerlib::load_library(None) {
        Ok((triggers, _warnings)) => triggers.iter().map(|t| t.effective_id()).collect(),
        Err(_) => HashSet::new(),
    };

    let import = parse_string(&text, &existing).context("share import failed")?;
    for (from, to) in &import.renamed {
        eprintln!("share import: id `{from}` already taken -> `{to}`");
    }
    eprintln!(
        "share import: {} trigger(s){}",
        import.triggers.len(),
        import
            .name
            .as_deref()
            .map(|n| format!(" from bundle \"{n}\""))
            .unwrap_or_default()
    );

    let pack = TriggerPack {
        name: import.name.unwrap_or_else(|| "Shared import".to_string()),
        triggers: import.triggers,
    };
    let json = serde_json::to_string_pretty(&pack).expect("pack serialization is infallible");
    match out {
        Some(path) => {
            std::fs::write(&path, json).with_context(|| format!("writing {}", path.display()))?;
            eprintln!("share import: wrote {}", path.display());
        }
        None => println!("{json}"),
    }
    Ok(())
}
