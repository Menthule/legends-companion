import { describe, expect, it } from "vitest";
import type { CharacterProfile } from "../types";
import {
  CLASS_NAME_TO_BIT,
  loadoutClassPreset,
  reconcileLoadoutClassFilter,
} from "./refFilters";

function profile(active: string): CharacterProfile {
  return {
    character: "Nyasha",
    level: 50,
    active_loadout: active,
    loadouts: [
      { name: "Caster", classes: ["Necromancer", "Shaman", "Monk"], overrides: {} },
      { name: "Pld", classes: ["Paladin", "Cleric", "Bard"], overrides: {} },
    ],
  };
}

function mask(...classes: string[]): number {
  return classes.reduce(
    (value, name) => value | (1 << CLASS_NAME_TO_BIT[name]),
    0,
  );
}

describe("loadout-backed database class filter", () => {
  it("builds the preset from the profile's current active loadout", () => {
    expect(loadoutClassPreset(profile("Caster"))).toEqual({
      label: "My loadout (Necromancer, Shaman, Monk)",
      mask: mask("Necromancer", "Shaman", "Monk"),
    });
    expect(loadoutClassPreset(profile("Pld"))).toEqual({
      label: "My loadout (Paladin, Cleric, Bard)",
      mask: mask("Paladin", "Cleric", "Bard"),
    });
  });

  it("moves an active My loadout filter to the new loadout classes", () => {
    const oldMask = mask("Necromancer", "Shaman", "Monk");
    const nextMask = mask("Paladin", "Cleric", "Bard");
    expect(
      reconcileLoadoutClassFilter(oldMask, oldMask, nextMask, true),
    ).toEqual({ classMask: nextMask, followingLoadout: true });
  });

  it("preserves an unrelated manual class selection", () => {
    const manual = mask("Rogue", "Berserker");
    expect(
      reconcileLoadoutClassFilter(
        manual,
        mask("Necromancer", "Shaman", "Monk"),
        mask("Paladin", "Cleric", "Bard"),
        false,
      ),
    ).toEqual({ classMask: manual, followingLoadout: false });
  });

  it("migrates an existing mask that matches the previous preset", () => {
    const oldMask = mask("Necromancer", "Shaman", "Monk");
    const nextMask = mask("Paladin", "Cleric", "Bard");
    expect(
      reconcileLoadoutClassFilter(oldMask, oldMask, nextMask, false),
    ).toEqual({ classMask: nextMask, followingLoadout: true });
  });
});
