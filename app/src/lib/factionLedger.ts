// Faction ledger: per-faction net standing movement, accumulated from
// Event::Faction lines ("Your faction standing with Befallen Inhabitants has
// been adjusted by -2." — the floor/ceiling "could not possibly get any
// worse/better" lines parse as delta 0 and still count as a hit).
//
// Two horizons: the session map lives in lib/sessionLog's snapshot (reset per
// app run), and an all-time map persists per character via createLocalStore.
// "All-time" honestly means SINCE TRACKING BEGAN — the log stream carries
// deltas only, never absolute standing, so the UI must label it that way.

import { createLocalStore, type LocalStore } from "./localStore";

export interface FactionSessionRow {
  faction: string;
  /** Net standing movement this session (sum of deltas). */
  net: number;
  /** Number of faction lines seen (including delta-0 floor/ceiling hits). */
  hits: number;
  /** Log-domain seconds of the most recent hit. */
  lastTs: number;
}

export interface FactionAllTimeRow {
  faction: string;
  net: number;
  hits: number;
  /** Wall-clock ms when tracking first / last saw this faction. */
  firstSeenMs: number;
  lastSeenMs: number;
}

/** Keyed by lowercased faction name. */
export type FactionAllTimeMap = Record<string, FactionAllTimeRow>;

export const FACTION_STORE_PREFIX = "eqlogs.factions.v1";
export const FACTION_STORE_EVENT = "eqlogs-factions-changed";

/** Normalized per-character storage suffix ("unknown" until config loads). */
export function characterStoreKey(character: string): string {
  return character.trim().toLowerCase() || "unknown";
}

function decodeAllTime(raw: unknown): FactionAllTimeMap {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: FactionAllTimeMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const row = value as Record<string, unknown>;
    if (typeof row.faction !== "string" || !row.faction.trim()) continue;
    const num = (x: unknown) =>
      typeof x === "number" && Number.isFinite(x) ? x : 0;
    out[key] = {
      faction: row.faction,
      net: num(row.net),
      hits: Math.max(0, Math.floor(num(row.hits))),
      firstSeenMs: num(row.firstSeenMs),
      lastSeenMs: num(row.lastSeenMs),
    };
  }
  return out;
}

/** Per-character all-time faction store (since tracking began). */
export function factionStore(character: string): LocalStore<FactionAllTimeMap> {
  return createLocalStore<FactionAllTimeMap>(
    `${FACTION_STORE_PREFIX}:${characterStoreKey(character)}`,
    FACTION_STORE_EVENT,
    decodeAllTime,
  );
}

/** Fold one faction line into the session map (immutable). */
export function applySessionDelta(
  map: Record<string, FactionSessionRow>,
  faction: string,
  delta: number,
  ts: number,
): Record<string, FactionSessionRow> {
  const key = faction.toLowerCase();
  const cur = map[key];
  return {
    ...map,
    [key]: cur
      ? {
          ...cur,
          net: cur.net + delta,
          hits: cur.hits + 1,
          lastTs: Math.max(cur.lastTs, ts),
        }
      : { faction, net: delta, hits: 1, lastTs: ts },
  };
}

/** Fold one faction line into the all-time map (immutable). */
export function applyAllTimeDelta(
  map: FactionAllTimeMap,
  faction: string,
  delta: number,
  nowMs: number,
): FactionAllTimeMap {
  const key = faction.toLowerCase();
  const cur = map[key];
  return {
    ...map,
    [key]: cur
      ? {
          ...cur,
          net: cur.net + delta,
          hits: cur.hits + 1,
          lastSeenMs: Math.max(cur.lastSeenMs, nowMs),
        }
      : {
          faction,
          net: delta,
          hits: 1,
          firstSeenMs: nowMs,
          lastSeenMs: nowMs,
        },
  };
}

/** The faction losing the most standing this session; null when nothing is
 *  net-negative yet. Ties break toward the most recent hit. */
export function mostDamaged(
  rows: FactionSessionRow[],
): FactionSessionRow | null {
  let worst: FactionSessionRow | null = null;
  for (const row of rows) {
    if (row.net >= 0) continue;
    if (!worst || row.net < worst.net || (row.net === worst.net && row.lastTs > worst.lastTs)) {
      worst = row;
    }
  }
  return worst;
}

/** Trend glyph for a net movement (em-dash for zero, per DESIGN.md). */
export function trendArrow(net: number): "▲" | "▼" | "—" {
  if (net > 0) return "▲";
  if (net < 0) return "▼";
  return "—";
}

/** Session rows sorted for display: biggest absolute movement first, then
 *  most recent. */
export function sortSessionRows(
  map: Record<string, FactionSessionRow>,
): FactionSessionRow[] {
  return Object.values(map).sort(
    (a, b) =>
      Math.abs(b.net) - Math.abs(a.net) ||
      b.lastTs - a.lastTs ||
      a.faction.localeCompare(b.faction),
  );
}
