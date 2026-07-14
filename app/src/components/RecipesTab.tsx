// Recipes reference tab: search/browse tradeskill recipes in the bundled
// classic-era reference database (same sqlite the Drops tab uses). The
// Drops tab deep-links here via lib/deepLinks openRecipes (searchRequest
// prop, wired in Dashboard). Component/result item names deep-link back
// into the Drops tab (openDrops).
//
// UX mirrors DropsTab via the shared scaffold (lib/refSearch + Pager):
// debounced search, .drops-* grid tables, 50/page paging, expandable
// detail rows with components + farming hints.

import { useEffect, useMemo, useRef, useState } from "react";
import { dropsZones, refdbRecipeDetail, refdbRecipeSearch } from "../api";
import type { DropZone, RecipeDetail, RecipeRef } from "../types";
import { TRADESKILL_NAMES, tradeskillName } from "../types";
import { SpecRow } from "./SearchSelect";
import Empty from "./Empty";
import Pager from "./Pager";
import ResourceLinks from "./ResourceLinks";
import { useDebouncedRefSearch } from "../lib/refSearch";
import {
  resolveLiveZoneShortName,
  useLiveZoneEnabled,
  useLiveZoneName,
} from "../lib/refFilters";
import { openDrops } from "../lib/deepLinks";

// Name | Tradeskill | Trivial
const GRID_TEMPLATE = "1.6fr 130px 56px";

/** Detail farming hints span every era — a scribing/crafting hunt shouldn't
 *  hide later-era component sources. */
const DETAIL_ERA_MAX = 3;

function ItemLink({ name }: { name: string }) {
  return (
    <button
      className="session-item-link"
      title="Look up this item in the Drops tab"
      onClick={() => openDrops(name)}
    >
      {name}
    </button>
  );
}

