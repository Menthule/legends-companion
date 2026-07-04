//! Append-only `app.log` in the app config dir — the observability sink for
//! everything that used to vanish into `eprintln!` (invisible in a windowed
//! Windows app): engine/pack warnings, tail-session errors, auto-resume
//! failures, store problems.
//!
//! Plain std-fs implementation (no new dependencies): each write appends one
//! timestamped line; when the file passes [`MAX_LOG_BYTES`] it rotates to
//! `app.log.1` (one previous generation kept, so at most ~2 MB on disk).

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// Rotate when `app.log` exceeds this size.
const MAX_LOG_BYTES: u64 = 1024 * 1024;
const ROTATED_NAME: &str = "app.log.1";

/// Full path of `app.log`; `None` until [`init`] runs (writes before then
/// only reach stderr, which matches the old behavior).
static LOG_FILE: OnceLock<PathBuf> = OnceLock::new();
/// Serializes rotate+append across the UI and tail threads.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Remember where `app.log` lives (the full file path). Call once, early in
/// setup — the caller passes `DataRoot::app_log()`.
pub fn init(path: PathBuf) {
    let _ = LOG_FILE.set(path);
}

/// Log a warning: stderr (dev runs) plus `app.log` (installed runs).
pub fn warn(msg: &str) {
    eprintln!("legends-companion: {msg}");
    append("WARN", msg);
}

/// Log an informational line to `app.log` only.
pub fn info(msg: &str) {
    append("INFO", msg);
}

fn append(level: &str, msg: &str) {
    let Some(path) = LOG_FILE.get() else {
        return;
    };
    // A poisoned lock only means another thread panicked mid-write; keep
    // logging (that panic is exactly what we want recorded).
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    rotate_if_needed(dir, path);
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "[{}] {level} {msg}", utc_timestamp());
    }
}

fn rotate_if_needed(dir: &std::path::Path, path: &std::path::Path) {
    let too_big = fs::metadata(path)
        .map(|m| m.len() >= MAX_LOG_BYTES)
        .unwrap_or(false);
    if too_big {
        // std rename replaces an existing destination on both Windows and
        // Unix, so the previous `.1` generation is dropped atomically.
        let _ = fs::rename(path, dir.join(ROTATED_NAME));
    }
}

/// `YYYY-MM-DD HH:MM:SSZ` from the system clock, std-only.
fn utc_timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let tod = secs % 86_400;
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}Z",
        tod / 3600,
        (tod % 3600) / 60,
        tod % 60
    )
}

/// Days-since-epoch → (year, month, day); Howard Hinnant's civil_from_days.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_from_days_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1)); // 2024-01-01
        assert_eq!(civil_from_days(20_637), (2026, 7, 3)); // 2026-07-03
    }
}
