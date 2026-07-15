import { describe, expect, it } from "vitest";
import {
  parseTrainingDuration,
  romanRankValue,
  timerTrainingStatus,
} from "./timerTraining";

describe("ranked timer training helpers", () => {
  it("parses seconds and minute durations", () => {
    expect(parseTrainingDuration("102")).toBe(102);
    expect(parseTrainingDuration("1:42")).toBe(102);
    expect(parseTrainingDuration("1:75")).toBeNull();
    expect(parseTrainingDuration("soon")).toBeNull();
  });

  it("orders roman spell ranks numerically", () => {
    expect(romanRankValue("VI")).toBe(6);
    expect(romanRankValue("VII")).toBe(7);
    expect(romanRankValue("IX")).toBe(9);
  });

  it("flags a materially longer observed duration", () => {
    expect(
      timerTrainingStatus(
        { durationSecs: 72, castTimeSecs: 3, source: "default" },
        {
          rank: "VII",
          castsSeen: 5,
          cleanSamples: 4,
          rejectedSamples: 1,
          observedMinSecs: 101,
          observedMaxSecs: 103,
          suggestedDurationSecs: 102,
          castSamples: 4,
          observedCastMinSecs: 2,
          observedCastMaxSecs: 3,
          suggestedCastTimeSecs: 2,
          configuredDurationSecs: 72,
          configuredCastTimeSecs: 3,
          durationDeltaSecs: 30,
          castTimeDeltaSecs: -1,
          status: "needs-update",
          needsUpdate: true,
          confidence: "good",
          reason: "consistent",
          canApply: true,
          samples: [],
        },
      ),
    ).toBe("drift");
  });
});
