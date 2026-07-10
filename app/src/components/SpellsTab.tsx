// Spell/ability reference tab: search/browse the bundled Legends spell
// database (spells/spell_classes tables in the same sqlite file the Drops
// tab uses). One component serves BOTH sidebar tabs — abilities are the
// is_ability=1 half of the spells table (endurance-costed combat skills),
// so the Abilities tab is this component with `kind="abilities"`.
//
// Search UX mirrors DropsTab: debounced name search (min 2 chars unless a
// class filter is active — browse mode), Class + max-level filters,
// sortable column headers, 50/page paging, and an expandable detail row
// with the cast/wear-off messages and the full class/level list. Table
// styling reuses the .drops-* grid classes.

import { useEffect, useMemo, useRef, useState } from "react";
import { dropsZones, refdbSpellScrolls, spellsSearch } from "../api";
import type { DropZone, SpellRow, SpellScroll } from "../types";
import Empty from "./Empty";
import {
  BUFF_CONFLICTS_EVENT,
  conflictsForMap,
  loadConflicts,
} from "../lib/buffConflicts";
import {
  classMaskToParam,
  resolveLiveZoneShortName,
  useClassMask,
  useLiveZoneEnabled,
  useLiveZoneName,
} from "../lib/refFilters";
import { ClassFilterButton } from "./RefFilters";
import ResourceLinks from "./ResourceLinks";

const PAGE_SIZE = 50;

/** Full class names as stored in spell_classes.class, with display codes. */
const CLASSES: { full: string; code: string }[] = [
  { full: "Warrior", code: "WAR" },
  { full: "Cleric", code: "CLR" },
  { full: "Paladin", code: "PAL" },
  { full: "Ranger", code: "RNG" },
  // NOTE: the DB stores "ShadowKnight" (no space) in spell_classes.class.
  { full: "ShadowKnight", code: "SHD" },
  { full: "Druid", code: "DRU" },
  { full: "Monk", code: "MNK" },
  { full: "Bard", code: "BRD" },
  { full: "Rogue", code: "ROG" },
  { full: "Shaman", code: "SHM" },
  { full: "Necromancer", code: "NEC" },
  { full: "Wizard", code: "WIZ" },
  { full: "Magician", code: "MAG" },
  { full: "Enchanter", code: "ENC" },
  { full: "Beastlord", code: "BST" },
  { full: "Berserker", code: "BER" },
];

/** Normalized (lowercase, letters-only) full name → 3-letter code, so
 *  "ShadowKnight" / "Shadow Knight" / "shadowknight" all abbreviate. */
const CLASS_CODE: Record<string, string> = Object.fromEntries(
  CLASSES.map((c) => [c.full.toLowerCase().replace(/[^a-z]/g, ""), c.code]),
);

function abbrevClass(full: string): string {
  return (
    CLASS_CODE[full.toLowerCase().replace(/[^a-z]/g, "")] ??
    full.slice(0, 3).toUpperCase()
  );
}

/** "Enchanter 12, Necromancer 16" → "ENC 12, NEC 16". Class names may
 *  contain spaces ("Shadow Knight 30"), so split at the LAST space. */
function abbrevClassLevels(s: string | null): string {
  if (!s) return "";
  return s
    .split(", ")
    .map((part) => {
      const i = part.lastIndexOf(" ");
      if (i <= 0) return part;
      return `${abbrevClass(part.slice(0, i))} ${part.slice(i + 1)}`;
    })
    .join(", ");
}

const RESIST_TYPES: Record<number, string> = {
  0: "Unresistable",
  1: "Magic",
  2: "Fire",
  3: "Cold",
  4: "Poison",
  5: "Disease",
};

/** Partial map — unknown codes fall back to the raw number. */
const TARGET_TYPES: Record<number, string> = {
  1: "Line of sight",
  3: "Group v1",
  4: "PB AE",
  5: "Single",
  6: "Self",
  8: "Targeted AE",
  11: "Animal",
  13: "Lifetap",
  14: "Pet",
  16: "Corpse",
  40: "Group v2",
};

