import { describe, expect, it } from "vitest";
import { classifySeverity } from "./severity";

describe("default trigger alert severity", () => {
  it.each([
    ["skills/melee/kick", "Kick"],
    ["universal/combat/resist-out", "Your spell resisted"],
    ["enemy-casts/lifetap", "Enemy cast: Lifetap"],
    ["enemy-casts/heals-other", "Enemy cast: Heals (minor)"],
    ["enemy-casts/death-touch", "Enemy cast: Death Touch"],
    ["class/monk/abilities/mend-failed", "Mend failed"],
    ["class/rogue/stealth/hide-failed", "Hide failed"],
    ["class/warrior/aggro/taunt-failed", "Taunt failed"],
  ])("keeps routine spell/damage event %s quiet", (id, name) => {
    expect(classifySeverity(id, name)).toBe("info");
  });

  it.each([
    ["universal/cc/rooted", "You are rooted"],
    ["class/enchanter/cc/charm-broken", "Charm broke"],
    ["universal/survival/stunned", "Stunned"],
    ["enemy-casts/mesmerize", "Enemy cast: Mesmerize"],
    ["enemy-casts/root-snare", "Enemy cast: Root & Snare"],
    ["imported/trigger", "Walking Sleep worn off"],
  ])("marks crowd-control event %s as warn", (id, name) => {
    expect(classifySeverity(id, name)).toBe("warn");
  });

  it.each([
    ["class/monk/fd/fallen-self", "Feign death FAILED"],
    ["class/monk/fd/fd-broken-by-spell", "FD broken"],
    ["class/necromancer/fd/fd-over", "Feign death ended"],
    ["universal/survival/summoned", "Summoned"],
    ["universal/survival/you-died", "You died"],
  ])("marks survival failure %s as loud", (id, name) => {
    expect(classifySeverity(id, name)).toBe("alarm");
  });

  it("does not promote arbitrary names containing death", () => {
    expect(classifySeverity("user/dot", "Bond of Death landed")).toBe("info");
  });
});
