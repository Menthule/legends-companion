export type ComparisonGoal = "xp" | "aa" | "motes" | "damage";

export type ConfidenceLevel = "insufficient" | "low" | "medium" | "high";

export type ComparisonDirection =
  | "improved"
  | "declined"
  | "unchanged"
  | "unavailable";

export type ComparisonMetricId =
  | "xpPerHour"
  | "aaPointsPerHour"
  | "aaPercentPerHour"
  | "motesPerHour"
  | "dps"
  | "killsPerHour"
  | "deathsPerHour"
  | "downtimePercent"
  | "damageTakenPerHour";

export interface SessionSkillSample {
  name: string;
  damage: number;
  uses: number;
}

export interface SessionRouteSample {
  label: string;
  durationSecs: number;
  xp?: number | null;
  aaPoints?: number | null;
  aaPercent?: number | null;
  motes?: number | null;
  damage?: number | null;
}

/**
 * A UI-independent view of either a live or stored session. Optional values
 * remain unknown; callers should not coerce data absent from old sessions to 0.
 */
export interface SessionComparisonSample {
  id: string;
  label: string;
  durationSecs: number;
  combatSecs?: number | null;
  activeSecs?: number | null;
  observations?: number | null;
  fights?: number | null;
  kills?: number | null;
  deaths?: number | null;
  xp?: number | null;
  aaPoints?: number | null;
  aaPercent?: number | null;
  motes?: number | null;
  damage?: number | null;
  damageTaken?: number | null;
  skills?: SessionSkillSample[];
  routes?: SessionRouteSample[];
}

export interface ComparisonMetric {
  id: ComparisonMetricId;
  label: string;
  unit: "percentPerHour" | "perHour" | "dps" | "percent";
  higherIsBetter: boolean;
  current: number | null;
  baseline: number | null;
  delta: number | null;
  /** Fractional change: 0.12 means 12% higher. Null for a zero/missing baseline. */
  deltaRatio: number | null;
  direction: ComparisonDirection;
}

export interface ComparisonConfidence {
  level: ConfidenceLevel;
  label: string;
  shortestDurationSecs: number;
  minimumObservations: number;
}

export interface SessionComparison {
  goal: ComparisonGoal;
  current: SessionComparisonSample;
  baseline: SessionComparisonSample;
  primaryMetricId: ComparisonMetricId;
  metrics: ComparisonMetric[];
  confidence: ComparisonConfidence;
  findings: string[];
}

interface MetricDefinition {
  id: ComparisonMetricId;
  label: string;
  unit: ComparisonMetric["unit"];
  higherIsBetter: boolean;
  value: (sample: SessionComparisonSample) => number | null;
}

const valid = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

function perHour(value: number | null | undefined, durationSecs: number): number | null {
  return valid(value) && durationSecs > 0 ? (value / durationSecs) * 3600 : null;
}

function combatDuration(sample: SessionComparisonSample): number {
  return valid(sample.combatSecs) && sample.combatSecs > 0
    ? sample.combatSecs
    : sample.durationSecs;
}

const METRICS: Record<ComparisonMetricId, MetricDefinition> = {
  xpPerHour: {
    id: "xpPerHour",
    label: "XP/hour",
    unit: "percentPerHour",
    higherIsBetter: true,
    value: (sample) => perHour(sample.xp, sample.durationSecs),
  },
  aaPointsPerHour: {
    id: "aaPointsPerHour",
    label: "AA/hour",
    unit: "perHour",
    higherIsBetter: true,
    value: (sample) => perHour(sample.aaPoints, sample.durationSecs),
  },
  aaPercentPerHour: {
    id: "aaPercentPerHour",
    label: "AA progress/hour",
    unit: "percentPerHour",
    higherIsBetter: true,
    value: (sample) => perHour(sample.aaPercent, sample.durationSecs),
  },
  motesPerHour: {
    id: "motesPerHour",
    label: "Motes/hour",
    unit: "perHour",
    higherIsBetter: true,
    value: (sample) => perHour(sample.motes, sample.durationSecs),
  },
  dps: {
    id: "dps",
    label: "DPS",
    unit: "dps",
    higherIsBetter: true,
    value: (sample) =>
      valid(sample.damage) ? sample.damage / Math.max(1, combatDuration(sample)) : null,
  },
  killsPerHour: {
    id: "killsPerHour",
    label: "Kills/hour",
    unit: "perHour",
    higherIsBetter: true,
    value: (sample) => perHour(sample.kills, sample.durationSecs),
  },
  deathsPerHour: {
    id: "deathsPerHour",
    label: "Deaths/hour",
    unit: "perHour",
    higherIsBetter: false,
    value: (sample) => perHour(sample.deaths, sample.durationSecs),
  },
  downtimePercent: {
    id: "downtimePercent",
    label: "Downtime",
    unit: "percent",
    higherIsBetter: false,
    value: (sample) =>
      valid(sample.activeSecs) && sample.durationSecs > 0
        ? Math.max(0, Math.min(100, (1 - sample.activeSecs / sample.durationSecs) * 100))
        : null,
  },
  damageTakenPerHour: {
    id: "damageTakenPerHour",
    label: "Damage taken/hour",
    unit: "perHour",
    higherIsBetter: false,
    value: (sample) => perHour(sample.damageTaken, sample.durationSecs),
  },
};

