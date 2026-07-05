// Global reference-database filters (era + class selection), shared by
// every Database tab (Drops, Mobs, Spells, Abilities). One store, one pair
// of components (see components/RefFilters.tsx): set the era or your
// classes once and every tab honors it. Persisted in localStorage; synced
// across mounted tabs via a same-window custom event (and the cross-window
// storage event, for completeness).

import { useEffect, useState } from "react";

/** The 16 Legends classes in bitmask order (bit i = 1 << i). */
export const CLASS_FULL = [
  "Warrior", "Cleric", "Paladin", "Ranger", "ShadowKnight", "Druid",
  "Monk", "Bard", "Rogue", "Shaman", "Necromancer", "Wizard",
  "Magician", "Enchanter", "Beastlord", "Berserker",
];
export const CLASS_ABBR = [
  "WAR", "CLR", "PAL", "RNG", "SHD", "DRU", "MNK", "BRD",
  "ROG", "SHM", "NEC", "WIZ", "MAG", "ENC", "BST", "BER",
];
export const CLASS_NAME_TO_BIT: Record<string, number> = Object.fromEntries(
  CLASS_FULL.map((n, i) => [n, i]),
);

const ERA_KEY = "eqlogs.ref.eraMax";
const CLASS_KEY = "eqlogs.ref.classMask";
const EVENT = "eqlogs-ref-filters-changed";

function loadNum(key: string, dflt: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return dflt;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  } catch {
    return dflt;
  }
}

function saveNum(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // localStorage unavailable — the filter just won't persist.
  }
  window.dispatchEvent(new Event(EVENT));
}

function useGlobalNum(key: string, dflt: number): [number, (n: number) => void] {
  const [value, setValue] = useState(() => loadNum(key, dflt));
  useEffect(() => {
    const refresh = () => setValue(loadNum(key, dflt));
    const onStorage = (e: StorageEvent) => {
      if (e.key === key) refresh();
    };
    window.addEventListener(EVENT, refresh);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, [key, dflt]);
  return [value, (n: number) => saveNum(key, n)];
}

/** Global era ceiling: 0 classic, 1 +kunark, 2 +velious, 3 everything. */
export function useEraMax(): [number, (n: number) => void] {
  return useGlobalNum(ERA_KEY, 0);
}

/** Global class selection bitmask (0 = any). */
export function useClassMask(): [number, (n: number) => void] {
  return useGlobalNum(CLASS_KEY, 0);
}

/** Full names of the selected classes, bit order. */
export function classMaskFullNames(mask: number): string[] {
  return CLASS_FULL.filter((n) => mask & (1 << CLASS_NAME_TO_BIT[n]));
}

/** Backend `classes` parameter: comma-wrapped full names (",Cleric,Wizard,")
 *  matched via instr() in SQL; "" = any. */
export function classMaskToParam(mask: number): string {
  const names = classMaskFullNames(mask);
  return names.length ? `,${names.join(",")},` : "";
}
