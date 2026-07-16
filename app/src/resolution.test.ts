import { describe, expect, it } from "vitest";
import {
  cloneLoadout,
  effectiveEnabledInLoadout,
  withTimingOverride,
  zoneScopeFor,
} from "./resolution";
import type { CharacterProfile, Loadout } from "./types";

describe("cloneLoadout", () => {
  it("preserves every trigger-management field without sharing nested state", () => {
    const source: Loadout = {
      name: "Raid",
      classes: ["Enchanter"],
      overrides: { "class/enchanter": true },
      channel_overrides: { "cc/root": { speak: false, alert: true } },
      severity_overrides: { "cc/root": "alarm" },
      zone_scopes: { "cc/root": ["Kael", "Growth"] },
      timing_overrides: {
        "cc/root": { IV: { duration_secs: 96, cast_time_secs: 2 } },
      },
    };

    const copy = cloneLoadout(source, "Raid copy");
    expect(copy).toEqual({ ...source, name: "Raid copy" });

    copy.classes.push("Cleric");
    copy.channel_overrides!["cc/root"].speak = true;
    copy.zone_scopes!["cc/root"].push("Sky");
    copy.timing_overrides!["cc/root"].IV.duration_secs = 120;
    expect(source.classes).toEqual(["Enchanter"]);
    expect(source.channel_overrides!["cc/root"].speak).toBe(false);
    expect(source.zone_scopes!["cc/root"]).toEqual(["Kael", "Growth"]);
    expect(source.timing_overrides!["cc/root"].IV.duration_secs).toBe(96);
  });
});

describe("observed trigger resolution", () => {
  const trigger = {
    id: "debuffs/enchanter/cast/mesmerization",
    category: "Debuffs/Enchanter/Timers",
    classes: ["Enchanter"],
    defaultEnabled: true,
    trackWhenObserved: true,
  };
  const stale: Loadout = {
    name: "Nyasha",
    classes: ["Necromancer", "Shaman", "Monk"],
    overrides: {},
  };

  it("tracks exact observed casts outside stale selected classes", () => {
    expect(effectiveEnabledInLoadout(trigger, stale)).toBe(true);
  });

  it("still honors an explicit disable", () => {
    expect(
      effectiveEnabledInLoadout(trigger, {
        ...stale,
        overrides: { [trigger.id]: false },
      }),
    ).toBe(false);
  });
});

describe("zoneScopeFor", () => {
  // Mirrors the Rust zone_scope_for tests in eqlog-triggers profile.rs.
  const trigger = { id: "class/enchanter/cc/mez-broken", category: "Class/Enchanter/CC" };
  const loadout = (zone_scopes: Record<string, string[]>): Loadout => ({
    name: "L",
    classes: [],
    overrides: {},
    zone_scopes,
  });

  it("returns null when the loadout defines no scopes", () => {
    expect(zoneScopeFor(trigger, loadout({}))).toBeNull();
    expect(
      zoneScopeFor(trigger, { name: "L", classes: [], overrides: {} }),
    ).toBeNull();
  });

  it("prefers an exact trigger-id entry over any prefix", () => {
    const l = loadout({
      "class/enchanter/cc/mez-broken": ["Kael"],
      "class/enchanter": ["Growth"],
    });
    expect(zoneScopeFor(trigger, l)).toEqual(["Kael"]);
  });

  it("matches the exact id case-insensitively", () => {
    const l = loadout({ "Class/Enchanter/CC/Mez-Broken": ["Kael"] });
    expect(zoneScopeFor(trigger, l)).toEqual(["Kael"]);
  });

  it("takes the longest matching prefix against category or id", () => {
    const l = loadout({
      "class/enchanter": ["Growth"],
      "class/enchanter/cc": ["Kael"],
    });
    expect(zoneScopeFor(trigger, l)).toEqual(["Kael"]);
    // Display-form category prefix matches too (pathHasPrefix is
    // case-insensitive).
    expect(
      zoneScopeFor(trigger, loadout({ "Class/Enchanter/CC": ["Sky"] })),
    ).toEqual(["Sky"]);
  });

  it("returns an empty list distinctly (scoped to no zone)", () => {
    const l = loadout({ "class/enchanter": [] });
    expect(zoneScopeFor(trigger, l)).toEqual([]);
  });

  it("ignores non-matching prefixes (no partial-segment match)", () => {
    const l = loadout({ "class/ench": ["Kael"] });
    expect(zoneScopeFor(trigger, l)).toBeNull();
  });
});

describe("withTimingOverride", () => {
  const profile: CharacterProfile = {
    character: "Nyasha",
    level: 50,
    active_loadout: "Raid",
    loadouts: [
      { name: "Solo", classes: [], overrides: {} },
      { name: "Raid", classes: ["Necromancer"], overrides: {} },
    ],
  };

  it("normalizes and stores timing only in the active loadout", () => {
    const next = withTimingOverride(profile, "dots/heat-blood", "iv", {
      duration_secs: 216,
      cast_time_secs: 2,
    });
    expect(next.loadouts[0].timing_overrides).toBeUndefined();
    expect(next.loadouts[1].timing_overrides).toEqual({
      "dots/heat-blood": { IV: { duration_secs: 216, cast_time_secs: 2 } },
    });
  });

  it("clears a rank and prunes empty trigger maps", () => {
    const saved = withTimingOverride(profile, "dots/heat-blood", "IV", {
      duration_secs: 216,
    });
    const cleared = withTimingOverride(saved, "dots/heat-blood", "iv", null);
    expect(cleared.loadouts[1].timing_overrides).toEqual({});
  });
});