export default function RecipesTab({
  searchRequest,
}: {
  /** Deep-link from the Drops tab: bump `seq` to re-trigger. */
  searchRequest: { query: string; seq: number } | null;
}) {
  const [query, setQuery] = useState("");
  const [tradeskill, setTradeskill] = useState(0);
  const [liveZoneEnabled] = useLiveZoneEnabled();
  const [liveZoneName] = useLiveZoneName();
  const [maxTrivial, setMaxTrivial] = useState(0);
  const [zones, setZones] = useState<DropZone[]>([]);
  const [detail, setDetail] = useState<RecipeDetail | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const active = query.trim().length >= 2 || tradeskill !== 0;

  const {
    page,
    setPage,
    pages,
    total,
    rows,
    error,
    setError,
    expanded,
    setExpanded,
    resetPaging,
    toggleExpand,
  } = useDebouncedRefSearch<RecipeRef>({
    active,
    fetch: (offset, limit) =>
      refdbRecipeSearch({
        query: query.trim(),
        tradeskill,
        maxTrivial,
        limit,
        offset,
      }),
    deps: [query, tradeskill, maxTrivial],
  });

  // Deep-link from the Drops tab crafting chips: clean lookup, filters reset.
  useEffect(() => {
    if (!searchRequest) return;
    setQuery(searchRequest.query);
    setTradeskill(0);
    setMaxTrivial(0);
    setPage(0);
    setExpanded(null);
    inputRef.current?.focus();
  }, [searchRequest]);

  useEffect(() => {
    dropsZones().then(setZones).catch(() => {});
  }, []);

  const liveZoneShort = useMemo(
    () =>
      liveZoneEnabled ? resolveLiveZoneShortName(liveZoneName, zones) : "",
    [liveZoneEnabled, liveZoneName, zones],
  );

  useEffect(() => {
    if (expanded == null) return;
    setDetail(null);
    refdbRecipeDetail(expanded, DETAIL_ERA_MAX, liveZoneShort)
      .then(setDetail)
      .catch((e) => setError(String(e)));
  }, [expanded, liveZoneShort]);

  function clearAll() {
    setQuery("");
    setTradeskill(0);
    setMaxTrivial(0);
    resetPaging();
  }

  return (
    <div className="card drops-card">
      <div className="card-head">
        <span className="section-title">Recipes</span>
        <span className="hint">
          Classic-era reference data (ProjectEQ) — search by name, or pick a
          tradeskill to browse its recipe list.
        </span>
      </div>
      <div className="drops-controls">
        <input
          ref={inputRef}
          type="search"
          placeholder="Search recipes by name…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            resetPaging();
          }}
        />
        <select
          value={tradeskill}
          onChange={(e) => {
            setTradeskill(Number(e.target.value));
            resetPaging();
          }}
          title="Only recipes of this tradeskill — an empty search then browses the full list"
        >
          <option value={0}>Any tradeskill</option>
          {Object.entries(TRADESKILL_NAMES).map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <label
          className="spells-maxlevel"
          title="Hide recipes that stay non-trivial above this skill (0 = any)"
        >
          Max trivial
          <input
            type="number"
            min={0}
            max={500}
            value={maxTrivial}
            onChange={(e) => {
              setMaxTrivial(Math.max(0, Number(e.target.value) || 0));
              resetPaging();
            }}
          />
        </label>
        {(query !== "" || tradeskill !== 0 || maxTrivial !== 0) && (
          <button className="ghost small" onClick={clearAll}>
            Clear
          </button>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      {!active ? (
        <Empty
          title="Search the recipe database"
          body="Type a recipe name (2+ characters), or pick a tradeskill to browse everything it can combine — components, results, trivials, and where to farm each ingredient."
        />
      ) : rows.length === 0 ? (
        <Empty
          title="No matches"
          body="No recipes match these filters — try clearing the tradeskill or raising the trivial cap."
        />
      ) : (
        <>
          <div className="drops-table">
            <div
              className="drops-row drops-head"
              style={{ gridTemplateColumns: GRID_TEMPLATE }}
              aria-hidden="true"
            >
              <span className="drops-col-label">Recipe</span>
              <span className="drops-col-label">Tradeskill</span>
              <span className="drops-col-label num">Trivial</span>
            </div>
            {rows.map((r) => (
              <div key={r.id}>
                <button
                  className={`drops-row drops-item${expanded === r.id ? " active" : ""}`}
                  style={{ gridTemplateColumns: GRID_TEMPLATE }}
                  onClick={() => toggleExpand(r.id)}
                >
                  <span className="drops-name">{r.name}</span>
                  <span className="drops-topsource">
                    {tradeskillName(r.tradeskill)}
                  </span>
                  <span className="num">{r.trivial || "—"}</span>
                </button>
                {expanded === r.id && (
                  <div className="drops-detail">
                    {detail === null ? (
                      <div className="hint">Loading recipe…</div>
                    ) : (
                      <>
                        <div className="drops-spec">
                          <SpecRow
                            label="Tradeskill"
                            value={tradeskillName(detail.tradeskill)}
                          />
                          <SpecRow
                            label="Trivial"
                            value={
                              detail.trivial > 0
                                ? String(detail.trivial)
                                : "—"
                            }
                          />
                          {detail.noFail ? (
                            <SpecRow label="Flags" value="NO FAIL" />
                          ) : null}
                        </div>
                        <ResourceLinks kind="recipe" name={detail.name} />
                        {detail.results.length > 0 && (
                          <>
                            <div className="refdb-subhead">Makes</div>
                            <div className="zoneinfo-list">
                              {detail.results.map((res) => (
                                <span key={res.itemId}>
                                  <ItemLink name={res.item} />
                                  {res.count > 1 ? (
                                    <span className="hint num">
                                      {" "}
                                      ×{res.count}
                                    </span>
                                  ) : null}
                                </span>
                              ))}
                            </div>
                          </>
                        )}
                        {detail.components.length > 0 ? (
                          <>
                            <div className="refdb-subhead">
                              Components
                              {liveZoneShort && <span className="drops-badge">Live zone preferred</span>}
                            </div>
                            <div className="refdb-rows">
                              <div
                                className="refdb-row refdb-row-head"
                                aria-hidden="true"
                                style={{
                                  gridTemplateColumns: "1.1fr 36px 1.8fr",
                                }}
                              >
                                <span>Item</span>
                                <span className="num">Qty</span>
                                <span>Where to get it</span>
                              </div>
                              {detail.components.map((c) => (
                                <div
                                  key={c.itemId}
                                  className="refdb-row"
                                  style={{
                                    gridTemplateColumns: "1.1fr 36px 1.8fr",
                                  }}
                                >
                                  <span>
                                    <ItemLink name={c.item} />
                                  </span>
                                  <span className="num">{c.count}</span>
                                  <span className="refdb-hint-str">
                                    {[c.topDrop, c.topVendor]
                                      .filter(Boolean)
                                      .join(" · ") || "no known source"}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </>
                        ) : (
                          <div className="hint">
                            No component list recorded for this recipe.
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          <Pager
            count={`${total} recipe${total === 1 ? "" : "s"}`}
            page={page}
            pages={pages}
            onPage={setPage}
          />
        </>
      )}
    </div>
  );
}
