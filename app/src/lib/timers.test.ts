import { describe, expect, it } from "vitest";
import {
  activeTimers,
  nextRepeatStart,
  parseDuration,
  type Timer,
} from "./timers";

describe("parseDuration", () => {
  it("parses bare seconds and unit suffixes", () => {
    expect(parseDuration("90")).toBe(90);
    expect(parseDuration("90s")).toBe(90);
    expect(parseDuration("30m")).toBe(1800);
    expect(parseDuration("2h")).toBe(7200);
    expect(parseDuration("1.5m")).toBe(90);
  });

  it("parses colon clock forms", () => {
    expect(parseDuration("6:40")).toBe(400); // m:ss
    expect(parseDuration("1:02:00")).toBe(3720); // h:mm:ss
  });

  it("rejects garbage, zero, and empty", () => {
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("   ")).toBeNull();
    expect(parseDuration("0")).toBeNull();
    expect(parseDuration("abc")).toBeNull();
    expect(parseDuration("-5")).toBeNull();
  });
});

describe("nextRepeatStart (P7)", () => {
  it("re-arms one cycle forward on a fresh pop", () => {
    // started at t=1000ms, 60s cycle, popped right at due (t=61000ms).
    expect(nextRepeatStart(1000, 60, 61000)).toBe(61000);
  });

  it("skips whole cycles missed while the app was closed", () => {
    // 60s cycle from t=0; reopened at t=250s. Next start anchors to the
    // current cycle (240s), not a backlog of pops.
    expect(nextRepeatStart(0, 60, 250_000)).toBe(240_000);
    // and the resulting cycle is still in the future.
    expect(nextRepeatStart(0, 60, 250_000) + 60_000).toBeGreaterThan(250_000);
  });

  it("stays on the original cadence (no drift toward now)", () => {
    // A pop detected 400ms late must not push the anchor by 400ms.
    expect(nextRepeatStart(0, 60, 60_400)).toBe(60_000);
  });

  it("guards against a zero duration", () => {
    expect(nextRepeatStart(0, 0, 5000)).toBe(5000);
  });
});

describe("activeTimers", () => {
  const base: Timer = {
    id: "t1",
    kind: "custom",
    label: "Test",
    zoneShort: null,
    zoneLong: null,
    startedAt: 0,
    durationSecs: 100,
    varianceSecs: 0,
    repeat: false,
    ttsOnPop: true,
    announced: false,
    source: "manual",
  };

  it("computes remaining and progress mid-countdown", () => {
    const [v] = activeTimers([base], 40_000); // 40s into a 100s timer
    expect(v.remainingSecs).toBe(60);
    expect(v.progress).toBeCloseTo(0.4, 5);
    expect(v.state).toBe("calm");
  });

  it("escalates state as it nears due", () => {
    expect(activeTimers([base], 70_000)[0].state).toBe("warn"); // 30% left
    expect(activeTimers([base], 90_000)[0].state).toBe("urgent"); // 10% left
    expect(activeTimers([base], 100_000)[0].state).toBe("up");
  });

  it("keeps a due timer through the grace window, then drops it", () => {
    // due at 100s; default 30s grace.
    expect(activeTimers([base], 120_000)).toHaveLength(1);
    expect(activeTimers([base], 131_000)).toHaveLength(0);
  });

  it("sorts soonest-due first", () => {
    const later = { ...base, id: "t2", durationSecs: 200 };
    const rows = activeTimers([later, base], 10_000);
    expect(rows.map((r) => r.id)).toEqual(["t1", "t2"]);
  });
});
