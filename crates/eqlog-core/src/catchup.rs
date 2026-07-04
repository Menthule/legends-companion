//! Catch-up guard: detects when a tail session is replaying old log content
//! instead of following the live edge (post-sprint item 13).
//!
//! Motivating incident: a false rotation detection reopened a 16 MB log from
//! offset 0 and replayed the whole thing through TTS. During such a replay,
//! line timestamps lag far behind the newest line time already seen — the
//! host must suppress audible/visible trigger actions and fight-history
//! writes until the stream is back at the live edge.
//!
//! This is the pure, unit-testable state machine; the Tauri tail session
//! feeds it every line (and idle ticks) and applies the suppression.
//!
//! Rules:
//! - **Enter** catch-up when a line's timestamp lags the newest-seen line
//!   timestamp by more than [`CatchUpGuard::enter_lag_secs`] (default 30 s).
//!   Out-of-order jitter of a few seconds never triggers it.
//! - **Exit** once a line's timestamp is within
//!   [`CatchUpGuard::exit_lag_secs`] (default 5 s) of the live clock — that
//!   line, and everything after it, is live and must NOT be suppressed.
//! - **Exit on idle** too: when no line has arrived for `exit_lag_secs`
//!   while catching up, the backlog is drained (the tailer is parked at
//!   EOF), so the session is back at the live edge even though the last
//!   replayed line was old.

/// What [`CatchUpGuard::observe_line`] / [`CatchUpGuard::observe_idle`]
/// reported about the guard's state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CatchUpTransition {
    /// No state change.
    None,
    /// Replay detected — suppression starts with the observed line.
    Entered,
    /// Back at the live edge; `suppressed_lines` lines were processed in
    /// catch-up mode. The line that triggered the exit is live (not counted,
    /// not to be suppressed).
    Exited { suppressed_lines: u64 },
}

/// See the module docs. Timestamps are Unix seconds; `now_ts` must come from
/// the live wall clock (the same domain the log's timestamps parse into).
#[derive(Debug)]
pub struct CatchUpGuard {
    enter_lag_secs: i64,
    exit_lag_secs: i64,
    max_seen_ts: i64,
    active: bool,
    suppressed_lines: u64,
}

impl CatchUpGuard {
    /// Spec thresholds: enter at > 30 s lag, exit within 5 s of live.
    pub fn new() -> Self {
        Self::with_thresholds(30, 5)
    }

    pub fn with_thresholds(enter_lag_secs: i64, exit_lag_secs: i64) -> Self {
        CatchUpGuard {
            enter_lag_secs,
            exit_lag_secs,
            max_seen_ts: 0,
            active: false,
            suppressed_lines: 0,
        }
    }

    /// Whether the session is currently replaying (suppress actions).
    pub fn is_active(&self) -> bool {
        self.active
    }

    /// Lines suppressed so far in the current catch-up episode.
    pub fn suppressed_lines(&self) -> u64 {
        self.suppressed_lines
    }

    /// Feed one parsed line (`line_ts` = its timestamp, `now_ts` = live wall
    /// clock). After the call, [`Self::is_active`] says whether this line's
    /// actions must be suppressed.
    pub fn observe_line(&mut self, line_ts: i64, now_ts: i64) -> CatchUpTransition {
        // Lag vs the newest line time seen BEFORE this one: a big positive
        // value means we jumped backwards — a replay, not live play.
        let lag_behind_seen = self.max_seen_ts - line_ts;
        if line_ts > self.max_seen_ts {
            self.max_seen_ts = line_ts;
        }
        if self.active {
            if now_ts - line_ts <= self.exit_lag_secs {
                // This line is (close enough to) live: the replay is over
                // and this line's own actions go through normally.
                return self.exit();
            }
            self.suppressed_lines += 1;
            return CatchUpTransition::None;
        }
        if lag_behind_seen > self.enter_lag_secs {
            self.active = true;
            self.suppressed_lines = 1; // this line is suppressed
            return CatchUpTransition::Entered;
        }
        CatchUpTransition::None
    }

    /// The line stream has been quiet for `idle_secs` (no lines pending):
    /// while catching up, that means the backlog is fully drained and the
    /// tailer is parked at EOF — i.e. we are at the live edge.
    pub fn observe_idle(&mut self, idle_secs: u64) -> CatchUpTransition {
        if self.active && idle_secs as i64 >= self.exit_lag_secs {
            return self.exit();
        }
        CatchUpTransition::None
    }

