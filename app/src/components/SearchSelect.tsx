// Shared Database-tab widgets: the SearchSelect type-to-filter combobox and
// the SpecRow labeled detail line. Homed here (not in DropsTab) because the
// Drops, Mobs, Recipes, and Timers tabs all consume them — importing a
// dropdown shouldn't pull in the whole Drops tab module graph.

import { useState } from "react";

/** One labeled line in the item-detail spec grid ("Damage  19 / 41 dly").
 *  Shared by the Drops/Mobs/Recipes tabs (same detail-grid conventions). */
export function SpecRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="drops-spec-row">
      <span className="drops-spec-label">{label}</span>
      <span className="drops-spec-value">{value}</span>
    </div>
  );
}

/**
 * Type-to-filter combobox for long option lists (specific effects, zones):
 * a text input that filters a dropdown, with ↑/↓/Enter/Escape keyboard
 * navigation. Closed, it shows the selected label (or "Any …").
 * Shared by the Drops (effect/zone filters), Mobs (zone filter), and
 * Timers (zone picker) tabs.
 */
export function SearchSelect({
  value,
  options,
  anyLabel,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  anyLabel: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const MAX_SHOWN = 60;

  const ql = q.trim().toLowerCase();
  const filtered = ql
    ? options.filter((o) => o.label.toLowerCase().includes(ql))
    : options;
  const shown = filtered.slice(0, MAX_SHOWN);
  // Row 0 is always the "Any" reset.
  const rowCount = shown.length + 1;

  const selectedLabel =
    options.find((o) => o.value === value)?.label ?? anyLabel;

  function pick(v: string) {
    onChange(v);
    setOpen(false);
    setQ("");
    setIdx(0);
  }

  // Whether the × clears typed text (menu open) or the selection itself.
  const clearable = (open && q !== "") || (!open && value !== "");

  return (
    <div className="sselect">
      <input
        type="text"
        value={open ? q : value === "" ? "" : selectedLabel}
        placeholder={anyLabel + " — type to search"}
        onFocus={() => {
          setOpen(true);
          setQ("");
          setIdx(0);
        }}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setIdx(0);
        }}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setIdx((i) => (i + 1) % rowCount);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setIdx((i) => (i - 1 + rowCount) % rowCount);
          } else if (e.key === "Enter") {
            e.preventDefault();
            pick(idx === 0 ? "" : (shown[idx - 1]?.value ?? ""));
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {clearable && (
        <button
          type="button"
          className="sselect-clear"
          title={open && q !== "" ? "Clear search" : "Clear selection"}
          onMouseDown={(e) => {
            e.preventDefault();
            if (open && q !== "") {
              setQ("");
              setIdx(0);
            } else {
              pick("");
            }
          }}
        >
          ×
        </button>
      )}
      <span className="sselect-chev" aria-hidden="true">
        ▾
      </span>
      {open && (
        <div className="sselect-menu" role="listbox">
          <button
            className={`sselect-row${idx === 0 ? " active" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              pick("");
            }}
          >
            {anyLabel}
          </button>
          {shown.map((o, i) => (
            <button
              key={o.value}
              className={`sselect-row${idx === i + 1 ? " active" : ""}${o.value === value ? " selected" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(o.value);
              }}
            >
              {o.label}
            </button>
          ))}
          {filtered.length > MAX_SHOWN && (
            <div className="sselect-more">
              +{filtered.length - MAX_SHOWN} more — keep typing to narrow
            </div>
          )}
          {filtered.length === 0 && (
            <div className="sselect-more">No matches</div>
          )}
        </div>
      )}
    </div>
  );
}
