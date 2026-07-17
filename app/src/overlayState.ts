// Persisted overlay visibility, shared by the top-bar toggle and the
// per-overlay switches in Settings. Overlays default to ON.

import { useEffect, useState } from "react";
import { OVERLAY_LABELS } from "./types";
import { computeRollingPaceRate } from "./lib/pace";

/** localStorage key for overlay visibility — exported so overlay windows can
 *  filter cross-window "storage" events. */
export const OVERLAY_VIS_KEY = "eqlogs.overlays.visible";
/** Same-window event: "storage" only fires in OTHER windows, so a window that
 *  writes visibility dispatches this to nudge its own listeners. */
export const OVERLAY_VIS_EVENT = "eqlogs-overlay-visibility-changed";

export type OverlayVisibility = Record<string, boolean>;

export function loadOverlayVisibility(): OverlayVisibility {
  const defaults: OverlayVisibility = {};
  for (const label of OVERLAY_LABELS) defaults[label] = true;
  try {
    const raw = localStorage.getItem(OVERLAY_VIS_KEY);
    if (!raw) return defaults;
    return { ...defaults, ...(JSON.parse(raw) as OverlayVisibility) };
  } catch {
    return defaults;
  }
}

export function saveOverlayVisibility(v: OverlayVisibility): void {
  try {
    localStorage.setItem(OVERLAY_VIS_KEY, JSON.stringify(v));
  } catch {
    // localStorage unavailable — visibility just won't persist.
  }
  window.dispatchEvent(new Event(OVERLAY_VIS_EVENT));
}

/** Is one overlay enabled? (absent = on, matching the default-visible model.) */
export function isOverlayEnabled(label: string): boolean {
  return loadOverlayVisibility()[label] !== false;
}

/** Flip one overlay's enabled flag and persist. Returns the new value. */
export function toggleOverlayEnabled(label: string): boolean {
  const vis = loadOverlayVisibility();
  const next = !(vis[label] !== false);
  saveOverlayVisibility({ ...vis, [label]: next });
  return next;
}

// ---------------------------------------------------------------------------
// Meter overlay "my sources" section (item 15 overlay companion). The locked
// overlay is click-through, so the toggle lives in Settings; the overlay
// window picks changes up via the cross-window "storage" event.
// ---------------------------------------------------------------------------

/** localStorage key — exported so the overlay can filter "storage" events. */
export const METER_SOURCES_KEY = "eqlogs.overlay.meterSources";

/** Whether the meter overlay shows the player's top damage sources. */
export function loadMeterSources(): boolean {
  try {
    // Default ON: the damage-type/source micro-rows under the player's bar
    // show unless the user has explicitly turned them off ("0"). An absent
    // key (never toggled) counts as on.
    return localStorage.getItem(METER_SOURCES_KEY) !== "0";
  } catch {
    return true;
  }
}

export function saveMeterSources(on: boolean): void {
  try {
    localStorage.setItem(METER_SOURCES_KEY, on ? "1" : "0");
  } catch {
    // localStorage unavailable — the toggle just won't persist.
  }
}

/** localStorage key — how many damage-source micro-rows to show under OTHER
 *  players' bars on the meter overlay. */
export const METER_OTHER_SOURCES_KEY = "eqlogs.overlay.meterOtherSources";
export const DEFAULT_METER_OTHER_SOURCES = 3;
export const MAX_METER_OTHER_SOURCES = 3;

/** Top-N damage sources shown under each non-player bar (0 = off). Default 3. */
export function loadMeterOtherSources(): number {
  try {
    const raw = localStorage.getItem(METER_OTHER_SOURCES_KEY);
    if (raw == null) return DEFAULT_METER_OTHER_SOURCES;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return DEFAULT_METER_OTHER_SOURCES;
    return Math.max(0, Math.min(MAX_METER_OTHER_SOURCES, n));
  } catch {
    return DEFAULT_METER_OTHER_SOURCES;
  }
}

export function saveMeterOtherSources(n: number): void {
  try {
    localStorage.setItem(METER_OTHER_SOURCES_KEY, String(n));
  } catch {
    // localStorage unavailable — the setting just won't persist.
  }
}

