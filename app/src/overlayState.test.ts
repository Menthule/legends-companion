import { describe, expect, it } from "vitest";
import {
  computeLevelEta,
  computeXpStats,
  type SharedXpRow,
  type XpSession,
} from "./overlayState";

// Rows are stored newest-first. `ts` is log-domain seconds; `at` is wall-clock
// ms used only as the "time since last gain" anchor.
function row(id: number, ts: number, percent: number, atMs: number): SharedXpRow {
  return { id, ts, percent, party: false, at: atMs };
}

// A session whose cumulative total matches its rows (the common case).
function sess(rows: SharedXpRow[]): XpSession {
  return {
    total: rows.reduce((s, r) => s + r.percent, 0),
    count: rows.length,
    rows,
  };
}

describe("computeXpStats (P-XP active-time window)", () => {
  it("returns nulls for an empty session", () => {
    expect(computeXpStats(sess([]), 0)).toEqual({
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
    const s = computeXpStats(sess(rows), T);
    expect(s.total).toBe(15);
    // window = 60 + 60 = 120s -> 15% / (120/3600 h) = 450%/h.
    expect(s.perHour).toBeCloseTo(450, 5);
    expect(s.perLevelHours).toBeCloseTo(100 / 450, 5);
  });

  it("caps a long idle gap so downtime doesn't dilute the rate", () => {
    const T = 2_000_000;
    // one 5% gain, then an hour of AFK, then another 5% gain.
    const rows = [row(2, 3700, 5, T), row(1, 100, 5, T - 3_600_000)];
    const s = computeXpStats(sess(rows), T);
    // gap 3600s clamps to 300s -> 10% / (300/3600 h) = 120%/h, NOT the
    // 10%/h an uncapped hour-long window would report.
    expect(s.perHour).toBeCloseTo(120, 5);
  });

  it("floors a single gain at a one-minute window", () => {
    const T = 3_000_000;
    const s = computeXpStats(sess([row(1, 100, 5, T)]), T);
    // window floored to 60s -> 5% / (60/3600 h) = 300%/h.
    expect(s.perHour).toBeCloseTo(300, 5);
  });

  it("decays the rate as time passes since the last gain", () => {
    const T = 4_000_000;
    const rows = [row(1, 100, 5, T)];
    const atGain = computeXpStats(sess(rows), T).perHour!;
    const twoMinLater = computeXpStats(sess(rows), T + 120_000).perHour!;
    expect(twoMinLater).toBeLessThan(atGain);
    // 2 min elapsed -> 5% / (120/3600 h) = 150%/h.
    expect(twoMinLater).toBeCloseTo(150, 5);
  });

  it("reports the cumulative total, not the capped rows sum (P21)", () => {
    // A marathon session: 250% earned over 50 gains, but only the 2 most
    // recent rows survived the rate-window cap. The total must reflect the
    // cumulative 250, not the 10 the surviving rows sum to.
    const T = 5_000_000;
    const rows = [row(50, 200, 5, T), row(49, 140, 5, T - 60_000)];
    const s = computeXpStats({ total: 250, count: 50, rows }, T);
    expect(s.total).toBe(250);
    // The rate window still comes from the surviving rows.
    expect(s.perHour).toBeCloseTo(600, 5); // 10% / (60/3600 h)
  });
});

describe("computeLevelEta (P9)", () => {
  it("derives kills and minutes to level from progress + rate", () => {
    // 60% into the level; 200% earned over 50 kills => 4%/kill; rate 120%/h.
    const eta = computeLevelEta({ total: 200, count: 50, rows: [] }, 60, 120);
    expect(eta.toLevelPct).toBe(40);
    expect(eta.avgPerKill).toBeCloseTo(4, 5);
    expect(eta.kills).toBe(10); // ceil(40 / 4)
    expect(eta.mins).toBeCloseTo(20, 5); // 40 / 120 * 60
  });

  it("returns null estimates without a rate or any gains", () => {
    expect(
      computeLevelEta({ total: 0, count: 0, rows: [] }, 50, null),
    ).toMatchObject({ kills: null, mins: null, avgPerKill: null });
  });

  it("clamps progress over 100 and floors the remainder at 0", () => {
    const eta = computeLevelEta({ total: 100, count: 10, rows: [] }, 150, 60);
    expect(eta.progressPct).toBe(100);
    expect(eta.toLevelPct).toBe(0);
    expect(eta.kills).toBe(0);
    expect(eta.mins).toBe(0);
  });
});
