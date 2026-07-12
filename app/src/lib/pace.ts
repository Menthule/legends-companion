/** Shared rate tracking for explicit grind samples. All timestamps are wall-clock ms. */

export const PACE_STATE_VERSION = 1 as const;
export const PACE_STATE_KEY = "eqlogs.pace.state.v1";
export const PACE_STATE_EVENT = "eqlogs:pace-state-changed";
export const PACE_HISTORY_LIMIT = 10;
export const PACE_ROLLING_WINDOW_SECS = 10 * 60;
export const PACE_IDLE_CAP_SECS = 5 * 60;

export type PaceSampleStatus = "running" | "paused" | "completed";
export type LootMatchKind = "exact" | "contains" | "regex";
export type LootOwner = "you" | "anyone";

export interface PaceLootMetric {
  id: string;
  label: string;
  enabled: boolean;
  match: { kind: LootMatchKind; value: string; caseSensitive?: boolean };
  owner: LootOwner;
}

export interface PaceSample {
  id: string;
  status: PaceSampleStatus;
  startedAtMs: number;
  pausedAtMs: number | null;
  pausedDurationMs: number;
  endedAtMs: number | null;
  aaStartPercent: number | null;
  aaEndPercent: number | null;
  aaPointsEarned: number;
  xpPercent: number;
  loot: Record<string, number>;
}

export interface PaceState {
  version: typeof PACE_STATE_VERSION;
  active: PaceSample | null;
  history: PaceSample[];
  lootMetrics: PaceLootMetric[];
}

export type PaceEvent =
  | { kind: "xp"; percent: number; atMs: number; replayed?: boolean }
  | { kind: "aa-point"; points: number; atMs: number; replayed?: boolean }
  | {
      kind: "loot";
      item: string;
      quantity: number;
      looter: string;
      atMs: number;
      replayed?: boolean;
    };

export interface PaceLootRate {
  metricId: string;
  label: string;
  total: number;
  perHour: number | null;
}

export interface PaceSnapshot {
  elapsedMs: number;
  xpPercent: number;
  xpPerHour: number | null;
  aaPointsEarned: number;
  aaPointsPerHour: number | null;
  aaPercentGained: number | null;
  aaPercentPerHour: number | null;
  loot: PaceLootRate[];
}

/** A newest-first observation for a rolling active-time rate. Source time is
 * relative only (log-domain seconds); observedAtMs anchors decay to wall time. */
export interface RollingPaceRow {
  sourceTimeSecs: number;
  value: number;
  observedAtMs?: number;
}

export interface RollingPaceRate {
  total: number;
  count: number;
  perHour: number | null;
}

export interface PaceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const DEFAULT_LOOT_METRICS: PaceLootMetric[] = [
  {
    id: "motes",
    label: "Motes",
    enabled: true,
    match: {
      kind: "regex",
      value: "^Mote of .+ Potential$",
      caseSensitive: false,
    },
    owner: "you",
  },
];

export function emptyPaceState(): PaceState {
  return {
    version: PACE_STATE_VERSION,
    active: null,
    history: [],
    lootMetrics: DEFAULT_LOOT_METRICS.map(cloneMetric),
  };
}

export function startPaceSample(
  state: PaceState,
  options: { nowMs: number; aaStartPercent?: number | null; id?: string },
): PaceState {
  const startedAtMs = finiteNonNegative(options.nowMs, Date.now());
  const id = options.id?.trim() || `pace-${startedAtMs}`;
  return {
    ...state,
    active: {
      id,
      status: "running",
      startedAtMs,
      pausedAtMs: null,
      pausedDurationMs: 0,
      endedAtMs: null,
      aaStartPercent: validPercent(options.aaStartPercent),
      aaEndPercent: null,
      aaPointsEarned: 0,
      xpPercent: 0,
      loot: {},
    },
  };
}

export function pausePaceSample(state: PaceState, nowMs: number): PaceState {
  const sample = state.active;
  if (!sample || sample.status !== "running") return state;
  return {
    ...state,
    active: { ...sample, status: "paused", pausedAtMs: Math.max(nowMs, sample.startedAtMs) },
  };
}

export function resumePaceSample(state: PaceState, nowMs: number): PaceState {
  const sample = state.active;
  if (!sample || sample.status !== "paused" || sample.pausedAtMs == null) return state;
  return {
    ...state,
    active: {
      ...sample,
      status: "running",
      pausedDurationMs:
        sample.pausedDurationMs + Math.max(0, nowMs - sample.pausedAtMs),
      pausedAtMs: null,
    },
  };
}

export function completePaceSample(
  state: PaceState,
  options: { nowMs: number; aaEndPercent?: number | null },
): PaceState {
  if (!state.active) return state;
  const resumed = resumePaceSample(state, options.nowMs);
  const sample = resumed.active!;
  const completed: PaceSample = {
    ...sample,
    status: "completed",
    endedAtMs: Math.max(options.nowMs, sample.startedAtMs),
    aaEndPercent: validPercent(options.aaEndPercent),
  };
  return {
    ...resumed,
    active: null,
    history: [completed, ...state.history].slice(0, PACE_HISTORY_LIMIT),
  };
}