// ---------------------------------------------------------------------------
// Buff-bar show threshold: long buffs (30–60 min) shouldn't hold a bar for
// their whole run — they only earn one once they're close to expiring.
// Minutes of remaining time under which buff / on-others bars appear;
// 0 = always show (the default — opt in from Settings). Overlay windows pick
// changes up via the cross-window "storage" event; same-window listeners via
// the custom event below.
// ---------------------------------------------------------------------------

export const BUFF_THRESHOLD_KEY = "eqlogs.overlay.buffThresholdMins";
export const BUFF_THRESHOLD_EVENT = "eqlogs-buff-threshold-changed";
export const DEFAULT_BUFF_THRESHOLD_MINS = 0;

export function loadBuffThresholdMins(): number {
  try {
    const raw = localStorage.getItem(BUFF_THRESHOLD_KEY);
    if (raw == null) return DEFAULT_BUFF_THRESHOLD_MINS;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_BUFF_THRESHOLD_MINS;
  } catch {
    return DEFAULT_BUFF_THRESHOLD_MINS;
  }
}

export function saveBuffThresholdMins(mins: number): void {
  try {
    localStorage.setItem(BUFF_THRESHOLD_KEY, String(mins));
  } catch {
    // localStorage unavailable — the threshold just won't persist.
  }
  // Storage events only fire in OTHER windows; nudge this one too.
  window.dispatchEvent(new Event(BUFF_THRESHOLD_EVENT));
}

// ---------------------------------------------------------------------------
// Alert text size (px) for the alerts overlay — adjustable because "easier
// to see over game footage" varies by resolution and eyesight. The alerts
// window picks changes up via the cross-window "storage" event.
// ---------------------------------------------------------------------------

export const ALERT_SIZE_KEY = "eqlogs.overlay.alertSizePx";
export const DEFAULT_ALERT_SIZE_PX = 20;

export function loadAlertSizePx(): number {
  try {
    const raw = localStorage.getItem(ALERT_SIZE_KEY);
    if (raw == null) return DEFAULT_ALERT_SIZE_PX;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 10 ? n : DEFAULT_ALERT_SIZE_PX;
  } catch {
    return DEFAULT_ALERT_SIZE_PX;
  }
}

export function saveAlertSizePx(px: number): void {
  try {
    localStorage.setItem(ALERT_SIZE_KEY, String(px));
  } catch {
    // localStorage unavailable — the size just won't persist.
  }
}

// ---------------------------------------------------------------------------
// Overlay arrange state, shared so overlay windows can show drag/resize chrome
// even if they miss the one-shot Tauri lock event — and so every main-window
// arrange control (top-bar Overlays menu, Settings → Overlays) reads the SAME
// state instead of each holding its own copy.
// ---------------------------------------------------------------------------

export const OVERLAY_ARRANGE_KEY = "eqlogs.overlays.arranging";
/** Same-window event: "storage" only fires in OTHER windows, so a window that
 *  writes the arrange flag dispatches this to nudge its own listeners. */
export const OVERLAY_ARRANGE_EVENT = "eqlogs-overlay-arrange-changed";