    fn exit(&mut self) -> CatchUpTransition {
        self.active = false;
        let suppressed_lines = std::mem::take(&mut self.suppressed_lines);
        CatchUpTransition::Exited { suppressed_lines }
    }
}

impl Default for CatchUpGuard {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 100_000;

    #[test]
    fn live_monotonic_lines_never_enter() {
        let mut g = CatchUpGuard::new();
        for i in 0..100 {
            let ts = NOW - 100 + i;
            assert_eq!(g.observe_line(ts, ts), CatchUpTransition::None);
            assert!(!g.is_active());
        }
    }

    #[test]
    fn small_out_of_order_jitter_is_tolerated() {
        let mut g = CatchUpGuard::new();
        g.observe_line(NOW, NOW);
        // 10 s backwards: below the 30 s threshold, stays live.
        assert_eq!(g.observe_line(NOW - 10, NOW), CatchUpTransition::None);
        assert!(!g.is_active());
        // Exactly at the threshold: still tolerated (strictly greater enters).
        assert_eq!(g.observe_line(NOW - 30, NOW), CatchUpTransition::None);
        assert!(!g.is_active());
    }

    #[test]
    fn replay_enters_counts_and_exits_on_live_line() {
        let mut g = CatchUpGuard::new();
        // Live tailing had reached NOW…
        g.observe_line(NOW, NOW);
        // …then a false rotation replays the file from hours ago.
        assert_eq!(g.observe_line(NOW - 7200, NOW), CatchUpTransition::Entered);
        assert!(g.is_active());
        // The backlog streams through (all suppressed).
        for i in 1..500 {
            assert_eq!(g.observe_line(NOW - 7200 + i, NOW), CatchUpTransition::None);
            assert!(g.is_active());
        }
        assert_eq!(g.suppressed_lines(), 500);
        // First line within 5 s of the live clock ends the episode, is NOT
        // counted as suppressed, and must go through unsuppressed.
        assert_eq!(
            g.observe_line(NOW - 3, NOW),
            CatchUpTransition::Exited {
                suppressed_lines: 500
            }
        );
        assert!(!g.is_active());
    }

    #[test]
    fn drained_backlog_exits_on_idle() {
        let mut g = CatchUpGuard::new();
        g.observe_line(NOW, NOW);
        g.observe_line(NOW - 1000, NOW);
        g.observe_line(NOW - 999, NOW);
        assert!(g.is_active());
        // Not idle for long enough yet.
        assert_eq!(g.observe_idle(2), CatchUpTransition::None);
        assert!(g.is_active());
        // 5 s with no lines: the tailer is at EOF — live edge.
        assert_eq!(
            g.observe_idle(5),
            CatchUpTransition::Exited {
                suppressed_lines: 2
            }
        );
        assert!(!g.is_active());
        // Idle while inactive is a no-op.
        assert_eq!(g.observe_idle(60), CatchUpTransition::None);
    }

    #[test]
    fn reenters_on_a_second_replay_with_fresh_count() {
        let mut g = CatchUpGuard::new();
        g.observe_line(NOW, NOW);
        assert_eq!(g.observe_line(NOW - 500, NOW), CatchUpTransition::Entered);
        assert_eq!(
            g.observe_line(NOW - 1, NOW),
            CatchUpTransition::Exited {
                suppressed_lines: 1
            }
        );
        // Second replay episode starts a fresh suppressed-line count.
        assert_eq!(g.observe_line(NOW - 400, NOW), CatchUpTransition::Entered);
        assert_eq!(g.suppressed_lines(), 1);
        g.observe_line(NOW - 399, NOW);
        assert_eq!(g.suppressed_lines(), 2);
    }

    #[test]
    fn first_line_ever_cannot_enter() {
        // max_seen starts at 0; an ancient first line has negative lag and
        // must not trigger (entry is measured against seen lines only).
        let mut g = CatchUpGuard::new();
        assert_eq!(g.observe_line(NOW - 7200, NOW), CatchUpTransition::None);
        assert!(!g.is_active());
    }
}
