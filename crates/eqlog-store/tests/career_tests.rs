//! Career store integration tests: schema migration, the import fold
//! (segmentation, aggregates, watermark dedupe), the DST caveat, and the
//! query API. Contract: docs/career-db-design.md.

use std::fs::OpenOptions;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use eqlog_store::career::{CareerStore, ImportOptions, ImportReport};
use eqlog_store::FightStore;
use rusqlite::Connection;

/// Unique per-test scratch directory under the system temp dir (same pattern
/// as the crate's unit tests; no tempfile crate).
struct TestDir {
    dir: PathBuf,
}

impl TestDir {
    fn new(tag: &str) -> TestDir {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "eqlog_career_tests_{}_{}_{}",
            std::process::id(),
            tag,
            nanos
        ));
        std::fs::create_dir_all(&dir).unwrap();
        TestDir { dir }
    }

    fn db_path(&self) -> PathBuf {
        self.dir.join("fights.sqlite")
    }

    fn log_path(&self) -> PathBuf {
        self.dir.join("eqlog_Nyasha_oggok.txt")
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Log timestamp `t` seconds after the base instant (Fri Jul 03 2026
/// 00:00:00, log-naive). Rolls into the following calendar days.
fn stamp(t: i64) -> String {
    let day = t.div_euclid(86_400);
    let rem = t.rem_euclid(86_400);
    let (dow, dom) = match day {
        0 => ("Fri", 3),
        1 => ("Sat", 4),
        2 => ("Sun", 5),
        _ => ("Mon", 6),
    };
    format!(
        "[{dow} Jul {dom:02} {:02}:{:02}:{:02} 2026]",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn line(t: i64, msg: &str) -> String {
    format!("{} {msg}\n", stamp(t))
}

fn write_log(path: &Path, content: &str) {
    std::fs::write(path, content).unwrap();
}

fn append_log(path: &Path, content: &str) {
    let mut f = OpenOptions::new().append(true).open(path).unwrap();
    f.write_all(content.as_bytes()).unwrap();
}

fn import(store: &mut CareerStore, path: &Path) -> ImportReport {
    store
        .import_file(path, &ImportOptions::default(), &mut |_| {})
        .unwrap()
}

/// A small "real activity" block starting at `t`: one XP gain, one kill,
/// one loot. Spans 20 seconds.
fn activity_block(t: i64) -> String {
    let mut s = String::new();
    s.push_str(&line(t, "You gain experience! (2.429%)"));
    s.push_str(&line(t + 10, "A gnoll pup has been slain by Nyasha!"));
    s.push_str(&line(
        t + 20,
        "--You have looted a Platinum Ring +2 from Gynok Moltor's corpse.--",
    ));
    s
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

#[test]
fn v1_database_migrates_in_place_and_keeps_fights() {
    let td = TestDir::new("migrate_v1");
    // Build a v1 fixture by hand: fights table only, user_version = 1.
    {
        let conn = Connection::open(td.db_path()).unwrap();
        conn.execute_batch(
            "CREATE TABLE fights (
                 id            INTEGER PRIMARY KEY,
                 target        TEXT    NOT NULL,
                 start_ts      INTEGER NOT NULL,
                 end_ts        INTEGER NOT NULL,
                 duration_secs INTEGER NOT NULL,
                 total_damage  INTEGER NOT NULL,
                 target_slain  INTEGER NOT NULL,
                 summary_json  TEXT    NOT NULL
             );
             CREATE INDEX fights_start_ts ON fights (start_ts DESC, id DESC);
             INSERT INTO fights VALUES (1, 'a gnoll pup', 10, 40, 30, 100, 1,
                 '{\"target\":\"a gnoll pup\",\"start_ts\":10,\"end_ts\":40,
                   \"duration_secs\":30,\"total_damage\":100,
                   \"target_slain\":true,\"rows\":[]}');
             PRAGMA user_version = 1;",
        )
        .unwrap();
    }
    // Opening the CareerStore migrates the shared database to the latest schema.
    {
        let store = CareerStore::open(td.db_path()).unwrap();
        assert!(store.summary("Nyasha", "oggok").unwrap().is_none());
    }
    let conn = Connection::open(td.db_path()).unwrap();
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, 3);
    for table in [
        "sessions",
        "level_ups",
        "loot",
        "session_mob_kills",
        "import_files",
        "career_watermarks",
    ] {
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "table {table} missing after migration");
    }
    // The fights row is untouched and FightStore still reads it.
    drop(conn);
    let fights = FightStore::open(td.db_path()).unwrap();
    assert_eq!(fights.count().unwrap(), 1);
    assert_eq!(
        fights.get(1).unwrap().unwrap().summary.target,
        "a gnoll pup"
    );
}

#[test]
fn fight_store_open_also_creates_career_tables() {
    let td = TestDir::new("shared_migration");
    {
        let _ = FightStore::open(td.db_path()).unwrap();
    }
    let conn = Connection::open(td.db_path()).unwrap();
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, 3);
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(n, 1);
}

// ---------------------------------------------------------------------------
// Segmentation + aggregates
// ---------------------------------------------------------------------------

#[test]
fn gap_splits_sessions_but_short_break_merges() {
    let td = TestDir::new("segmentation");
    let mut content = String::new();
    content.push_str(&activity_block(0)); // session 1 start
    content.push_str(&activity_block(27 * 60)); // 27 min break: same session
    content.push_str(&activity_block(27 * 60 + 31 * 60)); // 31 min gap: split
    write_log(&td.log_path(), &content);

    let mut store = CareerStore::open(td.db_path()).unwrap();
    let report = import(&mut store, &td.log_path());
    assert_eq!(report.character, "Nyasha");
    assert_eq!(report.server, "oggok");
    assert_eq!(report.sessions_added, 2);
    assert_eq!(report.sessions_updated, 0);
    assert!(!report.skipped);

    let (total, rows) = store.sessions("Nyasha", "oggok", 10, 0).unwrap();
    assert_eq!(total, 2);
    // Newest first.
    assert_eq!(rows[0].start_ts - rows[1].start_ts, (27 + 31) * 60);
    assert_eq!(rows[1].duration_secs, 27 * 60 + 20);
    assert_eq!(rows[1].kills, 2);
    assert_eq!(rows[0].kills, 1);
}

#[test]
fn interior_blip_is_discarded() {
    let td = TestDir::new("blip");
    let mut content = String::new();
    content.push_str(&activity_block(0));
    // 40 min later: a lone zero-activity line, then another 40 min gap.
    content.push_str(&line(40 * 60, "You have entered Dagnor's Cauldron."));
    content.push_str(&activity_block(80 * 60));
    write_log(&td.log_path(), &content);

    let mut store = CareerStore::open(td.db_path()).unwrap();
    let report = import(&mut store, &td.log_path());
    assert_eq!(report.sessions_added, 2, "the login-check blip is dropped");
    let (total, _) = store.sessions("Nyasha", "oggok", 10, 0).unwrap();
    assert_eq!(total, 2);
}

#[test]
fn aggregates_fold_all_event_kinds() {
    let td = TestDir::new("aggregates");
    let mut c = String::new();
    c.push_str(&line(0, "You have entered Dagnor's Cauldron."));
    c.push_str(&line(5, "You gain experience! (2.429%)"));
    c.push_str(&line(6, "You gain party experience! (0.083%)"));
    c.push_str(&line(10, "A gnoll pup has been slain by Nyasha!"));
    c.push_str(&line(11, "A gnoll pup has been slain by Torvin`s warder!"));
    // Player-shaped victim = dead groupmate, NOT a camp kill.
    c.push_str(&line(12, "Torvin has been slain by a gnoll pup!"));
    c.push_str(&line(13, "You died."));
    c.push_str(&line(
        20,
        "--You have looted a Platinum Ring +2 from Gynok Moltor's corpse.--",
    ));
    c.push_str(&line(
        21,
        "You looted a Ringmail Pants +1 from a Teir`Dal rogue's corpse and sold it for 3 platinum.",
    ));
    c.push_str(&line(
        22,
        "You looted a Mallet Hilt from an elf skeleton's corpse and sold it for free.",
    ));
    c.push_str(&line(
        30,
        "You receive 1 platinum, 8 gold, 9 silver and 6 copper from the corpse.",
    ));
    c.push_str(&line(40, "You have become better at Channeling! (118)"));
    c.push_str(&line(
        50,
        "You have gained an ability point!  You now have 6 ability points.",
    ));
    c.push_str(&line(60, "You have gained a level! Welcome to level 16!"));
    c.push_str(&line(70, "You have entered Kedge Keep."));
    c.push_str(&line(80, "You have entered Dagnor's Cauldron."));
    write_log(&td.log_path(), &c);

    let mut store = CareerStore::open(td.db_path()).unwrap();
    let report = import(&mut store, &td.log_path());
    assert_eq!(report.sessions_added, 1);
    assert_eq!(report.kills_added, 2);
    assert_eq!(report.loot_added, 3);
    assert_eq!(report.level_ups_added, 1);

    let (_, rows) = store.sessions("Nyasha", "oggok", 10, 0).unwrap();
    let s = &rows[0];
    assert_eq!(s.kills, 2, "player-shaped victim excluded");
    assert_eq!(s.deaths, 1);
    assert!((s.xp_percent - 2.512).abs() < 1e-9);
    assert!((s.party_xp_percent - 0.083).abs() < 1e-9);
    assert_eq!(s.level_ups, 1);
    assert_eq!(s.end_level, Some(16));
    assert_eq!(s.aa_points, 1);
    // Corpse coin 1896 + sold loot 3000 + sold-for-free 0.
    assert_eq!(s.coin_copper, 1896 + 3000);
    assert_eq!(s.skill_ups, 1);
    assert_eq!(s.loot_count, 3);
    // Unique zones in entry order.
    assert_eq!(s.zones, ["Dagnor's Cauldron", "Kedge Keep"]);

    let summary = store.summary("Nyasha", "oggok").unwrap().unwrap();
    assert_eq!(summary.sessions, 1);
    assert_eq!(summary.kills, 2);
    assert_eq!(summary.deaths, 1);
    assert_eq!(summary.end_level, Some(16));
    assert_eq!(summary.coin_copper, 4896);
    assert!(summary.last_import_at.is_some());

    let timeline = store.level_timeline("Nyasha", "oggok").unwrap();
    assert_eq!(timeline.len(), 1);
    assert_eq!(timeline[0].level, 16);
    assert_eq!(timeline[0].session_id, Some(s.id));

    // Loot ledger: search filter + paging + sold_for semantics.
    let (total, all) = store.loot("Nyasha", "oggok", "", 10, 0).unwrap();
    assert_eq!(total, 3);
    assert_eq!(all.len(), 3);
    let (total, hits) = store.loot("Nyasha", "oggok", "ringmail", 10, 0).unwrap();
    assert_eq!(total, 1);
    assert_eq!(hits[0].item, "Ringmail Pants +1");
    assert_eq!(hits[0].sold_for_copper, Some(3000));
    let free = all.iter().find(|l| l.item == "Mallet Hilt").unwrap();
    assert_eq!(free.sold_for_copper, Some(0), "sold for free = Some(0)");
    let kept = all.iter().find(|l| l.item == "Platinum Ring +2").unwrap();
    assert_eq!(kept.sold_for_copper, None, "kept = None");
    assert_eq!(kept.corpse.as_deref(), Some("Gynok Moltor"));
    assert_eq!(kept.looter, "Nyasha");

    // Per-mob kills + observed drops.
    let (total, mobs) = store.mob_kills("Nyasha", "oggok", "", 10, 0).unwrap();
    assert_eq!(total, 1);
    assert_eq!(mobs[0].mob, "A gnoll pup");
    assert_eq!(mobs[0].kills, 2);
    assert_eq!(mobs[0].loot_drops, 0);
    let drops = store.mob_drops("Nyasha", "oggok", "gynok moltor").unwrap();
    assert_eq!(drops.len(), 1);
    assert_eq!(drops[0].item, "Platinum Ring +2");
    assert_eq!(drops[0].count, 1);
}

// ---------------------------------------------------------------------------
// Idempotency + resume
// ---------------------------------------------------------------------------

#[test]
fn second_import_of_same_file_is_a_no_op() {
    let td = TestDir::new("idempotent");
    write_log(&td.log_path(), &activity_block(0));
    let mut store = CareerStore::open(td.db_path()).unwrap();
    let first = import(&mut store, &td.log_path());
    assert_eq!(first.sessions_added, 1);

    let second = import(&mut store, &td.log_path());
    assert!(second.skipped);
    assert_eq!(second.skip_reason.as_deref(), Some("no new content"));
    assert_eq!(second.lines_read, 0);
    assert_eq!(second.sessions_added, 0);
    assert_eq!(second.loot_added, 0);

    let summary = store.summary("Nyasha", "oggok").unwrap().unwrap();
    assert_eq!(summary.sessions, 1);
    assert_eq!(summary.kills, 1);
    assert_eq!(summary.loot_count, 1);
}

#[test]
fn append_within_gap_reopens_trailing_session() {
    let td = TestDir::new("reopen");
    write_log(&td.log_path(), &activity_block(0));
    let mut store = CareerStore::open(td.db_path()).unwrap();
    import(&mut store, &td.log_path());

    // 10 minutes later, more of the same play block.
    append_log(&td.log_path(), &activity_block(10 * 60));
    let report = import(&mut store, &td.log_path());
    assert_eq!(report.sessions_added, 0);
    assert_eq!(report.sessions_updated, 1, "trailing session extended");
    assert_eq!(report.loot_added, 1);

    let (total, rows) = store.sessions("Nyasha", "oggok", 10, 0).unwrap();
    assert_eq!(total, 1, "no phantom split at the old EOF");
    assert_eq!(rows[0].duration_secs, 10 * 60 + 20);
    assert_eq!(rows[0].kills, 2);
    assert_eq!(rows[0].loot_count, 2);
    // The reopened session's per-mob kills accumulated, not duplicated.
    let (_, mobs) = store.mob_kills("Nyasha", "oggok", "", 10, 0).unwrap();
    assert_eq!(mobs[0].kills, 2);
}

#[test]
fn append_after_gap_starts_a_new_session() {
    let td = TestDir::new("append_gap");
    write_log(&td.log_path(), &activity_block(0));
    let mut store = CareerStore::open(td.db_path()).unwrap();
    import(&mut store, &td.log_path());

    append_log(&td.log_path(), &activity_block(2 * 3600));
    let report = import(&mut store, &td.log_path());
    assert_eq!(report.sessions_added, 1);
    assert_eq!(report.sessions_updated, 0);
    let (total, _) = store.sessions("Nyasha", "oggok", 10, 0).unwrap();
    assert_eq!(total, 2);
}

#[test]
fn trailing_blip_survives_eof_then_is_discarded_when_final() {
    let td = TestDir::new("trailing_blip");
    let mut content = activity_block(0);
    // Trailing zero-activity blip at EOF: kept, because the next run might
    // extend it into a real session.
    content.push_str(&line(40 * 60, "You have entered Dagnor's Cauldron."));
    write_log(&td.log_path(), &content);
    let mut store = CareerStore::open(td.db_path()).unwrap();
    let report = import(&mut store, &td.log_path());
    assert_eq!(report.sessions_added, 2);
    let (total, _) = store.sessions("Nyasha", "oggok", 10, 0).unwrap();
    assert_eq!(total, 2, "trailing blip parked, reopenable");

    // The next content is beyond the gap: the parked blip is now final and
    // gets discarded; the new activity is its own session.
    append_log(&td.log_path(), &activity_block(90 * 60));
    let report = import(&mut store, &td.log_path());
    assert_eq!(report.sessions_added, 1);
    let (total, rows) = store.sessions("Nyasha", "oggok", 10, 0).unwrap();
    assert_eq!(total, 2, "parked blip discarded once final");
    assert!(rows.iter().all(|s| s.kills > 0));
}

#[test]
fn trailing_blip_extends_into_a_real_session() {
    let td = TestDir::new("blip_grows");
    write_log(
        &td.log_path(),
        &line(0, "You have entered Dagnor's Cauldron."),
    );
    let mut store = CareerStore::open(td.db_path()).unwrap();
    let report = import(&mut store, &td.log_path());
    assert_eq!(report.sessions_added, 1);

    append_log(&td.log_path(), &activity_block(5 * 60));
    let report = import(&mut store, &td.log_path());
    assert_eq!(report.sessions_updated, 1);
    let (total, rows) = store.sessions("Nyasha", "oggok", 10, 0).unwrap();
    assert_eq!(total, 1);
    assert_eq!(rows[0].start_ts, rows[0].end_ts - (5 * 60 + 20));
    assert_eq!(rows[0].zones, ["Dagnor's Cauldron"]);
    assert_eq!(rows[0].kills, 1);
}

#[test]
fn trailing_partial_line_is_not_consumed() {
    let td = TestDir::new("partial_line");
    let mut content = activity_block(0);
    content.push_str(&line(30, "You gain experience! (1.0%)"));
    let complete_len = content.len();
    content.push_str(&stamp(40)); // half a line, no newline
    content.push_str(" You gain exper");
    write_log(&td.log_path(), &content);

    let mut store = CareerStore::open(td.db_path()).unwrap();
    let report = import(&mut store, &td.log_path());
    assert_eq!(report.lines_read, 4);

    // Complete the line + append another; only the delta lands.
    write_log(
        &td.log_path(),
        &format!(
            "{}{}{}",
            &content[..complete_len],
            line(40, "You gain experience! (2.0%)"),
            line(50, "You gain experience! (3.0%)"),
        ),
    );
    let report = import(&mut store, &td.log_path());
    assert_eq!(report.lines_read, 2);
    let summary = store.summary("Nyasha", "oggok").unwrap().unwrap();
    assert!((summary.xp_percent - (2.429 + 1.0 + 2.0 + 3.0)).abs() < 1e-9);
}

// ---------------------------------------------------------------------------
// Layer-2 floor: archives, truncation, replacement
// ---------------------------------------------------------------------------

#[test]
fn overlapping_archive_folds_only_newer_content() {
    let td = TestDir::new("archive_overlap");
    write_log(&td.log_path(), &activity_block(10_000));
    let mut store = CareerStore::open(td.db_path()).unwrap();
    import(&mut store, &td.log_path());

    // Archived copy under a different path: overlaps the imported window,
    // then continues past it (a "weekly archive" taken later).
    let archive = td.dir.join("eqlog_Nyasha_oggok_may.txt");
    let mut content = activity_block(10_000); // duplicate content, floor-skipped
    content.push_str(&activity_block(10_000 + 10 * 60)); // genuinely new
    write_log(&archive, &content);
    let report = store
        .import_file(
            &archive,
            &ImportOptions {
                character: Some("Nyasha".to_string()),
                server: Some("oggok".to_string()),
                ..ImportOptions::default()
            },
            &mut |_| {},
        )
        .unwrap();
    assert_eq!(report.lines_skipped, 3, "overlap parsed but not folded");
    assert_eq!(report.kills_added, 1, "only the newer block folded");

    let summary = store.summary("Nyasha", "oggok").unwrap().unwrap();
    assert_eq!(summary.kills, 2, "no double count");
    assert_eq!(summary.loot_count, 2);
}

#[test]
fn fully_older_archive_is_refused_by_the_floor() {
    let td = TestDir::new("archive_old");
    write_log(&td.log_path(), &activity_block(50_000));
    let mut store = CareerStore::open(td.db_path()).unwrap();
    import(&mut store, &td.log_path());

    let archive = td.dir.join("eqlog_Nyasha_oggok_april.txt");
    write_log(&archive, &activity_block(1_000));
    let report = store
        .import_file(
            &archive,
            &ImportOptions {
                character: Some("Nyasha".to_string()),
                server: Some("oggok".to_string()),
                ..ImportOptions::default()
            },
            &mut |_| {},
        )
        .unwrap();
    assert!(report.skipped);
    assert_eq!(
        report.skip_reason.as_deref(),
        Some("older than existing career data")
    );
    assert_eq!(store.summary("Nyasha", "oggok").unwrap().unwrap().kills, 1);
}

#[test]
fn replaced_file_restarts_under_the_floor() {
    let td = TestDir::new("replaced");
    write_log(&td.log_path(), &activity_block(0));
    let mut store = CareerStore::open(td.db_path()).unwrap();
    import(&mut store, &td.log_path());

    // The game deleted + recreated the log: different prefix, newer content.
    write_log(&td.log_path(), &activity_block(3 * 3600));
    let report = import(&mut store, &td.log_path());
    assert!(!report.skipped);
    assert_eq!(report.sessions_added, 1);
    let summary = store.summary("Nyasha", "oggok").unwrap().unwrap();
    assert_eq!(summary.sessions, 2);
    assert_eq!(summary.kills, 2);

    // Restoring the OLD content over the live log double-counts nothing.
    write_log(&td.log_path(), &activity_block(0));
    let report = import(&mut store, &td.log_path());
    assert!(report.skipped);
    assert_eq!(
        report.skip_reason.as_deref(),
        Some("older than existing career data")
    );
    assert_eq!(store.summary("Nyasha", "oggok").unwrap().unwrap().kills, 2);
}

// ---------------------------------------------------------------------------
// Timestamp domain: the documented DST behavior
// ---------------------------------------------------------------------------

/// Naive local log time is discontinuous across DST. This test documents the
/// accepted behavior (docs/career-db-design.md §2): fall-back never splits or
/// double-counts (the repeated hour just folds into the same session, and the
/// session reads up to 1 h shorter than wall time); spring-forward's vanished
/// hour looks like a >30 min gap and mis-splits one real session in two.
#[test]
fn dst_transitions_distort_time_but_never_double_count() {
    // Fall-back: the clock jumps from 02:00 back to 01:00 mid-session.
    let td = TestDir::new("dst_fall_back");
    let two_am = 2 * 3600;
    let mut c = String::new();
    c.push_str(&activity_block(two_am - 60)); // 01:59
    c.push_str(&activity_block(two_am - 3600 + 30)); // clock repeats 01:00:30
    write_log(&td.log_path(), &c);
    let mut store = CareerStore::open(td.db_path()).unwrap();
    let report = import(&mut store, &td.log_path());
    // A backwards step is not a gap: one session, both blocks folded once.
    assert_eq!(report.sessions_added, 1);
    let (_, rows) = store.sessions("Nyasha", "oggok", 10, 0).unwrap();
    assert_eq!(rows[0].kills, 2, "no double count");
    // end_ts is the max ts seen (01:59:20); the repeated hour makes the
    // session read shorter than the real wall time.
    assert_eq!(rows[0].duration_secs, 20);

    // Spring-forward: 01:59 -> 03:00; the vanished hour reads as a 61-minute
    // gap and splits one real play block in two.
    let td2 = TestDir::new("dst_spring");
    let mut c = String::new();
    c.push_str(&activity_block(two_am - 60)); // 01:59
    c.push_str(&activity_block(3 * 3600)); // 03:00, played through
    write_log(&td2.log_path(), &c);
    let mut store2 = CareerStore::open(td2.db_path()).unwrap();
    let report = import(&mut store2, &td2.log_path());
    assert_eq!(
        report.sessions_added, 2,
        "spring-forward mis-splits (documented, accepted)"
    );
    let summary = store2.summary("Nyasha", "oggok").unwrap().unwrap();
    assert_eq!(summary.kills, 2, "still no double count");
}

// ---------------------------------------------------------------------------
// Options, identity, reset, dry-run
// ---------------------------------------------------------------------------

#[test]
fn character_defaults_from_filename_and_errors_without_one() {
    let td = TestDir::new("identity");
    let odd = td.dir.join("mylog.txt");
    write_log(&odd, &activity_block(0));
    let mut store = CareerStore::open(td.db_path()).unwrap();
    let err = store
        .import_file(&odd, &ImportOptions::default(), &mut |_| {})
        .expect_err("non-canonical filename without --character must fail");
    assert!(err.to_string().contains("cannot determine character"));

    // Serverless canonical name: character from filename, empty server.
    let serverless = td.dir.join("eqlog_Torvin.txt");
    write_log(&serverless, &activity_block(0));
    let report = store
        .import_file(&serverless, &ImportOptions::default(), &mut |_| {})
        .unwrap();
    assert_eq!(report.character, "Torvin");
    assert_eq!(report.server, "");
    assert_eq!(
        store.characters().unwrap(),
        vec![("Torvin".to_string(), "".to_string())]
    );
}

#[test]
fn dry_run_reports_but_writes_nothing() {
    let td = TestDir::new("dry_run");
    write_log(&td.log_path(), &activity_block(0));
    let mut store = CareerStore::open(td.db_path()).unwrap();
    let report = store
        .import_file(
            &td.log_path(),
            &ImportOptions {
                dry_run: true,
                ..ImportOptions::default()
            },
            &mut |_| {},
        )
        .unwrap();
    assert_eq!(report.sessions_added, 1, "dry-run still counts sessions");
    assert_eq!(report.loot_added, 1);
    assert_eq!(report.kills_added, 1);
    assert!(store.summary("Nyasha", "oggok").unwrap().is_none());
    // A real import afterwards folds everything (no watermark was written).
    let report = import(&mut store, &td.log_path());
    assert_eq!(report.sessions_added, 1);
}

#[test]
fn reset_character_clears_career_and_allows_full_reimport() {
    let td = TestDir::new("reset");
    write_log(&td.log_path(), &activity_block(0));
    let mut store = CareerStore::open(td.db_path()).unwrap();
    import(&mut store, &td.log_path());
    assert!(store.summary("Nyasha", "oggok").unwrap().is_some());

    let removed = store.reset_character("nyasha", "OGGOK").unwrap();
    assert!(
        removed >= 4,
        "sessions+loot+smk+import_files+watermark rows"
    );
    assert!(store.summary("Nyasha", "oggok").unwrap().is_none());
    assert!(store.max_folded_ts("Nyasha", "oggok").unwrap().is_none());

    // The documented remedy: reset + re-import everything.
    let report = import(&mut store, &td.log_path());
    assert_eq!(report.sessions_added, 1);
    assert_eq!(store.summary("Nyasha", "oggok").unwrap().unwrap().kills, 1);
}

#[test]
fn custom_gap_setting_is_honored() {
    let td = TestDir::new("custom_gap");
    let mut content = activity_block(0);
    content.push_str(&activity_block(10 * 60)); // 10 min later
    write_log(&td.log_path(), &content);
    let mut store = CareerStore::open(td.db_path()).unwrap();
    let report = store
        .import_file(
            &td.log_path(),
            &ImportOptions {
                gap_secs: 5 * 60,
                ..ImportOptions::default()
            },
            &mut |_| {},
        )
        .unwrap();
    assert_eq!(report.sessions_added, 2, "5-minute gap splits at 10 min");
}

#[test]
fn progress_callback_reports_terminal_state() {
    let td = TestDir::new("progress");
    write_log(&td.log_path(), &activity_block(0));
    let mut store = CareerStore::open(td.db_path()).unwrap();
    let mut calls = Vec::new();
    store
        .import_file(&td.log_path(), &ImportOptions::default(), &mut |p| {
            calls.push((p.bytes_read, p.bytes_total, p.lines_read, p.sessions_found))
        })
        .unwrap();
    let last = calls.last().unwrap();
    assert_eq!(last.0, last.1, "final call reads the whole file");
    assert_eq!(last.2, 3);
    assert_eq!(last.3, 1);
}

// ---------------------------------------------------------------------------
// Fixture smoke test
// ---------------------------------------------------------------------------

#[test]
fn sample_session_fixture_imports() {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/sample_session.txt");
    let td = TestDir::new("fixture");
    let mut store = CareerStore::open(td.db_path()).unwrap();
    let report = store
        .import_file(
            &fixture,
            &ImportOptions {
                character: Some("Nyasha".to_string()),
                server: Some("oggok".to_string()),
                ..ImportOptions::default()
            },
            &mut |_| {},
        )
        .unwrap();
    assert!(!report.skipped);
    assert!(report.lines_read > 1000);
    let summary = store.summary("Nyasha", "oggok").unwrap().unwrap();
    assert!(summary.sessions >= 1);
    assert!(summary.total_duration_secs > 0);

    // And a second run is a byte-exact no-op.
    let report = store
        .import_file(
            &fixture,
            &ImportOptions {
                character: Some("Nyasha".to_string()),
                server: Some("oggok".to_string()),
                ..ImportOptions::default()
            },
            &mut |_| {},
        )
        .unwrap();
    assert!(report.skipped);
    assert_eq!(report.sessions_added, 0);
}
