import { describe, expect, it } from "vitest";
import {
  applyRecords,
  dpsOf,
  emptyPlayer,
  isPlayerName,
  scoreRows,
  type Records,
  type Scoreboard,
} from "./scoreboard";

function freshRecords(): Records {
  return {
    highestHit: { value: 0, who: "", label: "" },
    bestStreak: { value: 0, who: "" },
    killingBlows: { value: 0, who: "" },
  };
}

describe("isPlayerName", () => {
  const owned = new Set(["gybard"]);
  it("accepts You, single-word groupmates, and owned pets", () => {
    expect(isPlayerName("You", owned)).toBe(true);
    expect(isPlayerName("Sliq", owned)).toBe(true);
    expect(isPlayerName("Gybard", owned)).toBe(true);
  });
  it("rejects mobs (articles / multi-word)", () => {
    expect(isPlayerName("a Teir`Dal ranger", owned)).toBe(false);
    expect(isPlayerName("Baron Telyx V`Zher", owned)).toBe(false);
    expect(isPlayerName("ice boned skeleton", owned)).toBe(false);
  });
});

describe("applyRecords", () => {
  it("seeds the first record silently (no trophy), then fires when beaten", () => {
    const rec = freshRecords();
    const p = emptyPlayer("You");
    p.highestHit = 100;
    // First time: seeds, no break announced.
    expect(applyRecords(rec, p)).toEqual([]);
    expect(rec.highestHit).toMatchObject({ value: 100, who: "You" });

    // A groupmate beats it → one trophy.
    const s = emptyPlayer("Sliq");
    s.highestHit = 250;
    s.highestHitLabel = "Blast of Frost";
    const breaks = applyRecords(rec, s);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]).toMatchObject({ stat: "Highest Hit", who: "Sliq", value: "250" });
    expect(rec.highestHit).toMatchObject({ value: 250, who: "Sliq", label: "Blast of Frost" });
  });

  it("does not re-fire on ties or lower values", () => {
    const rec = freshRecords();
    rec.highestHit = { value: 300, who: "You", label: "x" };
    const p = emptyPlayer("Sliq");
    p.highestHit = 300; // tie
    expect(applyRecords(rec, p)).toEqual([]);
    p.highestHit = 120; // lower
    expect(applyRecords(rec, p)).toEqual([]);
    expect(rec.highestHit.who).toBe("You");
  });
});

describe("scoreRows", () => {
  it("sorts by killing blows, then finishing blows, then damage", () => {
    const board: Scoreboard = {
      you: { ...emptyPlayer("You"), killingBlows: 5, finishingBlows: 2, totalDamage: 100 },
      sliq: { ...emptyPlayer("Sliq"), killingBlows: 5, finishingBlows: 4, totalDamage: 50 },
      cyan: { ...emptyPlayer("Cyan"), killingBlows: 9, finishingBlows: 0, totalDamage: 10 },
    };
    expect(scoreRows(board).map((r) => r.name)).toEqual(["Cyan", "Sliq", "You"]);
  });
});

describe("dpsOf", () => {
  it("is damage over the engagement span, guarded against a zero span", () => {
    const p = { ...emptyPlayer("You"), totalDamage: 1000, firstTs: 100, lastTs: 110 };
    expect(dpsOf(p)).toBe(100);
    const instant = { ...emptyPlayer("You"), totalDamage: 500, firstTs: 100, lastTs: 100 };
    expect(dpsOf(instant)).toBe(500); // span clamped to 1s, no divide-by-zero
  });
});
