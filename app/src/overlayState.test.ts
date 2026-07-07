import { describe, expect, it } from "vitest";
import { computeXpStats, type SharedXpRow } from "./overlayState";

// Rows are stored newest-first. `ts` is log-domain seconds; `at` is wall-clock
// ms used only as the "time since last gain" anchor.
function row(id: number, ts: number, percent: number, atMs: number): SharedXpRow {
  return { id, ts, percent, party: false, at: atMs };
}

describe("computeXpStats (P-XP active-time window)", () => {
  it("returns nulls for an empty session", () => {
    expect(computeXpStats([], 0)).toEqual({
      total: 0,
      perHour: null,
      perLevelHours: null,
    });
  });

  it("rates an active grind over summed inter-gain gaps", () => {
    const T = 1_000_000;
    // three 5% gains, 60s apart; asked right at the last gain.
    const rows = [
      row(3, 200, 5, T),
      row(2, 140, 5, T - 60_000),
      row(1, 80, 5, T - 120_000),
    ];
    const s = computeXpStats(rows, T);
    expect(s.total).toBe(15);
    // window = 60 + 60 = 120s -> 15% / (120/3600 h) = 450%/h.
    expect(s.perHour).toBeCloseTo(450, 5);
    expect(s.perLevelHours).toBeCloseTo(100 / 450, 5);
  });

  it("caps a long idle gap so downtime doesn't dilute the rate", () => {
    const T = 2_000_000;
    // one 5% gain, then an hour of AFK, then another 5% gain.
    const rows = [row(2, 3700, 5, T), row(1, 100, 5, T - 3_600_000)];
    const s = computeXpStats(rows, T);
    // gap 3600s clamps to 300s -> 10% / (300/3600 h) = 120%/h, NOT the
    // 10%/h an uncapped hour-long window would report.
    expect(s.perHour).toBeCloseTo(120, 5);
  });

  it("floors a single gain at a one-minute window", () => {
    const T = 3_000_000;
    const s = computeXpStats([row(1, 100, 5, T)], T);
    // window floored to 60s -> 5% / (60/3600 h) = 300%/h.
    expect(s.perHour).toBeCloseTo(300, 5);
  });

  it("decays the rate as time passes since the last gain", () => {
    const T = 4_000_000;
    const rows = [row(1, 100, 5, T)];
    const atGain = computeXpStats(rows, T).perHour!;
    const twoMinLater = computeXpStats(rows, T + 120_000).perHour!;
    expect(twoMinLater).toBeLessThan(atGain);
    // 2 min elapsed -> 5% / (120/3600 h) = 150%/h.
    expect(twoMinLater).toBeCloseTo(150, 5);
  });
});
