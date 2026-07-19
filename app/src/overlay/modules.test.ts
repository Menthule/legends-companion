import { describe, expect, it } from "vitest";
import { listOverlayDefinitions } from "../lib/overlayRegistry";
import tauriConfig from "../../src-tauri/tauri.conf.json";
import capabilities from "../../src-tauri/capabilities/default.json";
import { OVERLAY_LABELS } from "../types";
import {
  getOverlayModule,
  getOverlayModuleByRoute,
  getOverlayModuleByWindowLabel,
  OVERLAY_MODULES,
  overlayWindowLabels,
  unmappedTriggerOverlayDefinitions,
} from "./modules";

describe("overlay module catalog", () => {
  it("has unique ids, routes, and Tauri window labels", () => {
    expect(OVERLAY_MODULES).toHaveLength(13);
    for (const values of [
      OVERLAY_MODULES.map((module) => module.id),
      OVERLAY_MODULES.map((module) => module.route),
      overlayWindowLabels(),
    ]) {
      expect(new Set(values).size).toBe(values.length);
      expect(values.every(Boolean)).toBe(true);
    }
  });

  it("resolves each supported address back to the same module", () => {
    for (const module of OVERLAY_MODULES) {
      expect(getOverlayModule(module.id)).toBe(module);
      expect(getOverlayModuleByRoute(module.route)).toBe(module);
      expect(getOverlayModuleByWindowLabel(module.windowLabel)).toBe(module);
      expect(module.displayName).not.toBe("");
      expect(module.component).toBeTruthy();
    }
    expect(getOverlayModule("unknown")).toBeUndefined();
    expect(getOverlayModuleByRoute("unknown")).toBeUndefined();
    expect(getOverlayModuleByWindowLabel("unknown")).toBeUndefined();
  });

  it("maps every trigger action definition to exactly one window module", () => {
    expect(unmappedTriggerOverlayDefinitions()).toEqual([]);
    for (const definition of listOverlayDefinitions()) {
      const matches = OVERLAY_MODULES.filter(
        (module) => module.triggerActionDefinition?.id === definition.id,
      );
      expect(matches).toHaveLength(1);
      expect(matches[0].id).toBe(definition.id);
      expect(matches[0].windowLabel).toBe(definition.windowLabel);
    }
  });

  it("matches every overlay window declared by Tauri and its capability", () => {
    const catalog = overlayWindowLabels().sort();
    const configured = tauriConfig.app.windows
      .map((window) => window.label)
      .filter((label) => label.startsWith("overlay-"))
      .sort();
    const permitted = capabilities.windows
      .filter((label) => label.startsWith("overlay-"))
      .sort();
    expect(catalog).toEqual(configured);
    expect(catalog).toEqual(permitted);
  });

  it("matches the hand-maintained types.ts OVERLAY_LABELS catalog", () => {
    // OVERLAY_LABELS seeds overlay-visibility defaults (overlayState.ts) but
    // can't be derived from OVERLAY_MODULES without an import cycle — this
    // assertion keeps the two catalogs (and their display order) in lockstep.
    expect(overlayWindowLabels()).toEqual([...OVERLAY_LABELS]);
  });

  it("gives Impact a large focal default window", () => {
    const impact = tauriConfig.app.windows.find(
      (window) => window.label === "overlay-impact",
    );
    expect(impact?.width).toBeGreaterThanOrEqual(900);
    expect(impact?.height).toBeGreaterThanOrEqual(500);
  });
});
