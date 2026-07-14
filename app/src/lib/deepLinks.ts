// Cross-tab deep links ("look this up in the X database tab"). One typed
// dispatcher + one listener hook per target replaces the raw
// "eqlogs-open-*" CustomEvent strings that were previously duplicated at
// every dispatch and listen site.
//
// Dashboard owns the listen side (useDeepLink): it bumps a request seq —
// so the same name can be re-requested — and switches to the target tab.
// Adding a new deep-link target is a 2-line change here plus one
// useDeepLink call in Dashboard.

import { useEffect, useRef } from "react";

const EVENT = {
  drops: "eqlogs-open-drops",
  mobs: "eqlogs-open-mobs",
  recipes: "eqlogs-open-recipes",
  quests: "eqlogs-open-quests",
  spells: "eqlogs-open-spells",
  timers: "eqlogs-open-timers",
  triggers: "eqlogs-open-triggers",
} as const;

type Target = keyof typeof EVENT;

/** Event `detail` per target: a plain name, except spells which also says
 *  whether to land on the Abilities tab. */
interface DetailMap {
  drops: string;
  mobs: string;
  recipes: string;
  quests: string;
  spells: { name: string; isAbility?: boolean };
  timers: null;
  triggers: null;
}

function dispatch<T extends Target>(target: T, detail: DetailMap[T]): void {
  window.dispatchEvent(new CustomEvent(EVENT[target], { detail }));
}

/** Look up an item in the Drops tab. */
export function openDrops(item: string): void {
  dispatch("drops", item);
}

/** Open a mob in the Mobs database. */
export function openMobs(name: string): void {
  dispatch("mobs", name);
}

/** Open a recipe in the Recipes tab. */
export function openRecipes(name: string): void {
  dispatch("recipes", name);
}

/** Open a quest in the Quests tab. */
export function openQuests(name: string): void {
  dispatch("quests", name);
}

/** Open a spell (or ability) in the matching Database tab. */
export function openSpells(name: string, isAbility = false): void {
  dispatch("spells", { name, isAbility });
}

/** Jump to the Timers tab (the single live-timers surface). */
export function openTimers(): void {
  dispatch("timers", null);
}

/** Jump to the Triggers tab (the single classes/level editing surface). */
export function openTriggers(): void {
  dispatch("triggers", null);
}

/** Subscribe to one deep-link target for the component's lifetime. The
 *  handler ref is kept fresh so callers can pass inline closures without
 *  re-subscribing. */
export function useDeepLink<T extends Target>(
  target: T,
  handler: (detail: DetailMap[T]) => void,
): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const on = (e: Event) =>
      ref.current((e as CustomEvent).detail as DetailMap[T]);
    window.addEventListener(EVENT[target], on);
    return () => window.removeEventListener(EVENT[target], on);
  }, [target]);
}
