import {
  OVERLAY_ALERTS,
  OVERLAY_IMPACT,
  type ImpactEvent,
  type OverlayId,
  type TriggerOverlayPayload,
} from "../types";

export type OverlayControlType =
  | "text"
  | "textarea"
  | "select"
  | "color"
  | "number"
  | "icon";

export interface OverlayOption {
  value: string;
  label: string;
}

interface OverlayDescriptorBase {
  key: string;
  label: string;
  type: OverlayControlType;
  description?: string;
  placeholder?: string;
  options?: readonly OverlayOption[];
}

export interface OverlayFieldDescriptor extends OverlayDescriptorBase {
  required?: boolean;
  default: string;
}

export interface OverlayConfigDescriptor extends OverlayDescriptorBase {
  default: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  /** Divide stored numeric values by this factor for friendlier editor units. */
  inputScale?: number;
}

export interface OverlayDefinition {
  id: OverlayId;
  label: string;
  description: string;
  /** Tauri window label. This remains separate from the stable action id. */
  windowLabel: string;
  fields: readonly OverlayFieldDescriptor[];
  config: readonly OverlayConfigDescriptor[];
}

const SEVERITY_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "info", label: "Quiet" },
  { value: "warn", label: "Warn" },
  { value: "alarm", label: "Loud" },
] as const;

const IMPACT_STYLE_OPTIONS = [
  { value: "slash", label: "Slash" },
  { value: "big-number", label: "Big number" },
  { value: "level", label: "Level" },
  { value: "badge", label: "Badge" },
  { value: "medal", label: "Medal" },
  { value: "achievement-seal", label: "Achievement seal" },
  { value: "loot-chest", label: "Loot chest" },
  { value: "monster-rip", label: "Monster RIP" },
  { value: "slay-undead", label: "Slay Undead" },
] as const;

const IMPACT_INTENSITY_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
] as const;

const DEFINITIONS: readonly OverlayDefinition[] = [
  {
    id: "alerts",
    label: "Alerts",
    description: "Short stacked messages that remain readable over combat.",
    windowLabel: OVERLAY_ALERTS,
    fields: [
      {
        key: "text",
        label: "Text",
        type: "textarea",
        description: "The message shown in the alert stack.",
        placeholder: "Root: ${target}",
        required: true,
        default: "",
      },
      {
        key: "icon",
        label: "Icon",
        type: "icon",
        description: "Optional short glyph shown before the message.",
        placeholder: "!",
        default: "",
      },
      {
        key: "value",
        label: "Value",
        type: "text",
        description: "Optional result shown separately from the message.",
        placeholder: "${1}",
        default: "",
      },
    ],
    config: [
      {
        key: "severity",
        label: "Loudness",
        type: "select",
        options: SEVERITY_OPTIONS,
        default: "info",
      },
      {
        key: "color",
        label: "Text color",
        type: "color",
        default: "",
      },
      {
        key: "fontSize",
        label: "Text size",
        type: "number",
        description: "Pixels; blank uses the overlay setting.",
        min: 10,
        max: 96,
        step: 1,
        default: "",
      },
      {
        key: "durationMs",
        label: "Visible time (seconds)",
        type: "number",
        description: "Seconds before the alert fades.",
        min: 500,
        max: 60_000,
        step: 100,
        inputScale: 1000,
        default: "",
      },
    ],
  },
  {
    id: "impact",
    label: "Impact",
    description: "A single animated focal moment for exceptional events.",
    windowLabel: OVERLAY_IMPACT,
    fields: [
      {
        key: "headline",
        label: "Headline",
        type: "text",
        placeholder: "FINISHING BLOW",
        default: "",
      },
      {
        key: "big",
        label: "Focal text",
        type: "text",
        placeholder: "${amount}",
        required: true,
        default: "",
      },
      {
        key: "sub",
        label: "Detail",
        type: "text",
        placeholder: "${target}",
        default: "",
      },
      {
        key: "glyph",
        label: "Glyph",
        type: "icon",
        placeholder: "*",
        default: "",
      },
    ],
    config: [
      {
        key: "style",
        label: "Style",
        type: "select",
        options: IMPACT_STYLE_OPTIONS,
        default: "badge",
      },
      {
        key: "color",
        label: "Accent color",
        type: "color",
        default: "",
      },
      {
        key: "intensity",
        label: "Effect intensity",
        type: "select",
        options: IMPACT_INTENSITY_OPTIONS,
        default: "high",
      },
      {
        key: "durationMs",
        label: "Visible time (seconds)",
        type: "number",
        min: 500,
        max: 60_000,
        step: 100,
        inputScale: 1000,
        default: 2600,
      },
    ],
  },
] as const;

export function listOverlayDefinitions(): readonly OverlayDefinition[] {
  return DEFINITIONS;
}

export function getOverlayDefinition(id: OverlayId): OverlayDefinition | undefined {
  return DEFINITIONS.find((definition) => definition.id === id);
}

export function overlayDefaults(id: OverlayId): {
  fields: Record<string, string>;
  config: Record<string, unknown>;
} {
  const definition = getOverlayDefinition(id);
  return {
    fields: Object.fromEntries(
      (definition?.fields ?? []).map((field) => [field.key, field.default]),
    ),
    config: Object.fromEntries(
      (definition?.config ?? []).map((field) => [field.key, field.default]),
    ),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boundedNumber(
  value: unknown,
  min: number,
  max: number,
): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : undefined;
}

export interface AlertOverlayView {
  text: string;
  value?: string;
  icon?: string;
  severity?: "info" | "warn" | "alarm";
  color?: string;
  fontSize?: number;
  durationMs?: number;
}

/** Interpret only Alerts events; unknown fields/config remain harmless and are
 * available to future overlay versions without changing the shared payload. */
export function alertOverlayView(
  payload: TriggerOverlayPayload,
): AlertOverlayView | null {
  if (payload.overlay !== "alerts") return null;
  const text = stringValue(payload.fields.text);
  if (!text) return null;
  const config = payload.config ?? {};
  const severity = config.severity;
  return {
    text,
    value: stringValue(payload.fields.value),
    icon: stringValue(payload.fields.icon),
    severity:
      severity === "info" || severity === "warn" || severity === "alarm"
        ? severity
        : undefined,
    color: stringValue(config.color),
    fontSize: boundedNumber(config.fontSize, 10, 96),
    durationMs: boundedNumber(config.durationMs, 500, 60_000),
  };
}

export interface ImpactOverlayView {
  event: ImpactEvent;
  durationMs: number;
}

export function impactOverlayView(
  payload: TriggerOverlayPayload,
): ImpactOverlayView | null {
  if (payload.overlay !== "impact") return null;
  const defaults = overlayDefaults("impact");
  const config = payload.config ?? {};
  const intensity = stringValue(config.intensity);
  return {
    event: {
      style:
        stringValue(config.style) ?? String(defaults.config.style),
      headline: stringValue(payload.fields.headline),
      big: stringValue(payload.fields.big),
      sub: stringValue(payload.fields.sub),
      glyph: stringValue(payload.fields.glyph),
      color: stringValue(config.color),
      intensity:
        intensity === "low" || intensity === "medium" || intensity === "high"
          ? intensity
          : "high",
    },
    durationMs:
      boundedNumber(config.durationMs, 500, 60_000) ??
      Number(defaults.config.durationMs),
  };
}
