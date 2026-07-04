// Shared damage-table pieces (DESIGN.md meter spec), used by the Meters tab
// and the Fights history detail view.
//
// Names use the timer bars' dual-ink treatment: the base label sits in --ink
// over the track, and a copy clipped to the series-color fill carries that
// slot's on-fill ink (--series-N-ink), so the name never drops below AA on
// any fill color (the old scrim still measured ~2.2:1 white-on-amber).
//
// Rows expand (item 15) into per-source sub-rows: thin bars in the
// combatant's series color at reduced opacity, name in ink, and
// total / DPS share / % right-aligned in the same numeric columns.

import { useState } from "react";
import { fmtNum, useSeriesSlots } from "../hooks";
import { IS_MOCK } from "../mock";
import type { MeterRow, MeterSourceRow } from "../types";

/** Which metric the table bars/columns show. "damage" keeps the original
 *  total / DPS / % layout (and expandable per-source rows); "healing" and
 *  "taken" (X2) re-point the bars at healing / damage-taken. */
export type MeterMode = "damage" | "healing" | "taken";

/** The bar value for a row under the active mode. */
function metricOf(row: MeterRow, mode: MeterMode): number {
  if (mode === "healing") return row.healing ?? 0;
  if (mode === "taken") return row.damageTaken ?? 0;
  return row.total;
}

/** Mock-only: `?expand=Name1,Name2` pre-expands rows for screenshots. */
const DEMO_EXPANDED: string[] = (() => {
  if (!IS_MOCK) return [];
  const v = new URLSearchParams(window.location.search).get("expand");
  return v ? v.split(",").filter((s) => s.length > 0) : [];
})();

export function StatTile({ value, label }: { value: string; label: string }) {
  return (
    <div className="stat-tile">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function SourceRowView({
  source,
  row,
  maxTotal,
  slot,
}: {
  source: MeterSourceRow;
  row: MeterRow;
  maxTotal: number;
  slot: number;
}) {
  const frac = row.total > 0 ? source.total / row.total : 0;
  const widthPct = maxTotal > 0 ? (source.total / maxTotal) * 100 : 0;
  return (
    <div className="meter-sub-row">
      <span aria-hidden="true" />
      <div className="meter-sub-track">
        <div
          className="meter-sub-fill"
          style={{
            width: `${widthPct}%`,
            background: `var(--series-${slot + 1})`,
          }}
        />
        <span className="meter-sub-name">{source.name}</span>
      </div>
      <span className="meter-val meter-sub-val">{fmtNum(source.total)}</span>
      <span className="meter-val meter-sub-val">{fmtNum(row.dps * frac)}</span>
      <span className="meter-val meter-sub-val">
        {(frac * 100).toFixed(1)}%
      </span>
    </div>
  );
}

/** The three right-aligned numeric cells for a row under the active mode.
 *  Damage keeps total / DPS / share%; healing shows total / share% / overheal%
 *  (overheal in the third column); taken shows total / share% / —. */
function cellsOf(
  row: MeterRow,
  mode: MeterMode,
  grand: number,
): [string, string, string] {
  const share = (v: number) =>
    grand > 0 ? `${((v / grand) * 100).toFixed(1)}%` : "—";
  if (mode === "healing") {
    const heal = row.healing ?? 0;
    const over = row.overheal ?? 0;
    const overPct =
      heal + over > 0 ? `${((over / (heal + over)) * 100).toFixed(0)}%` : "—";
    return [fmtNum(heal), share(heal), overPct];
  }
  if (mode === "taken") {
    const taken = row.damageTaken ?? 0;
    return [fmtNum(taken), share(taken), "—"];
  }
  return [fmtNum(row.total), fmtNum(row.dps), `${row.pct.toFixed(1)}%`];
}

function MeterRowView({
  row,
  mode,
  maxValue,
  grand,
  slot,
  open,
  onToggle,
}: {
  row: MeterRow;
  mode: MeterMode;
  maxValue: number;
  grand: number;
  slot: number;
  open: boolean;
  onToggle: () => void;
}) {
  const value = metricOf(row, mode);
  const widthPct = maxValue > 0 ? (value / maxValue) * 100 : 0;
  // Per-source sub-rows are a damage breakdown; healing/taken have none.
  const sources = mode === "damage" ? (row.sources ?? []) : [];
  const [c1, c2, c3] = cellsOf(row, mode, grand);
  const name = (
    <>
      {row.name}
      {row.pet && <span className="meter-pet">+pet</span>}
    </>
  );
  return (
    <>
      <div className="meter-row">
        {sources.length > 0 ? (
          <button
            type="button"
            className="meter-chevron"
            onClick={onToggle}
            aria-expanded={open}
            aria-label={`${open ? "Hide" : "Show"} damage sources for ${row.name}`}
          >
            <span className={`meter-chev${open ? " open" : ""}`} />
          </button>
        ) : (
          <span aria-hidden="true" />
        )}
        <div className="meter-track">
          <div
            className="meter-fill"
            style={{
              width: `${widthPct}%`,
              background: `var(--series-${slot + 1})`,
            }}
          >
            {/* On-fill ink copy, clipped to the fill (dual-ink treatment). */}
            <span
              className="meter-name meter-name-clip"
              aria-hidden="true"
              style={{ color: `var(--series-${slot + 1}-ink)` }}
            >
              {name}
            </span>
          </div>
          <span className="meter-name">{name}</span>
        </div>
        <span className="meter-val">{c1}</span>
        <span className="meter-val">{c2}</span>
        <span className="meter-val">{c3}</span>
        {mode === "damage" && (
          <div className="meter-tip" role="tooltip">
            <div className="meter-tip-title">
              {row.name}
              {row.pet ? " (incl. pet)" : ""}
            </div>
            <div className="meter-tip-grid">
              <span>Hits</span>
              <span className="num">{row.hits ?? "—"}</span>
              <span>Crits</span>
              <span className="num">{row.crits ?? "—"}</span>
              <span>Misses</span>
              <span className="num">{row.misses ?? "—"}</span>
              <span>Max hit</span>
              <span className="num">{row.maxHit ?? "—"}</span>
            </div>
          </div>
        )}
      </div>
      {open && sources.length > 0 && (
        <div className="meter-sub-rows">
          {sources.map((s) => (
            <SourceRowView
              key={s.name}
              source={s}
              row={row}
              maxTotal={maxValue}
              slot={slot}
            />
          ))}
        </div>
      )}
    </>
  );
}

/** The horizontal-bars meter table. Series slots stick to a combatant on
 *  first appearance for the lifetime of the component (DESIGN.md); expanded
 *  state is remembered per combatant name the same way. `mode` re-points the
 *  bars/columns at damage (default), healing, or damage-taken (X2). */
export default function MeterTable({
  rows,
  mode = "damage",
}: {
  rows: MeterRow[];
  mode?: MeterMode;
}) {
  const slotOf = useSeriesSlots(rows.map((r) => r.name));
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(DEMO_EXPANDED),
  );
  const maxValue = rows.reduce((m, r) => Math.max(m, metricOf(r, mode)), 0);
  const grand = rows.reduce((s, r) => s + metricOf(r, mode), 0);
  const toggle = (name: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  return (
    <div className="meter-rows">
      {rows.map((r) => (
        <MeterRowView
          key={r.name}
          row={r}
          mode={mode}
          maxValue={maxValue}
          grand={grand}
          slot={slotOf(r.name)}
          open={expanded.has(r.name)}
          onToggle={() => toggle(r.name)}
        />
      ))}
    </div>
  );
}
