// Fight history browser (NOW-sprint item 2): paginated list of persisted
// fights (newest first) with a detail view that reuses the meter table.

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getFight, listFights, pasteParse } from "../api";
import { fmtClock, fmtDuration, fmtNum, useTauriEvent } from "../hooks";
import { IS_MOCK } from "../mock";
import type { FightRecord, FightUpdatePayload, LogLinePayload } from "../types";
import Empty from "./Empty";
import MeterTable, { StatTile } from "./MeterTable";

// ---------------------------------------------------------------------------
// Session tracker (APP_REVIEW X10): in-memory loot log + /random roll tracker,
// scoped to this app run (resets on restart). Fed by the "log-line" stream —
// the same events the live feed consumes — so it survives tab switches while
// this always-mounted component stays alive.
// ---------------------------------------------------------------------------

interface LootEntry {
  id: number;
  ts: number;
  item: string;
  qty: number;
  /** Looter (normalized "You" or a player/pet name). */
  who: string;
  /** Corpse the item came off, when the line carried one. */
  corpse: string | null;
}

interface RollEntry {
  id: number;
  ts: number;
  roller: string;
  min: number;
  max: number;
  result: number;
}

/** Read a serde-encoded eqlog-core Entity: "You" (bare string) or
 *  { Named: "<name>" }. */
function entityName(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "Named" in e) {
    return String((e as { Named: unknown }).Named);
  }
  return "?";
}

const SESSION_CAP = 200;

const PAGE_SIZE = 25;

/** "14:22" today, "Jul 1, 14:22" otherwise. */
function fmtWhen(ts: number): string {
  if (ts <= 0) return "—";
  const d = new Date(ts * 1000);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return hm;
  const month = d.toLocaleString(undefined, { month: "short" });
  return `${month} ${d.getDate()}, ${hm}`;
}

/** Mock-only: ?fight=<id> opens the detail view for screenshots. */
const FIGHT_DEMO: number | null = (() => {
  if (!IS_MOCK) return null;
  const v = new URLSearchParams(window.location.search).get("fight");
  const n = v === null ? NaN : parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
})();

/** Collapsed/expanded state for a Fights-tab section, persisted so the user's
 *  preferred layout sticks across launches. */
function useCollapsed(key: string, defaultCollapsed = false) {
  const storageKey = `fights.collapsed.${key}`;
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(storageKey);
      return v === null ? defaultCollapsed : v === "1";
    } catch {
      return defaultCollapsed;
    }
  });
  const toggle = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(storageKey, next ? "1" : "0");
      } catch {
        /* private mode / disabled storage — collapse still works this session */
      }
      return next;
    });
  }, [storageKey]);
  return [collapsed, toggle] as const;
}

/** A card whose header toggles its body. Collapsed headers keep the count badge
 *  visible so you know there's content without expanding; header controls
 *  (search, refresh) hide while collapsed. */
function Collapsible({
  title,
  count,
  storageKey,
  defaultCollapsed = false,
  headerAside,
  children,
}: {
  title: string;
  count?: number | null;
  storageKey: string;
  defaultCollapsed?: boolean;
  headerAside?: ReactNode;
  children: ReactNode;
}) {
  const [collapsed, toggle] = useCollapsed(storageKey, defaultCollapsed);
  return (
    <div className={`card collapsible${collapsed ? " is-collapsed" : ""}`}>
      <div className="card-head collapsible-head">
        <button
          type="button"
          className="collapsible-toggle"
          onClick={toggle}
          aria-expanded={!collapsed}
        >
          <span className="collapsible-chevron" aria-hidden="true">
            {collapsed ? "▸" : "▾"}
          </span>
          <span className="section-title">{title}</span>
          {count != null && count > 0 && (
            <span className="collapsible-count num">{count}</span>
          )}
        </button>
        {!collapsed && headerAside && (
          <span className="collapsible-aside">{headerAside}</span>
        )}
      </div>
      {!collapsed && <div className="collapsible-body">{children}</div>}
    </div>
  );
}

