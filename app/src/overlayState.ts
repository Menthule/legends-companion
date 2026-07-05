// Persisted overlay visibility, shared by the top-bar toggle and the
// per-overlay switches in Settings. Overlays default to ON.

import { OVERLAY_LABELS } from "./types";

const KEY = "eqlogs.overlays.visible";

export type OverlayVisibility = Record<string, boolean>;

export function loadOverlayVisibility(): OverlayVisibility {
  const defaults: OverlayVisibility = {};
  for (const label of OVERLAY_LABELS) defaults[label] = true;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults;
    return { ...defaults, ...(JSON.parse(raw) as OverlayVisibility) };
  } catch {
    return defaults;
  }
}

export function saveOverlayVisibility(v: OverlayVisibility): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    // localStorage unavailable — visibility just won't persist.
  }
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
    return localStorage.getItem(METER_SOURCES_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveMeterSources(on: boolean): void {
  try {
    localStorage.setItem(METER_SOURCES_KEY, on ? "1" : "0");
  } catch {
    // localStorage unavailable — the toggle just won't persist.
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
  ttlHours: number | null;
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
  if (rows.length === 0) return { total: 0, perHour: null, ttlHours: null };
  const total = rows.reduce((sum, row) => sum + row.percent, 0);
  const newest = rows[0];
  const oldest = rows[rows.length - 1];
  const sinceNewest =
    newest.at != null ? Math.max(0, (nowMs - newest.at) / 1000) : 0;
  const windowSecs = Math.max(60, newest.ts - oldest.ts + sinceNewest);
  const perHour = total / (windowSecs / 3600);
  const remaining = Math.max(0, 100 - total);
  const ttlHours = perHour > 0 ? remaining / perHour : null;
  return { total, perHour, ttlHours };
}