export function loadOverlayArrange(): boolean {
  try {
    return localStorage.getItem(OVERLAY_ARRANGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveOverlayArrange(on: boolean): void {
  try {
    localStorage.setItem(OVERLAY_ARRANGE_KEY, on ? "1" : "0");
  } catch {
    // localStorage unavailable — Tauri lock events still handle normal cases.
  }
  window.dispatchEvent(new Event(OVERLAY_ARRANGE_EVENT));
}

/** Main-window arrange state, kept in sync across every surface that shows it
 *  (Dashboard top bar + Settings → Overlays) and across windows. Read-only:
 *  mutate via saveOverlayArrange so all listeners hear it. Overlay windows
 *  keep their own hook (overlay/useOverlayLock) because their primary channel
 *  is the per-window Tauri lock event. */
export function useOverlayArrange(): boolean {
  const [arranging, setArranging] = useState(() => loadOverlayArrange());
  useEffect(() => {
    const refresh = () => setArranging(loadOverlayArrange());
    const onStorage = (event: StorageEvent) => {
      if (event.key === OVERLAY_ARRANGE_KEY) refresh();
    };
    window.addEventListener(OVERLAY_ARRANGE_EVENT, refresh);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(OVERLAY_ARRANGE_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return arranging;
}

// ---------------------------------------------------------------------------
// Session XP shared by the main Fights tab and the XP overlay. The main window
// is always mounted and receives log-line events; overlays read this store so
// opening/showing them after an XP tick does not leave them blank.
// ---------------------------------------------------------------------------

export const XP_SESSION_KEY = "eqlogs.session.xp";
// Rate-window rows are capped so a marathon session doesn't grow localStorage
// without bound. The cumulative total/count are tracked separately (P21) so the
// capped window never shrinks the displayed session total.
const XP_SESSION_CAP = 200;
// A gap this long since the last gain means a new play session — don't carry a
// stale total across it (P21). A quick restart mid-grind stays under it and
// continues the session.
const XP_SESSION_STALE_MS = 6 * 60 * 60 * 1000;

export interface SharedXpRow {
  id: number;
  /** Log-line timestamp (naive local — do NOT compare against Date.now()). */
  ts: number;
  percent: number;
  party: boolean;
  /** Wall-clock ms (Date.now()) when the row was observed. Optional so rows
   *  saved by older builds still load; used only as a duration anchor for
   *  the live XP/hour rate. */
  at?: number;
}

/** A play session's XP: cumulative `total`/`count` that never degrade, plus the
 *  most-recent `rows` (capped) that feed the live rate window. */
export interface XpSession {
  total: number;
  count: number;
  rows: SharedXpRow[];
}

const EMPTY_XP_SESSION: XpSession = { total: 0, count: 0, rows: [] };

export function loadXpSession(): XpSession {
  try {
    const raw = localStorage.getItem(XP_SESSION_KEY);
    if (!raw) return { ...EMPTY_XP_SESSION };
    const parsed: unknown = JSON.parse(raw);
    let session: XpSession;
    if (Array.isArray(parsed)) {
      // Legacy format: a bare rows array. Reconstruct the cumulative fields
      // from what we have (best effort — pre-P21 sessions only kept 200 rows).
      const rows = parsed as SharedXpRow[];
      session = {
        total: rows.reduce((s, r) => s + (r.percent ?? 0), 0),
        count: rows.length,
        rows,
      };
    } else if (parsed && typeof parsed === "object") {
      const o = parsed as Record<string, unknown>;
      session = {
        total: typeof o.total === "number" ? o.total : 0,
        count: typeof o.count === "number" ? o.count : 0,
        rows: Array.isArray(o.rows) ? (o.rows as SharedXpRow[]) : [],
      };
    } else {
      return { ...EMPTY_XP_SESSION };
    }
    // Drop a stale session: a long break since the last gain is a new play
    // session, not a continuation (P21).
    const newestAt = session.rows[0]?.at;
    if (newestAt != null && Date.now() - newestAt > XP_SESSION_STALE_MS) {
      return { ...EMPTY_XP_SESSION };
    }
    return session;
  } catch {
    return { ...EMPTY_XP_SESSION };
  }
}

export function saveXpSession(session: XpSession): void {
  try {
    localStorage.setItem(
      XP_SESSION_KEY,
      JSON.stringify({
        total: session.total,
        count: session.count,
        rows: session.rows.slice(0, XP_SESSION_CAP),
      }),
    );
  } catch {
    // localStorage unavailable — XP still renders in the main Fights tab.
  }
}

export function appendXpSession(
  row: SharedXpRow,
  opts: { stampNow?: boolean } = {},
): XpSession {
  // stampNow=false (replay catch-up): keep the row but don't anchor the
  // live XP/hour window at wall-clock "now" for an hours-old gain.
  const stamped =
    opts.stampNow === false ? { ...row } : { ...row, at: Date.now() };
  const prev = loadXpSession();
  const next: XpSession = {
    total: prev.total + row.percent, // cumulative — never capped away (P21)
    count: prev.count + 1,
    rows: [stamped, ...prev.rows].slice(0, XP_SESSION_CAP),
  };
  saveXpSession(next);
  return next;
}

/** Reset the session (the Fights-tab Reset button). Other windows hear the
 *  storage event; the caller updates its own state. */
export function clearXpSession(): void {
  saveXpSession({ ...EMPTY_XP_SESSION });
}

export interface XpStats {
  total: number;
  count: number;
  perHour: number | null;
  /** Hours to earn a FULL level (100%) at the current rate — NOT time to
   *  your next level (the log never reveals your position within a level). */
  perLevelHours: number | null;
}

/**
 * Session XP stats with a LIVE rate: the window runs from the first gain to
 * "now", so the rate keeps decaying between kills instead of freezing at the
 * last gain. Row timestamps are log-domain (naive local) while `nowMs` is
 * wall clock — the two never mix as absolutes: the window is the log-domain
 * span between gains plus the wall-clock duration since the newest one.
 * Floored at one minute so the first gain doesn't print an absurd rate.
 */
export function computeXpStats(session: XpSession, nowMs: number): XpStats {
  const rolling = computeRollingPaceRate(
    session.rows.map((row) => ({
      sourceTimeSecs: row.ts,
      value: row.percent,
      observedAtMs: row.at,
    })),
    nowMs,
  );
  // Time to earn ONE full level (100%) at the current rate. We can't compute
  // "time to YOUR next level" — the log reports xp as a per-level percentage
  // but never your absolute level or starting position within it, so the
  // session total isn't "progress into a level".
  const perLevelHours = rolling.perHour != null && rolling.perHour > 0
    ? 100 / rolling.perHour
    : null;
  return {
    ...rolling,
    perLevelHours,
  };
}

// --- Position within the current level & ETA-to-level (P9) -------------------
// The log never reports your absolute level or position within it, so we track
// it from events: reset to 0 on a LevelUp ding, accumulate each XpGain%. Until
// the app has seen a ding (the anchor) the position is a guess, so it is only
// trusted — and only shown — once the anchor flag is set. Both persist so the
// XP overlay (separate window) and later sessions keep the position.
export const XP_LEVEL_PROGRESS_KEY = "eqlogs.session.levelProgress";
export const XP_LEVEL_ANCHOR_KEY = "eqlogs.session.levelAnchor";

export function loadLevelAnchorKnown(): boolean {
  try {
    return localStorage.getItem(XP_LEVEL_ANCHOR_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveLevelAnchorKnown(known: boolean): void {
  try {
    localStorage.setItem(XP_LEVEL_ANCHOR_KEY, known ? "1" : "0");
  } catch {
    // localStorage unavailable — the anchor just won't persist.
  }
}

export function loadLevelProgress(): number {
  try {
    const raw = localStorage.getItem(XP_LEVEL_PROGRESS_KEY);
    const n = raw == null ? 0 : Number(raw);
    return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
  } catch {
    return 0;
  }
}

export function saveLevelProgress(pct: number): void {
  try {
    localStorage.setItem(
      XP_LEVEL_PROGRESS_KEY,
      String(Math.min(100, Math.max(0, pct))),
    );
  } catch {
    // localStorage unavailable — progress just won't persist.
  }
}

export interface LevelEta {
  /** Position within the current level, 0-100. */
  progressPct: number;
  /** Remaining % to ding. */
  toLevelPct: number;
  /** Mean % per kill this session (null if no gains yet). */
  avgPerKill: number | null;
  /** Estimated kills to level (null if unknown). */
  kills: number | null;
  /** Estimated minutes to level at the current rate (null if unknown). */
  mins: number | null;
}

/** Kills- and time-to-level from the tracked level position, the session's
 *  mean %/kill, and the live %/hour rate. All null-guarded: no rate or no
 *  gains yet ⇒ no estimate rather than a bogus one. */
export function computeLevelEta(
  session: XpSession,
  progressPct: number,
  perHour: number | null,
): LevelEta {
  const progress = Math.min(100, Math.max(0, progressPct));
  const toLevelPct = Math.max(0, 100 - progress);
  const avgPerKill = session.count > 0 ? session.total / session.count : null;
  const kills =
    avgPerKill && avgPerKill > 0 ? Math.ceil(toLevelPct / avgPerKill) : null;
  const mins = perHour && perHour > 0 ? (toLevelPct / perHour) * 60 : null;
  return { progressPct: progress, toLevelPct, avgPerKill, kills, mins };
}
