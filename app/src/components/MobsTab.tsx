// Mobs reference tab: search/browse NPCs in the bundled classic-era
// reference database (same sqlite the Drops tab uses) — who spawns where,
// what they drop, what they sell. Loot/sell item names deep-link into the
// Drops tab via the "eqlogs-open-drops" CustomEvent. When a zone filter is
// set, an expandable zone-info header (refdb_zone_info) shows connections,
// forage/fishing tables, and the zone's named mobs.
//
// UX mirrors DropsTab: debounced search, .drops-* grid tables, SearchSelect
// zone combobox, era select, 50/page paging, expandable detail rows.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  dropsZones,
  refdbMobDetail,
  refdbMobSearch,
  refdbZoneInfo,
} from "../api";
import type { DropZone, MobDetail, MobRow, ZoneInfo } from "../types";
import { SearchSelect, SpecRow } from "./DropsTab";
import Empty from "./Empty";
import {
  resolveLiveZoneShortName,
  useEraMax,
  useLiveZoneEnabled,
  useLiveZoneName,
} from "../lib/refFilters";
import { EraSelect } from "./RefFilters";
import { ItemTypeIcon } from "./ItemIcons";
import ResourceLinks from "./ResourceLinks";

const PAGE_SIZE = 50;

const ERA_NAMES = ["Classic", "Kunark", "Velious", "Later"];

// Name | Level | Zone | Loot | Respawn
const GRID_TEMPLATE = "1.5fr 52px 1fr 52px 68px";

