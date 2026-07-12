import { describe, expect, it } from "vitest";
import { observedSpellEffect } from "./effects";

describe("observed effect classification", () => {
  it("keeps Tremor as a spell without consulting item metadata", () => {
    expect(observedSpellEffect("Tremor", "a shadowknight", 122, false)).toEqual({
      kind: "spell",
      spell: "Tremor",
      target: "a shadowknight",
      amount: 122,
      critical: false,
    });
  });
});
