import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import {
  getOverlayDefinition,
  listOverlayDefinitions,
  type OverlayDefinition,
} from "../lib/overlayRegistry";
import {
  OVERLAY_ALERTS,
  OVERLAY_BUFFS,
  OVERLAY_IMPACT,
  OVERLAY_METER,
  OVERLAY_ONOTHERS,
  OVERLAY_RESPAWN,
  OVERLAY_SCOREBOARD,
  OVERLAY_STANCE,
  OVERLAY_TARGET,
  OVERLAY_XP,
} from "../types";

export interface OverlayModule {
  /** Stable app-level id. Trigger-capable modules use this as their action id. */
  id: string;
  /** Value accepted by the `?overlay=` webview route. */
  route: string;
  /** Tauri window label used by show/hide/arrange commands. */
  windowLabel: string;
  displayName: string;
  description: string;
  component: LazyExoticComponent<ComponentType>;
  /** Generic trigger action schema, when this overlay accepts Overlay actions. */
  triggerActionDefinition?: OverlayDefinition;
  /** Optional destination-neutral preview events for Settings. */
  preview?: readonly {
    event: string;
    payload: unknown;
    delayMs?: number;
  }[];
}

function triggerDefinition(id: string): OverlayDefinition | undefined {
  return getOverlayDefinition(id);
}

/** Central overlay catalog. Component imports stay lazy so the dashboard window
 * does not eagerly evaluate or bundle every overlay implementation. */
export const OVERLAY_MODULES: readonly OverlayModule[] = [
  {
    id: "alerts",
    route: "alerts",
    windowLabel: OVERLAY_ALERTS,
    displayName: "Alerts",
    description: "stacked text alerts",
    component: lazy(() => import("./OverlayAlerts")),
    triggerActionDefinition: triggerDefinition("alerts"),
  },
  {
    id: "buffs",
    route: "buffs",
    windowLabel: OVERLAY_BUFFS,
    displayName: "Buff timers",
    description: "your active buffs",
    component: lazy(() => import("./OverlayBuffs")),
  },
  {
    id: "onothers",
    route: "onothers",
    windowLabel: OVERLAY_ONOTHERS,
    displayName: "Buffs on others",
    description: "buffs you cast on other players",
    component: lazy(() => import("./OverlayOnOthers")),
  },
  {
    id: "target",
    route: "target",
    windowLabel: OVERLAY_TARGET,
    displayName: "Target effects",
    description: "your effects on enemies",
    component: lazy(() => import("./OverlayTarget")),
  },
  {
    id: "meter",
    route: "meter",
    windowLabel: OVERLAY_METER,
    displayName: "DPS meter",
    description: "live top-five combat meter",
    component: lazy(() => import("./OverlayMeter")),
  },
  {
    id: "xp",
    route: "xp",
    windowLabel: OVERLAY_XP,
    displayName: "XP rate",
    description: "session XP pace and ETA",
    component: lazy(() => import("./OverlayXp")),
  },
  {
    id: "stance",
    route: "stance",
    windowLabel: OVERLAY_STANCE,
    displayName: "Stance & invocation",
    description: "current martial stance and invocation",
    component: lazy(() => import("./OverlayStance")),
  },
  {
    id: "respawn",
    route: "respawn",
    windowLabel: OVERLAY_RESPAWN,
    displayName: "Timers",
    description: "respawn and custom countdowns",
    component: lazy(() => import("./OverlayRespawn")),
  },
  {
    id: "impact",
    route: "impact",
    windowLabel: OVERLAY_IMPACT,
    displayName: "Impact",
    description: "animated exceptional moments",
    component: lazy(() => import("./OverlayImpact")),
    triggerActionDefinition: triggerDefinition("impact"),
    preview: [
      {
        event: "impact",
        payload: {
          style: "slash",
          headline: "FINISHING BLOW",
          big: "1,234",
          sub: "You -> a training dummy",
        },
      },
      {
        event: "impact",
        delayMs: 1700,
        payload: {
          style: "medal",
          headline: "AA PROC",
          big: "Divine Intervention",
          sub: "saved you from death",
          glyph: "*",
        },
      },
    ],
  },
  {
    id: "scoreboard",
    route: "scoreboard",
    windowLabel: OVERLAY_SCOREBOARD,
    displayName: "Scoreboard",
    description: "party killing blows, biggest hits, and DPS",
    component: lazy(() => import("./OverlayScoreboard")),
  },
] as const;

export function getOverlayModule(id: string): OverlayModule | undefined {
  return OVERLAY_MODULES.find((module) => module.id === id);
}

export function getOverlayModuleByRoute(route: string): OverlayModule | undefined {
  return OVERLAY_MODULES.find((module) => module.route === route);
}

export function getOverlayModuleByWindowLabel(
  windowLabel: string,
): OverlayModule | undefined {
  return OVERLAY_MODULES.find((module) => module.windowLabel === windowLabel);
}

export function overlayWindowLabels(): string[] {
  return OVERLAY_MODULES.map((module) => module.windowLabel);
}

/** Registry integrity helper used by tests and diagnostics. */
export function unmappedTriggerOverlayDefinitions(): readonly OverlayDefinition[] {
  const moduleIds = new Set(
    OVERLAY_MODULES.filter((module) => module.triggerActionDefinition).map(
      (module) => module.id,
    ),
  );
  return listOverlayDefinitions().filter(
    (definition) => !moduleIds.has(definition.id),
  );
}