function primaryMetric(goal: ComparisonGoal, samples: SessionComparisonSample[]): ComparisonMetricId {
  if (goal === "xp") return "xpPerHour";
  if (goal === "motes") return "motesPerHour";
  if (goal === "damage") return "dps";
  if (samples.every((sample) => valid(sample.aaPoints)) && samples.some((sample) => sample.aaPoints! > 0)) {
    return "aaPointsPerHour";
  }
  if (samples.every((sample) => valid(sample.aaPercent))) return "aaPercentPerHour";
  return samples.some((sample) => valid(sample.aaPoints))
    ? "aaPointsPerHour"
    : "aaPercentPerHour";
}

function compareMetric(
  definition: MetricDefinition,
  current: SessionComparisonSample,
  baseline: SessionComparisonSample,
): ComparisonMetric {
  const currentValue = definition.value(current);
  const baselineValue = definition.value(baseline);
  const delta = currentValue !== null && baselineValue !== null
    ? currentValue - baselineValue
    : null;
  const deltaRatio = delta !== null && baselineValue !== null && baselineValue !== 0
    ? delta / Math.abs(baselineValue)
    : null;
  let direction: ComparisonDirection = "unavailable";
  if (delta !== null) {
    const tolerance = Math.max(0.000_001, Math.abs(baselineValue ?? 0) * 0.001);
    if (Math.abs(delta) <= tolerance) direction = "unchanged";
    else if ((delta > 0) === definition.higherIsBetter) direction = "improved";
    else direction = "declined";
  }
  return {
    id: definition.id,
    label: definition.label,
    unit: definition.unit,
    higherIsBetter: definition.higherIsBetter,
    current: currentValue,
    baseline: baselineValue,
    delta,
    deltaRatio,
    direction,
  };
}

function observations(sample: SessionComparisonSample): number {
  if (valid(sample.observations)) return Math.max(0, Math.floor(sample.observations));
  if (valid(sample.fights)) return Math.max(0, Math.floor(sample.fights));
  if (valid(sample.kills)) return Math.max(0, Math.floor(sample.kills));
  return 0;
}

function confidenceFor(
  current: SessionComparisonSample,
  baseline: SessionComparisonSample,
): ComparisonConfidence {
  const shortestDurationSecs = Math.max(
    0,
    Math.min(current.durationSecs, baseline.durationSecs),
  );
  const minimumObservations = Math.min(observations(current), observations(baseline));
  let level: ConfidenceLevel;
  if (shortestDurationSecs < 300 || minimumObservations < 2) level = "insufficient";
  else if (shortestDurationSecs < 900 || minimumObservations < 5) level = "low";
  else if (shortestDurationSecs < 2700 || minimumObservations < 15) level = "medium";
  else level = "high";
  const minutes = Math.max(1, Math.round(shortestDurationSecs / 60));
  const confidence = level === "insufficient"
    ? "Not enough data"
    : `${level[0].toUpperCase()}${level.slice(1)} confidence`;
  return {
    level,
    label: `${confidence} · ${minutes}m shortest · ${minimumObservations} observations minimum`,
    shortestDurationSecs,
    minimumObservations,
  };
}

function roundedPercent(value: number): string {
  return `${Math.max(1, Math.round(Math.abs(value) * 100))}%`;
}

