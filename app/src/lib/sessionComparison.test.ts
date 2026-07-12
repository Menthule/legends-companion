import { describe, expect, it } from "vitest";
import {
  compareSessions,
  type ComparisonGoal,
  type SessionComparisonSample,
} from "./sessionComparison";

function sample(
  patch: Partial<SessionComparisonSample> = {},
): SessionComparisonSample {
  return {
    id: "session",
    label: "Session",
    durationSecs: 3600,
    observations: 20,
    kills: 20,
    deaths: 1,
    xp: 10,
    aaPoints: 2,
    aaPercent: 40,
    motes: 8,
    damage: 36_000,
    combatSecs: 1800,
    activeSecs: 3000,
    damageTaken: 10_000,
    ...patch,
  };
}

function primary(goal: ComparisonGoal, current = sample(), baseline = sample()) {
  const result = compareSessions(current, baseline, goal);
  return result.metrics.find((metric) => metric.id === result.primaryMetricId)!;
}

describe("compareSessions", () => {
  it.each([
    ["xp", "xpPerHour", 10],
    ["aa", "aaPointsPerHour", 2],
    ["motes", "motesPerHour", 8],
    ["damage", "dps", 20],
  ] as const)("selects the %s goal metric", (goal, id, value) => {
    const metric = primary(goal);
    expect(metric.id).toBe(id);
    expect(metric.current).toBe(value);
  });

  it("falls back to AA percent when point progress is unavailable", () => {
    const current = sample({ aaPoints: null, aaPercent: 50 });
    const baseline = sample({ aaPoints: null, aaPercent: 25 });
    const metric = primary("aa", current, baseline);
    expect(metric.id).toBe("aaPercentPerHour");
    expect(metric.current).toBe(50);
    expect(metric.deltaRatio).toBe(1);
  });

  it("prefers a comparable AA percent pair over one-sided point data", () => {
    const metric = primary(
      "aa",
      sample({ aaPoints: 2, aaPercent: 40 }),
      sample({ id: "old", aaPoints: null, aaPercent: 20 }),
    );
    expect(metric.id).toBe("aaPercentPerHour");
    expect(metric.direction).toBe("improved");
  });

  it("uses manual AA percent when neither session earned a full AA point", () => {
    const metric = primary(
      "aa",
      sample({ aaPoints: 0, aaPercent: 45 }),
      sample({ id: "old", aaPoints: 0, aaPercent: 30 }),
    );
    expect(metric.id).toBe("aaPercentPerHour");
    expect(metric.current).toBe(45);
  });

  it("reports deltas and accounts for lower-is-better metrics", () => {
    const result = compareSessions(
      sample({ xp: 12, deaths: 0, activeSecs: 3300 }),
      sample({ id: "old", label: "Previous", xp: 10, deaths: 2, activeSecs: 2700 }),
      "xp",
    );
    const xp = result.metrics.find((metric) => metric.id === "xpPerHour")!;
    const deaths = result.metrics.find((metric) => metric.id === "deathsPerHour")!;
    const downtime = result.metrics.find((metric) => metric.id === "downtimePercent")!;
    expect(xp).toMatchObject({ delta: 2, deltaRatio: 0.2, direction: "improved" });
    expect(deaths.direction).toBe("improved");
    expect(downtime.direction).toBe("improved");
    expect(result.findings[0]).toBe("XP/hour is 20% higher than Previous.");
    expect(result.findings[1]).toContain("downtime fell 67%");
  });

  it("keeps absent history unknown and avoids percentages from a zero baseline", () => {
    const missing = primary(
      "motes",
      sample({ motes: 4 }),
      sample({ id: "old", motes: null }),
    );
    expect(missing).toMatchObject({ baseline: null, delta: null, direction: "unavailable" });

    const zero = primary(
      "motes",
      sample({ motes: 4 }),
      sample({ id: "old", motes: 0 }),
    );
    expect(zero).toMatchObject({ delta: 4, deltaRatio: null, direction: "improved" });
  });

  it.each([
    [299, 20, "insufficient", "Not enough data"],
    [600, 3, "low", "Low confidence"],
    [1800, 10, "medium", "Medium confidence"],
    [3600, 20, "high", "High confidence"],
  ] as const)("labels %s seconds and %s observations as %s", (durationSecs, observations, level, label) => {
    const result = compareSessions(
      sample({ durationSecs, observations }),
      sample({ durationSecs, observations }),
      "xp",
    );
    expect(result.confidence.level).toBe(level);
    expect(result.confidence.label).toContain(label);
    expect(result.confidence.minimumObservations).toBe(observations);
  });

  it("uses the smaller of the two samples for confidence", () => {
    const result = compareSessions(
      sample({ durationSecs: 7200, observations: 50 }),
      sample({ durationSecs: 600, observations: 3 }),
      "xp",
    );
    expect(result.confidence).toMatchObject({
      level: "low",
      shortestDurationSecs: 600,
      minimumObservations: 3,
    });
  });

  it("surfaces damage-per-use and strongest route findings", () => {
    const result = compareSessions(
      sample({
        skills: [{ name: "Tremor", damage: 6000, uses: 10 }],
        routes: [
          { label: "Befallen", durationSecs: 600, damage: 12_000 },
          { label: "Commonlands", durationSecs: 600, damage: 6_000 },
        ],
      }),
      sample({
        id: "old",
        label: "Baseline",
        skills: [{ name: "Tremor", damage: 5000, uses: 10 }],
      }),
      "damage",
    );
    expect(result.findings).toContain("Tremor damage/use improved 20%.");
    expect(result.findings).toContain("Befallen is the strongest route segment for this goal.");
  });

  it("does not call a zero-output route the strongest segment", () => {
    const result = compareSessions(
      sample({ routes: [{ label: "Idle", durationSecs: 600, damage: 0 }] }),
      sample({ id: "old" }),
      "damage",
    );
    expect(result.findings.some((finding) => finding.includes("strongest route"))).toBe(false);
  });
});