export function resetPaceSample(state: PaceState): PaceState {
  return state.active ? { ...state, active: null } : state;
}

export function applyPaceEvent(state: PaceState, event: PaceEvent): PaceState {
  const sample = state.active;
  if (
    !sample ||
    sample.status !== "running" ||
    event.replayed ||
    !Number.isFinite(event.atMs) ||
    event.atMs < sample.startedAtMs
  ) {
    return state;
  }

  if (event.kind === "xp") {
    if (!Number.isFinite(event.percent) || event.percent <= 0) return state;
    return { ...state, active: { ...sample, xpPercent: sample.xpPercent + event.percent } };
  }
  if (event.kind === "aa-point") {
    if (!Number.isFinite(event.points) || event.points <= 0) return state;
    return {
      ...state,
      active: {
        ...sample,
        aaPointsEarned: sample.aaPointsEarned + Math.floor(event.points),
      },
    };
  }

  const quantity = Number.isFinite(event.quantity) ? Math.floor(event.quantity) : 0;
  if (quantity <= 0) return state;
  let loot = sample.loot;
  for (const metric of state.lootMetrics) {
    if (!metric.enabled || !lootMetricMatches(metric, event.item, event.looter)) continue;
    if (loot === sample.loot) loot = { ...sample.loot };
    loot[metric.id] = (loot[metric.id] ?? 0) + quantity;
  }
  return loot === sample.loot ? state : { ...state, active: { ...sample, loot } };
}

export function paceElapsedMs(sample: PaceSample, nowMs: number): number {
  const end = sample.endedAtMs ?? (sample.pausedAtMs ?? nowMs);
  return Math.max(0, end - sample.startedAtMs - sample.pausedDurationMs);
}

export function paceSnapshot(
  sample: PaceSample,
  metrics: PaceLootMetric[],
  nowMs: number,
): PaceSnapshot {
  const elapsedMs = paceElapsedMs(sample, nowMs);
  const hours = elapsedMs > 0 ? elapsedMs / 3_600_000 : null;
  const rate = (total: number): number | null => (hours ? total / hours : null);
  const aaPercentGained =
    sample.aaStartPercent != null && sample.aaEndPercent != null
      ? sample.aaEndPercent - sample.aaStartPercent + sample.aaPointsEarned * 100
      : null;
  return {
    elapsedMs,
    xpPercent: sample.xpPercent,
    xpPerHour: rate(sample.xpPercent),
    aaPointsEarned: sample.aaPointsEarned,
    aaPointsPerHour: rate(sample.aaPointsEarned),
    aaPercentGained,
    aaPercentPerHour: aaPercentGained == null ? null : rate(aaPercentGained),
    loot: metrics
      .filter((metric) => metric.enabled)
      .map((metric) => {
        const total = sample.loot[metric.id] ?? 0;
        return { metricId: metric.id, label: metric.label, total, perHour: rate(total) };
      }),
  };
}

/**
 * Calculates a recent active-time rate without mixing absolute log and wall
 * clocks. Long gaps are capped as idle time and a single observation never
 * claims a meaningful rate.
 */
export function computeRollingPaceRate(
  rows: RollingPaceRow[],
  nowMs: number,
  options: { windowSecs?: number; idleCapSecs?: number; minWindowSecs?: number } = {},
): RollingPaceRate {
  if (rows.length === 0) return { total: 0, count: 0, perHour: null };
  const windowSecs = options.windowSecs ?? PACE_ROLLING_WINDOW_SECS;
  const idleCapSecs = options.idleCapSecs ?? PACE_IDLE_CAP_SECS;
  const minWindowSecs = options.minWindowSecs ?? 60;
  const newest = rows[0];
  const sinceNewest =
    newest.observedAtMs != null
      ? Math.max(0, (nowMs - newest.observedAtMs) / 1000)
      : 0;
  const ageSecs = (row: RollingPaceRow) => {
    if (newest.observedAtMs != null && row.observedAtMs != null) {
      return Math.max(0, sinceNewest + (newest.observedAtMs - row.observedAtMs) / 1000);
    }
    return Math.max(0, sinceNewest + (newest.sourceTimeSecs - row.sourceTimeSecs));
  };
  const recentRows = rows.filter((row) => ageSecs(row) <= windowSecs);
  if (recentRows.length === 0) return { total: 0, count: 0, perHour: null };
  const total = recentRows.reduce((sum, row) => sum + row.value, 0);
  if (recentRows.length < 2) return { total, count: recentRows.length, perHour: null };

  let activeSecs = Math.min(sinceNewest, idleCapSecs, windowSecs);
  for (let i = 0; i < recentRows.length - 1; i++) {
    const gap = recentRows[i].sourceTimeSecs - recentRows[i + 1].sourceTimeSecs;
    activeSecs += Math.min(Math.max(0, gap), idleCapSecs);
  }
  const measuredSecs = Math.max(minWindowSecs, Math.min(activeSecs, windowSecs));
  return {
    total,
    count: recentRows.length,
    perHour: total / (measuredSecs / 3600),
  };
}

