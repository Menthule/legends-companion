// Character-scoped item and kill watches. Rust owns persistence and live-event
// progress; this module keeps a synchronous UI cache for views and exposes
// async mutations for watch management.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  watchAddManual,
  watchAddQuestGoal,
  watchAddQuestGoals,
  watchAddManualKill,
  watchAddQuestKillGoal,
  watchImportLegacyNames,
  watchList,
  watchReconcileInventory,
  watchRemoveItem,
  watchRemoveKill,
  watchRemoveQuestKillGoal,
  watchRemoveQuestGoal,
  watchRemoveQuestGoals,
  watchUpdateGoal,
  watchUpdateKillGoal,
} from "../api";
import { IS_MOCK } from "../mock";
import type {
  InventoryWatchQuantity,
  QuestWatchInput,
  QuestKillWatchInput,
  WatchGoal,
  WatchList,
  WatchedItem,
  WatchedKill,
} from "../types";
import { normalizeInventoryItem, type InventorySnapshot } from "./quests";

export const WISHLIST_KEY = "eqlogs.wishlist.v1";
export const WISHLIST_EVENT = "eqlogs-wishlist-changed";

export type WishlistEntry = WatchedItem;
export type KillWatchEntry = WatchedKill;
export type { QuestKillWatchInput, QuestWatchInput, WatchGoal, WatchList, WatchedItem, WatchedKill };

const EMPTY_LIST: WatchList = {
  server: "",
  character: "",
  legacyNamesImported: false,
  items: [],
  kills: [],
};

let current: WatchList = EMPTY_LIST;
let activeCharacter = "";
let activeScope = "";
let unlisten: UnlistenFn | null = null;
let listenerStarted = false;

function key(value: string): string {
  return value.split(/\s+/).filter(Boolean).join(" ").toLowerCase();
}

function notify(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(WISHLIST_EVENT));
}

function adopt(list: WatchList): WatchList {
  current = list;
  notify();
  return list;
}

function mockList(items = current.items, kills = current.kills): WatchList {
  return { ...current, character: activeCharacter, items, kills };
}

function startListener(): void {
  if (listenerStarted || IS_MOCK) return;
  listenerStarted = true;
  void listen<WatchList>("watch-changed", (event) => adopt(event.payload))
    .then((stop) => { unlisten = stop; })
    .catch((error) => console.error("listen(watch-changed) failed", error));
}

