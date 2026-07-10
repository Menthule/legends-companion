// The two shared reference-database filter controls: EraSelect and
// ClassFilterButton. Both bind to the GLOBAL filter store
// (lib/refFilters.ts), so setting them on any Database tab applies to all
// of them — same component, same behavior, everywhere.

import { useEffect, useRef, useState } from "react";
import { getProfile } from "../api";
import {
  CLASS_FULL,
  CLASS_NAME_TO_BIT,
  classMaskFullNames,
  useClassMask,
  useEraMax,
  useLiveZoneEnabled,
  useLiveZoneName,
} from "../lib/refFilters";

const ERAS = [
  { value: 0, label: "Classic" },
  { value: 1, label: "+ Kunark" },
  { value: 2, label: "+ Velious" },
  { value: 3, label: "Everything" },
];

/** Global era ceiling select — identical on every Database tab. */
export function EraSelect() {
  const [eraMax, setEraMax] = useEraMax();
  return (
    <select
      value={eraMax}
      onChange={(e) => setEraMax(Number(e.target.value))}
      title="Era ceiling — applies to every Database tab"
    >
      {ERAS.map((era) => (
        <option key={era.value} value={era.value}>
          {era.label}
        </option>
      ))}
    </select>
  );
}

/**
 * Global multi-select class filter: a button summarizing the selection,
 * opening a popover with a full-name checkbox grid, a "my loadout" preset,
 * and a clear action. Click-outside closes it.
 */
export function ClassFilterButton() {
  const [classMask, setClassMask] = useClassMask();
  const [open, setOpen] = useState(false);
  const [loadout, setLoadout] = useState<{ label: string; mask: number } | null>(
    null,
  );
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getProfile()
      .then((p) => {
        const active =
          p.loadouts.find((l) => l.name === p.active_loadout) ?? p.loadouts[0];
        const classes = active?.classes ?? [];
        const mask = classes.reduce(
          (m, name) => m | (1 << (CLASS_NAME_TO_BIT[name] ?? 0)),
          0,
        );
        if (mask) {
          setLoadout({ label: `My loadout (${classes.join(", ")})`, mask });
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const selected = classMaskFullNames(classMask);
  const summary =
    selected.length === 0
      ? "Classes: any"
      : selected.length === 1
        ? selected[0]
        : `${selected[0]} +${selected.length - 1}`;

  return (
    <div className="drops-colpick" ref={ref}>
      <button
        className={`ghost small${classMask !== 0 ? " ref-filter-active" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="Class filter — applies to every Database tab"
      >
        {summary} ▾
      </button>
      {open && (
        <div className="drops-colpick-menu drops-filter-classes">
          <span className="drops-filter-mini">
            Classes (any of the checked) — applies to all Database tabs
          </span>
          {loadout && (
            <button
              className="ghost small"
              onClick={() =>
                setClassMask(classMask === loadout.mask ? 0 : loadout.mask)
              }
            >
              {classMask === loadout.mask ? "✓ " : ""}
              {loadout.label}
            </button>
          )}
          <div className="drops-class-grid">
            {CLASS_FULL.map((full) => {
              const bit = 1 << CLASS_NAME_TO_BIT[full];
              return (
                <label key={full} className="drops-class-opt">
                  <input
                    type="checkbox"
                    checked={(classMask & bit) !== 0}
                    onChange={() => setClassMask(classMask ^ bit)}
                  />
                  {full}
                </label>
              );
            })}
          </div>
          <button
            className="ghost small drops-filter-reset"
            disabled={classMask === 0}
            onClick={() => {
              setClassMask(0);
              setOpen(false);
            }}
          >
            Clear classes
          </button>
        </div>
      )}
    </div>
  );
}

export function LiveZoneFilterButton({
  matchedZone,
  className = "",
}: {
  matchedZone?: string;
  className?: string;
}) {
  const [enabled, setEnabled] = useLiveZoneEnabled();
  const [zoneName] = useLiveZoneName();
  const label = zoneName
    ? enabled
      ? `Live zone: ${matchedZone || zoneName}`
      : `Live zone off`
    : "Live zone";
  return (
    <button
      className={`ghost small live-zone-filter${enabled ? " ref-filter-active" : ""}${className ? ` ${className}` : ""}`}
      onClick={() => setEnabled((v) => !v)}
      disabled={!zoneName}
      title={
        zoneName
          ? `When on, zone filters follow your current in-game zone: ${zoneName}`
          : "Zone into the game once to enable live zone filtering"
      }
    >
      {label}
    </button>
  );
}
