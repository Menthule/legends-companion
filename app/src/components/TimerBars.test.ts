import { describe, expect, it } from "vitest";
import { timerIconKind } from "./TimerBars";

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
