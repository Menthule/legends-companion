// Party Scoreboard — per-player competitive session stats (killing blows,
// finishing blows, highest hit, damage, streaks). Written by FightsTab from the
// live event stream, read by the Scoreboard overlay. Cross-window sync uses
// localStorage + a storage/custom event, the same pattern as timers/wishlist.
//
// Session stats reset each app run; all-time RECORDS persist and, when beaten,
// fire a trophy on the Impact overlay.

import { createLocalStore } from "./localStore";

export const SCOREBOARD_KEY = "eqlogs.scoreboard";
export const SCOREBOARD_EVENT = "eqlogs-scoreboard-changed";
export const RECORDS_KEY = "eqlogs.scoreboard.records";

export interface PlayerScore {
  /** Display name ("You", "Sliq", …). */
  name: string;
  /** Kills this player landed the slaying blow on. */
  killingBlows: number;
  /** Finishing Blow AA procs. */
  finishingBlows: number;
  /** Mez breaks attributed to this player — HEURISTIC (first hit on a
   *  mezzed target / first hit right after its mez bar drops early; see
   *  lib/mezBreaks.ts). Label it honestly wherever it renders. */
  mezBreaks: number;
  /** Biggest single hit + what dealt it (spell/verb → target). */
  highestHit: number;
  highestHitLabel: string;
  /** Total damage dealt. */
  totalDamage: number;
  deaths: number;
  /** Current kills-without-dying run and this session's best. */
  curStreak: number;
  bestStreak: number;
  /** Log-time (secs) of first and latest hit — spans the DPS window. */
  firstTs: number;
  lastTs: number;
}

/** Keyed by lowercased player name. */
export type Scoreboard = Record<string, PlayerScore>;

/** All-time bests. `who` holds the record-setter's name at the time. */
export interface Records {
  highestHit: { value: number; who: string; label: string };
  bestStreak: { value: number; who: string };
  killingBlows: { value: number; who: string };
}

export function emptyPlayer(name: string): PlayerScore {
  return {
    name,
    killingBlows: 0,
    finishingBlows: 0,
    mezBreaks: 0,
    highestHit: 0,
    highestHitLabel: "",
    totalDamage: 0,
    deaths: 0,
    curStreak: 0,
    bestStreak: 0,
    firstTs: 0,
    lastTs: 0,
  };
}

const EMPTY_RECORDS: Records = {
  highestHit: { value: 0, who: "", label: "" },
  bestStreak: { value: 0, who: "" },
  killingBlows: { value: 0, who: "" },
};

/** DPS over a player's engagement span (first→last hit). Rough but comparable
 *  across players; downtime deflates it equally for everyone. */
export function dpsOf(p: PlayerScore): number {
  const span = Math.max(1, p.lastTs - p.firstTs);
  return p.totalDamage / span;
}

/** Is this attacker/killer name a player (you, a groupmate, or an owned pet)
 *  rather than a mob? Mobs carry articles / multi-word lowercase names; players
 *  and groupmates are a single capitalized word. */
export function isPlayerName(name: string, ownedNames: Set<string>): boolean {
  if (name === "You") return true;
  if (ownedNames.has(name.toLowerCase())) return true;
  return /^[A-Z][a-z'`]+$/.test(name);
}

// Same-window listeners hear SCOREBOARD_EVENT (the storage event only fires
// in OTHER windows). Records have no subscribers, so no event.
const boardStore = createLocalStore<Scoreboard>(
  SCOREBOARD_KEY,
  SCOREBOARD_EVENT,
  (raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    // Backfill stats added after a board was persisted (e.g. mezBreaks) so
    // readers never see `undefined` counters on rows written by an older run.
    const board: Scoreboard = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const p = v as Partial<PlayerScore>;
      board[k] = { ...emptyPlayer(p.name ?? k), ...p };
    }
    return board;
  },
);

const recordsStore = createLocalStore<Records>(RECORDS_KEY, undefined, (raw) =>
  raw && typeof raw === "object"
    ? { ...EMPTY_RECORDS, ...(raw as Partial<Records>) }
    : { ...EMPTY_RECORDS },
);

export function loadScoreboard(): Scoreboard {
  return boardStore.load();
}

export function saveScoreboard(s: Scoreboard): void {
  boardStore.save(s);
}

/** Hear scoreboard changes from this window (custom event) and others
 *  (storage event). Returns an unsubscribe function. */
export function subscribeScoreboard(cb: () => void): () => void {
  return boardStore.subscribe(cb);
}

export function loadRecords(): Records {
  return recordsStore.load();
}

export function saveRecords(r: Records): void {
  recordsStore.save(r);
}

/** Rows sorted for display: most killing blows first, then finishing blows,
 *  then total damage. */
export function scoreRows(s: Scoreboard): PlayerScore[] {
  return Object.values(s).sort(
    (a, b) =>
      b.killingBlows - a.killingBlows ||
      b.finishingBlows - a.finishingBlows ||
      b.totalDamage - a.totalDamage,
  );
}

/** A beaten all-time record, ready to celebrate on the Impact overlay. */
export interface RecordBreak {
  stat: string;
  who: string;
  value: string;
}

/** Compare a player's current session stats against the all-time records,
 *  updating `records` IN PLACE and returning any that were beaten. Only a
 *  strictly higher value counts (ties don't re-fire). A record with no prior
 *  holder (value 0) is seeded silently — the first kill shouldn't trumpet.  */
export function applyRecords(records: Records, p: PlayerScore): RecordBreak[] {
  const breaks: RecordBreak[] = [];
  const bump = (
    rec: { value: number; who: string },
    value: number,
    stat: string,
    extra?: (r: Records) => void,
  ) => {
    if (value <= 0 || value <= rec.value) return;
    const hadHolder = rec.value > 0;
    rec.value = value;
    rec.who = p.name;
    extra?.(records);
    if (hadHolder) breaks.push({ stat, who: p.name, value: value.toLocaleString() });
  };
  bump(records.highestHit, p.highestHit, "Highest Hit", (r) => {
    r.highestHit.label = p.highestHitLabel;
  });
  bump(records.bestStreak, p.bestStreak, "Best Killstreak");
  bump(records.killingBlows, p.killingBlows, "Most Killing Blows");
  return breaks;
}
