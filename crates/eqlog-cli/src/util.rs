//! Shared helpers: lossy line iteration, event-kind names, timestamp
//! formatting, and a tiny ANSI palette.

use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

use anyhow::Context;
use eqlog_core::events::Event;

/// Iterate a log file line by line, tolerating non-UTF8 bytes (lossy) and
/// stripping trailing CR/LF.
pub fn for_each_line(
    path: &Path,
    mut f: impl FnMut(&str) -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    let file = File::open(path).with_context(|| format!("opening {}", path.display()))?;
    let mut reader = BufReader::new(file);
    let mut buf = Vec::with_capacity(256);
    loop {
        buf.clear();
        let n = reader
            .read_until(b'\n', &mut buf)
            .with_context(|| format!("reading {}", path.display()))?;
        if n == 0 {
            return Ok(());
        }
        while matches!(buf.last(), Some(b'\n') | Some(b'\r')) {
            buf.pop();
        }
        let line = String::from_utf8_lossy(&buf);
        f(&line)?;
    }
}

/// Read a whole file to a string (for trigger packs).
pub fn read_to_string(path: &Path) -> anyhow::Result<String> {
    let mut s = String::new();
    File::open(path)
        .with_context(|| format!("opening {}", path.display()))?
        .read_to_string(&mut s)
        .with_context(|| format!("reading {}", path.display()))?;
    Ok(s)
}

/// Stable short name for an event variant (histogram keys, tail prefixes).
pub fn event_kind(event: &Event) -> &'static str {
    match event {
        Event::MeleeHit { .. } => "MeleeHit",
        Event::MeleeMiss { .. } => "MeleeMiss",
        Event::SpellDamage { .. } => "SpellDamage",
        Event::SpellDamageTaken { .. } => "SpellDamageTaken",
        Event::NonMeleeDamage { .. } => "NonMeleeDamage",
        Event::Heal { .. } => "Heal",
        Event::CastBegin { .. } => "CastBegin",
        Event::CastInterrupted { .. } => "CastInterrupted",
        Event::CastFizzled { .. } => "CastFizzled",
        Event::Resisted { .. } => "Resisted",
        Event::WornOff { .. } => "WornOff",
        Event::Slain { .. } => "Slain",
        Event::Loot { .. } => "Loot",
        Event::Roll { .. } => "Roll",
        Event::Chat { .. } => "Chat",
        Event::XpGain { .. } => "XpGain",
        Event::LevelUp { .. } => "LevelUp",
        Event::Faction { .. } => "Faction",
        Event::ZoneEnter { .. } => "ZoneEnter",
        Event::Loading => "Loading",
        Event::Stunned { .. } => "Stunned",
        Event::Location { .. } => "Location",
        Event::System => "System",
        Event::Unclassified => "Unclassified",
    }
}

/// Format an epoch timestamp (parsed from the log's naive local time) back
/// to `HH:MM:SS`. The parser treats the asctime prefix as UTC-naive, so the
/// time-of-day survives a plain modulo round trip.
pub fn fmt_clock(ts: i64) -> String {
    let secs = ts.rem_euclid(86_400);
    format!(
        "{:02}:{:02}:{:02}",
        secs / 3600,
        (secs % 3600) / 60,
        secs % 60
    )
}

/// Format a duration in seconds as `MM:SS` (or `H:MM:SS` when long).
pub fn fmt_duration(secs: u64) -> String {
    if secs >= 3600 {
        format!("{}:{:02}:{:02}", secs / 3600, (secs % 3600) / 60, secs % 60)
    } else {
        format!("{}:{:02}", secs / 60, secs % 60)
    }
}

/// Collapse digit runs to `N` so unclassified lines group by shape.
pub fn digits_to_n(message: &str) -> String {
    let mut out = String::with_capacity(message.len());
    let mut in_digits = false;
    for c in message.chars() {
        if c.is_ascii_digit() {
            if !in_digits {
                out.push('N');
                in_digits = true;
            }
        } else {
            in_digits = false;
            out.push(c);
        }
    }
    out
}

// ---- ANSI ---------------------------------------------------------------

pub const RESET: &str = "\x1b[0m";
pub const BOLD: &str = "\x1b[1m";
pub const DIM: &str = "\x1b[2m";
pub const RED: &str = "\x1b[31m";
pub const GREEN: &str = "\x1b[32m";
pub const YELLOW: &str = "\x1b[33m";
pub const BLUE: &str = "\x1b[34m";
pub const MAGENTA: &str = "\x1b[35m";
pub const CYAN: &str = "\x1b[36m";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digits_collapse_to_single_n() {
        assert_eq!(
            digits_to_n("You gain experience! (2.429%)"),
            "You gain experience! (N.N%)"
        );
        assert_eq!(digits_to_n("hits for 12345 points"), "hits for N points");
        assert_eq!(digits_to_n("no digits"), "no digits");
    }

    #[test]
    fn clock_round_trips_time_of_day() {
        // 23:32:46
        let ts = 86_400 * 20_000 + 23 * 3600 + 32 * 60 + 46;
        assert_eq!(fmt_clock(ts), "23:32:46");
    }

    #[test]
    fn duration_formats() {
        assert_eq!(fmt_duration(34), "0:34");
        assert_eq!(fmt_duration(754), "12:34");
        assert_eq!(fmt_duration(3661), "1:01:01");
    }
}