export default function FightsTab({ character }: { character: string }) {
  const [page, setPage] = useState(0);
  const [fights, setFights] = useState<FightRecord[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [selected, setSelected] = useState<FightRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const prevActive = useRef(false);
  const demoSeeded = useRef(false);
  // Session-scope loot + rolls (newest first). Captured for the whole app run
  // regardless of which tab is showing (this component stays mounted).
  const [loot, setLoot] = useState<LootEntry[]>([]);
  const [rolls, setRolls] = useState<RollEntry[]>([]);
  const sessionSeq = useRef(0);

  useTauriEvent<LogLinePayload>("log-line", (p) => {
    const ev = p.event;
    if (typeof ev !== "object" || ev === null) return;
    if ("Loot" in ev) {
      const d = ev.Loot as Record<string, unknown>;
      const entry: LootEntry = {
        id: sessionSeq.current++,
        ts: p.ts,
        item: String(d.item ?? "?"),
        qty: typeof d.quantity === "number" ? d.quantity : 1,
        who: entityName(d.looter),
        corpse: d.corpse == null ? null : String(d.corpse),
      };
      setLoot((prev) => [entry, ...prev].slice(0, SESSION_CAP));
    } else if ("Roll" in ev) {
      const d = ev.Roll as Record<string, unknown>;
      const roller = String(d.roller ?? "").trim();
      const entry: RollEntry = {
        id: sessionSeq.current++,
        ts: p.ts,
        roller: roller || "Unknown",
        min: typeof d.min === "number" ? d.min : 0,
        max: typeof d.max === "number" ? d.max : 0,
        result: typeof d.result === "number" ? d.result : 0,
      };
      setRolls((prev) => [entry, ...prev].slice(0, SESSION_CAP));
    }
  });

  const load = useCallback((pageIx: number) => {
    listFights(PAGE_SIZE, pageIx * PAGE_SIZE)
      .then((p) => {
        setFights(p.fights);
        setTotal(p.total);
        setError(null);
      })
      .catch((e) => {
        setFights([]);
        setTotal(null);
        setError(String(e));
      });
  }, []);

  useEffect(() => load(page), [page, load]);

  // A fight just completed (live meter flipped active -> inactive): the
  // backend has persisted it, so refresh the first page.
  useTauriEvent<FightUpdatePayload>("fight-update", (p) => {
    if (prevActive.current && !p.active && page === 0) load(0);
    prevActive.current = p.active;
  });

  useEffect(() => {
    if (!toast) return;
    const h = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(h);
  }, [toast]);

  // Mock-only screenshot hook: open a fight's detail view directly.
  useEffect(() => {
    if (FIGHT_DEMO === null || demoSeeded.current) return;
    demoSeeded.current = true;
    getFight(FIGHT_DEMO)
      .then((f) => f && setSelected(f))
      .catch(() => {});
  }, []);

  async function copyParse(f: FightRecord) {
    try {
      const text = await pasteParse(f.id, {
        character,
        target: f.target,
        durationSecs: f.durationSecs,
        rows: f.rows,
      });
      await navigator.clipboard.writeText(text);
      setToast("Parse copied — paste it into chat");
    } catch {
      setToast("Could not copy to the clipboard");
    }
  }

  function yourDps(f: FightRecord): number | null {
    const you = f.rows.find(
      (r) => r.name.toLowerCase() === character.toLowerCase(),
    );
    return you ? you.dps : null;
  }

  // ---- detail view ----
  if (selected) {
    const dps = yourDps(selected);
    return (
      <>
        <div className="toolbar">
          <button className="ghost" onClick={() => setSelected(null)}>
            ← All fights
          </button>
          <span className="spacer" />
          <button
            className="ghost small"
            onClick={() => void copyParse(selected)}
            title="Copy this fight as chat-ready text (240-char lines)"
          >
            Copy parse
          </button>
        </div>
        <div className="stat-tiles">
          <StatTile value={fmtDuration(selected.durationSecs)} label="Fight duration" />
          <StatTile value={fmtNum(selected.totalDamage)} label="Total damage" />
          <StatTile value={dps === null ? "—" : fmtNum(dps)} label="Your DPS" />
          <StatTile value={fmtWhen(selected.startTs)} label="When" />
        </div>
        <div className="card">
          <div className="card-head">
            <span className="section-title">Damage — {selected.target}</span>
            {selected.targetSlain && <span className="slain-chip">slain</span>}
          </div>
          {selected.rows.length === 0 ? (
            <Empty title="No damage rows" body="This fight recorded no damage contributions." />
          ) : (
            <MeterTable rows={selected.rows} />
          )}
        </div>
        {toast && (
          <div className="toast" role="status">
            {toast}
          </div>
        )}
      </>
    );
  }

  // ---- list view ----
  const pageCount =
    total !== null ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : null;
  const hasNext =
    pageCount !== null
      ? page + 1 < pageCount
      : (fights?.length ?? 0) === PAGE_SIZE;

  return (
    <>
      {error && <div className="error-banner">{error}</div>}
      <Collapsible
        title="Fight history"
        count={total}
        storageKey="history"
        headerAside={
          <button className="ghost small" onClick={() => load(page)}>
            Refresh
          </button>
        }
      >
        {fights === null ? (
          <div className="hint">Loading fight history…</div>
        ) : fights.length === 0 ? (
          <Empty
            title="No fights recorded yet"
            body="Completed fights are saved here automatically while tailing. Finish a pull and it will appear at the top."
          />
        ) : (
          <div className="fight-list">
            <div className="fight-row fight-head" aria-hidden="true">
              <span>When</span>
              <span>Target</span>
              <span className="num">Duration</span>
              <span className="num">Your DPS</span>
              <span />
            </div>
            {fights.map((f) => {
              const dps = yourDps(f);
              return (
                <div
                  className="fight-row"
                  key={f.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelected(f)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") setSelected(f);
                  }}
                >
                  <span className="fight-when num">{fmtWhen(f.startTs)}</span>
                  <span className="fight-target">
                    {f.target}
                    {f.targetSlain && <span className="slain-chip">slain</span>}
                  </span>
                  <span className="num fight-num">{fmtDuration(f.durationSecs)}</span>
                  <span className="num fight-num">
                    {dps === null ? "—" : fmtNum(dps)}
                  </span>
                  <span className="fight-btns">
                    <button
                      className="ghost small"
                      onClick={(e) => {
                        e.stopPropagation();
                        void copyParse(f);
                      }}
                      title="Copy this fight as chat-ready text"
                    >
                      Copy parse
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        )}
        {fights !== null && fights.length > 0 && (
          <div className="fight-pager">
            <button
              className="ghost small"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              ← Newer
            </button>
            <span className="hint num">
              Page {page + 1}
              {pageCount !== null ? ` of ${pageCount}` : ""}
            </span>
            <button
              className="ghost small"
              disabled={!hasNext}
              onClick={() => setPage((p) => p + 1)}
            >
              Older →
            </button>
          </div>
        )}
      </Collapsible>
      <SessionSection loot={loot} rolls={rolls} />
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Session section: loot log + roll tracker cards.
// ---------------------------------------------------------------------------

interface RollLeader {
  roller: string;
  best: number;
  count: number;
}

interface RollGroup {
  /** "min-max", the /random range these rolls share. */
  range: string;
  min: number;
  max: number;
  /** Per-roller best result, highest first. */
  leaders: RollLeader[];
  /** Roller with the top result (ties: first seen); null when empty. */
  winner: string | null;
  /** Newest roll timestamp in the group (for ordering groups). */
  lastTs: number;
  count: number;
}

/** Group rolls by their range and rank each roller's best result. */
function groupRolls(rolls: RollEntry[]): RollGroup[] {
  const byRange = new Map<string, RollEntry[]>();
  for (const r of rolls) {
    const key = `${r.min}-${r.max}`;
    const list = byRange.get(key);
    if (list) list.push(r);
    else byRange.set(key, [r]);
  }
  const groups: RollGroup[] = [];
  for (const [range, list] of byRange) {
    const best = new Map<string, RollLeader>();
    for (const r of list) {
      const cur = best.get(r.roller);
      if (!cur) best.set(r.roller, { roller: r.roller, best: r.result, count: 1 });
      else {
        cur.count += 1;
        if (r.result > cur.best) cur.best = r.result;
      }
    }
    const leaders = [...best.values()].sort((a, b) => b.best - a.best);
    groups.push({
      range,
      min: list[0].min,
      max: list[0].max,
      leaders,
      winner: leaders.length > 0 ? leaders[0].roller : null,
      lastTs: Math.max(...list.map((r) => r.ts)),
      count: list.length,
    });
  }
  // Most recently active range first.
  return groups.sort((a, b) => b.lastTs - a.lastTs);
}

const RECENT_ROLLS = 12;

function SessionSection({
  loot,
  rolls,
}: {
  loot: LootEntry[];
  rolls: RollEntry[];
}) {
  const [lootQuery, setLootQuery] = useState("");

  const shownLoot = useMemo(() => {
    const q = lootQuery.trim().toLowerCase();
    if (!q) return loot;
    return loot.filter(
      (l) =>
        l.item.toLowerCase().includes(q) ||
        l.who.toLowerCase().includes(q) ||
        (l.corpse ?? "").toLowerCase().includes(q),
    );
  }, [loot, lootQuery]);

  const groups = useMemo(() => groupRolls(rolls), [rolls]);
  const recentRolls = useMemo(() => rolls.slice(0, RECENT_ROLLS), [rolls]);

  return (
    <div className="session-cards">
      <Collapsible
        title="Session loot"
        count={loot.length}
        storageKey="loot"
        headerAside={
          <input
            type="text"
            className="session-search"
            placeholder="Filter items or looter…"
            value={lootQuery}
            onChange={(e) => setLootQuery(e.target.value)}
            aria-label="Filter loot"
          />
        }
      >
        {loot.length === 0 ? (
          <Empty
            title="No loot yet"
            body="Items looted this session appear here, newest first. Loot something while tailing and it will show up."
          />
        ) : shownLoot.length === 0 ? (
          <Empty title="No matches" body="No looted item matches that filter." />
        ) : (
          <div className="session-loot">
            <div className="session-loot-row session-loot-head" aria-hidden="true">
              <span>Time</span>
              <span>Item</span>
              <span>Looter</span>
            </div>
            {shownLoot.map((l) => (
              <div className="session-loot-row" key={l.id}>
                <span className="session-time num">{fmtClock(l.ts)}</span>
                <span className="session-item">
                  {l.qty > 1 && <span className="session-qty num">{l.qty}×</span>}
                  {l.item}
                </span>
                <span className="session-who" title={l.corpse ?? undefined}>
                  {l.who}
                </span>
              </div>
            ))}
          </div>
        )}
      </Collapsible>

      <Collapsible title="Roll tracker" count={rolls.length} storageKey="rolls">
        {rolls.length === 0 ? (
          <Empty
            title="No rolls yet"
            body="/random rolls seen this session group by range here, with the top roll in each range marked."
          />
        ) : (
          <>
            {groups.map((g) => (
              <div className="roll-group" key={g.range}>
                <div className="roll-group-head">
                  <span className="roll-range">{g.range}</span>
                  <span className="hint num">
                    {g.count} roll{g.count === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="roll-board">
                  {g.leaders.map((ld) => (
                    <div
                      className={`roll-lead${
                        ld.roller === g.winner ? " roll-winner" : ""
                      }`}
                      key={ld.roller}
                    >
                      <span className="roll-lead-name">{ld.roller}</span>
                      <span className="roll-lead-best num">{ld.best}</span>
                      {ld.roller === g.winner && (
                        <span className="roll-win-tag">winner</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <div className="roll-recent">
              <div className="roll-recent-head">Recent rolls</div>
              {recentRolls.map((r) => (
                <div className="roll-recent-row" key={r.id}>
                  <span className="session-time num">{fmtClock(r.ts)}</span>
                  <span className="roll-recent-name">{r.roller}</span>
                  <span className="roll-recent-val num">
                    {r.result}
                    <span className="roll-recent-range"> ({r.min}-{r.max})</span>
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </Collapsible>
    </div>
  );
}
