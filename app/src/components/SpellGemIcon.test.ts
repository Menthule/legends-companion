import { describe, expect, it } from "vitest";
import { spellIconId, spellIconName } from "./SpellGemIcon";

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

describe("spellIconName", () => {
  it("accepts captured spell-name references", () => {
    expect(spellIconName("spell-name:Cascading Darkness")).toBe(
      "Cascading Darkness",
    );
    expect(spellIconName(" SPELL-NAME: Odium VII ")).toBe("Odium VII");
  });

  it("rejects empty and unrelated references", () => {
    expect(spellIconName("spell-name: ")).toBeNull();
    expect(spellIconName("spell:160")).toBeNull();
  });
});
