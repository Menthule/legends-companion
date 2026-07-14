// Progression trends: per-session rate series (XP%/hr, kills/hr, deaths/hr,
// plat/hr) computed from the Session tab's persisted session-history rows,
// plus the pure geometry for the inline-SVG sparklines that render them.
// One accent-hue series per micro-chart, zero baseline, no charting library
// (DESIGN.md: identity comes from one accent hue and good numbers).

export interface TrendSessionInput {
  id: string;
  /** Wall-clock ms the session started (row label). */
  startedTs: number;
  durationSecs: number;
  xp: number;
  kills: number;
  deaths: number;
  /** Session coin income in copper; null/absent on rows persisted before
   *  coin tracking existed (rendered as a gap, not a zero). */
  platCopper?: number | null;
  /** Level-ups seen during the session; absent on legacy rows. */
  levelUps?: number | null;
}

export type TrendSeriesId = "xp" | "kills" | "deaths" | "plat";

export interface TrendPoint {
  id: string;
  /** Session start, wall-clock ms (tooltip label). */
  startedTs: number;
  /** Per-hour rate; null = unknowable for this row (legacy gap). */
  value: number | null;
  /** Level-ups during the session (marker on the XP chart). */
  levelUps: number;
}

export interface TrendSeries {
  id: TrendSeriesId;
  label: string;
  /** Unit suffix for direct labels, e.g. "%/hr". */
  unit: string;
  /** Oldest → newest. */
  points: TrendPoint[];
  /** Newest known value (direct label); null when no point has one. */
  latest: number | null;
}

/** Sessions charted (newest N, oldest → newest on the x axis). */
export const TREND_SESSION_CAP = 20;
/** Rows shorter than this produce meaningless rates and are skipped. */
export const TREND_MIN_DURATION_SECS = 60;

function perHour(value: number | null | undefined, durationSecs: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return (value / durationSecs) * 3600;
}

/**
 * Build the four rate series from history rows (any input order; sorted by
 * start time, capped to the newest TREND_SESSION_CAP, sub-minute rows
 * dropped). Legacy rows without coin data yield null plat points — a gap in
 * the line, never a fake zero.
 */
export function buildTrendSeries(rows: TrendSessionInput[]): TrendSeries[] {
  const usable = rows
    .filter(
      (row) =>
        Number.isFinite(row.durationSecs) &&
        row.durationSecs >= TREND_MIN_DURATION_SECS,
    )
    .sort((a, b) => a.startedTs - b.startedTs)
    .slice(-TREND_SESSION_CAP);

  const make = (
    id: TrendSeriesId,
    label: string,
    unit: string,
    value: (row: TrendSessionInput) => number | null,
  ): TrendSeries => {
    const points = usable.map((row) => ({
      id: row.id,
      startedTs: row.startedTs,
      value: value(row),
      levelUps: Math.max(0, Math.floor(row.levelUps ?? 0)),
    }));
    const latest =
      [...points].reverse().find((p) => p.value !== null)?.value ?? null;
    return { id, label, unit, points, latest };
  };

  return [
    make("xp", "XP", "%/hr", (r) => perHour(r.xp, r.durationSecs)),
    make("kills", "Kills", "/hr", (r) => perHour(r.kills, r.durationSecs)),
    make("deaths", "Deaths", "/hr", (r) => perHour(r.deaths, r.durationSecs)),
    make("plat", "Plat", "p/hr", (r) =>
      r.platCopper == null ? null : perHour(r.platCopper / 1000, r.durationSecs),
    ),
  ];
}

export interface SparkLayout {
  /** SVG path ("M x y L x y …"); null points break the line into segments. */
  path: string;
  /** Per-input-point coordinates; null where the value was null. */
  points: ({ x: number; y: number } | null)[];
}

/**
 * Sparkline geometry: values scale from a zero baseline to the series max
 * (rates start at 0 honestly; a truncated axis would exaggerate wiggle).
 * A single point still gets a coordinate (rendered as a dot, no line).
 */
export function sparklineLayout(
  values: (number | null)[],
  width: number,
  height: number,
  pad = 3,
): SparkLayout {
  const innerW = Math.max(1, width - pad * 2);
  const innerH = Math.max(1, height - pad * 2);
  const known = values.filter((v): v is number => v !== null);
  const max = known.reduce((m, v) => Math.max(m, v), 0);
  const denom = values.length > 1 ? values.length - 1 : 1;
  const round = (n: number) => Math.round(n * 100) / 100;
  const points = values.map((v, i) => {
    if (v === null) return null;
    const x = pad + (values.length > 1 ? (i / denom) * innerW : innerW / 2);
    const frac = max > 0 ? Math.max(0, v) / max : 0;
    const y = pad + (1 - frac) * innerH;
    return { x: round(x), y: round(y) };
  });
  let path = "";
  let penDown = false;
  for (const p of points) {
    if (p === null) {
      penDown = false;
      continue;
    }
    path += `${path ? " " : ""}${penDown ? "L" : "M"}${p.x} ${p.y}`;
    penDown = true;
  }
  return { path, points };
}

/** Compact direct label for a trend value: 2 decimals under 10, 1 under
 *  100, whole numbers above. */
export function fmtTrendValue(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 100) return String(Math.round(value));
  if (abs >= 10) return value.toFixed(1);
  return value.toFixed(2);
}
