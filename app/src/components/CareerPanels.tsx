// Career panels for the Session tab (docs/career-db-design.md §7): the
// "Career" panel (summary stat tiles, level timeline, career trend
// sparklines, paged sessions table) and the "Loot ledger" panel (searchable
// loot ledger + per-mob kills with expandable observed drop counts).
//
// Data comes from the career DB via the career_* commands — durable imported
// history, unlike lib/sessionLog's app-run state. Panels read on mount and
// refresh once when an import finishes (the final done "career-import-
// progress" event); they never poll. All timestamps are log-domain epoch
// seconds and go through the UTC-getter formatters in lib/career.

import { useCallback, useEffect, useState } from "react";
import {
  careerLevelTimeline,
  careerLoot,
  careerMobDrops,
  careerMobKills,
  careerSessions,
  careerSummary,
  onCareerChanged,
} from "../api";
import { fmtDuration, fmtNum, useDebouncedValue, useTauriEvent } from "../hooks";
import {
  buildLevelTimeline,
  careerTrendInputs,
  fmtLogDate,
  fmtLogDateTime,
  fmtObservedDrops,
  lootDisposition,
  maxLevelSecs,
} from "../lib/career";
import { openDrops, openSettingsSection } from "../lib/deepLinks";
import {
  buildTrendSeries,
  fmtTrendValue,
  sparklineLayout,
  TREND_SESSION_CAP,
} from "../lib/trends";
import { fmtCopperAmount } from "../lib/wallet";
import type {
  CareerImportProgress,
  CareerLevelUp,
  CareerLootRow,
  CareerMobDrop,
  CareerMobKills,
  CareerSession,
  CareerSummary,
} from "../types";
import Empty from "./Empty";
import { StatTile } from "./MeterTable";
import Pager from "./Pager";

const SESSION_PAGE = 10;
const LOOT_PAGE = 12;
const MOB_PAGE = 10;
/** Keystroke → query debounce for the DB-backed searches. */
const SEARCH_DEBOUNCE_MS = 200;

/** Bump a reload seq once per finished import file and on same-window
 *  import/reset completion (no polling). */
function useImportRefresh(reload: () => void): void {
  useTauriEvent<CareerImportProgress>("career-import-progress", (p) => {
    if (p.done && !p.error) reload();
  });
  useEffect(() => onCareerChanged(reload), [reload]);
}

/** Empty-state action: jump to Settings → General (the import block). */
function ImportCta() {
  return (
    <button className="ghost" onClick={() => openSettingsSection("general")}>
      Import log history
    </button>
  );
}

// ---------------------------------------------------------------------------
// Career panel
// ---------------------------------------------------------------------------

