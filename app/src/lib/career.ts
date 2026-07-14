// Career-view helpers: pure math/formatting over the career DB wire shapes
// (docs/career-db-design.md §6). Level-timeline "time per level" derivation,
// the CareerSession → lib/trends input mapping, and log-domain date labels.
//
// Log-domain timestamps are the log's naive-local wall clock encoded as UTC
// epoch seconds (the fights.startTs convention), so every formatter here
// reads with UTC getters — local getters would shift the player's own clock
// by the host UTC offset (the app's known timestamp-domain trap).

import type { CareerLevelUp, CareerLootRow, CareerSession } from "../types";
import { fmtCopperAmount } from "./wallet";
import type { TrendSessionInput } from "./trends";

/** One ding row on the level timeline. */
export interface LevelTimelineRow {
  /** Level reached by this ding. */
  level: number;
  /** Log-domain seconds of the ding. */
  ts: number;
  /** Seconds spent in the previous level (previous ding → this ding);
   *  null for the first observed ding (its level-entry time is unknown). */
  secsInPrev: number | null;
}

/**
 * Time-per-level rows from raw level-ups (any input order; sorted by ts,
 * ties by level). The first observed ding has no known predecessor, so its
 * time-in-level is null — the UI shows a dash, never a fake zero.
 */
export function buildLevelTimeline(ups: CareerLevelUp[]): LevelTimelineRow[] {
  const sorted = [...ups].sort((a, b) => a.ts - b.ts || a.level - b.level);
  const rows: LevelTimelineRow[] = [];
  let prevTs: number | null = null;
  for (const up of sorted) {
    rows.push({
      level: up.level,
      ts: up.ts,
      secsInPrev: prevTs === null ? null : Math.max(0, up.ts - prevTs),
    });
    prevTs = up.ts;
  }
  return rows;
}

/** Longest known time-in-level (bar-scale denominator); 0 when unknown. */
export function maxLevelSecs(rows: LevelTimelineRow[]): number {
  return rows.reduce((m, r) => Math.max(m, r.secsInPrev ?? 0), 0);
}

/**
 * Map career sessions onto lib/trends inputs so buildTrendSeries charts
 * career rates with the exact same geometry as the live Trends panel.
 * `startedTs` stays in the log domain (ms) — career tooltips must format it
 * with the UTC-getter helpers below, not toLocaleString.
 */
export function careerTrendInputs(sessions: CareerSession[]): TrendSessionInput[] {
  return sessions.map((s) => ({
    id: String(s.id),
    startedTs: s.startTs * 1000,
    durationSecs: s.durationSecs,
    xp: s.xpPercent,
    kills: s.kills,
    deaths: s.deaths,
    platCopper: s.coinCopper,
    levelUps: s.levelUps,
  }));
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Log-domain date label, e.g. "Jun 12" (adds the year when not current). */
export function fmtLogDate(ts: number): string {
  const d = new Date(ts * 1000);
  const base = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  const nowYear = new Date().getUTCFullYear();
  return d.getUTCFullYear() === nowYear ? base : `${base}, ${d.getUTCFullYear()}`;
}

/** Log-domain date + wall-clock label, e.g. "Jun 12 · 19:42". */
export function fmtLogDateTime(ts: number): string {
  const d = new Date(ts * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${fmtLogDate(ts)} · ${hh}:${mm}`;
}

/** Ledger disposition column: kept / sold for free / sold for coin. */
export function lootDisposition(row: Pick<CareerLootRow, "soldForCopper">): string {
  if (row.soldForCopper === null) return "kept";
  if (row.soldForCopper === 0) return "sold · free";
  return `sold · ${fmtCopperAmount(row.soldForCopper)}`;
}

/** Honest observed-drop label: "12× in 87 kills" (counts, never a rate %). */
export function fmtObservedDrops(count: number, kills: number): string {
  return `${count}× in ${kills} kill${kills === 1 ? "" : "s"}`;
}
