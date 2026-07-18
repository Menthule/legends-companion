import { describe, expect, it } from "vitest";
import { timerDisplayName, timerIconKind } from "./TimerBars";

describe("TimerBars icon column", () => {
  it("uses spell artwork for configured spell references", () => {
    expect(timerIconKind("spell:6")).toBe("spell");
    expect(timerIconKind(" spell:374 ")).toBe("spell");
  });

  it("keeps custom glyphs and reserves the fallback for missing icons", () => {
    expect(timerIconKind("!")).toBe("glyph");
    expect(timerIconKind("shield")).toBe("glyph");
    expect(timerIconKind(undefined)).toBe("fallback");
    expect(timerIconKind(null)).toBe("fallback");
    expect(timerIconKind("   ")).toBe("fallback");
  });
});

describe("TimerBars labels", () => {
  it("hides the internal self target while preserving pet targets", () => {
    expect(timerDisplayName({ lane: "buff", name: "Shield of Fire — You" })).toBe(
      "Shield of Fire",
    );
    expect(
      timerDisplayName({ lane: "on-others", name: "Shield of Fire — Gasn" }),
    ).toBe("Shield of Fire — Gasn");
  });
});
