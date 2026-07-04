//! Shared trigger-library plumbing for the CLI subcommands: full-library
//! loading (`triggers/` + `triggers/curated/` + `triggers/generated/`),
//! class-name parsing/validation, the spell→classes map derived from
//! `fixtures/local/spell_summary.json`, and log-driven class auto-detect.

use std::collections::HashMap;
use std::path::Path;

use anyhow::{bail, Context};
use serde::Deserialize;

use eqlog_core::events::{Entity, Event};
use eqlog_core::parser::Parser;
use eqlog_triggers::{detect_classes, load_packs, ClassDetection, Trigger, TriggerPack};

use crate::util;

/// The 16 Legends classes, canonical spelling (matches trigger `classes`
/// tags and profile JSON).
pub const CLASS_NAMES: [&str; 16] = [
    "Warrior",
    "Cleric",
    "Paladin",
    "Ranger",
    "ShadowKnight",
    "Druid",
    "Monk",
    "Bard",
    "Rogue",
    "Shaman",
    "Necromancer",
    "Wizard",
    "Magician",
    "Enchanter",
    "Beastlord",
    "Berserker",
];

/// Root of the on-disk trigger library (relative to the working directory).
pub const LIBRARY_DIR: &str = "triggers";
/// Single-pack fallback when the library directory is absent.
pub const DEFAULT_TRIGGER_PACK: &str = "triggers/default.json";
/// Default spell-data summary used to build the spell→classes map.
pub const DEFAULT_SPELL_SUMMARY: &str = "fixtures/local/spell_summary.json";

/// Canonical spelling for a class name, matched case-insensitively.
pub fn canonical_class(name: &str) -> Option<&'static str> {
    CLASS_NAMES
        .iter()
        .find(|c| c.eq_ignore_ascii_case(name))
        .copied()
}

/// Parse a `--classes A,B,C` value: up to 3 distinct class names, each
/// validated against [`CLASS_NAMES`] (case-insensitive).
pub fn parse_classes(arg: &str) -> anyhow::Result<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for raw in arg.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        let Some(class) = canonical_class(raw) else {
            bail!(
                "unknown class `{raw}` (expected one of: {})",
                CLASS_NAMES.join(", ")
            );
        };
        if !out.iter().any(|c| c == class) {
            out.push(class.to_string());
        }
    }
    if out.is_empty() {
        bail!("--classes requires at least one class name");
    }
    if out.len() > 3 {
        bail!("--classes takes at most 3 class names (Legends characters are tri-class)");
    }
    Ok(out)
}

/// Load a single trigger pack file: either the `TriggerPack {name, triggers}`
/// shape or a bare `[Trigger, ...]` array.
pub fn load_pack_file(path: &Path) -> anyhow::Result<Vec<Trigger>> {
    let text = util::read_to_string(path)?;
    if let Ok(pack) = serde_json::from_str::<TriggerPack>(&text) {
        return Ok(pack.triggers);
    }
    let triggers: Vec<Trigger> = serde_json::from_str(&text)
        .with_context(|| format!("{} is not a trigger pack", path.display()))?;
    Ok(triggers)
}

/// Load the trigger library. With `single_pack` set, load just that file
/// (must exist). Otherwise merge every pack under [`LIBRARY_DIR`]
/// (recursively — default.json, curated/, generated/); if the directory is
/// missing fall back to [`DEFAULT_TRIGGER_PACK`], then to an empty library.
/// Returns the merged triggers plus non-fatal load warnings.
pub fn load_library(single_pack: Option<&Path>) -> anyhow::Result<(Vec<Trigger>, Vec<String>)> {
    if let Some(path) = single_pack {
        return Ok((load_pack_file(path)?, Vec::new()));
    }
    let dir = Path::new(LIBRARY_DIR);
    if dir.is_dir() {
        let loaded = load_packs(dir)
            .with_context(|| format!("loading trigger library from {}", dir.display()))?;
        return Ok((loaded.triggers, loaded.warnings));
    }
    let default = Path::new(DEFAULT_TRIGGER_PACK);
    if default.exists() {
        return Ok((load_pack_file(default)?, Vec::new()));
    }
    Ok((Vec::new(), Vec::new()))
}