/** Respawn seconds → "m:ss"; unknown/0 → "—". */
function fmtRespawn(secs: number): string {
  if (secs <= 0) return "—";
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

function fmtChance(chance: number): string {
  return chance >= 1 ? `${Math.round(chance)}%` : `${chance.toFixed(1)}%`;
}

/** Look up an item in the Drops tab (Dashboard listens for this event). */
function openDrops(name: string) {
  window.dispatchEvent(new CustomEvent("eqlogs-open-drops", { detail: name }));
}

/** Clickable item name that deep-links into the Drops tab. */
function ItemLink({
  name,
  itemtype,
  slots,
}: {
  name: string;
  itemtype?: number | null;
  slots?: number | null;
}) {
  return (
    <span className="refdb-item">
      <ItemTypeIcon itemtype={itemtype} slots={slots} />
      <button
        className="session-item-link"
        title="Look up this item in the Drops tab"
        onClick={() => openDrops(name)}
      >
        {name}
      </button>
    </span>
  );
}

export default function MobsTab({
  searchRequest,
}: {
  /** Deep-link (e.g. a mob name clicked in the Drops tab); bump seq to re-trigger. */
  searchRequest?: { query: string; seq: number } | null;
}) {
  const [query, setQuery] = useState("");
  const [eraMax] = useEraMax();
  const [minLevel, setMinLevel] = useState(0);
  const [maxLevel, setMaxLevel] = useState(0);
  const [zone, setZone] = useState("");
  const [liveZoneEnabled] = useLiveZoneEnabled();
  const [liveZoneName] = useLiveZoneName();
  const [zones, setZones] = useState<DropZone[]>([]);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<MobRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [detail, setDetail] = useState<MobDetail | null>(null);
  /** Zone-info header expansion + lazily fetched almanac. */
  const [zoneInfoOpen, setZoneInfoOpen] = useState(false);
  const [zoneInfo, setZoneInfo] = useState<ZoneInfo | null>(null);
  const debounce = useRef<number | null>(null);

  useEffect(() => {
    dropsZones().then(setZones).catch(() => {});
  }, []);

  // Deep-link: clean lookup for the requested mob name.
  useEffect(() => {
    if (!searchRequest) return;
    setQuery(searchRequest.query);
    setZone("");
    setMinLevel(0);
    setMaxLevel(0);
    setPage(0);
    setExpanded(null);
  }, [searchRequest]);

  const active =
    query.trim().length >= 2 || zone !== "" || minLevel > 0 || maxLevel > 0;

  useEffect(() => {
    if (debounce.current) window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => {
      if (!active) {
        setRows([]);
        setTotal(0);
        setError(null);
        return;
      }
      refdbMobSearch({
        query: query.trim(),
        eraMax,
        minLevel,
        maxLevel,
        zone,
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
  }, [active, query, eraMax, minLevel, maxLevel, zone, page]);

  // The almanac belongs to the selected zone: drop it when that changes.
  useEffect(() => {
    setZoneInfo(null);
    setZoneInfoOpen(false);
  }, [zone]);

  function resetPaging() {
    setPage(0);
    setExpanded(null);
  }

  const liveZoneShort = useMemo(
    () => resolveLiveZoneShortName(liveZoneName, zones),
    [liveZoneName, zones],
  );
  // Follow the live zone only when it CHANGES (zoning, or toggle flipped on):
  // a manual pick in the zone dropdown must stick, not snap back.
  const appliedLiveZone = useRef<string | null>(null);
  useEffect(() => {
    if (!liveZoneEnabled || !liveZoneShort) {
      appliedLiveZone.current = null;
      return;
    }
    if (appliedLiveZone.current === liveZoneShort) return;
    appliedLiveZone.current = liveZoneShort;
    if (zone !== liveZoneShort) {
      setZone(liveZoneShort);
      resetPaging();
    }
  }, [liveZoneEnabled, liveZoneShort, zone]);

  function toggleZoneInfo() {
    const next = !zoneInfoOpen;
    setZoneInfoOpen(next);
    if (next && zoneInfo === null && zone !== "") {
      refdbZoneInfo(zone)
        .then(setZoneInfo)
        .catch((e) => setError(String(e)));
    }
  }

  function toggleExpand(id: number) {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    setDetail(null);
    refdbMobDetail(id)
      .then(setDetail)
      .catch((e) => setError(String(e)));
  }

  function clearAll() {
    setQuery("");
    setMinLevel(0);
    setMaxLevel(0);
    setZone("");
    resetPaging();
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const shownZones = useMemo(
    () => zones.filter((z) => z.era <= eraMax || z.shortName === zone),
    [zones, eraMax, zone],
  );
  const zoneLong =
    zones.find((z) => z.shortName === zone)?.longName ?? zone;
  const expandedRow = rows.find((r) => r.id === expanded) ?? null;

  return (
    <div className="card drops-card">
      <div className="card-head">
        <span className="section-title">Mobs</span>
        <span className="hint">
          Classic-era reference data (ProjectEQ) — Legends spawns, levels and
          loot may differ.
        </span>
      </div>
      <div className="drops-controls">
        <input
          type="search"
          placeholder="Search mobs by name…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            resetPaging();
          }}
        />
        <label className="mobs-level" title="Minimum mob level (0 = any)">
          Level
          <input
            type="number"
            min={0}
            max={125}
            value={minLevel}
            onChange={(e) => {
              setMinLevel(Math.max(0, Number(e.target.value) || 0));
              resetPaging();
            }}
          />
          –
          <input
            type="number"
            min={0}
            max={125}
            value={maxLevel}
            title="Maximum mob level (0 = any)"
            onChange={(e) => {
              setMaxLevel(Math.max(0, Number(e.target.value) || 0));
              resetPaging();
            }}
          />
        </label>
        <div className="mobs-zone">
          <SearchSelect
            value={zone}
            anyLabel="Any zone"
            options={shownZones.map((z) => ({
              value: z.shortName,
              label: z.longName,
            }))}
            onChange={(v) => {
              setZone(v);
              resetPaging();
            }}
          />
        </div>
        <EraSelect />
        {(query !== "" || zone !== "" || minLevel > 0 || maxLevel > 0) && (
          <button className="ghost small" onClick={clearAll}>
            Clear
          </button>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      {zone !== "" && (
        <div className="zoneinfo">
          <button
            className="zoneinfo-head"
            onClick={toggleZoneInfo}
            aria-expanded={zoneInfoOpen}
          >
            <span className="zoneinfo-caret" aria-hidden="true">
              {zoneInfoOpen ? "▾" : "▸"}
            </span>
            <span className="zoneinfo-name">{zoneLong}</span>
            <span className="hint">
              zone info — connections, forage, fishing, named mobs
            </span>
          </button>
          {zoneInfoOpen &&
            (zoneInfo === null ? (
              <div className="hint">Loading zone info…</div>
            ) : (
              <div className="zoneinfo-cols">
                {zoneInfo.connections.length > 0 && (
                  <div>
                    <div className="refdb-subhead">Connects to</div>
                    <div className="zoneinfo-list">
                      {zoneInfo.connections.map((c) => (
                        <span key={c.zone}>
                          <button
                            className="session-item-link"
                            title="Filter mobs to this zone"
                            onClick={() => {
                              setZone(c.zone);
                              resetPaging();
                            }}
                          >
                            {c.zoneLong ?? c.zone}
                          </button>
                          {c.era != null && c.era > 0 ? (
                            <span className="drops-badge">
                              {ERA_NAMES[c.era]}
                            </span>
                          ) : null}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {zoneInfo.forage.length > 0 && (
                  <div>
                    <div className="refdb-subhead">Forage</div>
                    <div className="zoneinfo-list">
                      {zoneInfo.forage.map((f) => (
                        <span key={f.itemId} className="zoneinfo-gather">
                          <ItemLink name={f.item} />
                          <span className="num hint">{fmtChance(f.chance)}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {zoneInfo.fishing.length > 0 && (
                  <div>
                    <div className="refdb-subhead">Fishing</div>
                    <div className="zoneinfo-list">
                      {zoneInfo.fishing.map((f) => (
                        <span key={f.itemId} className="zoneinfo-gather">
                          <ItemLink name={f.item} />
                          <span className="num hint">{fmtChance(f.chance)}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {zoneInfo.namedMobs.length > 0 && (
                  <div>
                    <div className="refdb-subhead">Named mobs</div>
                    <div className="zoneinfo-list">
                      {zoneInfo.namedMobs.map((m) => (
                        <span key={m.id} className="zoneinfo-gather">
                          <button
                            className="session-item-link"
                            title="Search this mob"
                            onClick={() => {
                              setQuery(m.name);
                              resetPaging();
                            }}
                          >
                            {m.name}
                          </button>
                          <span className="num hint">
                            L{m.level} · {fmtRespawn(m.respawnSecs)}
                          </span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {zoneInfo.connections.length === 0 &&
                  zoneInfo.forage.length === 0 &&
                  zoneInfo.fishing.length === 0 &&
                  zoneInfo.namedMobs.length === 0 && (
                    <div className="hint">
                      No zone details recorded for this zone.
                    </div>
                  )}
              </div>
            ))}
        </div>
      )}

      {!active ? (
        <Empty
          title="Search the mob database"
          body="Type a mob name (2+ characters), pick a zone, or set a level range to browse spawns — where they pop, how fast they respawn, what they drop and sell. Classic-era emulator data: a guide, not gospel."
        />
      ) : rows.length === 0 ? (
        <Empty
          title="No matches"
          body="No mobs match these filters — try widening the era or level range, or clearing the zone."
        />
      ) : (
        <>
          <div className="drops-table">
            <div
              className="drops-row drops-head"
              style={{ gridTemplateColumns: GRID_TEMPLATE }}
              aria-hidden="true"
            >
              <span className="drops-col-btn">Name</span>
              <span className="drops-col-btn num">Level</span>
              <span className="drops-col-btn">Zone</span>
              <span className="drops-col-btn num">Loot</span>
              <span className="drops-col-btn num">Respawn</span>
            </div>
            {rows.map((m) => (
              <div key={m.id}>
                <button
                  className={`drops-row drops-item${expanded === m.id ? " active" : ""}`}
                  style={{ gridTemplateColumns: GRID_TEMPLATE }}
                  onClick={() => toggleExpand(m.id)}
                >
                  <span className="drops-name">
                    {m.named === 1 ? (
                      <span className="mob-star" title="Named / rare spawn">
                        ★
                      </span>
                    ) : null}
                    {m.name}
                    {m.merchant ? (
                      <span className="drops-badge">VENDOR</span>
                    ) : null}
                  </span>
                  <span className="num">{m.level || "—"}</span>
                  <span className="drops-topsource" title={m.topZone ?? undefined}>
                    {m.topZone ?? "(no known spawn)"}
                  </span>
                  <span className="num">{m.lootCount || ""}</span>
                  <span className="num">{fmtRespawn(m.respawnSecs)}</span>
                </button>
                {expanded === m.id && (
                  <div className="drops-detail">
                    {detail === null ? (
                      <div className="hint">Loading mob detail…</div>
                    ) : (
                      <>
                        <div className="drops-spec">
                          <SpecRow
                            label="Level"
                            value={String(detail.level || "—")}
                          />
                          {detail.faction && (
                            <SpecRow label="Faction" value={detail.faction} />
                          )}
                          <SpecRow
                            label="Respawn"
                            value={fmtRespawn(
                              expandedRow?.respawnSecs ??
                                detail.zones[0]?.respawnSecs ??
                                0,
                            )}
                          />
                        </div>
                        <ResourceLinks kind="mob" name={detail.name} />
                        {detail.zones.length > 0 && (
                          <>
                            <div className="refdb-subhead">Spawns in</div>
                            <div className="refdb-rows">
                              {detail.zones.map((z, i) => (
                                <div
                                  key={i}
                                  className="refdb-row"
                                  style={{
                                    gridTemplateColumns: "1.4fr 64px 68px",
                                  }}
                                >
                                  <span>
                                    {z.zoneLong ?? z.zone}
                                    {z.era != null && z.era > 0 ? (
                                      <span className="drops-badge">
                                        {ERA_NAMES[z.era]}
                                      </span>
                                    ) : null}
                                  </span>
                                  <span className="num">
                                    {z.spawns > 0
                                      ? `${z.spawns} spawn${z.spawns === 1 ? "" : "s"}`
                                      : ""}
                                  </span>
                                  <span className="num">
                                    {fmtRespawn(z.respawnSecs)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </>
                        )}
                        {detail.loot.length > 0 ? (
                          <>
                            <div className="refdb-subhead">Loot</div>
                            <div className="refdb-rows">
                              {detail.loot.map((it) => (
                                <div
                                  key={it.itemId}
                                  className="refdb-row"
                                  style={{ gridTemplateColumns: "1fr 64px" }}
                                >
                                  <ItemLink
                                    name={it.item}
                                    itemtype={it.itemtype}
                                    slots={it.slots}
                                  />
                                  <span className="num">
                                    {fmtChance(it.chance)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </>
                        ) : (
                          <div className="hint">No known drops.</div>
                        )}
                        {detail.sells.length > 0 && (
                          <>
                            <div className="refdb-subhead">Sells</div>
                            <div className="zoneinfo-list">
                              {detail.sells.map((s) => (
                                <ItemLink key={s.itemId} name={s.item} />
                              ))}
                            </div>
                          </>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="drops-pager">
            <span className="hint num">
              {total} mob{total === 1 ? "" : "s"}
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
