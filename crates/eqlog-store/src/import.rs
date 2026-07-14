//! The career importer: file IO, `eqlog_core::parser::Parser` replay, the
//! session-segmentation fold, and the two-layer watermark dedupe protocol
//! (docs/career-db-design.md §2–§3).
//!
//! Invariant: no career row is ever written twice for the same log content.
//! Layer 1 is a per-file byte watermark (`import_files`): a verified resume
//! parses only new bytes, so no line is ever parsed twice. Layer 2 is the
//! per-character time floor (`career_watermarks.max_ts`): whenever Layer 1
//! restarts from byte 0, lines with `ts <= max_ts` are parsed but not folded.
//!
//! Timestamp domain: everything here is LOG-DOMAIN (naive-local-as-UTC epoch
//! seconds). DST caveat (accepted, documented in the design + the DST test):
//! fall-back can shorten a spanning session by up to 1 h; spring-forward can
//! lengthen one or split it via a phantom >gap gap. Never double-counts —
//! bytes, not time, are the dedupe authority.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use eqlog_core::events::{Coins, Entity, Event};
use eqlog_core::parser::Parser;
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::career::CareerStore;
use crate::StoreError;

/// Default session-split gap: 30 minutes (docs/career-db-design.md §3 —
/// grounded in the measured gap distribution of the full fixture log).
pub const DEFAULT_GAP_SECS: i64 = 30 * 60;

/// A segment shorter than this with zero activity is a login-check blip and
/// is discarded (§3).
const MIN_SESSION_SECS: i64 = 60;

/// Hash at most this many leading bytes for the file-identity check.
const PREFIX_HASH_MAX: u64 = 64 * 1024;

/// Call the progress callback roughly every this many bytes read.
const PROGRESS_STRIDE: u64 = 64 * 1024;

/// Options for [`CareerStore::import_file`].
#[derive(Debug, Clone)]
pub struct ImportOptions {
    /// `None` => parse from the `eqlog_<Character>_<server>.txt` filename;
    /// error if neither yields a character.
    pub character: Option<String>,
    /// `None` => parse from the filename; `""` is allowed (serverless log).
    pub server: Option<String>,
    /// Gap that splits sessions, in seconds.
    pub gap_secs: i64,
    /// Parse and segment but write nothing.
    pub dry_run: bool,
}

impl Default for ImportOptions {
    fn default() -> Self {
        ImportOptions {
            character: None,
            server: None,
            gap_secs: DEFAULT_GAP_SECS,
            dry_run: false,
        }
    }
}

/// Progress callback payload (called at most ~every 64 KiB read, plus once
/// at the end of the read phase).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    pub file: String,
    pub bytes_read: u64,
    pub bytes_total: u64,
    pub lines_read: u64,
    pub sessions_found: u64,
}

/// Per-file import outcome. Field names serialize camelCase — the wire shape
/// of the frontend's `CareerImportReport`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub file: String,
    pub character: String,
    pub server: String,
    pub lines_read: u64,
    /// Layer-2 floor skips (parsed but not folded).
    pub lines_skipped: u64,
    pub sessions_added: u64,
    /// Trailing-session reopens (0 or 1).
    pub sessions_updated: u64,
    pub level_ups_added: u64,
    pub loot_added: u64,
    pub kills_added: u64,
    /// The whole file was a no-op.
    pub skipped: bool,
    pub skip_reason: Option<String>,
}

/// Mirror of `eqlog_triggers::storage::parse_log_filename` (kept local so
/// eqlog-store gains no crate edge on eqlog-triggers — the design forbids new
/// edges). `eqlog_<Character>_<server>.txt` → (character, server); a
/// serverless `eqlog_Name.txt` yields an empty server.
fn parse_log_filename(name: &str) -> Option<(String, String)> {
    let rest = name.strip_prefix("eqlog_")?.strip_suffix(".txt")?;
    let (character, server) = match rest.split_once('_') {
        Some((c, s)) => (c, s),
        None => (rest, ""),
    };
    if character.is_empty() {
        return None;
    }
    Some((character.to_string(), server.to_string()))
}

