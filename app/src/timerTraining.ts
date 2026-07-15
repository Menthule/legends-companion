import { activeLoadout } from "./resolution";
import type {
  CharacterProfile,
  RankTrainingResult,
  TimerTrainingReport,
} from "./types";

export type TimerTrainingStatus =
  | "drift"
  | "inconsistent"
  | "collecting"
  | "verified";

export interface EffectiveTrainingTiming {
  durationSecs: number;
  castTimeSecs: number;
  source: "default" | "loadout";
}

export function effectiveTrainingTiming(
  profile: CharacterProfile | null,
  report: TimerTrainingReport,
  rank: RankTrainingResult,
): EffectiveTrainingTiming {
  const override = profile
    ? activeLoadout(profile).timing_overrides?.[report.triggerId]?.[
        rank.rank.trim().toUpperCase()
      ]
    : undefined;
  return {
    durationSecs:
      override?.duration_secs ??
      rank.configuredDurationSecs ??
      report.configuredDurationSecs,
    castTimeSecs:
      override?.cast_time_secs ??
      rank.configuredCastTimeSecs ??
      report.configuredCastTimeSecs,
    source:
      override?.duration_secs != null || override?.cast_time_secs != null
        ? "loadout"
        : "default",
  };
}

export function timerTrainingStatus(
  timing: EffectiveTrainingTiming,
  rank: RankTrainingResult,
): TimerTrainingStatus {
  if (rank.confidence === "inconsistent") return "inconsistent";
  if (!rank.canApply || rank.suggestedDurationSecs == null) return "collecting";
  const delta = Math.abs(rank.suggestedDurationSecs - timing.durationSecs);
  const materialDelta =
    timing.durationSecs <= 0
      ? delta > 0
      : delta >= 6 && delta / timing.durationSecs >= 0.1;
  return materialDelta ? "drift" : "verified";
}

export function trainingStatusPriority(status: TimerTrainingStatus): number {
  switch (status) {
    case "drift":
      return 0;
    case "inconsistent":
      return 1;
    case "collecting":
      return 2;
    case "verified":
      return 3;
  }
}

export function parseTrainingDuration(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const match = /^(\d+):(\d{1,2})$/.exec(trimmed);
  if (!match) return null;
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  if (seconds >= 60) return null;
  return minutes * 60 + seconds;
}

export function romanRankValue(rank: string): number {
  const values: Record<string, number> = {
    I: 1,
    V: 5,
    X: 10,
    L: 50,
    C: 100,
    D: 500,
    M: 1000,
  };
  let total = 0;
  let previous = 0;
  for (const char of rank.trim().toUpperCase().split("").reverse()) {
    const value = values[char] ?? 0;
    total += value < previous ? -value : value;
    previous = Math.max(previous, value);
  }
  return total;
}
