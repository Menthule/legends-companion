import { describe, expect, it } from "vitest";
import {
  buildLevelTimeline,
  careerTrendInputs,
  fmtLogDate,
  fmtLogDateTime,
  fmtObservedDrops,
  lootDisposition,
  maxLevelSecs,
} from "./career";
import type { CareerLevelUp, CareerSession } from "../types";

function up(overrides: Partial<CareerLevelUp> = {}): CareerLevelUp {
  return {
    id: overrides.id ?? 1,
    ts: overrides.ts ?? 0,
    level: overrides.level ?? 10,
    sessionId: overrides.sessionId ?? null,
  };
}

describe("buildLevelTimeline", () => {
  it("returns rows sorted by ts with per-level deltas", () => {
    const rows = buildLevelTimeline([
      up({ id: 3, ts: 10_000, level: 12 }),
      up({ id: 1, ts: 1_000, level: 10 }),
      up({ id: 2, ts: 4_000, level: 11 }),
    ]);
    expect(rows.map((r) => r.level)).toEqual([10, 11, 12]);
    // First observed ding: time-in-previous-level is unknowable.
    expect(rows[0].secsInPrev).toBeNull();
    expect(rows[1].secsInPrev).toBe(3_000);
    expect(rows[2].secsInPrev).toBe(6_000);
  });

  it("handles empty input and single dings", () => {
    expect(buildLevelTimeline([])).toEqual([]);
    const one = buildLevelTimeline([up({ ts: 42, level: 7 })]);
    expect(one).toHaveLength(1);
    expect(one[0].secsInPrev).toBeNull();
  });

  it("breaks ts ties by level and never yields negative deltas", () => {
    const rows = buildLevelTimeline([
      up({ id: 2, ts: 5_000, level: 21 }),
      up({ id: 1, ts: 5_000, level: 20 }),
    ]);
    expect(rows.map((r) => r.level)).toEqual([20, 21]);
    expect(rows[1].secsInPrev).toBe(0);
  });

  it("maxLevelSecs scales off the longest known level", () => {
    const rows = buildLevelTimeline([
      up({ id: 1, ts: 0, level: 10 }),
      up({ id: 2, ts: 7_200, level: 11 }),
      up({ id: 3, ts: 10_800, level: 12 }),
    ]);
    expect(maxLevelSecs(rows)).toBe(7_200);
    expect(maxLevelSecs([])).toBe(0);
  });
});

describe("careerTrendInputs", () => {
  it("maps career sessions onto lib/trends inputs (log-domain ms)", () => {
    const session: CareerSession = {
      id: 7,
      startTs: 1_700_000_000,
      endTs: 1_700_003_600,
      durationSecs: 3_600,
      zones: ["Befallen"],
      kills: 30,
      deaths: 2,
      xpPercent: 12.5,
      partyXpPercent: 4.5,
      levelUps: 1,
      endLevel: 14,
      aaPoints: 0,
      coinCopper: 4_500,
      skillUps: 3,
      lootCount: 9,
      sourceFile: "eqlog_Nyasha_legends.txt",
    };
    const [row] = careerTrendInputs([session]);
    expect(row.id).toBe("7");
    expect(row.startedTs).toBe(1_700_000_000_000);
    expect(row.durationSecs).toBe(3_600);
    expect(row.xp).toBeCloseTo(12.5);
    expect(row.kills).toBe(30);
    expect(row.deaths).toBe(2);
    expect(row.platCopper).toBe(4_500);
    expect(row.levelUps).toBe(1);
  });
});

describe("log-domain date labels", () => {
  it("formats with UTC getters (no host-offset shift)", () => {
    // 2026-06-12 19:42:07 UTC — log-domain encoding of that wall clock.
    const ts = Date.UTC(2026, 5, 12, 19, 42, 7) / 1000;
    expect(fmtLogDateTime(ts)).toMatch(/^Jun 12(, 2026)? · 19:42$/);
  });

  it("adds the year only when it is not the current year", () => {
    const past = Date.UTC(2001, 0, 3, 8, 0, 0) / 1000;
    expect(fmtLogDate(past)).toBe("Jan 3, 2001");
  });
});

describe("ledger labels", () => {
  it("distinguishes kept / sold-free / sold-for-coin", () => {
    expect(lootDisposition({ soldForCopper: null })).toBe("kept");
    expect(lootDisposition({ soldForCopper: 0 })).toBe("sold · free");
    expect(lootDisposition({ soldForCopper: 129 })).toBe("sold · 1g 2s 9c");
  });

  it("labels observed drops as counts, never a rate", () => {
    expect(fmtObservedDrops(12, 87)).toBe("12× in 87 kills");
    expect(fmtObservedDrops(1, 1)).toBe("1× in 1 kill");
    expect(fmtObservedDrops(12, 87)).not.toContain("%");
  });
});