/// The live `/^[A-Z][a-z]+$/` groupmate heuristic from `lib/sessionLog.ts`:
/// one capitalized ASCII word is a player (a dead groupmate, not a camp
/// kill); mobs carry articles or multiple words.
fn is_player_shaped(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_uppercase() => {}
        _ => return false,
    }
    let mut rest = 0usize;
    for c in chars {
        if !c.is_ascii_lowercase() {
            return false;
        }
        rest += 1;
    }
    rest > 0
}

/// Copper breakdown persisted as `sessions.coin_json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct CoinBreakdown {
    #[serde(default)]
    corpse: i64,
    #[serde(default)]
    vendor: i64,
    #[serde(default)]
    item: i64,
    #[serde(default, rename = "soldLoot")]
    sold_loot: i64,
}

impl CoinBreakdown {
    fn total(&self) -> i64 {
        self.corpse + self.vendor + self.item + self.sold_loot
    }
}

/// A loot event buffered for insertion.
#[derive(Debug, Clone)]
struct LootEvent {
    ts: i64,
    item: String,
    quantity: u32,
    corpse: Option<String>,
    looter: String,
    sold_for_copper: Option<i64>,
}

/// One session being accumulated by the fold.
#[derive(Debug, Default)]
struct SessionAcc {
    /// `Some(rowid)` when this reopens the previous run's trailing session.
    reopen_id: Option<i64>,
    start_ts: i64,
    end_ts: i64,
    zones: Vec<String>,
    kills: u64,
    deaths: u64,
    xp_percent: f64,
    party_xp_percent: f64,
    /// Pre-existing count when reopened (raw rows already inserted).
    prior_level_ups: u64,
    new_level_ups: Vec<(i64, u32)>,
    end_level: Option<u32>,
    aa_points: u64,
    coin: CoinBreakdown,
    skill_ups: u64,
    prior_loot: u64,
    new_loot: Vec<LootEvent>,
    /// Kills folded THIS run (upsert-added for a reopened session).
    mob_kills: HashMap<String, u64>,
}

impl SessionAcc {
    fn new(ts: i64) -> SessionAcc {
        SessionAcc {
            start_ts: ts,
            end_ts: ts,
            ..SessionAcc::default()
        }
    }

    fn fold(&mut self, ts: i64, event: &Event, character: &str) {
        self.end_ts = self.end_ts.max(ts);
        match event {
            Event::ZoneEnter { zone } => {
                if !self.zones.iter().any(|z| z == zone) {
                    self.zones.push(zone.clone());
                }
            }
            Event::Slain { victim, .. } => match victim {
                Entity::You => self.deaths += 1,
                Entity::Named(name) => {
                    // Player-shaped one-word names are dead groupmates, not
                    // camp kills. Kills count regardless of killer so camp
                    // counts survive group play (§3).
                    if !is_player_shaped(name) {
                        self.kills += 1;
                        *self.mob_kills.entry(name.clone()).or_insert(0) += 1;
                    }
                }
            },
            Event::XpGain { percent, party } => {
                self.xp_percent += percent;
                if *party {
                    self.party_xp_percent += percent;
                }
            }
            Event::LevelUp { level } => {
                self.new_level_ups.push((ts, *level));
                self.end_level = Some(self.end_level.map_or(*level, |l| l.max(*level)));
            }
            Event::AaPointGain { points, .. } => {
                self.aa_points += *points as u64;
            }
            Event::Money { kind, coins } => {
                let copper = coins.total_copper() as i64;
                match kind {
                    eqlog_core::events::MoneyKind::CorpseLoot => self.coin.corpse += copper,
                    eqlog_core::events::MoneyKind::VendorSale => self.coin.vendor += copper,
                    eqlog_core::events::MoneyKind::ItemSale => self.coin.item += copper,
                }
            }
            Event::Loot {
                looter,
                item,
                quantity,
                corpse,
                sold_for,
            } => {
                let sold_for_copper = sold_for.as_ref().map(|c: &Coins| c.total_copper() as i64);
                if looter == &Entity::You {
                    self.coin.sold_loot += sold_for_copper.unwrap_or(0);
                }
                self.new_loot.push(LootEvent {
                    ts,
                    item: item.clone(),
                    quantity: *quantity,
                    corpse: corpse.clone(),
                    looter: looter.name(character).to_string(),
                    sold_for_copper,
                });
            }
            Event::SkillUp { .. } => self.skill_ups += 1,
            _ => {}
        }
    }

