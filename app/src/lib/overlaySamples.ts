// Sample timer bars shown in the timer overlays while UNLOCKED and empty, so
// arranging over the game isn't done against a bare dashed box (P10). Mirrors
// the "waiting" placeholders the Meter/XP overlays already show. Never shown
// while locked / in play.

import type { TimerView } from "../hooks";
import type { TimerLane } from "../types";

function bar(name: string, lane: TimerLane, frac: number, warn = false): TimerView {
  return {
    name,
    durationSecs: 300,
    left: Math.round(300 * frac),
    frac,
    warn,
    expired: false,
    pending: false,
    lane,
  };
}

/** Two representative bars for a timer overlay's lane. */
export function sampleTimers(lane: "buff" | "on-others" | "enemy"): TimerView[] {
  switch (lane) {
    case "buff":
      return [bar("Clarity", "buff", 0.68), bar("Spirit of Wolf", "buff", 0.12, true)];
    case "on-others":
      return [
        bar("Regrowth — Vibarn", "on-others", 0.55),
        bar("Aegolism — Sliq", "on-others", 0.28),
      ];
    case "enemy":
      return [
        bar("Mesmerize — a kobold shaman", "enemy", 0.42),
        bar("Darkness — a kobold shaman", "enemy", 0.14, true),
      ];
  }
}
