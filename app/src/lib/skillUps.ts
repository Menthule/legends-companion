// Skill-up tracker: consumes Event::SkillUp ("You have become better at
// Channeling! (118)" — the value is the NEW ABSOLUTE skill level the client
// reports, not a delta). Per-skill current value persists per character via
// createLocalStore; the tonight's-gains list lives in lib/sessionLog's
// snapshot (reset per app run).
//
// "Stuck" heuristic (label it honestly in the UI): a skill counts one
// "skill-up session" each app run where at least one LIVE skill-up fires —
// idle runs don't advance the counter. A skill that has gone up before but
// not in the last STUCK_SESSIONS such sessions is flagged. The log can't see
// caps or unpracticed skills, so this is a best-effort nudge, not a fact.

import { createLocalStore, type LocalStore } from "./localStore";
import { characterStoreKey } from "./factionLedger";

export interface SkillRecord {
  skill: string;
  /** Latest absolute value reported by the client. */
  value: number;
  /** Total live skill-ups seen since tracking began. */
  ups: number;
  /** Wall-clock ms of the last live skill-up. */
  lastUpMs: number;
  /** Skill-up-session index (see module header) of the last live up. */
  lastUpSession: number;
  firstSeenMs: number;
}

export interface SkillStoreState {
  version: 1;
  /** Highest skill-up-session index handed out (0 = never). */
  sessionCounter: number;
  /** Keyed by lowercased skill name. */
  skills: Record<string, SkillRecord>;
}

export const SKILL_STORE_PREFIX = "eqlogs.skills.v1";
export const SKILL_STORE_EVENT = "eqlogs-skills-changed";
/** Sessions-without-a-gain threshold for the "stuck" callout. */
export const STUCK_SESSIONS = 3;

export function emptySkillStore(): SkillStoreState {
  return { version: 1, sessionCounter: 0, skills: {} };
}

function decodeSkillStore(raw: unknown): SkillStoreState {
  if (typeof raw !== "object" || raw === null) return emptySkillStore();
  const rec = raw as Record<string, unknown>;
  const num = (x: unknown) =>
    typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0;
  const skills: Record<string, SkillRecord> = {};
  if (typeof rec.skills === "object" && rec.skills !== null) {
    for (const [key, value] of Object.entries(
      rec.skills as Record<string, unknown>,
    )) {
      if (typeof value !== "object" || value === null) continue;
      const row = value as Record<string, unknown>;
      if (typeof row.skill !== "string" || !row.skill.trim()) continue;
      skills[key] = {
        skill: row.skill,
        value: num(row.value),
        ups: num(row.ups),
        lastUpMs: num(row.lastUpMs),
        lastUpSession: num(row.lastUpSession),
        firstSeenMs: num(row.firstSeenMs),
      };
    }
  }
  return { version: 1, sessionCounter: num(rec.sessionCounter), skills };
}

/** Per-character persisted skill values. */
export function skillStore(character: string): LocalStore<SkillStoreState> {
  return createLocalStore<SkillStoreState>(
    `${SKILL_STORE_PREFIX}:${characterStoreKey(character)}`,
    SKILL_STORE_EVENT,
    decodeSkillStore,
  );
}

/** Claim the next skill-up-session index (call once per app run, lazily on
 *  the first live skill-up). */
export function beginSkillSession(
  state: SkillStoreState,
): { state: SkillStoreState; index: number } {
  const index = state.sessionCounter + 1;
  return { state: { ...state, sessionCounter: index }, index };
}

/**
 * Fold one skill-up into the store (immutable). Live ups take the reported
 * value as truth and stamp activity; replayed (catch-up) ups only raise the
 * stored value — re-stamping hours-old activity at "now" would lie to the
 * stuck heuristic. Returns the gained delta when the previous value is known
 * (null on first sighting).
 */
export function applySkillUp(
  state: SkillStoreState,
  skill: string,
  value: number,
  opts: { live: boolean; nowMs: number; sessionIndex: number },
): { state: SkillStoreState; delta: number | null } {
  const key = skill.toLowerCase();
  const cur = state.skills[key];
  const delta = cur ? value - cur.value : null;
  const next: SkillRecord = cur
    ? {
        ...cur,
        value: opts.live ? value : Math.max(cur.value, value),
        ups: opts.live ? cur.ups + 1 : cur.ups,
        lastUpMs: opts.live ? opts.nowMs : cur.lastUpMs,
        lastUpSession: opts.live ? opts.sessionIndex : cur.lastUpSession,
      }
    : {
        skill,
        value,
        ups: opts.live ? 1 : 0,
        lastUpMs: opts.live ? opts.nowMs : 0,
        lastUpSession: opts.live ? opts.sessionIndex : 0,
        firstSeenMs: opts.nowMs,
      };
  return {
    state: { ...state, skills: { ...state.skills, [key]: next } },
    delta,
  };
}

/** Skills that have gone up before but not in the last `minSessions`
 *  skill-up sessions — stalest first. Skills never seen going up live are
 *  excluded (nothing honest to say about them). */
export function stuckSkills(
  state: SkillStoreState,
  minSessions = STUCK_SESSIONS,
): SkillRecord[] {
  return Object.values(state.skills)
    .filter(
      (row) =>
        row.ups > 0 &&
        state.sessionCounter - row.lastUpSession >= minSessions,
    )
    .sort(
      (a, b) =>
        a.lastUpSession - b.lastUpSession ||
        a.skill.localeCompare(b.skill),
    );
}

/** Sessions since a skill last went up (for the stuck row label). */
export function sessionsSinceUp(
  state: SkillStoreState,
  row: SkillRecord,
): number {
  return Math.max(0, state.sessionCounter - row.lastUpSession);
}