    fn duration_secs(&self) -> i64 {
        self.end_ts - self.start_ts
    }

    /// New activity folded this run (a reopened session always had activity
    /// checked over its lifetime totals, which include prior_*).
    fn has_activity(&self) -> bool {
        self.kills > 0
            || self.deaths > 0
            || self.xp_percent != 0.0
            || self.prior_level_ups + self.new_level_ups.len() as u64 > 0
            || self.aa_points > 0
            || self.coin.total() != 0
            || self.skill_ups > 0
            || self.prior_loot + self.new_loot.len() as u64 > 0
    }

    /// Login-check blip: shorter than a minute with zero activity (§3).
    fn is_blip(&self) -> bool {
        self.duration_secs() < MIN_SESSION_SECS && !self.has_activity()
    }
}

/// Stored trailing-session row loaded for the reopen check.
struct TrailingSeed {
    id: i64,
    start_ts: i64,
    end_ts: i64,
    zones: Vec<String>,
    kills: u64,
    deaths: u64,
    xp_percent: f64,
    party_xp_percent: f64,
    level_ups: u64,
    end_level: Option<u32>,
    aa_points: u64,
    coin: CoinBreakdown,
    skill_ups: u64,
    loot_count: u64,
}

/// Stored per-file watermark row.
struct FileMark {
    id: i64,
    prefix_sha256: String,
    prefix_len: u64,
    byte_offset: u64,
    line_count: u64,
    last_ts: i64,
    last_session_id: Option<i64>,
}

fn io_err(path: &Path) -> impl Fn(std::io::Error) -> StoreError + '_ {
    move |source| StoreError::ImportIo {
        path: path.to_path_buf(),
        source,
    }
}