/** Milliseconds → "2.5s" (trailing .0 dropped); 0/negative → "". */
function fmtMs(ms: number): string {
  if (ms <= 0) return "";
  return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`;
}

/** Seconds → "m:ss"; 0/negative → "". */
function fmtDuration(secs: number): string {
  if (secs <= 0) return "";
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

type SortKey =
  | "name"
  | "level"
  | "mana"
  | "endurance"
  | "cast"
  | "recast"
  | "duration";

// Name | Classes | Mana(End) | Cast | Recast | Duration | Resist
const GRID_TEMPLATE = "1.3fr 1.1fr 56px 60px 64px 68px 90px";

export default function SpellsTab({
  kind,
  searchRequest,
}: {
  kind: "spells" | "abilities";
  /** Deep-link (ding digest → spell): prefill the query. `seq` bumps so the
   *  same name can be re-requested. */
  searchRequest?: { query: string; seq: number } | null;
}) {
  const isAbility = kind === "abilities";
  // Abilities cost endurance; the cost column (and its sort) follows suit.
  const costLabel = isAbility ? "End" : "Mana";
  const costSort: SortKey = isAbility ? "endurance" : "mana";

  const [query, setQuery] = useState("");
  // Deep-link prefill: adopt the requested query when the seq changes.
  useEffect(() => {
    if (searchRequest && searchRequest.query) setQuery(searchRequest.query);
  }, [searchRequest?.seq]);

  // Learned buff conflicts (P11) — refreshed on the same-window notify and on
  // cross-window storage writes.
  const [conflictVer, setConflictVer] = useState(0);
  useEffect(() => {
    const bump = () => setConflictVer((v) => v + 1);
    window.addEventListener(BUFF_CONFLICTS_EVENT, bump);
    window.addEventListener("storage", bump);
    return () => {
      window.removeEventListener(BUFF_CONFLICTS_EVENT, bump);
      window.removeEventListener("storage", bump);
    };
  }, []);
  const conflictMap = useMemo(() => loadConflicts(), [conflictVer]);
  const [classMask, setClassMask] = useClassMask();
  const [liveZoneEnabled] = useLiveZoneEnabled();
  const [liveZoneName] = useLiveZoneName();
  const classes = classMaskToParam(classMask);
  const [zones, setZones] = useState<DropZone[]>([]);
  const [maxLevel, setMaxLevel] = useState(0);
  const [sort, setSort] = useState<SortKey>("name");
  const [descending, setDescending] = useState(false);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<SpellRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  /** Scroll items teaching the expanded spell (null = loading). */
  const [scrolls, setScrolls] = useState<SpellScroll[] | null>(null);
  const debounce = useRef<number | null>(null);

  const active = query.trim().length >= 2 || classes !== "";

  useEffect(() => {
    dropsZones().then(setZones).catch(() => {});
  }, []);

  const liveZoneShort = useMemo(
    () =>
      liveZoneEnabled ? resolveLiveZoneShortName(liveZoneName, zones) : "",
    [liveZoneEnabled, liveZoneName, zones],
  );

  useEffect(() => {
    if (debounce.current) window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => {
      if (!active) {
        setRows([]);
        setTotal(0);
        setError(null);
        return;
      }
      spellsSearch({
        query: query.trim(),
        isAbility,
        classes,
        maxLevel,
        sort,
        descending,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      })
        .then((res) => {
          setRows(res.rows);
          setTotal(res.total);
          setError(null);
        })
        .catch((e) => setError(String(e)));
    }, 250);
    return () => {
      if (debounce.current) window.clearTimeout(debounce.current);
    };
  }, [active, query, isAbility, classes, maxLevel, sort, descending, page]);

  function resetPaging() {
    setPage(0);
    setExpanded(null);
  }

  function toggleExpand(id: number) {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    // Scroll sources are secondary detail: a failure just hides the section.
    // Era 3 ("Everything") — scribing hunts shouldn't hide later-era copies.
    setScrolls(null);
  }

  useEffect(() => {
    if (expanded == null) return;
    setScrolls(null);
    refdbSpellScrolls(expanded, 3, liveZoneShort)
      .then(setScrolls)
      .catch(() => setScrolls([]));
  }, [expanded, liveZoneShort]);

  function toggleSort(key: SortKey) {
    if (sort === key) {
      setDescending((d) => !d);
    } else {
      setSort(key);
      // Name reads best A-Z; numeric columns largest-first, except level
      // which browses naturally low-to-high.
      setDescending(key !== "name" && key !== "level");
    }
    setPage(0);
  }

  function clearAll() {
    setQuery("");
    setClassMask(0);
    setMaxLevel(0);
    resetPaging();
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const noun = isAbility ? "ability" : "spell";

  function sortHeader(key: SortKey, label: string, numeric: boolean) {
    return (
      <button
        className={`drops-col-btn${numeric ? " num" : ""}${sort === key ? " active" : ""}`}
        onClick={() => toggleSort(key)}
        title={`Sort by ${label}`}
      >
        {label}
        {sort === key ? (descending ? " ↓" : " ↑") : ""}
      </button>
    );
  }

  return (
    <div className="card drops-card">
      <div className="card-head">
        <span className="section-title">
          {isAbility ? "Abilities" : "Spells"}
        </span>
        <span className="hint">
          Bundled Legends reference data — search by name, or pick a class to
          browse its {noun} list.
        </span>
      </div>
      <div className="drops-controls">
        <input
          type="search"
          placeholder={`Search ${isAbility ? "abilities" : "spells"} by name…`}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            resetPaging();
          }}
        />
        <ClassFilterButton />
        <label
          className="spells-maxlevel"
          title="Hide entries the class gets above this level (0 = any)"
        >
          Max level
          <input
            type="number"
            min={0}
            max={125}
            value={maxLevel}
            onChange={(e) => {
              setMaxLevel(Math.max(0, Number(e.target.value) || 0));
              resetPaging();
            }}
          />
        </label>
        {(query !== "" || classMask !== 0 || maxLevel !== 0) && (
          <button className="ghost small" onClick={clearAll}>
            Clear
          </button>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      {!active ? (
        <Empty
          title={`Search the ${noun} database`}
          body={`Type a${isAbility ? "n ability" : " spell"} name (2+ characters), or pick a class to browse everything it gets — costs, cast times, durations, and the log messages each ${noun} produces.`}
        />
      ) : rows.length === 0 ? (
        <Empty
          title="No matches"
          body={
            classMask !== 0
              ? "Nothing matches that name for these classes and level cap — try clearing a filter."
              : `No ${isAbility ? "abilities" : "spells"} match that name.`
          }
        />
      ) : (
        <>
          <div className="drops-table">
            <div
              className="drops-row drops-head"
              style={{ gridTemplateColumns: GRID_TEMPLATE }}
              aria-hidden="true"
            >
              {sortHeader("name", "Name", false)}
              {sortHeader("level", "Classes", false)}
              {sortHeader(costSort, costLabel, true)}
              {sortHeader("cast", "Cast", true)}
              {sortHeader("recast", "Recast", true)}
              {sortHeader("duration", "Duration", true)}
              <span className="drops-col-btn">Resist</span>
            </div>
            {rows.map((r) => (
              <div key={r.id}>
                <button
                  className={`drops-row drops-item${expanded === r.id ? " active" : ""}`}
                  style={{ gridTemplateColumns: GRID_TEMPLATE }}
                  onClick={() => toggleExpand(r.id)}
                >
                  <span className="drops-name">
                    {r.name}
                    {r.beneficial ? null : (
                      <span className="drops-badge warn">DET</span>
                    )}
                    {conflictsForMap(conflictMap, r.name).length > 0 && (
                      <span
                        className="drops-badge conflict"
                        title={`Won't stack with: ${conflictsForMap(conflictMap, r.name).join(", ")}`}
                      >
                        conflicts
                      </span>
                    )}
                  </span>
                  <span
                    className="drops-topsource"
                    title={r.classesStr ?? undefined}
                  >
                    {abbrevClassLevels(r.classesStr)}
                  </span>
                  <span className="num">
                    {(isAbility ? r.endurance : r.mana) || ""}
                  </span>
                  <span className="num">{fmtMs(r.castTimeMs)}</span>
                  <span className="num">{fmtMs(r.recastMs)}</span>
                  <span className="num">{fmtDuration(r.durationSecs)}</span>
                  <span>
                    {r.beneficial
                      ? ""
                      : (RESIST_TYPES[r.resistType] ?? `#${r.resistType}`)}
                  </span>
                </button>
                {expanded === r.id && (
                  <div className="drops-detail">
                    <div className="drops-statline">
                      <span>{r.beneficial ? "Beneficial" : "Detrimental"}</span>
                      <span>
                        Target: {TARGET_TYPES[r.targetType] ?? `#${r.targetType}`}
                      </span>
                      <span>
                        Resist:{" "}
                        {RESIST_TYPES[r.resistType] ?? `#${r.resistType}`}
                      </span>
                      {r.spellRange > 0 && (
                        <span className="num">Range {r.spellRange}</span>
                      )}
                      {r.mana > 0 && <span className="num">Mana {r.mana}</span>}
                      {r.endurance > 0 && (
                        <span className="num">End {r.endurance}</span>
                      )}
                      <span className="num">
                        Cast {fmtMs(r.castTimeMs) || "instant"}
                      </span>
                      {r.recastMs > 0 && (
                        <span className="num">Recast {fmtMs(r.recastMs)}</span>
                      )}
                      {r.durationSecs > 0 && (
                        <span className="num">
                          Duration {fmtDuration(r.durationSecs)}
                        </span>
                      )}
                    </div>
                    <ResourceLinks
                      kind={isAbility ? "ability" : "spell"}
                      name={r.name}
                      eqId={isAbility ? null : r.id}
                    />
                    {r.classesStr && (
                      <div className="spells-classlist">
                        Classes: {r.classesStr}
                      </div>
                    )}
                    {r.castOnYou || r.castOnOther || r.wearOff ? (
                      <div className="spells-msgs">
                        {r.castOnYou && (
                          <div>
                            <span className="spells-msg-label">On you</span>
                            {r.castOnYou}
                          </div>
                        )}
                        {r.castOnOther && (
                          <div>
                            <span className="spells-msg-label">On other</span>
                            {r.castOnOther}
                          </div>
                        )}
                        {r.wearOff && (
                          <div>
                            <span className="spells-msg-label">Wears off</span>
                            {r.wearOff}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="hint">No log messages recorded.</div>
                    )}
                    {scrolls && scrolls.length > 0 && (
                      <>
                        <div className="refdb-subhead">
                          Scrolls
                          {liveZoneShort && <span className="drops-badge">Live zone preferred</span>}
                        </div>
                        <div className="refdb-rows">
                          {scrolls.map((s) => (
                            <div
                              key={s.itemId}
                              className="refdb-row"
                              style={{ gridTemplateColumns: "1.1fr 1.9fr" }}
                            >
                              <span>
                                <button
                                  className="session-item-link"
                                  title="Look up this scroll in the Drops tab"
                                  onClick={() =>
                                    window.dispatchEvent(
                                      new CustomEvent("eqlogs-open-drops", {
                                        detail: s.item,
                                      }),
                                    )
                                  }
                                >
                                  {s.item}
                                </button>
                              </span>
                              <span className="refdb-hint-str">
                                {[
                                  s.dropCount > 0
                                    ? `${s.dropCount} drop source${
                                        s.dropCount === 1 ? "" : "s"
                                      }${s.topDrop ? ` — ${s.topDrop}` : ""}`
                                    : null,
                                  s.vendorCount > 0
                                    ? `${s.vendorCount} vendor${
                                        s.vendorCount === 1 ? "" : "s"
                                      }${s.topVendor ? ` — ${s.topVendor}` : ""}`
                                    : null,
                                ]
                                  .filter(Boolean)
                                  .join(" · ") || "no known source"}
                              </span>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="drops-pager">
            <span className="hint num">
              {total} {total === 1 ? noun : `${noun.replace(/y$/, "ie")}s`}
            </span>
            {pages > 1 && (
              <>
                <button
                  className="ghost small"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  ‹ Prev
                </button>
                <span className="hint num">
                  {page + 1} / {pages}
                </span>
                <button
                  className="ghost small"
                  disabled={page + 1 >= pages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next ›
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
