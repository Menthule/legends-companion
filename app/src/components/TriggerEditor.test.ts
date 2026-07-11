import { describe, expect, it } from "vitest";
import type { TriggerAction } from "../types";
import { actionsFromRows, rowsFromActions } from "./TriggerEditor";

function roundTrip(actions: TriggerAction[]): TriggerAction[] {
  const result = actionsFromRows(rowsFromActions(actions));
  expect(typeof result).not.toBe("string");
  return result as TriggerAction[];
}

describe("trigger action editor codec", () => {
  it("preserves advanced timer fields that are not shown in the compact editor", () => {
    const actions: TriggerAction[] = [
      {
        StartTimer: {
          name: "Root - ${1}",
          duration_secs: 90,
          warn_at_secs: 12,
          duration_formula: 7,
          duration_cap_ticks: 25,
          lane: "enemy",
          cast_time_secs: 3,
          mode: "start-new-instance",
          repeat_secs: 90,
          stopwatch: true,
          warn_text: "${1} nearly free",
          expire_text: "${1} free",
          warn_sound: "warning.wav",
          expire_sound: "danger.wav",
        },
      },
    ];

    expect(roundTrip(actions)).toEqual(actions);
  });

  it("migrates legacy visual actions to generic overlay actions", () => {
    const result = roundTrip([
      { DisplayText: { template: "${1} rooted" } },
      {
        Impact: {
          style: "slash",
          headline: "FINISHING BLOW",
          big: "${2}",
          sub: "${1}",
          color: "#ffb454",
        },
      },
    ]);

    expect(result[0]).toMatchObject({
      Overlay: { overlay: "alerts", fields: { text: "${1} rooted" } },
    });
    expect(result[1]).toMatchObject({
      Overlay: {
        overlay: "impact",
        fields: { headline: "FINISHING BLOW", big: "${2}", sub: "${1}" },
        config: { style: "slash", color: "#ffb454" },
      },
    });
  });

  it("preserves repeated overlay destinations for independent fan-out", () => {
    const actions: TriggerAction[] = [
      { Speak: { template: "rooted" } },
      {
        Overlay: {
          overlay: "alerts",
          fields: { text: "${1} rooted" },
          config: { severity: "warn" },
        },
      },
      {
        Overlay: {
          overlay: "raid-calls",
          fields: { target: "${1}", effect: "root" },
          config: { lane: "crowd-control", nested: { priority: 2 } },
        },
      },
    ];

    expect(roundTrip(actions)).toEqual(actions);
  });

  it("preserves empty and nested data for an overlay not installed in this build", () => {
    const actions: TriggerAction[] = [
      {
        Overlay: {
          overlay: "future-raid-grid",
          fields: { title: "Incoming", optional: "" },
          config: { enabled: false, count: 0, nested: { lanes: ["north"] } },
        },
      },
    ];

    expect(roundTrip(actions)).toEqual(actions);
  });

  it("opens the first action and collapses later actions initially", () => {
    const rows = rowsFromActions([
      { Speak: { template: "move" } },
      { CancelTimer: { name: "danger" } },
    ]);

    expect(rows.map((row) => row.expanded)).toEqual([true, false]);
  });
});