fn sha256_prefix(path: &Path, len: u64) -> Result<String, StoreError> {
    let mut file = File::open(path).map_err(io_err(path))?;
    let mut hasher = Sha256::new();
    let mut remaining = len;
    let mut buf = [0u8; 8192];
    while remaining > 0 {
        let want = remaining.min(buf.len() as u64) as usize;
        let n = file.read(&mut buf[..want]).map_err(io_err(path))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        remaining -= n as u64;
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn now_utc() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

impl CareerStore {
    /// Import one log file (watermark-resumed, transactional). `progress` is
    /// called at most ~every 64 KiB read. Not cancellable in v1. Idempotent:
    /// re-running only folds bytes appended since the last run.
    pub fn import_file(
        &mut self,
        path: &Path,
        opts: &ImportOptions,
        progress: &mut dyn FnMut(&ImportProgress),
    ) -> Result<ImportReport, StoreError> {
        let file_display = path.display().to_string();
        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        let parsed_name = parse_log_filename(file_name);
        let character = match (&opts.character, &parsed_name) {
            (Some(c), _) => c.clone(),
            (None, Some((c, _))) => c.clone(),
            (None, None) => {
                return Err(StoreError::Import(format!(
                    "cannot determine character: `{file_name}` is not an \
                     eqlog_<Character>_<server>.txt filename and no --character was given"
                )))
            }
        };
        let server = match (&opts.server, &parsed_name) {
            (Some(s), _) => s.clone(),
            (None, Some((_, s))) => s.clone(),
            (None, None) => String::new(),
        };
        if opts.gap_secs <= 0 {
            return Err(StoreError::Import("gap must be positive".to_string()));
        }

        let mut report = ImportReport {
            file: file_display.clone(),
            character: character.clone(),
            server: server.clone(),
            lines_read: 0,
            lines_skipped: 0,
            sessions_added: 0,
            sessions_updated: 0,
            level_ups_added: 0,
            loot_added: 0,
            kills_added: 0,
            skipped: false,
            skip_reason: None,
        };

        let file_len = std::fs::metadata(path).map_err(io_err(path))?.len();

        // ---- Layer 1: locate + verify the per-file byte watermark. ----
        let mark = self.load_file_mark(&character, &server, &file_display)?;
        let (mut start_offset, mut prior_lines, resumed) = match &mark {
            None => (0u64, 0u64, false),
            Some(m) => {
                let identity_ok = file_len >= m.byte_offset
                    && sha256_prefix(path, m.prefix_len.min(file_len))? == m.prefix_sha256;
                if identity_ok {
                    (m.byte_offset, m.line_count, true)
                } else {
                    // Truncation / rotation / replacement: a different
                    // stream. Restart from 0 under the Layer-2 floor.
                    (0, 0, false)
                }
            }
        };
        if resumed && start_offset == file_len {
            report.skipped = true;
            report.skip_reason = Some("no new content".to_string());
            if !opts.dry_run {
                if let Some(m) = &mark {
                    self.conn.execute(
                        "UPDATE import_files SET imported_at = ?1 WHERE id = ?2",
                        params![now_utc(), m.id],
                    )?;
                }
            }
            return Ok(report);
        }
        if start_offset > file_len {
            // Unreachable given the identity check, but never seek past EOF.
            start_offset = 0;
            prior_lines = 0;
        }

        // ---- Layer 2: the per-character time floor applies whenever we
        // start from byte 0 (fresh path or identity mismatch). A verified
        // byte-exact resume needs no floor — no line is parsed twice.
        let floor: Option<i64> = if start_offset == 0 {
            self.max_folded_ts(&character, &server)?
        } else {
            None
        };

        // Trailing-session reopen candidate: only meaningful on a verified
        // byte-exact resume of the same stream.
        let mut trailing: Option<TrailingSeed> = if resumed {
            match mark.as_ref().and_then(|m| m.last_session_id) {
                Some(id) => self.load_trailing_seed(id)?,
                None => None,
            }
        } else {
            None
        };

        // ---- Read + fold. ----
        let parser = Parser::new();
        let mut file = File::open(path).map_err(io_err(path))?;
        file.seek(SeekFrom::Start(start_offset))
            .map_err(io_err(path))?;
        let mut reader = BufReader::new(file);

        let mut consumed = start_offset; // offset AFTER the last complete line
        let mut buf: Vec<u8> = Vec::with_capacity(256);
        let mut cur: Option<SessionAcc> = None;
        let mut finished: Vec<SessionAcc> = Vec::new();
        let mut stale_trailing: Option<TrailingSeed> = None;
        let mut last_ts: Option<i64> = None;
        let mut next_progress = start_offset + PROGRESS_STRIDE;
        let mut first_event = true;

        loop {
            buf.clear();
            let n = reader.read_until(b'\n', &mut buf).map_err(io_err(path))?;
            if n == 0 {
                break;
            }
            if buf.last() != Some(&b'\n') {
                // Trailing partial line: not consumed; it re-parses next run
                // once complete.
                break;
            }
            consumed += n as u64;
            report.lines_read += 1;

            let text = String::from_utf8_lossy(&buf);
            let text = text.trim_end_matches(['\r', '\n']);
            if let Some(parsed) = parser.parse_line(text) {
                let ts = parsed.line.timestamp;
                if let Some(max_ts) = floor {
                    if ts <= max_ts {
                        report.lines_skipped += 1;
                        last_ts = Some(last_ts.map_or(ts, |t: i64| t.max(ts)));
                        continue;
                    }
                }
                if first_event {
                    first_event = false;
                    if let Some(seed) = trailing.take() {
                        if ts - seed.end_ts <= opts.gap_secs {
                            // Extend the previous run's trailing session
                            // instead of creating a phantom split at old EOF.
                            cur = Some(acc_from_seed(&seed));
                        } else {
                            // The trailing session is final; if it was a
                            // parked login-check blip, discard it now (§3's
                            // rule, deferred to the moment it became final).
                            stale_trailing = Some(seed);
                        }
                    }
                }
                match &mut cur {
                    Some(acc) => {
                        if ts - acc.end_ts > opts.gap_secs {
                            let done = cur.take().expect("session in progress");
                            if !done.is_blip() {
                                finished.push(done);
                            }
                            cur = Some(SessionAcc::new(ts));
                        }
                    }
                    None => cur = Some(SessionAcc::new(ts)),
                }
                let acc = cur.as_mut().expect("session started above");
                acc.fold(ts, &parsed.event, &character);
                last_ts = Some(last_ts.map_or(ts, |t: i64| t.max(ts)));
            }

            if consumed >= next_progress {
                next_progress = consumed + PROGRESS_STRIDE;
                progress(&ImportProgress {
                    file: file_display.clone(),
                    bytes_read: consumed,
                    bytes_total: file_len,
                    lines_read: report.lines_read,
                    sessions_found: finished.len() as u64 + cur.is_some() as u64,
                });
            }
        }
        progress(&ImportProgress {
            file: file_display.clone(),
            bytes_read: consumed,
            bytes_total: file_len,
            lines_read: report.lines_read,
            sessions_found: finished.len() as u64 + cur.is_some() as u64,
        });

        // The trailing session at EOF is ALWAYS kept (even a blip) so a
        // later resume can reopen and extend it; if it stays final and
        // blip-like, the next import discards it (stale_trailing above).
        let trailing_acc = cur.take();

        if trailing_acc.is_none() && finished.is_empty() && stale_trailing.is_none() {
            report.skipped = true;
            report.skip_reason = Some(if report.lines_skipped > 0 {
                "older than existing career data".to_string()
            } else {
                "no new content".to_string()
            });
        }

        if opts.dry_run {
            // Report what WOULD land; nothing is written.
            for acc in finished.iter().chain(trailing_acc.iter()) {
                count_into_report(&mut report, acc);
                if acc.reopen_id.is_some() {
                    report.sessions_updated += 1;
                } else {
                    report.sessions_added += 1;
                }
            }
            return Ok(report);
        }

        // ---- Write phase: one transaction per file. ----
        let tx = self.conn.transaction()?;
        // A replaced stream (identity mismatch) must not keep pointing at the
        // old stream's trailing session — that could spuriously reopen it.
        let mut last_session_id: Option<i64> = if resumed {
            mark.as_ref().and_then(|m| m.last_session_id)
        } else {
            None
        };

        if let Some(seed) = &stale_trailing {
            if seed_is_blip(seed) {
                // ON DELETE CASCADE clears its session_mob_kills; a blip has
                // no loot/level_ups children by definition.
                tx.execute("DELETE FROM sessions WHERE id = ?1", params![seed.id])?;
            }
        }
        for acc in finished.iter() {
            let id = write_session(&tx, acc, &character, &server, &file_display)?;
            count_into_report(&mut report, acc);
            if acc.reopen_id.is_some() {
                report.sessions_updated += 1;
            } else {
                report.sessions_added += 1;
            }
            last_session_id = Some(id);
        }
        if let Some(acc) = &trailing_acc {
            let id = write_session(&tx, acc, &character, &server, &file_display)?;
            count_into_report(&mut report, acc);
            if acc.reopen_id.is_some() {
                report.sessions_updated += 1;
            } else {
                report.sessions_added += 1;
            }
            last_session_id = Some(id);
        }

        // Watermark updates (Layer 1 + Layer 2). A resumed run that parsed no
        // new timestamped line keeps the previous last_ts.
        let new_last_ts = last_ts.unwrap_or(if resumed {
            mark.as_ref().map_or(0, |m| m.last_ts)
        } else {
            0
        });
        let prefix_len = consumed.min(PREFIX_HASH_MAX);
        let prefix_sha = sha256_prefix(path, prefix_len)?;
        match &mark {
            Some(m) => {
                tx.execute(
                    "UPDATE import_files SET prefix_sha256 = ?1, prefix_len = ?2,
                         byte_offset = ?3, line_count = ?4, last_ts = ?5,
                         last_session_id = ?6, imported_at = ?7
                     WHERE id = ?8",
                    params![
                        prefix_sha,
                        prefix_len as i64,
                        consumed as i64,
                        (prior_lines + report.lines_read) as i64,
                        new_last_ts,
                        last_session_id,
                        now_utc(),
                        m.id
                    ],
                )?;
            }
            None => {
                tx.execute(
                    "INSERT INTO import_files (character, server, path, prefix_sha256,
                         prefix_len, byte_offset, line_count, last_ts,
                         last_session_id, imported_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                    params![
                        character,
                        server,
                        file_display,
                        prefix_sha,
                        prefix_len as i64,
                        consumed as i64,
                        report.lines_read as i64,
                        new_last_ts,
                        last_session_id,
                        now_utc()
                    ],
                )?;
            }
        }
        if let Some(ts) = last_ts {
            let existing: Option<i64> = tx
                .prepare_cached(
                    "SELECT max_ts FROM career_watermarks
                     WHERE character = ?1 COLLATE NOCASE AND server = ?2 COLLATE NOCASE",
                )?
                .query_row(params![character, server], |row| row.get(0))
                .optional()?;
            match existing {
                Some(old) if old >= ts => {}
                Some(_) => {
                    tx.execute(
                        "UPDATE career_watermarks SET max_ts = ?3
                         WHERE character = ?1 COLLATE NOCASE AND server = ?2 COLLATE NOCASE",
                        params![character, server, ts],
                    )?;
                }
                None => {
                    tx.execute(
                        "INSERT INTO career_watermarks (character, server, max_ts)
                         VALUES (?1, ?2, ?3)",
                        params![character, server, ts],
                    )?;
                }
            }
        }
        tx.commit()?;
        Ok(report)
    }

    fn load_file_mark(
        &self,
        character: &str,
        server: &str,
        path: &str,
    ) -> Result<Option<FileMark>, StoreError> {
        let mark = self
            .conn
            .prepare_cached(
                "SELECT id, prefix_sha256, prefix_len, byte_offset, line_count,
                        last_ts, last_session_id
                 FROM import_files
                 WHERE character = ?1 COLLATE NOCASE AND server = ?2 COLLATE NOCASE
                   AND path = ?3",
            )?
            .query_row(params![character, server, path], |row| {
                Ok(FileMark {
                    id: row.get(0)?,
                    prefix_sha256: row.get(1)?,
                    prefix_len: row.get::<_, i64>(2)?.max(0) as u64,
                    byte_offset: row.get::<_, i64>(3)?.max(0) as u64,
                    line_count: row.get::<_, i64>(4)?.max(0) as u64,
                    last_ts: row.get(5)?,
                    last_session_id: row.get(6)?,
                })
            })
            .optional()?;
        Ok(mark)
    }

    fn load_trailing_seed(&self, id: i64) -> Result<Option<TrailingSeed>, StoreError> {
        let seed = self
            .conn
            .prepare_cached(
                "SELECT id, start_ts, end_ts, zones_json, kills, deaths,
                        xp_percent, party_xp_percent, level_ups, end_level,
                        aa_points, coin_json, skill_ups, loot_count
                 FROM sessions WHERE id = ?1",
            )?
            .query_row(params![id], |row| {
                let zones_json: String = row.get(3)?;
                let coin_json: String = row.get(11)?;
                Ok(TrailingSeed {
                    id: row.get(0)?,
                    start_ts: row.get(1)?,
                    end_ts: row.get(2)?,
                    zones: serde_json::from_str(&zones_json).unwrap_or_default(),
                    kills: row.get::<_, i64>(4)?.max(0) as u64,
                    deaths: row.get::<_, i64>(5)?.max(0) as u64,
                    xp_percent: row.get(6)?,
                    party_xp_percent: row.get(7)?,
                    level_ups: row.get::<_, i64>(8)?.max(0) as u64,
                    end_level: row.get(9)?,
                    aa_points: row.get::<_, i64>(10)?.max(0) as u64,
                    coin: serde_json::from_str(&coin_json).unwrap_or_default(),
                    skill_ups: row.get::<_, i64>(12)?.max(0) as u64,
                    loot_count: row.get::<_, i64>(13)?.max(0) as u64,
                })
            })
            .optional()?;
        Ok(seed)
    }
}

fn acc_from_seed(seed: &TrailingSeed) -> SessionAcc {
    SessionAcc {
        reopen_id: Some(seed.id),
        start_ts: seed.start_ts,
        end_ts: seed.end_ts,
        zones: seed.zones.clone(),
        kills: seed.kills,
        deaths: seed.deaths,
        xp_percent: seed.xp_percent,
        party_xp_percent: seed.party_xp_percent,
        prior_level_ups: seed.level_ups,
        new_level_ups: Vec::new(),
        end_level: seed.end_level,
        aa_points: seed.aa_points,
        coin: seed.coin.clone(),
        skill_ups: seed.skill_ups,
        prior_loot: seed.loot_count,
        new_loot: Vec::new(),
        mob_kills: HashMap::new(),
    }
}

fn seed_is_blip(seed: &TrailingSeed) -> bool {
    seed.end_ts - seed.start_ts < MIN_SESSION_SECS
        && seed.kills == 0
        && seed.deaths == 0
        && seed.xp_percent == 0.0
        && seed.level_ups == 0
        && seed.aa_points == 0
        && seed.coin.total() == 0
        && seed.skill_ups == 0
        && seed.loot_count == 0
}

fn count_into_report(report: &mut ImportReport, acc: &SessionAcc) {
    report.level_ups_added += acc.new_level_ups.len() as u64;
    report.loot_added += acc.new_loot.len() as u64;
    report.kills_added += acc.mob_kills.values().sum::<u64>();
}

/// Insert a new session (or update a reopened one) plus its raw children and
/// per-mob kill aggregates. Returns the session's rowid.
fn write_session(
    tx: &Transaction<'_>,
    acc: &SessionAcc,
    character: &str,
    server: &str,
    source_file: &str,
) -> Result<i64, StoreError> {
    let zones_json = serde_json::to_string(&acc.zones).expect("Vec<String> serializes");
    let coin_json = serde_json::to_string(&acc.coin).expect("CoinBreakdown serializes");
    let loot_count = acc.prior_loot + acc.new_loot.len() as u64;
    let level_ups = acc.prior_level_ups + acc.new_level_ups.len() as u64;
    let id = match acc.reopen_id {
        Some(id) => {
            tx.execute(
                "UPDATE sessions SET end_ts = ?1, duration_secs = ?2, zones_json = ?3,
                     kills = ?4, deaths = ?5, xp_percent = ?6, party_xp_percent = ?7,
                     level_ups = ?8, end_level = ?9, aa_points = ?10,
                     coin_copper = ?11, coin_json = ?12, skill_ups = ?13,
                     loot_count = ?14
                 WHERE id = ?15",
                params![
                    acc.end_ts,
                    acc.duration_secs(),
                    zones_json,
                    acc.kills as i64,
                    acc.deaths as i64,
                    acc.xp_percent,
                    acc.party_xp_percent,
                    level_ups as i64,
                    acc.end_level,
                    acc.aa_points as i64,
                    acc.coin.total(),
                    coin_json,
                    acc.skill_ups as i64,
                    loot_count as i64,
                    id
                ],
            )?;
            id
        }
        None => {
            tx.execute(
                "INSERT INTO sessions (character, server, start_ts, end_ts,
                     duration_secs, zones_json, kills, deaths, xp_percent,
                     party_xp_percent, level_ups, end_level, aa_points,
                     coin_copper, coin_json, skill_ups, loot_count, source_file)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                         ?13, ?14, ?15, ?16, ?17, ?18)",
                params![
                    character,
                    server,
                    acc.start_ts,
                    acc.end_ts,
                    acc.duration_secs(),
                    zones_json,
                    acc.kills as i64,
                    acc.deaths as i64,
                    acc.xp_percent,
                    acc.party_xp_percent,
                    level_ups as i64,
                    acc.end_level,
                    acc.aa_points as i64,
                    acc.coin.total(),
                    coin_json,
                    acc.skill_ups as i64,
                    loot_count as i64,
                    source_file
                ],
            )?;
            tx.last_insert_rowid()
        }
    };
    for (ts, level) in &acc.new_level_ups {
        tx.execute(
            "INSERT INTO level_ups (character, server, ts, level, session_id)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![character, server, ts, level, id],
        )?;
    }
    for l in &acc.new_loot {
        tx.execute(
            "INSERT INTO loot (character, server, ts, item, quantity, corpse,
                 looter, sold_for_copper, session_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                character,
                server,
                l.ts,
                l.item,
                l.quantity,
                l.corpse,
                l.looter,
                l.sold_for_copper,
                id
            ],
        )?;
    }
    for (mob, kills) in &acc.mob_kills {
        tx.execute(
            "INSERT INTO session_mob_kills (session_id, character, server, mob, kills)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (session_id, mob) DO UPDATE SET kills = kills + excluded.kills",
            params![id, character, server, mob, *kills as i64],
        )?;
    }
    Ok(id)
}