/// Print library-load warnings to stderr, capped so a broken directory does
/// not flood the terminal.
pub fn print_warnings(label: &str, warnings: &[String]) {
    const CAP: usize = 10;
    for warning in warnings.iter().take(CAP) {
        eprintln!("{}warning:{} {label}: {warning}", util::YELLOW, util::RESET);
    }
    if warnings.len() > CAP {
        eprintln!(
            "{}warning:{} {label}: … and {} more",
            util::YELLOW,
            util::RESET,
            warnings.len() - CAP
        );
    }
}

// ---- spell→classes map ----------------------------------------------------

#[derive(Deserialize)]
struct SpellSummary {
    #[serde(default)]
    spells: Vec<SpellRow>,
}

#[derive(Deserialize)]
struct SpellRow {
    name: String,
    /// Lowercase class name → level the class gets the spell.
    #[serde(default)]
    classes: HashMap<String, u32>,
}

/// Build the spell→classes map from a `spell_summary.json` (the extractor's
/// output in `fixtures/local/`). Spells sharing a name across ranks merge to
/// the union of their classes; class names are canonicalized to
/// [`CLASS_NAMES`] spelling and sorted for determinism.
pub fn load_spell_classes(path: &Path) -> anyhow::Result<HashMap<String, Vec<String>>> {
    let text = util::read_to_string(path)?;
    let summary: SpellSummary = serde_json::from_str(&text)
        .with_context(|| format!("{} is not a spell summary", path.display()))?;
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    for row in summary.spells {
        if row.classes.is_empty() {
            continue;
        }
        let entry = map.entry(row.name).or_default();
        for key in row.classes.keys() {
            if let Some(class) = canonical_class(key) {
                if !entry.iter().any(|c| c == class) {
                    entry.push(class.to_string());
                }
            }
        }
    }
    map.retain(|_, classes| !classes.is_empty());
    for classes in map.values_mut() {
        classes.sort();
    }
    Ok(map)
}

/// Distinct spell names the character cast in a log ("You begin casting X."
/// lines), in first-seen order.
pub fn cast_spells_in_log(path: &Path) -> anyhow::Result<Vec<String>> {
    let parser = Parser::new();
    let mut seen: Vec<String> = Vec::new();
    util::for_each_line(path, |raw| {
        if let Some(parsed) = parser.parse_line(raw) {
            if let Event::CastBegin {
                caster: Entity::You,
                spell,
            } = &parsed.event
            {
                if !seen.iter().any(|s| s.eq_ignore_ascii_case(spell)) {
                    seen.push(spell.clone());
                }
            }
        }
        Ok(())
    })?;
    Ok(seen)
}

/// Run class auto-detect over a log: scan for the character's cast spells,
/// look them up in the spell→classes map from `spells_path`, and return both
/// the distinct cast spell names and the detection result.
pub fn detect_from_log(
    log: &Path,
    spells_path: &Path,
) -> anyhow::Result<(Vec<String>, ClassDetection)> {
    let map = load_spell_classes(spells_path)
        .with_context(|| format!("loading spell data from {}", spells_path.display()))?;
    let cast = cast_spells_in_log(log)?;
    let refs: Vec<&str> = cast.iter().map(String::as_str).collect();
    let detection = detect_classes(&refs, &map);
    Ok((cast, detection))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_classes_validates_and_canonicalizes() {
        assert_eq!(
            parse_classes("necromancer, SHAMAN,Warrior").unwrap(),
            vec!["Necromancer", "Shaman", "Warrior"]
        );
        assert!(parse_classes("Necromancer,Shaman,Warrior,Cleric").is_err());
        assert!(parse_classes("Ninja").is_err());
        assert!(parse_classes("").is_err());
        // Duplicates collapse.
        assert_eq!(parse_classes("Monk,monk").unwrap(), vec!["Monk"]);
    }

    #[test]
    fn canonical_class_spellings() {
        assert_eq!(canonical_class("shadowknight"), Some("ShadowKnight"));
        assert_eq!(canonical_class("Beastlord"), Some("Beastlord"));
        assert_eq!(canonical_class("wizzard"), None);
    }
}