export function lootMetricMatches(
  metric: PaceLootMetric,
  item: string,
  looter: string,
): boolean {
  if (metric.owner === "you" && looter.trim().toLowerCase() !== "you") return false;
  const caseSensitive = metric.match.caseSensitive === true;
  const actual = caseSensitive ? item : item.toLowerCase();
  const expected = caseSensitive ? metric.match.value : metric.match.value.toLowerCase();
  if (metric.match.kind === "exact") return actual === expected;
  if (metric.match.kind === "contains") return actual.includes(expected);
  try {
    return new RegExp(metric.match.value, caseSensitive ? "" : "i").test(item);
  } catch {
    return false;
  }
}

export function loadPaceState(storage: PaceStorage | null = browserStorage()): PaceState {
  if (!storage) return emptyPaceState();
  try {
    const raw = storage.getItem(PACE_STATE_KEY);
    return raw == null ? emptyPaceState() : normalizePaceState(JSON.parse(raw));
  } catch {
    return emptyPaceState();
  }
}

export function savePaceState(
  state: PaceState,
  storage: PaceStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(PACE_STATE_KEY, JSON.stringify(state));
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(PACE_STATE_EVENT, { detail: state }));
    }
  } catch {
    // A rate tracker should keep working in memory if storage is unavailable.
  }
}

export function normalizePaceState(value: unknown): PaceState {
  if (!isRecord(value) || value.version !== PACE_STATE_VERSION) return emptyPaceState();
  const metrics = Array.isArray(value.lootMetrics)
    ? value.lootMetrics.map(normalizeMetric).filter((v): v is PaceLootMetric => v != null)
    : [];
  const active = normalizeSample(value.active, false);
  const history = Array.isArray(value.history)
    ? value.history
        .map((sample) => normalizeSample(sample, true))
        .filter((sample): sample is PaceSample => sample != null)
        .slice(0, PACE_HISTORY_LIMIT)
    : [];
  return {
    version: PACE_STATE_VERSION,
    active,
    history,
    lootMetrics: metrics.length ? metrics : DEFAULT_LOOT_METRICS.map(cloneMetric),
  };
}

function normalizeSample(value: unknown, completed: boolean): PaceSample | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const startedAtMs = finiteNonNegative(value.startedAtMs, NaN);
  if (!Number.isFinite(startedAtMs)) return null;
  const endedAtMs = completed ? finiteNonNegative(value.endedAtMs, NaN) : null;
  if (completed && !Number.isFinite(endedAtMs)) return null;
  const status: PaceSampleStatus = completed
    ? "completed"
    : value.status === "paused"
      ? "paused"
      : "running";
  return {
    id: value.id,
    status,
    startedAtMs,
    pausedAtMs:
      status === "paused" ? finiteNonNegative(value.pausedAtMs, startedAtMs) : null,
    pausedDurationMs: finiteNonNegative(value.pausedDurationMs, 0),
    endedAtMs: completed ? endedAtMs : null,
    aaStartPercent: validPercent(value.aaStartPercent),
    aaEndPercent: completed ? validPercent(value.aaEndPercent) : null,
    aaPointsEarned: finiteNonNegativeInteger(value.aaPointsEarned),
    xpPercent: finiteNonNegative(value.xpPercent, 0),
    loot: normalizeLoot(value.loot),
  };
}

function normalizeMetric(value: unknown): PaceLootMetric | null {
  if (!isRecord(value) || !isRecord(value.match)) return null;
  const kind = value.match.kind;
  if (
    typeof value.id !== "string" ||
    !value.id.trim() ||
    typeof value.label !== "string" ||
    !value.label.trim() ||
    (kind !== "exact" && kind !== "contains" && kind !== "regex") ||
    typeof value.match.value !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    label: value.label,
    enabled: value.enabled !== false,
    match: {
      kind,
      value: value.match.value,
      caseSensitive: value.match.caseSensitive === true,
    },
    owner: value.owner === "anyone" ? "anyone" : "you",
  };
}

function normalizeLoot(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, count]) => [key, finiteNonNegativeInteger(count)] as const)
      .filter(([, count]) => count > 0),
  );
}

function validPercent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

function finiteNonNegative(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function finiteNonNegativeInteger(value: unknown): number {
  return Math.floor(finiteNonNegative(value, 0));
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function cloneMetric(metric: PaceLootMetric): PaceLootMetric {
  return { ...metric, match: { ...metric.match } };
}

function browserStorage(): PaceStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
