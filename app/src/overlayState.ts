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
const XP_SESSION_CAP = 200;

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

export function loadXpSession(): SharedXpRow[] {
  try {
    const raw = localStorage.getItem(XP_SESSION_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SharedXpRow[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveXpSession(rows: SharedXpRow[]): void {
  try {
    localStorage.setItem(XP_SESSION_KEY, JSON.stringify(rows.slice(0, XP_SESSION_CAP)));
  } catch {
    // localStorage unavailable — XP still renders in the main Fights tab.
  }
}

export function appendXpSession(
  row: SharedXpRow,
  opts: { stampNow?: boolean } = {},
): SharedXpRow[] {
  // stampNow=false (replay catch-up): keep the row but don't anchor the
  // live XP/hour window at wall-clock "now" for an hours-old gain.
  const stamped =
    opts.stampNow === false ? { ...row } : { ...row, at: Date.now() };
  const next = [stamped, ...loadXpSession()].slice(0, XP_SESSION_CAP);
  saveXpSession(next);
  return next;
}

/** Reset the session (the Fights-tab Reset button). Other windows hear the
 *  storage event; the caller updates its own state. */
export function clearXpSession(): void {
  saveXpSession([]);
}

export interface XpStats {
  total: number;
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
export function computeXpStats(rows: SharedXpRow[], nowMs: number): XpStats {
  if (rows.length === 0) return { total: 0, perHour: null, perLevelHours: null };
  const total = rows.reduce((sum, row) => sum + row.percent, 0);
  const newest = rows[0];
  const oldest = rows[rows.length - 1];
  const sinceNewest =
    newest.at != null ? Math.max(0, (nowMs - newest.at) / 1000) : 0;
  const windowSecs = Math.max(60, newest.ts - oldest.ts + sinceNewest);
  const perHour = total / (windowSecs / 3600);
  // Time to earn ONE full level (100%) at the current rate. We can't compute
  // "time to YOUR next level" — the log reports xp as a per-level percentage
  // but never your absolute level or starting position within it, so the
  // session total isn't "progress into a level".
  const perLevelHours = perHour > 0 ? 100 / perHour : null;
  return { total, perHour, perLevelHours };
}