function legacyNames(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(WISHLIST_KEY) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((value) => typeof value === "string"
        ? value
        : value && typeof value === "object" && "name" in value
          ? String((value as { name: unknown }).name)
          : "")
      .map((name) => name.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Refresh when the active character changes. The backend resolves the
 * selected character from AppConfig; the string here only guards stale async
 * responses and labels mock data. */
export async function setWishlistCharacter(character: string, scope = character): Promise<void> {
  const requested = character.trim();
  const requestedScope = scope.trim().toLowerCase();
  if (requestedScope !== activeScope) {
    activeScope = requestedScope;
    current = { ...EMPTY_LIST, character: requested };
    notify();
  }
  activeCharacter = requested;
  startListener();
  if (IS_MOCK) {
    adopt(mockList());
    return;
  }
  try {
    let list = await watchList();
    if (activeCharacter !== requested || activeScope !== requestedScope) return;
    const names = legacyNames();
    if (!list.legacyNamesImported) {
      list = await watchImportLegacyNames(names);
      try { localStorage.removeItem(WISHLIST_KEY); } catch { /* best effort */ }
    }
    if (activeCharacter === requested && activeScope === requestedScope) adopt(list);
  } catch (error) {
    console.error("load item watches failed", error);
  }
}

export function wishlistCharacter(): string {
  return activeCharacter;
}

export function loadWishlist(): WishlistEntry[] {
  return current.items;
}

export const loadWatchedItems = loadWishlist;

export function loadWatchedKills(): KillWatchEntry[] {
  return current.kills;
}

export async function refreshWishlist(): Promise<WishlistEntry[]> {
  if (IS_MOCK) return loadWishlist();
  return adopt(await watchList()).items;
}

export function isWishlisted(name: string): boolean {
  const wanted = key(name);
  return current.items.some((item) =>
    item.key === wanted && item.goals.some((goal) => goal.enabled && goal.remainingQuantity > 0));
}

export function isKillWatched(name: string): boolean {
  const wanted = key(name);
  return current.kills.some((kill) =>
    kill.key === wanted && kill.goals.some((goal) => goal.enabled && goal.remainingQuantity > 0));
}

export function watchRemainingQuantity(item: Pick<WatchedItem, "goals">): number {
  return item.goals
    .filter((goal) => goal.enabled)
    .reduce((total, goal) => total + goal.remainingQuantity, 0);
}

export function questGoal(itemName: string, questId: string): WatchGoal | null {
  const item = current.items.find((row) => row.key === key(itemName));
  return item?.goals.find((goal) => goal.id === `quest:${questId.trim()}`) ?? null;
}

export function questKillGoal(mobName: string, questId: string): WatchGoal | null {
  const kill = current.kills.find((row) => row.key === key(mobName));
  return kill?.goals.find((goal) => goal.id === `quest:${questId.trim()}`) ?? null;
}

export async function addManualWatch(
  name: string,
  quantity = 1,
  autoRemove = true,
): Promise<WatchList> {
  if (IS_MOCK) {
    const item: WatchedItem = {
      key: key(name),
      name: name.trim(),
      goals: [{
        id: "manual",
        source: { kind: "manual" },
        requiredQuantity: quantity,
        ownedQuantity: 0,
        remainingQuantity: quantity,
        enabled: true,
        autoRemove,
      }],
    };
    return adopt(mockList([...current.items.filter((row) => row.key !== item.key), item]));
  }
  return adopt(await watchAddManual(name, quantity, autoRemove));
}

export async function addQuestWatch(input: QuestWatchInput): Promise<WatchList> {
  if (IS_MOCK) return current;
  return adopt(await watchAddQuestGoal(input));
}

export async function addQuestWatches(inputs: QuestWatchInput[]): Promise<WatchList> {
  if (inputs.length === 0) return current;
  if (IS_MOCK) return current;
  return adopt(await watchAddQuestGoals(inputs));
}

export async function addManualKillWatch(
  name: string,
  quantity = 1,
  autoRemove = true,
): Promise<WatchList> {
  if (IS_MOCK) {
    const wanted = key(name);
    const existing = current.kills.find((kill) => kill.key === wanted);
    const goal: WatchGoal = {
      id: "manual",
      source: { kind: "manual" },
      requiredQuantity: quantity,
      ownedQuantity: 0,
      remainingQuantity: quantity,
      enabled: true,
      autoRemove,
    };
    const kill: WatchedKill = {
      key: wanted,
      name: name.trim(),
      goals: [...(existing?.goals.filter((candidate) => candidate.id !== goal.id) ?? []), goal],
    };
    return adopt(mockList(current.items, [
      ...current.kills.filter((candidate) => candidate.key !== wanted),
      kill,
    ]));
  }
  return adopt(await watchAddManualKill(name, quantity, autoRemove));
}

export async function addQuestKillWatch(input: QuestKillWatchInput): Promise<WatchList> {
  if (IS_MOCK) {
    const wanted = key(input.mobName);
    const existing = current.kills.find((kill) => kill.key === wanted);
    const required = Math.max(1, input.requiredQuantity);
    const observed = Math.min(required, Math.max(0, input.observedQuantity ?? 0));
    const goal: WatchGoal = {
      id: `quest:${input.questId.trim()}`,
      source: { kind: "quest", questId: input.questId.trim(), questName: input.questName.trim() },
      requiredQuantity: required,
      ownedQuantity: observed,
      remainingQuantity: required - observed,
      enabled: true,
      autoRemove: input.autoRemove ?? true,
    };
    const kill: WatchedKill = {
      key: wanted,
      name: input.mobName.trim(),
      goals: [...(existing?.goals.filter((candidate) => candidate.id !== goal.id) ?? []), goal],
    };
    return adopt(mockList(current.items, [
      ...current.kills.filter((candidate) => candidate.key !== wanted),
      kill,
    ]));
  }
  return adopt(await watchAddQuestKillGoal(input));
}

export async function removeWatchedItem(name: string): Promise<WatchList> {
  if (IS_MOCK) return adopt(mockList(current.items.filter((item) => item.key !== key(name))));
  return adopt(await watchRemoveItem(name));
}

export async function removeWatchedKill(name: string): Promise<WatchList> {
  if (IS_MOCK) {
    return adopt(mockList(current.items, current.kills.filter((kill) => kill.key !== key(name))));
  }
  return adopt(await watchRemoveKill(name));
}

export async function removeQuestKillWatch(mobName: string, questId: string): Promise<WatchList> {
  if (IS_MOCK) {
    const goalId = `quest:${questId.trim()}`;
    const kills = current.kills
      .map((kill) => kill.key === key(mobName)
        ? { ...kill, goals: kill.goals.filter((goal) => goal.id !== goalId) }
        : kill)
      .filter((kill) => kill.goals.length > 0);
    return adopt(mockList(current.items, kills));
  }
  return adopt(await watchRemoveQuestKillGoal(mobName, questId));
}

export async function removeQuestWatch(itemName: string, questId: string): Promise<WatchList> {
  if (IS_MOCK) return current;
  return adopt(await watchRemoveQuestGoal(itemName, questId));
}

export async function removeQuestWatches(questId: string): Promise<WatchList> {
  if (IS_MOCK) {
    const goalId = `quest:${questId.trim()}`;
    const items = current.items
      .map((item) => ({ ...item, goals: item.goals.filter((goal) => goal.id !== goalId) }))
      .filter((item) => item.goals.length > 0);
    const kills = current.kills
      .map((kill) => ({ ...kill, goals: kill.goals.filter((goal) => goal.id !== goalId) }))
      .filter((kill) => kill.goals.length > 0);
    return adopt(mockList(items, kills));
  }
  return adopt(await watchRemoveQuestGoals(questId));
}

export async function updateWatchGoal(
  itemName: string,
  goalId: string,
  values: { enabled?: boolean; autoRemove?: boolean; remainingQuantity?: number },
): Promise<WatchList> {
  if (IS_MOCK) return current;
  return adopt(await watchUpdateGoal(itemName, goalId, values));
}

export async function updateKillWatchGoal(
  mobName: string,
  goalId: string,
  values: { enabled?: boolean; autoRemove?: boolean; remainingQuantity?: number },
): Promise<WatchList> {
  if (IS_MOCK) {
    const kills = current.kills.map((kill) => {
      if (kill.key !== key(mobName)) return kill;
      return {
        ...kill,
        goals: kill.goals.map((goal) => {
          if (goal.id !== goalId) return goal;
          const remaining = values.remainingQuantity ?? goal.remainingQuantity;
          return {
            ...goal,
            enabled: values.enabled ?? goal.enabled,
            autoRemove: values.autoRemove ?? goal.autoRemove,
            remainingQuantity: remaining,
            requiredQuantity: values.remainingQuantity === undefined
              ? goal.requiredQuantity
              : goal.ownedQuantity + remaining,
          };
        }),
      };
    });
    return adopt(mockList(current.items, kills));
  }
  return adopt(await watchUpdateKillGoal(mobName, goalId, values));
}

export async function toggleWishlist(name: string): Promise<boolean> {
  if (isWishlisted(name)) {
    await removeWatchedItem(name);
    return false;
  }
  await addManualWatch(name);
  return true;
}

/** Absolute inventory refresh; this updates progress silently and never emits
 * a typed watched-loot signal. */
export async function reconcileWishlistInventory(
  snapshot: InventorySnapshot,
): Promise<WatchList> {
  const inventory: InventoryWatchQuantity[] = current.items.map((watched) => {
    const wanted = normalizeInventoryItem(watched.name);
    const quantity = snapshot.items
      .filter((item) => [item.name, ...item.names]
        .some((name) => normalizeInventoryItem(name) === wanted))
      .reduce((total, item) => total + item.quantity, 0);
    return { name: watched.name, quantity };
  });
  if (IS_MOCK) return current;
  return adopt(await watchReconcileInventory(inventory));
}

export function onWishlistChanged(callback: () => void): () => void {
  const handler = () => callback();
  window.addEventListener(WISHLIST_EVENT, handler);
  return () => window.removeEventListener(WISHLIST_EVENT, handler);
}

/** Test cleanup for the module-level Tauri listener. */
export function stopWishlistListener(): void {
  unlisten?.();
  unlisten = null;
  listenerStarted = false;
}
