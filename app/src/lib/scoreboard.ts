// Party Scoreboard — per-player competitive session stats (killing blows,
// finishing blows, highest hit, damage, streaks). Written by FightsTab from the
// live event stream, read by the Scoreboard overlay. Cross-window sync uses
// localStorage + a storage/custom event, the same pattern as timers/wishlist.
//
// Session stats reset each app run; all-time RECORDS persist and, when beaten,
// fire a trophy on the Impact overlay.

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

export function loadScoreboard(): Scoreboard {
  try {
    const raw = localStorage.getItem(SCOREBOARD_KEY);
    return raw ? (JSON.parse(raw) as Scoreboard) : {};
  } catch {
    return {};
  }
}

export function saveScoreboard(s: Scoreboard): void {
  try {
    localStorage.setItem(SCOREBOARD_KEY, JSON.stringify(s));
  } catch {
    /* quota / unavailable — non-fatal */
  }
  // Same-window listeners (the storage event only fires in OTHER windows).
  window.dispatchEvent(new Event(SCOREBOARD_EVENT));
}

export function loadRecords(): Records {
  try {
    const raw = localStorage.getItem(RECORDS_KEY);
    if (!raw) return { ...EMPTY_RECORDS };
    return { ...EMPTY_RECORDS, ...(JSON.parse(raw) as Records) };
  } catch {
    return { ...EMPTY_RECORDS };
  }
}

export function saveRecords(r: Records): void {
  try {
    localStorage.setItem(RECORDS_KEY, JSON.stringify(r));
  } catch {
    /* non-fatal */
  }
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
