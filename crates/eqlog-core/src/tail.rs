//! Log file tailer.
//!
//! Pattern (from EQLogParser's LogReader): open share-friendly, seek to end,
//! poll-read on ~200ms, detect truncation via `len < pos` and reopen/rewind.
//! Content is always discovered by polling reads — filesystem watching is
//! unreliable for appended content and is not used here.
//!
//! Behavior:
//! - Only complete lines are emitted. A trailing partial line (the game
//!   flushes mid-line) is buffered until its newline arrives.
//! - CRLF/LF terminators are stripped before sending.
//! - If the file is truncated (`len < pos`), reading restarts from offset 0.
//! - If the file disappears, the tailer retries opening it every poll
//!   interval and reads the replacement from the start.
//! - If the path is swapped for a different file (rename+recreate or atomic
//!   replace — the launcher rotating the log), the tailer detects the
//!   identity change at EOF and reopens the new file from the start.
//! - Dropping the [`Tailer`] handle (or calling [`Tailer::stop`]) signals the
//!   reader thread and joins it; no detached thread outlives the handle.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, SendTimeoutError, Sender};

/// Configuration for [`Tailer::spawn`].
#[derive(Debug, Clone)]
pub struct TailerConfig {
    pub path: PathBuf,
    /// Start reading from the beginning instead of seeking to the end.
    pub from_start: bool,
    pub poll_interval_ms: u64,
}

impl Default for TailerConfig {
    fn default() -> Self {
        TailerConfig {
            path: PathBuf::new(),
            from_start: false,
            poll_interval_ms: 200,
        }
    }
}

