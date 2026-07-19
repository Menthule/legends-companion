import { describe, expect, it } from "vitest";
import {
  computeLevelEta,
  computeXpStats,
  shouldShowOverlayWindow,
  type SharedXpRow,
  type XpSession,
} from "./overlayState";

describe("overlay window visibility", () => {
  it("keeps disabled overlays hidden while locked", () => {
    expect(shouldShowOverlayWindow(false, false)).toBe(false);
  });

  it("shows enabled overlays and reveals disabled overlays while arranging", () => {
    expect(shouldShowOverlayWindow(true, false)).toBe(true);
    expect(shouldShowOverlayWindow(false, true)).toBe(true);
  });
});

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
      count: 0,
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
    expect(s.count).toBe(3);
    // window = 60 + 60 = 120s -> 15% / (120/3600 h) = 450%/h.
    expect(s.perHour).toBeCloseTo(450, 5);
    expect(s.perLevelHours).toBeCloseTo(100 / 450, 5);
  });

  it("drops an idle-gap gain outside the recent window", () => {
    const T = 2_000_000;
    // one 5% gain, then an hour of AFK, then another 5% gain.
    const rows = [row(2, 3700, 5, T), row(1, 100, 5, T - 3_600_000)];
    const s = computeXpStats(sess(rows), T);
    expect(s.total).toBe(5);
    expect(s.count).toBe(1);
    expect(s.perHour).toBeNull();
    expect(s.perLevelHours).toBeNull();
  });

  it("does not estimate rate from a single gain", () => {
    const T = 3_000_000;
    const s = computeXpStats(sess([row(1, 100, 5, T)]), T);
    expect(s.total).toBe(5);
    expect(s.count).toBe(1);
    expect(s.perHour).toBeNull();
    expect(s.perLevelHours).toBeNull();
  });

  it("decays the rate as time passes since the last gain", () => {
    const T = 4_000_000;
    const rows = [row(2, 160, 5, T), row(1, 100, 5, T - 60_000)];
    const atGain = computeXpStats(sess(rows), T).perHour!;
    const twoMinLater = computeXpStats(sess(rows), T + 120_000).perHour!;
    expect(twoMinLater).toBeLessThan(atGain);
    // 60s inter-gain + 120s since last gain -> 10% / (180/3600 h).
    expect(twoMinLater).toBeCloseTo(200, 5);
  });

  it("reports recent-window total, not the all-session total", () => {
    // A marathon session: 250% earned over 50 gains, but the visible/rate
    // stats intentionally reflect the recent 10-minute grind.
    const T = 5_000_000;
    const rows = [row(50, 200, 5, T), row(49, 140, 5, T - 60_000)];
    const s = computeXpStats({ total: 250, count: 50, rows }, T);
    expect(s.total).toBe(10);
    expect(s.count).toBe(2);
    expect(s.perHour).toBeCloseTo(600, 5); // 10% / (60/3600 h)
  });

  it("drops gains older than the 10 minute window", () => {
    const T = 6_000_000;
    const rows = [
      row(3, 1000, 5, T),
      row(2, 700, 5, T - 300_000),
      row(1, 300, 5, T - 700_000),
    ];
    const s = computeXpStats(sess(rows), T);
    expect(s.total).toBe(10);
    expect(s.count).toBe(2);
    expect(s.perHour).toBeCloseTo(120, 5); // 10% over 5 minutes.
  });

  it("returns no rate when the newest gain is outside the 10 minute window", () => {
    const T = 7_000_000;
    const s = computeXpStats(sess([row(1, 100, 5, T - 700_000)]), T);
    expect(s).toEqual({
      total: 0,
      count: 0,
      perHour: null,
      perLevelHours: null,
    });
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
