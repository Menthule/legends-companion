import { describe, expect, it } from "vitest";
import { spellIconId } from "./SpellGemIcon";

describe("spellIconId", () => {
  it("accepts portable spell references including icon zero", () => {
    expect(spellIconId("spell:0")).toBe(0);
    expect(spellIconId(" spell:374 ")).toBe(374);
  });

  it("rejects unrelated or malformed icon values", () => {
    expect(spellIconId("⚠")).toBeNull();
    expect(spellIconId("spell:-1")).toBeNull();
    expect(spellIconId("spell:12px")).toBeNull();
    expect(spellIconId(null)).toBeNull();
  });
});
