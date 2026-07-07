import { describe, expect, it } from "vitest";
import {
  conflictsForMap,
  mergeConflict,
  type ConflictMap,
} from "./buffConflicts";

describe("mergeConflict (P11)", () => {
  it("records the pair symmetrically", () => {
    const { map, learned } = mergeConflict({}, "Protect", "Spirit Armor");
    expect(learned).toBe(true);
    expect(map["Protect"]).toEqual(["Spirit Armor"]);
    expect(map["Spirit Armor"]).toEqual(["Protect"]);
  });

  it("dedupes case-insensitively and reports nothing new learned", () => {
    const start: ConflictMap = {
      Protect: ["Spirit Armor"],
      "Spirit Armor": ["Protect"],
    };
    const { learned } = mergeConflict(start, "protect", "SPIRIT ARMOR");
    expect(learned).toBe(false);
  });

  it("ignores a self-conflict or empty names", () => {
    expect(mergeConflict({}, "Protect", "Protect").learned).toBe(false);
    expect(mergeConflict({}, "", "Spirit Armor").learned).toBe(false);
  });

  it("accumulates multiple blockers for one spell", () => {
    let m: ConflictMap = {};
    m = mergeConflict(m, "Protect", "Spirit Armor").map;
    m = mergeConflict(m, "Protect", "Shield of Words").map;
    expect(m["Protect"].sort()).toEqual(["Shield of Words", "Spirit Armor"]);
  });
});

describe("conflictsForMap (P11)", () => {
  const map: ConflictMap = { Protect: ["Spirit Armor"], "Spirit Armor": ["Protect"] };
  it("looks up case-insensitively", () => {
    expect(conflictsForMap(map, "protect")).toEqual(["Spirit Armor"]);
  });
  it("returns empty for an unknown spell", () => {
    expect(conflictsForMap(map, "Clarity")).toEqual([]);
  });
});
