import { describe, expect, it } from "vitest";
import { cloneLoadout, withTimingOverride } from "./resolution";
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
