import { describe, expect, it } from "vitest";
import {
  buildTrendSeries,
  fmtTrendValue,
  sparklineLayout,
  TREND_MIN_DURATION_SECS,
  TREND_SESSION_CAP,
  type TrendSessionInput,
} from "./trends";

function row(overrides: Partial<TrendSessionInput> = {}): TrendSessionInput {
  return {
    id: overrides.id ?? "s1",
    startedTs: overrides.startedTs ?? 0,
    durationSecs: overrides.durationSecs ?? 3600,
    xp: overrides.xp ?? 0,
    kills: overrides.kills ?? 0,
    deaths: overrides.deaths ?? 0,
    platCopper: overrides.platCopper,
    levelUps: overrides.levelUps,
  };
}

describe("buildTrendSeries", () => {
  it("computes per-hour rates for a one-hour session", () => {
    const series = buildTrendSeries([
      row({ xp: 12.5, kills: 30, deaths: 2, platCopper: 4500 }),
    ]);
    const byId = Object.fromEntries(series.map((s) => [s.id, s]));
    expect(byId.xp.points[0].value).toBeCloseTo(12.5);
    expect(byId.kills.points[0].value).toBeCloseTo(30);
    expect(byId.deaths.points[0].value).toBeCloseTo(2);
    // 4500 copper = 4.5 plat over one hour.
    expect(byId.plat.points[0].value).toBeCloseTo(4.5);
  });

  it("orders points oldest → newest regardless of input order", () => {
    const series = buildTrendSeries([
      row({ id: "new", startedTs: 2000, xp: 2 }),
      row({ id: "old", startedTs: 1000, xp: 1 }),
    ]);
    const xp = series.find((s) => s.id === "xp")!;
    expect(xp.points.map((p) => p.id)).toEqual(["old", "new"]);
    expect(xp.latest).toBeCloseTo(2);
  });

  it("gaps (null) the plat series on legacy rows without coin data", () => {
    const series = buildTrendSeries([
      row({ id: "legacy", startedTs: 1000 }),
      row({ id: "tracked", startedTs: 2000, platCopper: 1000 }),
    ]);
    const plat = series.find((s) => s.id === "plat")!;
    expect(plat.points[0].value).toBeNull();
    expect(plat.points[1].value).toBeCloseTo(1);
    expect(plat.latest).toBeCloseTo(1);
  });

  it("drops sub-minute rows and caps to the newest sessions", () => {
    const rows: TrendSessionInput[] = [
      row({ id: "blip", startedTs: 0, durationSecs: TREND_MIN_DURATION_SECS - 1 }),
    ];
    for (let i = 0; i < TREND_SESSION_CAP + 5; i++) {
      rows.push(row({ id: `s${i}`, startedTs: 1000 + i }));
    }
    const xp = buildTrendSeries(rows).find((s) => s.id === "xp")!;
    expect(xp.points.length).toBe(TREND_SESSION_CAP);
    expect(xp.points.some((p) => p.id === "blip")).toBe(false);
    expect(xp.points[0].id).toBe("s5"); // oldest kept
  });

  it("carries level-up counts onto points", () => {
    const xp = buildTrendSeries([row({ levelUps: 2 })]).find((s) => s.id === "xp")!;
    expect(xp.points[0].levelUps).toBe(2);
  });
});

describe("sparklineLayout", () => {
  it("scales from a zero baseline to the max value", () => {
    const { points } = sparklineLayout([0, 10], 100, 50, 5);
    // First point: value 0 sits on the baseline (max y).
    expect(points[0]).toEqual({ x: 5, y: 45 });
    // Max value sits at the top pad.
    expect(points[1]).toEqual({ x: 95, y: 5 });
  });

  it("breaks the path at null gaps", () => {
    const { path, points } = sparklineLayout([1, null, 1], 100, 50, 0);
    expect(points[1]).toBeNull();
    // Two disjoint segments → two M commands, no L.
    expect(path.match(/M/g)?.length).toBe(2);
    expect(path.includes("L")).toBe(false);
  });

  it("draws a connected line for consecutive values", () => {
    const { path } = sparklineLayout([1, 2, 3], 100, 50, 0);
    expect(path.match(/M/g)?.length).toBe(1);
    expect(path.match(/L/g)?.length).toBe(2);
  });

  it("centers a single point and survives an all-zero series", () => {
    const single = sparklineLayout([5], 100, 50, 0);
    expect(single.points[0]?.x).toBe(50);
    const zeros = sparklineLayout([0, 0], 100, 50, 0);
    // Flat on the baseline, not NaN.
    expect(zeros.points.every((p) => p !== null && Number.isFinite(p.y))).toBe(true);
  });
});

describe("fmtTrendValue", () => {
  it("uses fewer decimals as magnitude grows", () => {
    expect(fmtTrendValue(3.14159)).toBe("3.14");
    expect(fmtTrendValue(42.4)).toBe("42.4");
    expect(fmtTrendValue(123.4)).toBe("123");
  });
});
