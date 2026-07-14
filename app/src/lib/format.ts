// Canonical duration / number / byte formatters — the ONE home for the
// m:ss family that used to be re-implemented per tab, per overlay, and per
// lib module (and had drifted: the respawn overlay dropped seconds on
// hour-long countdowns that the Timers tab kept, and the scoreboard
// abbreviated numbers differently from the meters). Pure module — safe to
// import from components, overlays, and other lib code alike.

/** Seconds → `m:ss`, rolling into `h:mm:ss` past an hour (floor).
 *
 *  The hour rollover keeps long spans (per-level ETA, multi-hour respawns,
 *  session length) reading as H:MM:SS instead of a runaway minute count
 *  like "988:09" — and keeps the real seconds, since hour+ respawns aren't
 *  always whole minutes (P43). Sub-hour output is M:SS. */
export function fmtDuration(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const sec = String(s % 60).padStart(2, "0");
  const h = Math.floor(s / 3600);
  if (h > 0) {
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    return `${h}:${m}:${sec}`;
  }
  return `${Math.floor(s / 60)}:${sec}`;
}

/** Countdown label for respawn/custom timers: "UP" at zero, `Ns` under a
 *  minute, then `m:ss` / `h:mm:ss`. */
export function fmtCountdown(secs: number): string {
  if (secs <= 0) return "UP";
  if (secs < 60) return `${secs}s`;
  return fmtDuration(secs);
}

/** Duration for list rows (respawn lengths, timer durations): "—" when
 *  unknown/zero, else `m:ss` / `h:mm:ss`. */
export function fmtLen(secs: number): string {
  if (secs <= 0) return "—";
  return fmtDuration(secs);
}

/** Compact number: 12345 → "12.3k", 3400000 → "3.4m"; below 10k, plain. */
export function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** Human-readable byte size, e.g. "947 B" / "512.0 MB" / "1.2 GB". */
export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

/** Relative age of a past instant: "42s ago" / "5m ago". */
export function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return `${m}m ago`;
}
