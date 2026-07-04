//! Integration tests for the live log tailer.
//!
//! These use real files under std::env::temp_dir() (unique per-test subdirs,
//! no tempfile crate) and short poll intervals so the suite stays fast.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crossbeam_channel::{RecvTimeoutError, TryRecvError};
use eqlog_core::tail::{Tailer, TailerConfig};

const RECV_TIMEOUT: Duration = Duration::from_secs(5);
const POLL_MS: u64 = 10;

/// Unique per-test scratch directory under the system temp dir.
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
            "eqlog_tail_tests_{}_{}_{}",
            std::process::id(),
            tag,
            nanos
        ));
        fs::create_dir_all(&dir).unwrap();
        TestDir { dir }
    }

    fn log_path(&self) -> PathBuf {
        self.dir.join("eqlog_Nyasha_oggok.txt")
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn config(path: &Path, from_start: bool) -> TailerConfig {
    TailerConfig {
        path: path.to_path_buf(),
        from_start,
        poll_interval_ms: POLL_MS,
    }
}

/// Append raw bytes to the file (creating it if needed) and flush.
fn append(path: &Path, data: &str) {
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .unwrap();
    f.write_all(data.as_bytes()).unwrap();
    f.flush().unwrap();
}

fn recv_line(tailer: &Tailer) -> String {
    tailer
        .lines
        .recv_timeout(RECV_TIMEOUT)
        .expect("expected a line from the tailer before timeout")
}

#[test]
fn default_config_polls_at_200ms_from_end() {
    let cfg = TailerConfig::default();
    assert_eq!(cfg.poll_interval_ms, 200);
    assert!(!cfg.from_start);
}

#[test]
fn spawn_fails_when_file_missing() {
    let td = TestDir::new("missing");
    let result = Tailer::spawn(config(&td.log_path(), false));
    assert!(result.is_err());
}

#[test]
fn appended_lines_arrive_in_order() {
    let td = TestDir::new("ordered");
    let path = td.log_path();
    append(&path, ""); // create empty file
    let tailer = Tailer::spawn(config(&path, false)).unwrap();

    // Mix of CRLF (the real log ends lines CRLF) and LF terminators.
    append(
        &path,
        "[Thu Jul 02 23:32:46 2026] You begin casting Lifedraw.\r\n",
    );
    append(
        &path,
        "[Thu Jul 02 23:32:47 2026] Vibarn tries to pierce a Teir`Dal ranger, but misses!\n\
         [Thu Jul 02 23:32:48 2026] You gain experience! (2.429%)\r\n",
    );

    assert_eq!(
        recv_line(&tailer),
        "[Thu Jul 02 23:32:46 2026] You begin casting Lifedraw."
    );
    assert_eq!(
        recv_line(&tailer),
        "[Thu Jul 02 23:32:47 2026] Vibarn tries to pierce a Teir`Dal ranger, but misses!"
    );
    assert_eq!(
        recv_line(&tailer),
        "[Thu Jul 02 23:32:48 2026] You gain experience! (2.429%)"
    );
}

#[test]
fn partial_line_held_until_newline_arrives() {
    let td = TestDir::new("partial");
    let path = td.log_path();
    append(&path, "");
    let tailer = Tailer::spawn(config(&path, false)).unwrap();

    // The game flushes mid-line: write half a line, no terminator.
    append(&path, "[Thu Jul 02 23:32:46 2026] You have entered ");

    // Give the tailer several poll cycles; nothing must be emitted yet.
    thread::sleep(Duration::from_millis(POLL_MS * 15));
    assert_eq!(tailer.lines.try_recv(), Err(TryRecvError::Empty));

    // Complete the line; the whole thing arrives as one message.
    append(&path, "Dagnor's Cauldron.\r\n");
    assert_eq!(
        recv_line(&tailer),
        "[Thu Jul 02 23:32:46 2026] You have entered Dagnor's Cauldron."
    );
}

#[test]
fn truncate_and_rewrite_reads_from_start() {
    let td = TestDir::new("truncate");
    let path = td.log_path();
    append(&path, "");
    let tailer = Tailer::spawn(config(&path, false)).unwrap();

    // Long enough that the rewritten content below is strictly shorter,
    // making the len < pos truncation check deterministic.
    append(
        &path,
        "[Thu Jul 02 23:32:46 2026] A Teir`Dal ranger slashes YOU for 2 points of damage.\r\n",
    );
    assert_eq!(
        recv_line(&tailer),
        "[Thu Jul 02 23:32:46 2026] A Teir`Dal ranger slashes YOU for 2 points of damage."
    );

    // Truncate to zero and write fresh, shorter content.
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(0)
        .unwrap();
    append(&path, "fresh line after truncation\r\n");

    assert_eq!(recv_line(&tailer), "fresh line after truncation");
}

#[test]
fn from_start_reads_existing_content() {
    let td = TestDir::new("from_start");
    let path = td.log_path();
    append(&path, "first existing line\r\nsecond existing line\n");

    let tailer = Tailer::spawn(config(&path, true)).unwrap();
    assert_eq!(recv_line(&tailer), "first existing line");
    assert_eq!(recv_line(&tailer), "second existing line");

    // And it keeps tailing new appends afterwards.
    append(&path, "appended after spawn\r\n");
    assert_eq!(recv_line(&tailer), "appended after spawn");
}

#[test]
fn from_end_skips_existing_content() {
    let td = TestDir::new("from_end");
    let path = td.log_path();
    append(&path, "old line that must be skipped\r\n");

    let tailer = Tailer::spawn(config(&path, false)).unwrap();
    append(&path, "new line\r\n");
    assert_eq!(recv_line(&tailer), "new line");
    assert_eq!(tailer.lines.try_recv(), Err(TryRecvError::Empty));
}

#[test]
fn deleted_file_is_reopened_when_it_reappears() {
    let td = TestDir::new("reappear");
    let path = td.log_path();
    append(&path, "");
    let tailer = Tailer::spawn(config(&path, false)).unwrap();

    append(&path, "before delete\r\n");
    assert_eq!(recv_line(&tailer), "before delete");

    fs::remove_file(&path).unwrap();
    // Let the tailer observe the disappearance across several poll cycles
    // before the replacement shows up.
    thread::sleep(Duration::from_millis(POLL_MS * 20));

    append(&path, "reborn\r\n");
    assert_eq!(recv_line(&tailer), "reborn");
}

#[test]
fn rename_and_recreate_rotation_switches_to_the_new_file() {
    // The launcher rotates the log by renaming it away and creating a fresh
    // file at the same path. std::fs::metadata(path) keeps succeeding (the
    // NEW file exists) and the OLD handle stays at EOF, so the tailer must
    // detect the identity change rather than polling the dead handle forever.
    let td = TestDir::new("rotate");
    let path = td.log_path();
    append(&path, "");
    let tailer = Tailer::spawn(config(&path, false)).unwrap();

    append(&path, "before rotation\r\n");
    assert_eq!(recv_line(&tailer), "before rotation");

    let rotated = path.with_extension("txt.1");
    fs::rename(&path, &rotated).unwrap();
    fs::write(&path, "first in new file\r\nsecond in new file\r\n").unwrap();

    assert_eq!(recv_line(&tailer), "first in new file");
    assert_eq!(recv_line(&tailer), "second in new file");

    // And it keeps following appends to the replacement.
    append(&path, "appended after rotation\r\n");
    assert_eq!(recv_line(&tailer), "appended after rotation");
}

#[test]
fn same_size_rotation_switches_to_the_new_file() {
    // Rotation where the replacement happens to be byte-for-byte the same
    // LENGTH as what the old file held: identity must be decided by file
    // identity (inode / creation time), never by size equality.
    let td = TestDir::new("rotate_same_size");
    let path = td.log_path();
    append(&path, "");
    let tailer = Tailer::spawn(config(&path, false)).unwrap();

    append(&path, "AAAA old contents\r\n");
    assert_eq!(recv_line(&tailer), "AAAA old contents");

    let rotated = path.with_extension("txt.1");
    fs::rename(&path, &rotated).unwrap();
    // Same length as the old file (19 bytes incl. CRLF), fresh identity.
    fs::write(&path, "BBBB new contents\r\n").unwrap();

    assert_eq!(recv_line(&tailer), "BBBB new contents");
}

#[test]
fn slow_appends_are_never_replayed() {
    // Regression net for the rotation false-positive (APP_REVIEW N4): the
    // tailer sits at EOF between appends, re-running the identity check ~per
    // poll while the writer races it. Every line must arrive exactly once —
    // a false rotation/truncation verdict would replay the file from the
    // top and emit duplicates.
    let td = TestDir::new("no_replay");
    let path = td.log_path();
    append(&path, "");
    let tailer = Tailer::spawn(config(&path, false)).unwrap();

    for i in 0..20 {
        append(&path, &format!("line {i}\r\n"));
        // Several poll cycles at EOF between appends.
        thread::sleep(Duration::from_millis(POLL_MS * 3));
    }
    for i in 0..20 {
        assert_eq!(recv_line(&tailer), format!("line {i}"));
    }
    // Nothing extra: no duplicates, no replay.
    thread::sleep(Duration::from_millis(POLL_MS * 10));
    assert_eq!(tailer.lines.try_recv(), Err(TryRecvError::Empty));
}

#[test]
fn drop_stops_the_reader_thread_promptly() {
    let td = TestDir::new("drop");
    let path = td.log_path();
    append(&path, "");

    // Long poll interval on purpose: shutdown must not wait a full cycle.
    let tailer = Tailer::spawn(TailerConfig {
        path: path.clone(),
        from_start: false,
        poll_interval_ms: 1000,
    })
    .unwrap();
    let rx = tailer.lines.clone();

    // Drop on a helper thread so we can bound the join with a timeout.
    let dropper = thread::spawn(move || drop(tailer));
    let started = Instant::now();
    while !dropper.is_finished() {
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "dropping the Tailer did not stop the reader thread within 3s"
        );
        thread::sleep(Duration::from_millis(10));
    }
    dropper.join().unwrap();

    // The reader thread exited, so the sender side is gone.
    assert_eq!(
        rx.recv_timeout(Duration::from_millis(500)),
        Err(RecvTimeoutError::Disconnected)
    );
}

#[test]
fn explicit_stop_terminates_the_thread() {
    let td = TestDir::new("stop");
    let path = td.log_path();
    append(&path, "");

    let tailer = Tailer::spawn(config(&path, false)).unwrap();
    let rx = tailer.lines.clone();
    tailer.stop(); // joins the thread before returning

    assert_eq!(rx.try_recv(), Err(TryRecvError::Disconnected));
}