/// Handle to a running tailer thread. Dropping it stops the tailer.
pub struct Tailer {
    /// Complete log lines (terminators stripped), in file order.
    pub lines: Receiver<String>,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl Tailer {
    /// Open the log file and start the reader thread.
    ///
    /// Fails immediately if the file cannot be opened; disappearance *after*
    /// spawn is handled by re-open polling inside the thread.
    pub fn spawn(config: TailerConfig) -> io::Result<Tailer> {
        let mut file = open_shared(&config.path)?;
        let pos = if config.from_start {
            0
        } else {
            file.seek(SeekFrom::End(0))?
        };

        // Bounded so a full-log replay (from_start, or a big catch-up after a
        // rotation) can't outrun the consumer and balloon memory with millions
        // of queued lines — the reader blocks with backpressure when the buffer
        // is full (P31). The cap is generous enough to absorb normal bursts.
        let (tx, rx) = crossbeam_channel::bounded(LINE_BUFFER_CAP);
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let poll = Duration::from_millis(config.poll_interval_ms.max(1));
        let path = config.path;

        let handle = thread::Builder::new()
            .name("eqlog-tailer".to_owned())
            .spawn(move || read_loop(file, pos, path, poll, tx, thread_stop))?;

        Ok(Tailer {
            lines: rx,
            stop,
            handle: Some(handle),
        })
    }

    /// Stop the reader thread and wait for it to exit.
    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for Tailer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Open the file without denying the game its own handles. On Windows the
/// game keeps the log open for writing (and the launcher may rotate it), so
/// we must share READ | WRITE | DELETE (0x7).
#[cfg(windows)]
fn open_shared(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ_WRITE_DELETE: u32 = 0x7;
    std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ_WRITE_DELETE)
        .open(path)
}

#[cfg(not(windows))]
fn open_shared(path: &Path) -> io::Result<File> {
    File::open(path)
}

fn read_loop(
    mut file: File,
    mut pos: u64,
    path: PathBuf,
    poll: Duration,
    tx: Sender<String>,
    stop: Arc<AtomicBool>,
) {
    // Bytes of a trailing partial line, kept until its newline arrives.
    let mut partial: Vec<u8> = Vec::new();
    let mut buf = [0u8; 8192];

    while !stop.load(Ordering::Relaxed) {
        match file.read(&mut buf) {
            Ok(0) => {
                // At EOF. Check lifecycle before sleeping.
                let Ok(path_meta) = std::fs::metadata(&path) else {
                    // File disappeared (deleted/renamed with no successor
                    // yet). Poll for a replacement and read it from the
                    // start.
                    partial.clear();
                    match wait_for_reopen(&path, poll, &stop) {
                        Some(new_file) => {
                            file = new_file;
                            pos = 0;
                        }
                        None => return, // stop requested while waiting
                    }
                    continue;
                };
                if rotated(&file, &path_meta) {
                    // The path now names a different file (rename+recreate
                    // or atomic replace). Reopen it and read from the start;
                    // if the successor vanishes mid-swap, retry next cycle.
                    if let Ok(new_file) = open_shared(&path) {
                        partial.clear();
                        file = new_file;
                        pos = 0;
                        continue;
                    }
                }
                if path_meta.len() < pos {
                    // The file at the path is shorter than what we already
                    // read: either the log was truncated in place, or the
                    // identity check missed a swap (e.g. Windows tunneling
                    // reusing the creation time of a recreated file). Both
                    // are handled the same read-position-safe way: reopen
                    // the *path* and restart from offset 0 — never trust the
                    // old handle or the old position. Appends can only grow
                    // the path's length past `pos`, so this cannot misfire
                    // on writer activity.
                    if let Ok(new_file) = open_shared(&path) {
                        partial.clear();
                        file = new_file;
                        pos = 0;
                        continue; // read the rewritten content immediately
                    }
                }
                if !sleep_until_stop(&stop, poll) {
                    return;
                }
            }
            Ok(n) => {
                pos += n as u64;
                partial.extend_from_slice(&buf[..n]);
                if !emit_complete_lines(&mut partial, &tx, &stop) {
                    return; // receiver dropped or stop requested
                }
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => {
                // Handle went bad (e.g. rotated out from under us). Recover
                // by reopening the path from the start.
                partial.clear();
                match wait_for_reopen(&path, poll, &stop) {
                    Some(new_file) => {
                        file = new_file;
                        pos = 0;
                    }
                    None => return,
                }
            }
        }
    }
}

/// True when `path_meta` (a fresh stat of the tailed path) refers to a
/// different file than the open handle — i.e. the log was rotated by
/// rename+recreate or atomic replace. Plain truncation and appends are NOT
/// rotation and return false.
fn rotated(file: &File, path_meta: &std::fs::Metadata) -> bool {
    let Ok(handle_meta) = file.metadata() else {
        // The handle itself went bad; treat as rotated so we reopen.
        return true;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        handle_meta.ino() != path_meta.ino() || handle_meta.dev() != path_meta.dev()
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        windows_path_swapped(
            (handle_meta.creation_time(), handle_meta.file_size()),
            (path_meta.creation_time(), path_meta.file_size()),
        )
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (&handle_meta, path_meta);
        false
    }
}

/// Windows file-identity decision, factored out (and compiled on every
/// platform) so the rotation logic is unit-testable on non-Windows hosts.
/// Inputs are `(creation_time, file_size)` from two NON-ATOMIC stats: one of
/// the open handle, one of the path.
///
/// Only the creation times are compared. The sizes are deliberately ignored:
/// the game appends to the log continuously, so a write landing between the
/// two stats makes the sizes diverge *for the same file* — treating that as
/// rotation replayed the whole log from offset 0 (hours of TTS spam and
/// double-counted meters mid-raid). Creation time is stable across appends
/// and truncation, and changes whenever the path is swapped for a new file
/// (rename+recreate or atomic replace) — including a same-size rewrite. The
/// one miss (Windows tunneling reusing a creation time within ~15 s of a
/// same-name recreate) is caught by the `path len < pos` reopen guard in
/// [`read_loop`] when the replacement is shorter.
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_path_swapped(handle: (u64, u64), path: (u64, u64)) -> bool {
    let ((handle_created, _handle_size), (path_created, _path_size)) = (handle, path);
    handle_created != path_created
}

/// Max lines buffered between the reader thread and the consumer. Bounds
/// memory during a full-log replay; large enough to absorb normal live bursts
/// without the reader ever blocking in steady state.
const LINE_BUFFER_CAP: usize = 8192;

/// Drain every complete (newline-terminated) line out of `partial`, strip
/// CRLF/LF, and send it. On a full bounded channel the send blocks with
/// backpressure, re-checking `stop` on a short timeout so shutdown is never
/// wedged behind a full queue. Returns `false` if the receiver is gone or a
/// stop was requested mid-send.
fn emit_complete_lines(partial: &mut Vec<u8>, tx: &Sender<String>, stop: &AtomicBool) -> bool {
    while let Some(nl) = partial.iter().position(|&b| b == b'\n') {
        let mut line: Vec<u8> = partial.drain(..=nl).collect();
        line.pop(); // '\n'
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        let mut text = String::from_utf8_lossy(&line).into_owned();
        loop {
            match tx.send_timeout(text, Duration::from_millis(100)) {
                Ok(()) => break,
                Err(SendTimeoutError::Timeout(returned)) => {
                    if stop.load(Ordering::Relaxed) {
                        return false;
                    }
                    text = returned; // consumer is slow; keep applying backpressure
                }
                Err(SendTimeoutError::Disconnected(_)) => return false,
            }
        }
    }
    true
}

/// Try to reopen `path`, retrying every `poll` until it exists or a stop is
/// requested. Returns `None` if stopped first.
fn wait_for_reopen(path: &Path, poll: Duration, stop: &AtomicBool) -> Option<File> {
    loop {
        if stop.load(Ordering::Relaxed) {
            return None;
        }
        if let Ok(file) = open_shared(path) {
            return Some(file);
        }
        if !sleep_until_stop(stop, poll) {
            return None;
        }
    }
}

/// Sleep for `total`, waking early if `stop` is set. Sleeps in short slices
/// so shutdown stays prompt even with long poll intervals. Returns `false`
/// if a stop was requested.
fn sleep_until_stop(stop: &AtomicBool, total: Duration) -> bool {
    const SLICE: Duration = Duration::from_millis(25);
    let deadline = Instant::now() + total;
    loop {
        if stop.load(Ordering::Relaxed) {
            return false;
        }
        let now = Instant::now();
        if now >= deadline {
            return true;
        }
        thread::sleep((deadline - now).min(SLICE));
    }
}

#[cfg(test)]
mod tests {
    use super::windows_path_swapped;

    /// Regression for the rotation false-positive race (APP_REVIEW N4,
    /// `tail.rs:217-225`): the game appending between the two non-atomic
    /// stats makes the sizes differ for the SAME file. The old logic called
    /// that a rotation and replayed the log from the top; it must not.
    #[test]
    fn append_between_stats_is_not_rotation() {
        let handle = (116_444_736_000_000_000, 84_672);
        let path = (116_444_736_000_000_000, 84_791); // +119 bytes appended
        assert!(
            !windows_path_swapped(handle, path),
            "size divergence from a raced append must not read as rotation"
        );
    }

    /// A same-size atomic replace still reads as rotation: the sizes match
    /// but the replacement file has its own creation time.
    #[test]
    fn same_size_rewrite_is_rotation() {
        let handle = (116_444_736_000_000_000, 4_096);
        let path = (116_444_737_000_000_000, 4_096);
        assert!(windows_path_swapped(handle, path));
    }

    #[test]
    fn identical_stats_are_the_same_file() {
        assert!(!windows_path_swapped((7, 512), (7, 512)));
    }
}