function comparisonFinding(metric: ComparisonMetric, baselineLabel: string): string | null {
  if (metric.direction === "unavailable") return null;
  if (metric.direction === "unchanged") {
    return `${metric.label} is unchanged from ${baselineLabel}.`;
  }
  if (metric.deltaRatio === null) {
    return `${metric.label} is ${metric.direction === "improved" ? "better" : "worse"} than ${baselineLabel}.`;
  }
  const relative = metric.deltaRatio > 0 ? "higher" : "lower";
  return `${metric.label} is ${roundedPercent(metric.deltaRatio)} ${relative} than ${baselineLabel}.`;
}

function driverFinding(primary: ComparisonMetric, metrics: ComparisonMetric[]): string | null {
  if (primary.direction !== "improved" && primary.direction !== "declined") return null;
  const drivers = metrics
    .filter((metric) =>
      metric.id !== primary.id &&
      metric.direction === primary.direction &&
      metric.deltaRatio !== null &&
      Math.abs(metric.deltaRatio) >= 0.03,
    )
    .sort((a, b) => Math.abs(b.deltaRatio!) - Math.abs(a.deltaRatio!))
    .slice(0, 2);
  if (drivers.length === 0) return null;
  const phrases = drivers.map((metric) => {
    const movement = metric.deltaRatio! > 0 ? "rose" : "fell";
    return `${metric.label.toLowerCase()} ${movement} ${roundedPercent(metric.deltaRatio!)}`;
  });
  const joined = phrases.length === 2 ? `${phrases[0]} and ${phrases[1]}` : phrases[0];
  return `The result aligns with ${joined}.`;
}

function skillFinding(
  goal: ComparisonGoal,
  current: SessionComparisonSample,
  baseline: SessionComparisonSample,
): string | null {
  if (goal !== "damage") return null;
  const previous = new Map((baseline.skills ?? []).map((skill) => [skill.name.toLowerCase(), skill]));
  const changes = (current.skills ?? []).flatMap((skill) => {
    const old = previous.get(skill.name.toLowerCase());
    if (!old || skill.uses < 3 || old.uses < 3) return [];
    const before = old.damage / old.uses;
    const after = skill.damage / skill.uses;
    if (before <= 0) return [];
    return [{ name: skill.name, ratio: (after - before) / before }];
  }).sort((a, b) => Math.abs(b.ratio) - Math.abs(a.ratio));
  const best = changes[0];
  if (!best || Math.abs(best.ratio) < 0.05) return null;
  return `${best.name} damage/use ${best.ratio > 0 ? "improved" : "fell"} ${roundedPercent(best.ratio)}.`;
}

function routeGoalValue(route: SessionRouteSample, goal: ComparisonGoal): number | null {
  if (goal === "xp") return perHour(route.xp, route.durationSecs);
  if (goal === "motes") return perHour(route.motes, route.durationSecs);
  if (goal === "damage") {
    return valid(route.damage) ? route.damage / Math.max(1, route.durationSecs) : null;
  }
  return valid(route.aaPoints)
    ? perHour(route.aaPoints, route.durationSecs)
    : perHour(route.aaPercent, route.durationSecs);
}

function routeFinding(current: SessionComparisonSample, goal: ComparisonGoal): string | null {
  const ranked = (current.routes ?? [])
    .map((route) => ({ label: route.label, value: routeGoalValue(route, goal) }))
    .filter((route): route is { label: string; value: number } => route.value !== null && route.value > 0)
    .sort((a, b) => b.value - a.value);
  return ranked[0] ? `${ranked[0].label} is the strongest route segment for this goal.` : null;
}

export function compareSessions(
  current: SessionComparisonSample,
  baseline: SessionComparisonSample,
  goal: ComparisonGoal,
): SessionComparison {
  const primaryMetricId = primaryMetric(goal, [current, baseline]);
  const metricIds: ComparisonMetricId[] = [
    primaryMetricId,
    "killsPerHour",
    "deathsPerHour",
    "downtimePercent",
    "dps",
    "damageTakenPerHour",
  ];
  const metrics = [...new Set(metricIds)].map((id) =>
    compareMetric(METRICS[id], current, baseline),
  );
  const primary = metrics.find((metric) => metric.id === primaryMetricId)!;
  const findings = [
    comparisonFinding(primary, baseline.label),
    driverFinding(primary, metrics),
    skillFinding(goal, current, baseline),
    routeFinding(current, goal),
  ].filter((finding): finding is string => finding !== null).slice(0, 3);

  return {
    goal,
    current,
    baseline,
    primaryMetricId,
    metrics,
    confidence: confidenceFor(current, baseline),
    findings,
  };
}
