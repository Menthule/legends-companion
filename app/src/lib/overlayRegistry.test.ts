import { describe, expect, it } from "vitest";
import type { TriggerOverlayPayload } from "../types";
import {
  alertOverlayView,
  getOverlayDefinition,
  impactOverlayView,
  listOverlayDefinitions,
  overlayDefaults,
} from "./overlayRegistry";

function payload(
  overlay: string,
  fields: Record<string, string>,
  config: Record<string, unknown> = {},
): TriggerOverlayPayload {
  return { trigger: null, overlay, fields, config };
}

describe("overlay registry", () => {
  it("publishes unique, editor-renderable definitions", () => {
    const definitions = listOverlayDefinitions();
    expect(definitions.map((definition) => definition.id)).toEqual([
      "alerts",
      "impact",
    ]);
    expect(new Set(definitions.map((definition) => definition.id)).size).toBe(
      definitions.length,
    );
    for (const definition of definitions) {
      expect(definition.label).not.toBe("");
      expect(definition.windowLabel).toMatch(/^overlay-/);
      expect(new Set(definition.fields.map((field) => field.key)).size).toBe(
        definition.fields.length,
      );
      expect(new Set(definition.config.map((field) => field.key)).size).toBe(
        definition.config.length,
      );
      for (const descriptor of [...definition.fields, ...definition.config]) {
        expect(descriptor.key).not.toBe("");
        expect(descriptor.label).not.toBe("");
        if (descriptor.type === "select") {
          expect(descriptor.options?.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("returns definitions and complete defaults for generic editors", () => {
    expect(getOverlayDefinition("alerts")?.fields[0].key).toBe("text");
    expect(getOverlayDefinition("future-overlay")).toBeUndefined();
    expect(overlayDefaults("impact")).toEqual({
      fields: { headline: "", big: "", sub: "", glyph: "" },
      config: { style: "badge", color: "", intensity: "high", durationMs: 2600 },
    });
    expect(overlayDefaults("future-overlay")).toEqual({ fields: {}, config: {} });
  });

  it("offers the loot chest as an Impact action style", () => {
    const style = getOverlayDefinition("impact")?.config.find(
      (field) => field.key === "style",
    );
    expect(style?.options).toContainEqual({
      value: "loot-chest",
      label: "Loot chest",
    });
  });
});

describe("overlay payload interpretation", () => {
  it("normalizes Alerts fields and clamps numeric presentation", () => {
    expect(
      alertOverlayView(
        payload(
          "alerts",
          { text: "  Root broke  ", icon: " ! " },
          {
            severity: "alarm",
            color: " #ff0000 ",
            fontSize: 200,
            durationMs: 100,
          },
        ),
      ),
    ).toEqual({
      text: "Root broke",
      icon: "!",
      severity: "alarm",
      color: "#ff0000",
      fontSize: 96,
      durationMs: 500,
    });
  });

  it("ignores empty Alerts messages and another overlay's payload", () => {
    expect(alertOverlayView(payload("alerts", { text: " " }))).toBeNull();
    expect(alertOverlayView(payload("impact", { text: "Not an alert" }))).toBeNull();
  });

  it("maps Impact fields/config and applies destination defaults", () => {
    expect(
      impactOverlayView(
        payload(
          "impact",
          { headline: " LEVEL UP ", big: " 42 ", sub: " Ding! " },
          { style: "level", color: "#ffd166", intensity: "medium", durationMs: 4200 },
        ),
      ),
    ).toEqual({
      event: {
        style: "level",
        headline: "LEVEL UP",
        big: "42",
        sub: "Ding!",
        glyph: undefined,
        color: "#ffd166",
        intensity: "medium",
      },
      durationMs: 4200,
    });

    expect(impactOverlayView(payload("impact", { big: "Saved" }))).toEqual({
      event: {
        style: "badge",
        headline: undefined,
        big: "Saved",
        sub: undefined,
        glyph: undefined,
        color: undefined,
        intensity: "high",
      },
      durationMs: 2600,
    });
  });
});