export function CareerPanel() {
  const [loaded, setLoaded] = useState(false);
  const [summary, setSummary] = useState<CareerSummary | null>(null);
  const [levelUps, setLevelUps] = useState<CareerLevelUp[]>([]);
  const [trendSessions, setTrendSessions] = useState<CareerSession[]>([]);
  const [page, setPage] = useState(0);
  const [sessionsPage, setSessionsPage] = useState<{
    total: number;
    rows: CareerSession[];
  }>({ total: 0, rows: [] });
  const [seq, setSeq] = useState(0);
  const reload = useCallback(() => setSeq((s) => s + 1), []);
  useImportRefresh(reload);

  useEffect(() => {
    let stale = false;
    void (async () => {
      const [sum, ups, trend] = await Promise.all([
        careerSummary(),
        careerLevelTimeline(),
        careerSessions(TREND_SESSION_CAP, 0).catch(() => ({
          total: 0,
          rows: [] as CareerSession[],
        })),
      ]);
      if (stale) return;
      setSummary(sum);
      setLevelUps(ups);
      setTrendSessions(trend.rows);
      setLoaded(true);
    })();
    return () => {
      stale = true;
    };
  }, [seq]);

  useEffect(() => {
    let stale = false;
    careerSessions(SESSION_PAGE, page * SESSION_PAGE)
      .then((r) => {
        if (!stale) setSessionsPage(r);
      })
      .catch(() => {
        if (!stale) setSessionsPage({ total: 0, rows: [] });
      });
    return () => {
      stale = true;
    };
  }, [page, seq]);

  if (!loaded) {
    return (
      <section className="card coach-span">
        <div className="card-head">
          <span className="section-title">Career</span>
        </div>
        <div className="hint">Loading career history…</div>
      </section>
    );
  }

  if (!summary || summary.sessions === 0) {
    return (
      <section className="card coach-span">
        <div className="card-head">
          <span className="section-title">Career</span>
        </div>
        <Empty
          title="No career history yet"
          body="Import your existing EQ log files once and months of sessions, level-ups, loot, and kills are reconstructed here — then each import only reads what's new."
          action={<ImportCta />}
        />
      </section>
    );
  }

  const timeline = buildLevelTimeline(levelUps);
  const levelMax = maxLevelSecs(timeline);
  const series = buildTrendSeries(careerTrendInputs(trendSessions));
  const chartable = series.some((s) => s.points.length >= 2);
  const pages = Math.max(1, Math.ceil(sessionsPage.total / SESSION_PAGE));
  const span =
    summary.firstTs !== null && summary.lastTs !== null
      ? `${fmtLogDate(summary.firstTs)} – ${fmtLogDate(summary.lastTs)}`
      : null;

  return (
    <section className="card coach-span">
      <div className="card-head">
        <span className="section-title">Career</span>
        <span className="hint num">
          {summary.character}
          {summary.server ? ` · ${summary.server}` : ""}
          {span ? ` · ${span}` : ""}
        </span>
      </div>

      <div className="stat-tiles compact">
        <StatTile value={fmtNum(summary.sessions)} label="Sessions" />
        <StatTile
          value={fmtDuration(summary.totalDurationSecs)}
          label="Play time"
        />
        <StatTile value={fmtNum(summary.kills)} label="Kills" />
        <StatTile value={fmtNum(summary.deaths)} label="Deaths" />
        <StatTile
          value={`+${fmtTrendValue(summary.xpPercent)}%`}
          label="XP observed"
        />
        <StatTile
          value={summary.endLevel === null ? "—" : String(summary.endLevel)}
          label={`Level · ${summary.levelUps} ding${summary.levelUps === 1 ? "" : "s"}`}
        />
        <StatTile value={fmtCopperAmount(summary.coinCopper)} label="Coin" />
        <StatTile value={fmtNum(summary.lootCount)} label="Loot" />
      </div>

      {timeline.length > 0 && (
        <>
          <div className="card-head">
            <span className="section-title">Level timeline</span>
            <span className="hint">Time per level, ding to ding</span>
          </div>
          <div className="career-levels">
            {timeline.map((row) => (
              <div className="career-level-row" key={`${row.level}:${row.ts}`}>
                <span className="career-level-label num">Lv {row.level}</span>
                <span className="career-level-bar-wrap">
                  {row.secsInPrev !== null && (
                    <span
                      className="career-level-bar"
                      style={{
                        width: `${levelMax > 0 ? Math.max(1, (row.secsInPrev / levelMax) * 100) : 0}%`,
                      }}
                    />
                  )}
                </span>
                <span className="career-level-time num">
                  {row.secsInPrev === null ? "—" : fmtDuration(row.secsInPrev)}
                </span>
                <span className="career-level-date hint num">
                  {fmtLogDate(row.ts)}
                </span>
              </div>
            ))}
          </div>
          <div className="hint">
            Bars measure calendar time between dings — time away from the
            game counts. The first observed ding has no known level start,
            so it shows no bar.
          </div>
        </>
      )}

      {chartable && (
        <>
          <div className="card-head">
            <span className="section-title">Career trends</span>
            <span className="hint">
              Per-session rates, oldest → newest (last {TREND_SESSION_CAP})
            </span>
          </div>
          <div className="trend-grid">
            {series.map((s) => {
              const layout = sparklineLayout(
                s.points.map((p) => p.value),
                240,
                56,
                4,
              );
              const hasData = s.points.some((p) => p.value !== null);
              if (!hasData) return null;
              return (
                <div className="trend-chart" key={s.id}>
                  <div className="trend-head">
                    <span className="trend-label">{s.label}</span>
                    <span className="trend-latest num">
                      {s.latest === null
                        ? "—"
                        : `${fmtTrendValue(s.latest)}${s.unit}`}
                    </span>
                  </div>
                  <svg
                    className="trend-spark"
                    viewBox="0 0 240 56"
                    role="img"
                    aria-label={`${s.label} per hour across career sessions`}
                  >
                    <line
                      className="trend-baseline"
                      x1="4"
                      y1="52"
                      x2="236"
                      y2="52"
                    />
                    {layout.path && <path className="trend-line" d={layout.path} />}
                    {layout.points.map((pt, i) => {
                      if (!pt) return null;
                      const point = s.points[i];
                      const ding = s.id === "xp" && point.levelUps > 0;
                      return (
                        <g key={point.id}>
                          <title>
                            {`${fmtLogDateTime(point.startedTs / 1000)} — ${
                              point.value === null
                                ? "—"
                                : fmtTrendValue(point.value)
                            }${s.unit}${
                              ding
                                ? ` · ${point.levelUps} level-up${point.levelUps === 1 ? "" : "s"}`
                                : ""
                            }`}
                          </title>
                          <circle className="trend-hit" cx={pt.x} cy={pt.y} r="7" />
                          <circle
                            className={ding ? "trend-ding" : "trend-dot"}
                            cx={pt.x}
                            cy={pt.y}
                            r={ding ? 3.5 : 2}
                          />
                        </g>
                      );
                    })}
                  </svg>
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="card-head">
        <span className="section-title">Sessions</span>
        <span className="hint">Newest first</span>
      </div>
      <div className="session-loot">
        <div className="career-session-row session-loot-head" aria-hidden="true">
          <span>When</span>
          <span className="num">Time</span>
          <span>Zones</span>
          <span className="num">Kills</span>
          <span className="num">Deaths</span>
          <span className="num">XP</span>
          <span className="num">Coin</span>
          <span className="num">Loot</span>
        </div>
        {sessionsPage.rows.map((s) => (
          <div className="career-session-row" key={s.id}>
            <span className="num">{fmtLogDateTime(s.startTs)}</span>
            <span className="num">{fmtDuration(s.durationSecs)}</span>
            <span className="session-item" title={s.sourceFile}>
              {s.zones.join(", ") || "—"}
            </span>
            <span className="num">{fmtNum(s.kills)}</span>
            <span className="num">{s.deaths}</span>
            <span className="num">
              +{s.xpPercent.toFixed(2)}%
              {s.levelUps > 0 && (
                <span
                  className="career-ding-chip"
                  title={`${s.levelUps} level-up${s.levelUps === 1 ? "" : "s"} this session`}
                >
                  {s.levelUps}× ding
                </span>
              )}
            </span>
            <span className="num">{fmtCopperAmount(s.coinCopper)}</span>
            <span className="num">{s.lootCount}</span>
          </div>
        ))}
      </div>
      <Pager
        count={`${sessionsPage.total} session${sessionsPage.total === 1 ? "" : "s"}`}
        page={page}
        pages={pages}
        onPage={setPage}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Loot ledger panel
// ---------------------------------------------------------------------------

export function LootLedgerPanel() {
  const [loaded, setLoaded] = useState(false);
  const [hasData, setHasData] = useState(false);
  const [lootQuery, setLootQuery] = useState("");
  const lootSearch = useDebouncedValue(lootQuery, SEARCH_DEBOUNCE_MS);
  const [lootPage, setLootPage] = useState(0);
  const [loot, setLoot] = useState<{ total: number; rows: CareerLootRow[] }>({
    total: 0,
    rows: [],
  });
  const [mobQuery, setMobQuery] = useState("");
  const mobSearch = useDebouncedValue(mobQuery, SEARCH_DEBOUNCE_MS);
  const [mobPage, setMobPage] = useState(0);
  const [mobs, setMobs] = useState<{ total: number; rows: CareerMobKills[] }>({
    total: 0,
    rows: [],
  });
  const [expandedMob, setExpandedMob] = useState<string | null>(null);
  const [drops, setDrops] = useState<CareerMobDrop[]>([]);
  const [seq, setSeq] = useState(0);
  const reload = useCallback(() => setSeq((s) => s + 1), []);
  useImportRefresh(reload);

  // New search text restarts paging.
  useEffect(() => setLootPage(0), [lootSearch]);
  useEffect(() => setMobPage(0), [mobSearch]);

  useEffect(() => {
    let stale = false;
    careerSummary().then((s) => {
      if (stale) return;
      setHasData(s !== null && (s.lootCount > 0 || s.kills > 0));
      setLoaded(true);
    });
    return () => {
      stale = true;
    };
  }, [seq]);

  useEffect(() => {
    let stale = false;
    careerLoot(lootSearch, LOOT_PAGE, lootPage * LOOT_PAGE)
      .then((r) => {
        if (!stale) setLoot(r);
      })
      .catch(() => {
        if (!stale) setLoot({ total: 0, rows: [] });
      });
    return () => {
      stale = true;
    };
  }, [lootSearch, lootPage, seq]);

  useEffect(() => {
    let stale = false;
    careerMobKills(mobSearch, MOB_PAGE, mobPage * MOB_PAGE)
      .then((r) => {
        if (!stale) setMobs(r);
      })
      .catch(() => {
        if (!stale) setMobs({ total: 0, rows: [] });
      });
    return () => {
      stale = true;
    };
  }, [mobSearch, mobPage, seq]);

  useEffect(() => {
    if (expandedMob === null) {
      setDrops([]);
      return;
    }
    let stale = false;
    careerMobDrops(expandedMob).then((r) => {
      if (!stale) setDrops(r);
    });
    return () => {
      stale = true;
    };
  }, [expandedMob, seq]);

  if (!loaded) {
    return (
      <section className="card coach-span">
        <div className="card-head">
          <span className="section-title">Loot ledger</span>
        </div>
        <div className="hint">Loading career loot…</div>
      </section>
    );
  }

  if (!hasData) {
    return (
      <section className="card coach-span">
        <div className="card-head">
          <span className="section-title">Loot ledger</span>
        </div>
        <Empty
          title="No career loot yet"
          body="Import your log history and every item you ever looted lands here — searchable, with per-mob kill counts and observed drops."
          action={<ImportCta />}
        />
      </section>
    );
  }

  const lootPages = Math.max(1, Math.ceil(loot.total / LOOT_PAGE));
  const mobPages = Math.max(1, Math.ceil(mobs.total / MOB_PAGE));

  return (
    <section className="card coach-span">
      <div className="card-head">
        <span className="section-title">Loot ledger</span>
        <input
          type="search"
          className="session-search"
          placeholder="Search items…"
          value={lootQuery}
          onChange={(e) => setLootQuery(e.target.value)}
          aria-label="Search career loot"
        />
      </div>
      {loot.rows.length === 0 ? (
        <Empty
          title="No matches"
          body="No looted item matches that search."
        />
      ) : (
        <div className="session-loot">
          <div className="career-loot-row session-loot-head" aria-hidden="true">
            <span>When</span>
            <span>Item</span>
            <span>Mob</span>
            <span>Kept / sold</span>
          </div>
          {loot.rows.map((l) => (
            <div className="career-loot-row" key={l.id}>
              <span className="session-time num">{fmtLogDateTime(l.ts)}</span>
              <span className="session-item">
                {l.quantity > 1 && (
                  <span className="session-qty num">{l.quantity}×</span>
                )}
                <button
                  className="session-item-link"
                  title="Look up in the Drops database"
                  onClick={() => openDrops(l.item)}
                >
                  {l.item}
                </button>
              </span>
              <span className="session-who">{l.corpse ?? "—"}</span>
              <span className="num">{lootDisposition(l)}</span>
            </div>
          ))}
        </div>
      )}
      <Pager
        count={`${loot.total} loot event${loot.total === 1 ? "" : "s"}`}
        page={lootPage}
        pages={lootPages}
        onPage={setLootPage}
      />

      <div className="card-head">
        <span className="section-title">Kills by mob</span>
        <input
          type="search"
          className="session-search"
          placeholder="Search mobs…"
          value={mobQuery}
          onChange={(e) => setMobQuery(e.target.value)}
          aria-label="Search career mob kills"
        />
      </div>
      {mobs.rows.length === 0 ? (
        <Empty title="No matches" body="No mob matches that search." />
      ) : (
        <div className="session-loot">
          <div className="career-mob-row session-loot-head" aria-hidden="true">
            <span>Mob</span>
            <span className="num">Kills</span>
            <span className="num">Drops seen</span>
            <span className="num">Items</span>
            <span className="num">Last</span>
          </div>
          {mobs.rows.map((m) => {
            const expanded = expandedMob === m.mob;
            return (
              <div key={m.mob.toLowerCase()}>
                <button
                  type="button"
                  className={`career-mob-row career-mob-toggle${expanded ? " expanded" : ""}`}
                  onClick={() => setExpandedMob(expanded ? null : m.mob)}
                  title={
                    expanded
                      ? "Hide observed drops"
                      : "Show observed drops off this mob"
                  }
                >
                  <span className="session-item">
                    <span className="career-mob-caret" aria-hidden="true">
                      {expanded ? "▾" : "▸"}
                    </span>
                    {m.mob}
                  </span>
                  <span className="num">{fmtNum(m.kills)}</span>
                  <span className="num">{fmtNum(m.lootDrops)}</span>
                  <span className="num">{m.distinctItems}</span>
                  <span className="num">{fmtLogDate(m.lastTs)}</span>
                </button>
                {expanded && (
                  <div className="career-mob-drops">
                    {drops.length === 0 ? (
                      <div className="hint">
                        No loot observed off this mob yet.
                      </div>
                    ) : (
                      drops.map((d) => (
                        <div className="career-drop-row" key={d.item}>
                          <button
                            className="session-item-link"
                            title="Look up in the Drops database"
                            onClick={() => openDrops(d.item)}
                          >
                            {d.item}
                          </button>
                          <span className="num">
                            {fmtObservedDrops(d.count, m.kills)}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <Pager
        count={`${mobs.total} mob${mobs.total === 1 ? "" : "s"}`}
        page={mobPage}
        pages={mobPages}
        onPage={setMobPage}
      />
      <div className="hint">
        Observed counts only — loot you were present to see, not reference
        drop rates. &ldquo;12× in 87 kills&rdquo; means 12 drops were seen
        across your 87 recorded kills.
      </div>
    </section>
  );
}
