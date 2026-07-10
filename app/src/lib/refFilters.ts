// Global reference-database filters (era + class selection), shared by
// every Database tab (Drops, Mobs, Spells, Abilities). One store, one pair
// of components (see components/RefFilters.tsx): set the era or your
// classes once and every tab honors it. Persisted in localStorage; synced
// across mounted tabs via a same-window custom event (and the cross-window
// storage event, for completeness).

import { useEffect, useState } from "react";
import type { DropZone } from "../types";

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
const LIVE_ZONE_KEY = "eqlogs.ref.liveZone";
const LIVE_ZONE_ENABLED_KEY = "eqlogs.ref.liveZone.enabled";
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

type NumUpdater = number | ((prev: number) => number);
type StringUpdater = string | ((prev: string) => string);
type BoolUpdater = boolean | ((prev: boolean) => boolean);

function useGlobalNum(
  key: string,
  dflt: number,
): [number, (n: NumUpdater) => void] {
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
  // Functional updaters read the freshest PERSISTED value (localStorage is the
  // cross-tab source of truth), so a setter called from a stale render closure
  // still composes onto the current mask instead of dropping a concurrent
  // selection (P43).
  const set = (n: NumUpdater) =>
    saveNum(key, typeof n === "function" ? n(loadNum(key, dflt)) : n);
  return [value, set];
}

function loadString(key: string, dflt = ""): string {
  try {
    return localStorage.getItem(key) ?? dflt;
  } catch {
    return dflt;
  }
}

function saveString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // localStorage unavailable — the filter just won't persist.
  }
  window.dispatchEvent(new Event(EVENT));
}

function loadBool(key: string, dflt = false): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? dflt : raw === "1";
  } catch {
    return dflt;
  }
}

function saveBool(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // localStorage unavailable — the filter just won't persist.
  }
  window.dispatchEvent(new Event(EVENT));
}

/** Global era ceiling: 0 classic, 1 +kunark, 2 +velious, 3 everything. */
export function useEraMax(): [number, (n: NumUpdater) => void] {
  return useGlobalNum(ERA_KEY, 0);
}

/** Global class selection bitmask (0 = any). Setter accepts a functional
 *  updater for compose-onto-current writes (see useGlobalNum). */
export function useClassMask(): [number, (n: NumUpdater) => void] {
  return useGlobalNum(CLASS_KEY, 0);
}

function useGlobalString(
  key: string,
  dflt = "",
): [string, (n: StringUpdater) => void] {
  const [value, setValue] = useState(() => loadString(key, dflt));
  useEffect(() => {
    const refresh = () => setValue(loadString(key, dflt));
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
  const set = (n: StringUpdater) =>
    saveString(key, typeof n === "function" ? n(loadString(key, dflt)) : n);
  return [value, set];
}

function useGlobalBool(
  key: string,
  dflt = false,
): [boolean, (n: BoolUpdater) => void] {
  const [value, setValue] = useState(() => loadBool(key, dflt));
  useEffect(() => {
    const refresh = () => setValue(loadBool(key, dflt));
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
  const set = (n: BoolUpdater) =>
    saveBool(key, typeof n === "function" ? n(loadBool(key, dflt)) : n);
  return [value, set];
}

export function setLiveZoneName(zone: string): void {
  saveString(LIVE_ZONE_KEY, zone.trim());
}

export function useLiveZoneName(): [string, (n: StringUpdater) => void] {
  return useGlobalString(LIVE_ZONE_KEY, "");
}

export function useLiveZoneEnabled(): [boolean, (n: BoolUpdater) => void] {
  return useGlobalBool(LIVE_ZONE_ENABLED_KEY, false);
}

function norm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function resolveLiveZoneShortName(zoneName: string, zones: DropZone[]): string {
  const q = norm(zoneName);
  if (!q) return "";
  const hit =
    zones.find((z) => norm(z.longName) === q) ??
    zones.find((z) => norm(z.shortName) === q) ??
    zones.find((z) => norm(z.longName).includes(q) || q.includes(norm(z.longName)));
  return hit?.shortName ?? "";
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
