import { describe, expect, it } from "vitest";
import { cloneLoadout } from "./resolution";
import type { Loadout } from "./types";

describe("cloneLoadout", () => {
  it("preserves every trigger-management field without sharing nested state", () => {
    const source: Loadout = {
      name: "Raid",
      classes: ["Enchanter"],
      overrides: { "class/enchanter": true },
      channel_overrides: { "cc/root": { speak: false, alert: true } },
      severity_overrides: { "cc/root": "alarm" },
      zone_scopes: { "cc/root": ["Kael", "Growth"] },
    };

    const copy = cloneLoadout(source, "Raid copy");
    expect(copy).toEqual({ ...source, name: "Raid copy" });

    copy.classes.push("Cleric");
    copy.channel_overrides!["cc/root"].speak = true;
    copy.zone_scopes!["cc/root"].push("Sky");
    expect(source.classes).toEqual(["Enchanter"]);
    expect(source.channel_overrides!["cc/root"].speak).toBe(false);
    expect(source.zone_scopes!["cc/root"]).toEqual(["Kael", "Growth"]);
  });
});
