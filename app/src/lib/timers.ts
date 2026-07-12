// Unified timer model — respawn countdowns (kill → repop) AND user-created
// custom timers (get-off-at, egg timers, ability cooldowns) in one store.
// Written by the Timers tab (TimersTab.tsx); read by the tab list AND the
// unified timer overlay (OverlayRespawn.tsx). Both windows stay in sync via
// the browser `storage` event (fires in OTHER windows on any write), so the
// overlay updates the moment a kill lands or a timer is armed.
//
// Supersedes lib/campTimers.ts. Nothing here touches sqlite — all state is
// localStorage; the bundled reference DB stays read-only.

import type { RespawnContext, RespawnTimingSource } from "./respawnTiming";

export type TimerKind = "respawn" | "custom";

export interface Timer {
  /** Stable id (dedupe, dismiss). */
  id: string;
  kind: TimerKind;
  /** Mob name (respawn) or user label (custom). */
  label: string;
  /** Respawn timers carry their zone; custom timers are global (null). */
  zoneShort: string | null;
  zoneLong: string | null;
  /** Wall-clock ms the countdown anchors to — remaining recomputes from this,
   *  so a reload keeps the countdown honest. */
  startedAt: number;
  /** Base countdown length in seconds. */
  durationSecs: number;
  /** ± window in seconds (raid targets); 0 = fixed (dungeon rares, customs). */
  varianceSecs: number;
  /** Speak a heads-up this many seconds BEFORE pop (P41); 0 = off (default). */
  warnSecs: number;
  /** Pre-pop warning already spoken (persisted; re-armed like `announced`). */
  warnAnnounced: boolean;
  /** Custom repeating timer re-arms itself on pop. */
  repeat: boolean;
  /** Speak at pop? Respawn timers default false (visual only per DESIGN.md);
   *  custom timers default true (a "get off" timer needs to be heard). */
  ttsOnPop: boolean;
  /** Pop already announced (persisted so a reload never repeats it). */
  announced: boolean;
  /** auto = kill-detected rare; manual = tracked kill / armed rare / custom. */
  source: "auto" | "manual";
  /** Timing provenance for respawns; absent on legacy/custom timers. */
  timingContext?: RespawnContext;
  timingSource?: RespawnTimingSource;
  /** Unmodified database/fallback value, retained so Reset can remove an override. */
  referenceDurationSecs?: number;
}

export const TIMERS_KEY = "eqlogs.timers.v1";
export const TIMER_CAP = 30;

/** Legacy camp-timer store — imported once into the unified store on load. */
const LEGACY_CAMP_KEY = "eqlogs.campTimers.v1";

