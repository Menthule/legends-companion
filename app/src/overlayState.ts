// Persisted overlay visibility, shared by the top-bar toggle and the
// per-overlay switches in Settings. Overlays default to ON.

import { OVERLAY_LABELS } from "./types";

const KEY = "eqlogs.overlays.visible";

export type OverlayVisibility = Record<string, boolean>;

export function loadOverlayVisibility(): OverlayVisibility {
  const defaults: OverlayVisibility = {};
  for (const label of OVERLAY_LABELS) defaults[label] = true;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults;
    return { ...defaults, ...(JSON.parse(raw) as OverlayVisibility) };
  } catch {
    return defaults;
  }
}

export function saveOverlayVisibility(v: OverlayVisibility): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    // localStorage unavailable — visibility just won't persist.
  }
}

// ---------------------------------------------------------------------------
// Meter overlay "my sources" section (item 15 overlay companion). The locked
// overlay is click-through, so the toggle lives in Settings; the overlay
// window picks changes up via the cross-window "storage" event.
// ---------------------------------------------------------------------------

/** localStorage key — exported so the overlay can filter "storage" events. */
export const METER_SOURCES_KEY = "eqlogs.overlay.meterSources";

/** Whether the meter overlay shows the player's top damage sources. */
export function loadMeterSources(): boolean {
  try {
    return localStorage.getItem(METER_SOURCES_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveMeterSources(on: boolean): void {
  try {
    localStorage.setItem(METER_SOURCES_KEY, on ? "1" : "0");
  } catch {
    // localStorage unavailable — the toggle just won't persist.
  }
}
