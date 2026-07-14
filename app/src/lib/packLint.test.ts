import { describe, expect, it } from "vitest";
import type { Trigger, TriggerAction } from "../types";
import {
  findLookarounds,
  isAbsoluteLocalPath,
  isHotPattern,
  lintTriggersForShare,
} from "./packLint";

function trig(overrides: Partial<Trigger> & { pattern: string }): Trigger {
  return {
    name: "Test trigger",
    enabled: true,
    actions: [],
    ...overrides,
  };
}

const speak = (template: string): TriggerAction => ({ Speak: { template } });
const sound = (path: string): TriggerAction => ({ PlaySound: { path } });
const timer = (name: string, lane?: "buff" | "enemy" | "other" | null): TriggerAction => ({
  StartTimer: {
    name,
    duration_secs: 30,
    warn_at_secs: null,
    ...(lane !== undefined ? { lane } : {}),
  },
});

describe("findLookarounds", () => {
  it("detects all four lookaround forms", () => {
    expect(findLookarounds("^You (?=begin)")).toEqual(["(?="]);
    expect(findLookarounds("(?!not this)x")).toEqual(["(?!"]);
    expect(findLookarounds("x(?<=behind)")).toEqual(["(?<="]);
    expect(findLookarounds("x(?<!behind)")).toEqual(["(?<!"]);
    expect(findLookarounds("(?=a)(?!b)")).toEqual(["(?=", "(?!"]);
  });

  it("ignores escaped parens, char classes, and named groups", () => {
    expect(findLookarounds("\\(?=literal")).toEqual([]);
    expect(findLookarounds("[(?=]")).toEqual([]);
    expect(findLookarounds("(?P<S1>.+) casts")).toEqual([]);
    expect(findLookarounds("(?<rank>[IVX]+)")).toEqual([]); // named group, not lookbehind
    expect(findLookarounds("^You have slain (.+)!$")).toEqual([]);
  });
});

describe("isAbsoluteLocalPath", () => {
  it("flags Windows drive, UNC, and Unix absolute paths", () => {
    expect(isAbsoluteLocalPath("C:\\Sounds\\ding.wav")).toBe(true);
    expect(isAbsoluteLocalPath("d:/audio/alert.mp3")).toBe(true);
    expect(isAbsoluteLocalPath("\\\\nas\\share\\ding.wav")).toBe(true);
    expect(isAbsoluteLocalPath("/home/me/ding.wav")).toBe(true);
  });

  it("passes relative paths", () => {
    expect(isAbsoluteLocalPath("sounds/ding.wav")).toBe(false);
    expect(isAbsoluteLocalPath("ding.wav")).toBe(false);
  });
});

describe("isHotPattern", () => {
  it("flags combat-spam verbs and unanchored wildcards", () => {
    expect(isHotPattern("for \\d+ points of damage")).toBe(true);
    expect(isHotPattern("^A gnoll hits YOU")).toBe(true); // hot verb even anchored
    expect(isHotPattern("{S} staggers")).toBe(true); // unanchored broad token
    expect(isHotPattern("something .* happened")).toBe(true);
  });

  it("passes anchored specific patterns and plain literals", () => {
    expect(isHotPattern("^You have been slain")).toBe(false);
    expect(isHotPattern("^Your {S} spell has worn off\\.$")).toBe(false); // anchored
    expect(isHotPattern("mesmerized")).toBe(false); // no wildcard, no hot verb
  });
});

describe("lintTriggersForShare", () => {
  it("reports a lookaround finding with the trigger identity", () => {
    const t = trig({ pattern: "^You (?=resist)", id: "my/look", name: "Look" });
    const findings = lintTriggersForShare([t], null);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("regex-lookaround");
    expect(findings[0].triggerId).toBe("my/look");
    expect(findings[0].message).toContain("(?=");
  });

  it("reports absolute sound paths but not relative ones", () => {
    const bad = trig({ pattern: "^x$", actions: [sound("C:\\me\\ding.wav")] });
    const good = trig({ pattern: "^y$", actions: [sound("sounds/ding.wav")] });
    const findings = lintTriggersForShare([bad, good], null);
    expect(findings.map((f) => f.rule)).toEqual(["absolute-sound-path"]);
  });

  it("reports hardcoded character names in pattern and templates", () => {
    const inPattern = trig({ pattern: "^Nyasha has been slain" });
    const inSpeak = trig({ pattern: "^x$", actions: [speak("heal Nyasha now")] });
    const usesToken = trig({ pattern: "^{C} has been slain" });
    const findings = lintTriggersForShare([inPattern, inSpeak, usesToken], "Nyasha");
    expect(findings.filter((f) => f.rule === "hardcoded-character")).toHaveLength(2);
    expect(findings[0].message).toContain("{C}");
    // No character name known -> rule is skipped entirely.
    expect(
      lintTriggersForShare([inPattern], null).filter(
        (f) => f.rule === "hardcoded-character",
      ),
    ).toHaveLength(0);
  });

  it("does not match the character name inside a longer word", () => {
    const t = trig({ pattern: "^Nyashathar growls" });
    expect(lintTriggersForShare([t], "Nyasha")).toHaveLength(0);
  });

  it("reports hot patterns without cooldown, honoring cooldown and suppress", () => {
    const hot = trig({ pattern: "for \\d+ points of damage" });
    const throttled = trig({ pattern: "for \\d+ points of damage", cooldown_secs: 10 });
    const suppressor = trig({ pattern: "for \\d+ points of damage", suppress: true });
    const findings = lintTriggersForShare([hot, throttled, suppressor], null);
    expect(findings.map((f) => f.rule)).toEqual(["hot-pattern-no-cooldown"]);
  });

  it("reports StartTimer actions without an explicit lane", () => {
    const noLane = trig({ pattern: "^x$", actions: [timer("SoW")] });
    const nullLane = trig({ pattern: "^y$", actions: [timer("Haste", null)] });
    const withLane = trig({ pattern: "^z$", actions: [timer("Root", "enemy")] });
    const findings = lintTriggersForShare([noLane, nullLane, withLane], null);
    expect(findings.map((f) => f.rule)).toEqual([
      "timer-without-lane",
      "timer-without-lane",
    ]);
    expect(findings[0].message).toContain("SoW");
  });

  it("returns no findings for a clean shareable trigger", () => {
    const clean = trig({
      pattern: "^{C} has been mesmerized",
      actions: [speak("mezzed"), timer("Mez", "enemy"), sound("sounds/bell.wav")],
      cooldown_secs: 5,
    });
    expect(lintTriggersForShare([clean], "Nyasha")).toEqual([]);
  });
});