function newId(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function coerceTimer(e: Record<string, unknown>): Timer | null {
  const startedAt = typeof e.startedAt === "number" ? e.startedAt : 0;
  const durationSecs =
    typeof e.durationSecs === "number" ? e.durationSecs : 0;
  const label = String(e.label ?? "");
  if (!label || durationSecs <= 0) return null;
  const kind: TimerKind = e.kind === "custom" ? "custom" : "respawn";
  return {
    id: typeof e.id === "string" && e.id ? e.id : newId(),
    kind,
    label,
    zoneShort: e.zoneShort == null ? null : String(e.zoneShort),
    zoneLong: e.zoneLong == null ? null : String(e.zoneLong),
    startedAt,
    durationSecs,
    varianceSecs:
      typeof e.varianceSecs === "number" && e.varianceSecs > 0
        ? e.varianceSecs
        : 0,
    warnSecs:
      typeof e.warnSecs === "number" && e.warnSecs > 0 ? e.warnSecs : 0,
    warnAnnounced: e.warnAnnounced === true,
    repeat: e.repeat === true,
    ttsOnPop: e.ttsOnPop === true,
    announced: e.announced === true,
    source:
      e.source === "auto" || e.source === "manual"
        ? (e.source as "auto" | "manual")
        : "manual",
    timingContext:
      e.timingContext === "public" ||
      e.timingContext === "private" ||
      e.timingContext === "custom"
        ? e.timingContext
        : undefined,
    timingSource:
      e.timingSource === "reference" ||
      e.timingSource === "zone-default" ||
      e.timingSource === "manual" ||
      e.timingSource === "observed"
        ? e.timingSource
        : undefined,
    referenceDurationSecs:
      typeof e.referenceDurationSecs === "number" && e.referenceDurationSecs > 0
        ? e.referenceDurationSecs
        : undefined,
  };
}

/** One-time migration of the legacy camp-timer array into unified timers. */
function migrateLegacyCamps(now: number): Timer[] {
  try {
    const raw = localStorage.getItem(LEGACY_CAMP_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: Timer[] = [];
    for (const e of parsed) {
      if (typeof e !== "object" || e === null) continue;
      const c = e as Record<string, unknown>;
      const diedAt = typeof c.diedAt === "number" ? c.diedAt : 0;
      const respawnSecs =
        typeof c.respawnSecs === "number" ? c.respawnSecs : 0;
      const name = String(c.name ?? "");
      if (!name || respawnSecs <= 0) continue;
      out.push({
        id: newId(),
        kind: "respawn",
        label: name,
        zoneShort: null,
        zoneLong: c.zoneLong == null ? null : String(c.zoneLong),
        startedAt: diedAt,
        durationSecs: respawnSecs,
        varianceSecs: 0,
        warnSecs: 0,
        warnAnnounced: false,
        repeat: false,
        ttsOnPop: false,
        announced: c.announced === true || diedAt + respawnSecs * 1000 <= now,
        source: "auto",
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    // Consume the legacy key so the migration runs exactly once.
    try {
      localStorage.removeItem(LEGACY_CAMP_KEY);
    } catch {
      // ignore
    }
  }
}

export function loadTimers(): Timer[] {
  const now = Date.now();
  let timers: Timer[] = [];
  try {
    const raw = localStorage.getItem(TIMERS_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        timers = parsed
          .filter(
            (e): e is Record<string, unknown> =>
              typeof e === "object" && e !== null,
          )
          .map(coerceTimer)
          .filter((t): t is Timer => t !== null);
      }
    }
  } catch {
    timers = [];
  }
  // Fold any legacy camp timers in (runs once; clears the old key).
  const migrated = migrateLegacyCamps(now);
  if (migrated.length) {
    const seen = new Set(timers.map((t) => t.label.toLowerCase()));
    for (const m of migrated) {
      if (!seen.has(m.label.toLowerCase())) timers.push(m);
    }
    saveTimers(timers);
  }
  return timers.slice(0, TIMER_CAP);
}

export function saveTimers(timers: Timer[]): void {
  try {
    localStorage.setItem(
      TIMERS_KEY,
      JSON.stringify(timers.slice(0, TIMER_CAP)),
    );
  } catch {
    // localStorage unavailable — timers just won't survive a reload.
  }
}

/** A timer with live progress, for the overlay/list. */
export interface TimerView extends Timer {
  /** Wall-clock ms the timer is due (startedAt + durationSecs*1000). */
  dueAt: number;
  /** End of the variance window (dueAt + varianceSecs*1000); == dueAt if fixed. */
  windowEndsAt: number;
  /** Seconds until due; <= 0 means up now. */
  remainingSecs: number;
  /** 0..1 elapsed fraction of the countdown (1 = up). */
  progress: number;
  /** Severity for color-state: calm > warn > urgent > up. */
  state: "calm" | "warn" | "urgent" | "up";
}

/** Active timers at `now`, soonest-to-due first. A timer stays in the list for
 *  a short grace period after it is due (so "UP" is visible) then drops off. A
 *  variance timer keeps the grace measured from the END of its window. */
export function activeTimers(
  timers: Timer[],
  now: number,
  graceSecs = 30,
): TimerView[] {
  return timers
    .map((t) => {
      const dueAt = t.startedAt + t.durationSecs * 1000;
      const windowEndsAt = dueAt + t.varianceSecs * 1000;
      const remainingSecs = Math.round((dueAt - now) / 1000);
      const elapsed = (now - t.startedAt) / (t.durationSecs * 1000);
      const progress = Math.max(0, Math.min(1, elapsed));
      let state: TimerView["state"];
      if (remainingSecs <= 0) state = "up";
      else if (1 - progress <= 0.15) state = "urgent";
      else if (1 - progress <= 0.33) state = "warn";
      else state = "calm";
      return {
        ...t,
        dueAt,
        windowEndsAt,
        remainingSecs,
        progress,
        state,
      };
    })
    .filter((t) => now < t.windowEndsAt + graceSecs * 1000)
    .sort((a, b) => a.remainingSecs - b.remainingSecs);
}

/** For a variance timer that's UP but still inside its spawn window, the
 *  seconds left in that window; null for a fixed timer or once the window
 *  closes. Drives the "UP · window 4m" display so a camper knows the spawn
 *  could still be coming (P41). */
export function windowRemainingSecs(t: TimerView, now: number): number | null {
  if (t.varianceSecs <= 0 || now < t.dueAt) return null;
  const left = Math.round((t.windowEndsAt - now) / 1000);
  return left > 0 ? left : null;
}

/** Next `startedAt` for a repeating timer after it pops at `now` (P7). Anchored
 *  to the original cadence (not `now`) to avoid per-cycle drift, but skips any
 *  whole cycles missed while the app was closed so a reopen re-arms once for
 *  the current cycle instead of firing the whole backlog. */
export function nextRepeatStart(
  startedAt: number,
  durationSecs: number,
  now: number,
): number {
  const step = durationSecs * 1000;
  if (step <= 0) return now;
  let started = startedAt + step;
  while (started + step <= now) started += step;
  return started;
}

// ---------------------------------------------------------------------------
// Learned rares — mob names the game conned as "a rare creature". Overrides
// the mob DB's naming-convention `named` guess (Legends has lowercase-article
// rares like "a ghoul sentinel" that the convention misses). Stored lowercased.
// ---------------------------------------------------------------------------

export const LEARNED_RARES_KEY = "eqlogs.learnedRares.v1";

export function loadLearnedRares(): Set<string> {
  try {
    const raw = localStorage.getItem(LEARNED_RARES_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

/** Add a conned-rare name; returns true if it was new (caller may re-render). */
export function addLearnedRare(name: string): boolean {
  const key = name.trim().toLowerCase();
  if (!key) return false;
  const set = loadLearnedRares();
  if (set.has(key)) return false;
  set.add(key);
  try {
    localStorage.setItem(LEARNED_RARES_KEY, JSON.stringify([...set]));
  } catch {
    // ignore
  }
  return true;
}

/** Is this mob a rare? DB `named` flag OR a learned "a rare creature" con. */
export function isRare(
  name: string,
  dbNamed: number,
  learned: Set<string>,
): boolean {
  return dbNamed === 1 || learned.has(name.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Rares-only toggle (kept from campTimers.ts; same localStorage key).
// ---------------------------------------------------------------------------

export const CAMP_RARES_ONLY_KEY = "eqlogs.camp.raresOnly";

/** Only auto-track rare/named spawns? Default ON — a camp timer is for waiting
 *  on a rare; auto-tracking trash with long respawns is noise. Off = also
 *  auto-track any 5-minute-plus respawn. (Manual Track/Arm ignore this.) */
export function loadCampRaresOnly(): boolean {
  try {
    return localStorage.getItem(CAMP_RARES_ONLY_KEY) !== "0";
  } catch {
    return true;
  }
}

export function saveCampRaresOnly(on: boolean): void {
  try {
    localStorage.setItem(CAMP_RARES_ONLY_KEY, on ? "1" : "0");
  } catch {
    // localStorage unavailable — the toggle just won't persist.
  }
}

// ---------------------------------------------------------------------------
// Custom-timer input parsing.
// ---------------------------------------------------------------------------

// Duration parsing is consolidated in lib/patternJs (P37) — the single
// canonical superset of the two that used to diverge. Re-exported here so the
// Timers tab's import path stays stable. Accepts `90`/`90s`, `35m`, `1.5h`,
// `1h30m`, `6:40` (m:ss), `1:02:00` (h:mm:ss); null on garbage or non-positive.
export { parseDuration } from "./patternJs";
