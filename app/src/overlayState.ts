// Persisted overlay visibility, shared by the top-bar toggle and the
// per-overlay switches in Settings. Overlays default to ON.

import { OVERLAY_LABELS } from "./types";

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
export const DEFAULT_ALERT_SIZE_PX = 26;

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
// even if they miss the one-shot Tauri lock event.
// ---------------------------------------------------------------------------

export const OVERLAY_ARRANGE_KEY = "eqlogs.overlays.arranging";

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
// Displayed XP rate/ETA is based on the recent grind, not the whole retained
// session. The cumulative session is still stored for history/reset behavior.
const XP_RECENT_WINDOW_SECS = 10 * 60;

// Gaps longer than this between consecutive gains are treated as downtime
// (AFK, medding, camp-move, or the game being closed while the session
// persists in localStorage) and don't count toward the rate window. Normal
// pull-to-pull gaps stay well under it, so active grinding is measured
// honestly instead of being diluted by idle time.
const XP_IDLE_CAP_SECS = 300;

export function computeXpStats(session: XpSession, nowMs: number): XpStats {
  const rows = session.rows;
  if (rows.length === 0) {
    return { total: 0, count: 0, perHour: null, perLevelHours: null };
  }
  const newest = rows[0];
  const sinceNewest =
    newest.at != null ? Math.max(0, (nowMs - newest.at) / 1000) : 0;
  const ageSecs = (row: SharedXpRow) => {
    if (newest.at != null && row.at != null) {
      return Math.max(0, sinceNewest + (newest.at - row.at) / 1000);
    }
    return Math.max(0, sinceNewest + (newest.ts - row.ts));
  };
  const recentRows = rows.filter((r) => ageSecs(r) <= XP_RECENT_WINDOW_SECS);
  if (recentRows.length === 0) {
    return { total: 0, count: 0, perHour: null, perLevelHours: null };
  }
  const windowTotal = recentRows.reduce((sum, r) => sum + r.percent, 0);
  // Active-time window: sum the log-domain gaps between consecutive gains
  // (rows are newest-first), each capped so a long idle stretch counts as at
  // most XP_IDLE_CAP_SECS. Add the (also capped) time since the last gain so
  // the rate still decays for a few minutes after a kill, then settles.
  let activeSecs = Math.min(
    sinceNewest,
    XP_IDLE_CAP_SECS,
    XP_RECENT_WINDOW_SECS,
  );
  for (let i = 0; i < recentRows.length - 1; i++) {
    const gap = recentRows[i].ts - recentRows[i + 1].ts;
    activeSecs += Math.min(Math.max(0, gap), XP_IDLE_CAP_SECS);
  }
  const windowSecs = Math.max(60, Math.min(activeSecs, XP_RECENT_WINDOW_SECS));
  const perHour = windowTotal / (windowSecs / 3600);
  // Time to earn ONE full level (100%) at the current rate. We can't compute
  // "time to YOUR next level" — the log reports xp as a per-level percentage
  // but never your absolute level or starting position within it, so the
  // session total isn't "progress into a level".
  const perLevelHours = perHour > 0 ? 100 / perHour : null;
  return {
    total: windowTotal,
    count: recentRows.length,
    perHour,
    perLevelHours,
  };
}

// --- Position within the current level & ETA-to-level (P9) -------------------
// The log never reports your absolute level or position within it, so we track
// it from events: reset to 0 on a LevelUp ding, accumulate each XpGain%. Until
// the first ding of a session the position is unknown, so the user can set it
// (persisted) to get an accurate kills/ETA-to-level.
export const XP_LEVEL_PROGRESS_KEY = "eqlogs.session.levelProgress";

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

export const PROC_ALERTS_KEY = "eqlogs.proc.alerts";
export const PROC_TTS_KEY = "eqlogs.proc.tts";
export const PROC_PREF_EVENT = "eqlogs-proc-pref";

function loadBoolPref(key: string, defaultValue: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return defaultValue;
    return raw === "1";
  } catch {
    return defaultValue;
  }
}

function saveBoolPref(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
    window.dispatchEvent(new Event(PROC_PREF_EVENT));
  } catch {
    // localStorage unavailable — the current in-memory state still works.
  }
}

export function loadProcAlerts(): boolean {
  return loadBoolPref(PROC_ALERTS_KEY, true);
}

export function saveProcAlerts(value: boolean): void {
  saveBoolPref(PROC_ALERTS_KEY, value);
}

export function loadProcTts(): boolean {
  return loadBoolPref(PROC_TTS_KEY, false);
}

export function saveProcTts(value: boolean): void {
  saveBoolPref(PROC_TTS_KEY, value);
}
