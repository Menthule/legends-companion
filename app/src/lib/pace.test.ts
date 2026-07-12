import { describe, expect, it } from "vitest";
import {
  PACE_HISTORY_LIMIT,
  PACE_STATE_EVENT,
  PACE_STATE_KEY,
  applyPaceEvent,
  completePaceSample,
  computeRollingPaceRate,
  emptyPaceState,
  loadPaceState,
  lootMetricMatches,
  normalizePaceState,
  paceSnapshot,
  pausePaceSample,
  resumePaceSample,
  savePaceState,
  startPaceSample,
  type PaceStorage,
} from "./pace";

const HOUR = 3_600_000;

function running(startAaPercent: number | null = 20) {
  return startPaceSample(emptyPaceState(), {
    nowMs: 1_000,
    aaStartPercent: startAaPercent,
    id: "sample",
  });
}

describe("pace sample", () => {
  it("calculates XP, automatic AA rollover, and mote rates on one clock", () => {
    let state = running(70);
    state = applyPaceEvent(state, {
      kind: "xp",
      percent: 12.5,
      atMs: 2_000,
    });
    state = applyPaceEvent(state, {
      kind: "aa-point",
      points: 1,
      atMs: 3_000,
    });
    state = applyPaceEvent(state, {
      kind: "loot",
      item: "Mote of Minor Potential",
      quantity: 4,
      looter: "You",
      atMs: 4_000,
    });
    state = completePaceSample(state, {
      nowMs: 1_000 + HOUR / 2,
      aaEndPercent: 20,
    });

    const snapshot = paceSnapshot(
      state.history[0],
      state.lootMetrics,
      1_000 + HOUR / 2,
    );
    expect(snapshot.elapsedMs).toBe(HOUR / 2);
    expect(snapshot.xpPerHour).toBe(25);
    expect(snapshot.aaPointsPerHour).toBe(2);
    expect(snapshot.aaPercentGained).toBe(50);
    expect(snapshot.aaPercentPerHour).toBe(100);
    expect(snapshot.loot[0]).toEqual({
      metricId: "motes",
      label: "Motes",
      total: 4,
      perHour: 8,
    });
  });

  it("excludes paused time and ignores events while paused", () => {
    let state = running();
    state = pausePaceSample(state, 1_000 + HOUR / 4);
    const unchanged = applyPaceEvent(state, {
      kind: "xp",
      percent: 99,
      atMs: 1_000 + HOUR / 2,
    });
    expect(unchanged).toBe(state);
    state = resumePaceSample(state, 1_000 + (3 * HOUR) / 4);
    state = applyPaceEvent(state, {
      kind: "xp",
      percent: 10,
      atMs: 1_000 + (3 * HOUR) / 4,
    });
    state = completePaceSample(state, { nowMs: 1_000 + HOUR });
    expect(paceSnapshot(state.history[0], state.lootMetrics, 0).elapsedMs).toBe(HOUR / 2);
    expect(paceSnapshot(state.history[0], state.lootMetrics, 0).xpPerHour).toBe(20);
  });

  it("rejects catch-up events and events older than the sample", () => {
    let state = running();
    const events = [
      { kind: "xp" as const, percent: 5, atMs: 999 },
      { kind: "xp" as const, percent: 5, atMs: 2_000, replayed: true },
    ];
    for (const event of events) state = applyPaceEvent(state, event);
    expect(state.active?.xpPercent).toBe(0);
  });

  it("reports point rate without inventing fractional AA progress", () => {
    let state = running(null);
    state = applyPaceEvent(state, { kind: "aa-point", points: 2, atMs: 2_000 });
    const snapshot = paceSnapshot(state.active!, state.lootMetrics, 1_000 + HOUR);
    expect(snapshot.aaPointsPerHour).toBe(2);
    expect(snapshot.aaPercentGained).toBeNull();
    expect(snapshot.aaPercentPerHour).toBeNull();
  });

  it("caps completed history", () => {
    let state = emptyPaceState();
    for (let i = 0; i < PACE_HISTORY_LIMIT + 3; i++) {
      state = startPaceSample(state, { nowMs: i * 100 + 1, id: String(i) });
      state = completePaceSample(state, { nowMs: i * 100 + 2 });
    }
    expect(state.history).toHaveLength(PACE_HISTORY_LIMIT);
    expect(state.history[0].id).toBe(String(PACE_HISTORY_LIMIT + 2));
  });
});

describe("rolling pace rate", () => {
  it("uses the common active-time window for newest-first observations", () => {
    const nowMs = 1_000_000;
    const result = computeRollingPaceRate(
      [
        { sourceTimeSecs: 200, value: 5, observedAtMs: nowMs },
        { sourceTimeSecs: 140, value: 5, observedAtMs: nowMs - 60_000 },
        { sourceTimeSecs: 80, value: 5, observedAtMs: nowMs - 120_000 },
      ],
      nowMs,
    );
    expect(result).toEqual({ total: 15, count: 3, perHour: 450 });
  });

  it("caps idle gaps and supports non-XP values and custom windows", () => {
    const result = computeRollingPaceRate(
      [
        { sourceTimeSecs: 1_000, value: 4 },
        { sourceTimeSecs: 100, value: 2 },
      ],
      0,
      { windowSecs: 1_000, idleCapSecs: 300 },
    );
    expect(result.total).toBe(6);
    expect(result.count).toBe(2);
    expect(result.perHour).toBe(72);
  });
});

describe("configurable loot metrics", () => {
  it("matches mote tiers for the player by default", () => {
    const metric = emptyPaceState().lootMetrics[0];
    expect(lootMetricMatches(metric, "Mote of Lesser Potential", "You")).toBe(true);
    expect(lootMetricMatches(metric, "Mote of Minor Potential", "Friend")).toBe(false);
    expect(lootMetricMatches(metric, "Crystallized Potential", "You")).toBe(false);
  });

  it("supports exact and contains matching without hardcoded item parsing", () => {
    const base = emptyPaceState().lootMetrics[0];
    expect(
      lootMetricMatches(
        { ...base, owner: "anyone", match: { kind: "exact", value: "Blue Diamond" } },
        "blue diamond",
        "Friend",
      ),
    ).toBe(true);
    expect(
      lootMetricMatches(
        { ...base, match: { kind: "contains", value: "silk" } },
        "Spider Silk",
        "You",
      ),
    ).toBe(true);
  });

  it("treats an invalid user regex as a non-match", () => {
    const metric = emptyPaceState().lootMetrics[0];
    expect(
      lootMetricMatches({ ...metric, match: { kind: "regex", value: "[" } }, "Mote", "You"),
    ).toBe(false);
  });
});

describe("pace persistence", () => {
  it("round-trips state using the stable storage key", () => {
    const values = new Map<string, string>();
    const storage: PaceStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    };
    const state = running(42);
    savePaceState(state, storage);
    expect(values.has(PACE_STATE_KEY)).toBe(true);
    expect(loadPaceState(storage)).toEqual(state);
  });

  it("falls back safely for corrupt or incompatible state", () => {
    expect(normalizePaceState(null)).toEqual(emptyPaceState());
    expect(normalizePaceState({ version: 999 })).toEqual(emptyPaceState());
  });

  it("exports a stable cross-window event name", () => {
    expect(PACE_STATE_EVENT).toBe("eqlogs:pace-state-changed");
  });
});
