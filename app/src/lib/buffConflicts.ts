// Buff-conflict advisor (P11): the game tells us authoritatively which buffs
// don't stack — "Your Protect spell did not take hold. (Blocked by Spirit
// Armor.)". We learn those pairs from the log (symmetric: if A blocks B, B
// blocks A) and surface them as "conflicts with" chips on the Spells DB tab.

import { createLocalStore } from "./localStore";

export const BUFF_CONFLICTS_KEY = "eqlogs.buffConflicts.v1";
/** Same-window notify (storage events only fire in OTHER windows). */
export const BUFF_CONFLICTS_EVENT = "eqlogs-conflicts-changed";

/** spell (display name) -> list of buffs it's been observed to conflict with. */
export type ConflictMap = Record<string, string[]>;

/** Add A↔B to the map (symmetric, case-insensitive dedupe). Pure — returns a
 *  possibly-mutated map and whether anything was newly learned. */
export function mergeConflict(
  map: ConflictMap,
  spell: string,
  blocker: string,
): { map: ConflictMap; learned: boolean } {
  if (
    !spell ||
    !blocker ||
    spell.toLowerCase() === blocker.toLowerCase()
  ) {
    return { map, learned: false };
  }
  const add = (a: string, b: string): boolean => {
    // Resolve the key case-insensitively so "protect" and "Protect" don't
    // create separate entries; first-seen casing stays canonical.
    const key = Object.keys(map).find((k) => k.toLowerCase() === a.toLowerCase()) ?? a;
    const list = map[key] ?? (map[key] = []);
    if (list.some((x) => x.toLowerCase() === b.toLowerCase())) return false;
    list.push(b);
    return true;
  };
  const learned = [add(spell, blocker), add(blocker, spell)].some(Boolean);
  return { map, learned };
}

/** Conflicts for a spell (case-insensitive), from an already-loaded map. */
export function conflictsForMap(map: ConflictMap, spell: string): string[] {
  const key = Object.keys(map).find(
    (k) => k.toLowerCase() === spell.toLowerCase(),
  );
  return key ? map[key] : [];
}

const store = createLocalStore<ConflictMap>(
  BUFF_CONFLICTS_KEY,
  BUFF_CONFLICTS_EVENT,
  (raw) => {
    if (!raw || typeof raw !== "object") return {};
    // Keep only string[] values.
    const out: ConflictMap = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string");
    }
    return out;
  },
);

export function loadConflicts(): ConflictMap {
  return store.load();
}

/** Record an observed block. Returns true if it was newly learned (so the
 *  caller can fire a one-shot correction). Saving notifies listeners on
 *  BUFF_CONFLICTS_EVENT. */
export function recordConflict(spell: string, blocker: string): boolean {
  const map = loadConflicts();
  const { learned } = mergeConflict(map, spell, blocker);
  if (learned) store.save(map);
  return learned;
}

/** Conflicts for a spell, loading the persisted map. */
export function conflictsFor(spell: string): string[] {
  return conflictsForMap(loadConflicts(), spell);
}
