// Fight history browser: paginated list of persisted fights (newest first)
// with a detail view that reuses the meter table, plus read-only offline log
// import (raid replay). Session-scoped data (loot, rolls, XP, kills, effects,
// death recaps, wishlist) lives on the Session tab, accumulated by
// lib/sessionLog regardless of which tab is mounted.

import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  analyzeLog,
  confirmDiscard,
  deleteFight,
  exportFight,
  getFight,
  listFights,
  pasteParse,
  pickLogFile,
  pruneFights,
} from "../api";
import { fmtDuration, fmtNum, useTauriEvent } from "../hooks";
import {
  incomingDamageRows,
  incomingDamageTotal,
  splitPetDamageRows,
} from "../lib/meterRows";
import { IS_MOCK } from "../mock";
import type { FightRecord, FightUpdatePayload } from "../types";
import Empty from "./Empty";
import MeterTable, { StatTile } from "./MeterTable";
import Modal from "./Modal";
import { useToast } from "./Toast";

const PAGE_SIZE = 25;

/** "14:22" today, "Jul 1, 14:22" otherwise. Log times are naive local encoded
 *  as UTC seconds (P18), so read them with UTC getters to recover the in-game
 *  wall-clock; the "today" test compares that local calendar date against the
 *  host's current local date. */
function fmtWhen(ts: number): string {
  if (ts <= 0) return "—";
  const d = new Date(ts * 1000);
  const now = new Date();
  const hm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(
    d.getUTCMinutes(),
  ).padStart(2, "0")}`;
  const sameDay =
    d.getUTCFullYear() === now.getFullYear() &&
    d.getUTCMonth() === now.getMonth() &&
    d.getUTCDate() === now.getDate();
  if (sameDay) return hm;
  const month = d.toLocaleString(undefined, {
    month: "short",
    timeZone: "UTC",
  });
  return `${month} ${d.getUTCDate()}, ${hm}`;
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
  const [toastNode, showToast] = useToast();
  // Fight awaiting its deferred backend delete (undo window, see deleteOne).
  const [pendingDelete, setPendingDelete] = useState<FightRecord | null>(null);
  // "Tell" parse dialog: which fight to format, and the recipient name.
  const [tellFor, setTellFor] = useState<FightRecord | null>(null);
  const [tellName, setTellName] = useState("");
  // Offline log import / raid replay (P26): a read-only set of fights parsed
  // from a chosen file, shown in place of live history until closed.
  const [imported, setImported] = useState<{
    file: string;
    fights: FightRecord[];
  } | null>(null);
  const [importing, setImporting] = useState(false);
  const prevActive = useRef(false);
  const demoSeeded = useRef(false);

  const load = useCallback((pageIx: number, retry = true) => {
    listFights(PAGE_SIZE, pageIx * PAGE_SIZE)
      .then((p) => {
        setFights(p.fights);
        setTotal(p.total);
        setError(null);
      })
      .catch((e) => {
        const message = String(e);
        if (retry && message.includes("database failed to open")) {
          window.setTimeout(() => load(pageIx, false), 500);
          return;
        }
        setFights([]);
        setTotal(null);
        setError(message);
      });
  }, []);

  useEffect(() => load(page), [page, load]);

  // A fight just completed (live meter flipped active -> inactive): the
  // backend has persisted it, so refresh the first page.
  useTauriEvent<FightUpdatePayload>("fight-update", (p) => {
    if (prevActive.current && !p.active && page === 0) load(0);
    prevActive.current = p.active;
  });

  // Undo window: commit the deferred delete when the toast expires.
  useEffect(() => {
    if (!pendingDelete) return;
    const h = window.setTimeout(() => {
      commitDelete(pendingDelete);
      setPendingDelete(null);
    }, 6000);
    return () => window.clearTimeout(h);
  }, [pendingDelete]);

  // Safety net: commit a still-pending delete if this component ever unmounts
  // mid-window.
  const pendingDeleteRef = useRef<FightRecord | null>(null);
  pendingDeleteRef.current = pendingDelete;
  useEffect(
    () => () => {
      const p = pendingDeleteRef.current;
      if (p) deleteFight(p.id).catch(() => {});
    },
    [],
  );

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
      // Imported fights carry negative ids and aren't stored — format locally.
      const text = await pasteParse(f.id >= 0 ? f.id : null, {
        character,
        target: f.target,
        durationSecs: f.durationSecs,
        rows: f.rows,
      });
      await navigator.clipboard.writeText(text);
      showToast("Parse copied — paste it into chat");
    } catch {
      showToast("Could not copy to the clipboard");
    }
  }

  // Per-fight delete with an undo window (mirrors the trigger-delete toast):
  // the row is hidden immediately but the backend delete is deferred until
  // the toast expires, so Undo simply reveals the row again — the store has
  // no restore command.
  function commitDelete(f: FightRecord) {
    setFights((prev) => (prev ? prev.filter((x) => x.id !== f.id) : prev));
    setTotal((t) => (t === null ? t : Math.max(0, t - 1)));
    deleteFight(f.id).catch(() => showToast("Could not delete that fight"));
  }

  function deleteOne(f: FightRecord) {
    if (pendingDelete && pendingDelete.id !== f.id) commitDelete(pendingDelete);
    if (selected?.id === f.id) setSelected(null);
    setPendingDelete(f);
    // The undo toast and the deferred-commit effect share the 6s window; the
    // effect is the authority — Undo just reveals the still-stored row.
    showToast(`Deleted “${f.target}”`, {
      undo: () => setPendingDelete(null),
    });
  }

  async function clearHistory() {
    if (
      !(await confirmDiscard(
        "Delete ALL saved fights? This can't be undone.",
        "Clear fight history",
      ))
    ) {
      return;
    }
    try {
      const n = await pruneFights({ keepLastN: 0 });
      setPendingDelete(null);
      setSelected(null);
      setPage(0);
      load(0);
      showToast(`Cleared ${n} fight${n === 1 ? "" : "s"} from history`);
    } catch {
      showToast("Could not clear history");
    }
  }

  async function exportOne(f: FightRecord) {
    try {
      const json = await exportFight(f.id);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const stamp = fmtWhen(f.startTs).replace(/[^\w-]+/g, "_");
      a.download = `fight-${f.target.replace(/[^\w-]+/g, "_")}-${stamp}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      showToast("Could not export that fight");
    }
  }

  async function importLog() {
    let path: string | null = null;
    try {
      path = await pickLogFile();
    } catch (e) {
      showToast(`Could not open the file picker: ${e}`);
      return;
    }
    if (!path) return;
    setImporting(true);
    try {
      const parsed = await analyzeLog(path);
      const file = path.split(/[\\/]/).pop() ?? path;
      setSelected(null);
      setImported({ file, fights: parsed });
      showToast(
        `Imported ${parsed.length} fight${parsed.length === 1 ? "" : "s"} from ${file}`,
      );
    } catch (e) {
      showToast(`Import failed: ${e}`);
    } finally {
      setImporting(false);
    }
  }

  function openTell(f: FightRecord) {
    setTellName("");
    setTellFor(f);
  }

  async function copyTellParse(f: FightRecord, who: string) {
    try {
      const text = await pasteParse(f.id >= 0 ? f.id : null, {
        character,
        target: f.target,
        durationSecs: f.durationSecs,
        rows: f.rows,
      });
      await navigator.clipboard.writeText(
        text
          .split(/\r?\n/)
          .filter((line) => line.trim().length > 0)
          .map((line) => `/tell ${who} ${line}`)
          .join("\n"),
      );
      showToast(`Tell parse copied for ${who} — paste it in game`);
    } catch {
      showToast("Could not copy to the clipboard");
    }
  }

  function yourDps(f: FightRecord): number | null {
    const you = f.rows.find(
      (r) => r.name.toLowerCase() === character.toLowerCase(),
    );
    return you ? you.dps : null;
  }

  function splitPetRows(rows: FightRecord["rows"]): FightRecord["rows"] {
    return splitPetDamageRows(
      rows,
      selected?.durationSecs ?? 0,
      selected?.totalDamage ?? 0,
    );
  }

  // "Tell" dialog (rendered in both the list and detail views). EQ character
  // names are a single word of letters; anything else would garble the /tell.
  const tellWho = tellName.trim();
  const tellValid = /^[A-Za-z]+$/.test(tellWho);

  function submitTell() {
    if (!tellFor || !tellValid) return;
    const f = tellFor;
    setTellFor(null);
    void copyTellParse(f, tellWho);
  }

  const tellDialog = tellFor && (
    <Modal
      label={`Tell parse — ${tellFor.target}`}
      onClose={() => setTellFor(null)}
    >
      <div className="card-head">
        <span className="section-title">Tell parse — {tellFor.target}</span>
      </div>
      <p className="hint">
        Copies this parse as /tell lines to the clipboard for pasting in
        game — nothing is sent automatically.
      </p>
      <label className="field">
        <span>Send to</span>
        <input
          type="text"
          value={tellName}
          placeholder="Player name"
          autoFocus
          onChange={(e) => setTellName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitTell();
          }}
        />
      </label>
      {tellWho !== "" && !tellValid && (
        <p className="hint">
          Character names are a single word of letters only.
        </p>
      )}
      <div className="editor-foot">
        <button className="primary" disabled={!tellValid} onClick={submitTell}>
          Copy /tell lines
        </button>
        <span className="spacer" />
        <button className="ghost" onClick={() => setTellFor(null)}>
          Cancel
        </button>
      </div>
    </Modal>
  );

  // ---- detail view ----
  if (selected) {
    const dps = yourDps(selected);
    const detailRows = splitPetRows(selected.rows);
    const recordedEnemyRows = [...(selected.enemyRows ?? [])].sort(
      (a, b) => b.total - a.total || a.name.localeCompare(b.name),
    );
    const legacyIncomingRows = incomingDamageRows(selected.rows);
    const legacyEnemyTotal = incomingDamageTotal(legacyIncomingRows);
    const enemyRows =
      recordedEnemyRows.length > 0
        ? recordedEnemyRows
        : legacyEnemyTotal > 0
          ? [
              {
                name: selected.target,
                total: legacyEnemyTotal,
                dps: legacyEnemyTotal / Math.max(1, selected.durationSecs),
                pct: 100,
                sources: [],
              },
            ]
          : [];
    const enemyTotal = enemyRows.reduce((sum, row) => sum + row.total, 0);
    const isLegacyEnemyTotal =
      recordedEnemyRows.length === 0 && legacyEnemyTotal > 0;
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
          <button
            className="ghost small"
            onClick={() => openTell(selected)}
            title="Copy this fight as /tell lines (nothing is sent)"
          >
            Copy tell
          </button>
        </div>
        <div className="stat-tiles">
          <StatTile value={fmtDuration(selected.durationSecs)} label="Fight duration" />
          <StatTile value={fmtNum(selected.totalDamage)} label="Damage dealt" />
          <StatTile value={dps === null ? "—" : fmtNum(dps)} label="Your DPS" />
          <StatTile value={fmtWhen(selected.startTs)} label="When" />
        </div>
        <div className="card">
          <div className="card-head">
            <span className="section-title">Players — damage to {selected.target}</span>
            {selected.targetSlain && <span className="slain-chip">slain</span>}
          </div>
          {detailRows.length === 0 ? (
            <Empty title="No damage rows" body="This fight recorded no damage contributions." />
          ) : (
            <MeterTable rows={detailRows} />
          )}
        </div>
        <div className="card">
          <div className="card-head">
            <span className="section-title">Enemies — damage to players</span>
            <span className="hint">
              {fmtNum(enemyTotal)} during {selected.target}
              {isLegacyEnemyTotal && " · source details unavailable for older fight"}
            </span>
          </div>
          {enemyRows.length === 0 ? (
            <Empty
              title="No enemy damage recorded"
              body="This fight did not contain damage from an enemy to a tracked player or pet."
            />
          ) : (
            <MeterTable rows={enemyRows} initiallyExpanded />
          )}
        </div>
        {toastNode}
        {tellDialog}
      </>
    );
  }

  // ---- list view ----
  // Hide the pending-delete row without touching the loaded page, so Undo is
  // a pure reveal even if a refresh re-fetched the still-stored row.
  const visibleFights =
    fights === null
      ? null
      : pendingDelete
        ? fights.filter((f) => f.id !== pendingDelete.id)
        : fights;
  const visibleTotal =
    total === null ? null : Math.max(0, total - (pendingDelete ? 1 : 0));
  const pageCount =
    total !== null ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : null;
  const hasNext =
    pageCount !== null
      ? page + 1 < pageCount
      : (fights?.length ?? 0) === PAGE_SIZE;

  return (
    <>
      {error && <div className="error-banner">{error}</div>}
      {imported && (
        <div className="import-review">
          <div className="import-banner">
            <span>
              Reviewing <strong>{imported.file}</strong> —{" "}
              {imported.fights.length} fight
              {imported.fights.length === 1 ? "" : "s"} (read-only)
            </span>
            <button className="ghost small" onClick={() => setImported(null)}>
              Close
            </button>
          </div>
          {imported.fights.length === 0 ? (
            <Empty
              title="No fights found"
              body="No completed fights were parsed from that log file."
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
              {imported.fights.map((f) => {
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
                    <span className="num fight-num">
                      {fmtDuration(f.durationSecs)}
                    </span>
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
        </div>
      )}
      <Collapsible
        title="Fight history"
        count={visibleTotal}
        storageKey="history"
        headerAside={
          <span className="history-actions">
            <button
              className="ghost small"
              onClick={() => void importLog()}
              disabled={importing}
              title="Analyze a past log file (raid replay) — read-only"
            >
              {importing ? "Importing…" : "Import log"}
            </button>
            <button className="ghost small" onClick={() => load(page)}>
              Refresh
            </button>
            {visibleFights && visibleFights.length > 0 && (
              <button className="ghost small" onClick={() => void clearHistory()}>
                Clear history
              </button>
            )}
          </span>
        }
      >
        {visibleFights === null ? (
          <div className="hint">Loading fight history…</div>
        ) : visibleFights.length === 0 ? (
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
            {visibleFights.map((f) => {
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
                    <button
                      className="ghost small"
                      onClick={(e) => {
                        e.stopPropagation();
                        openTell(f);
                      }}
                      title="Copy this fight as /tell lines (nothing is sent)"
                    >
                      Tell
                    </button>
                    <button
                      className="ghost small"
                      onClick={(e) => {
                        e.stopPropagation();
                        void exportOne(f);
                      }}
                      title="Download this fight as JSON"
                    >
                      Export
                    </button>
                    <button
                      className="ghost small icon-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        void deleteOne(f);
                      }}
                      title="Delete this fight"
                      aria-label={`Delete ${f.target}`}
                    >
                      ×
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        )}
        {visibleFights !== null && visibleFights.length > 0 && (
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
      {toastNode}
      {tellDialog}
    </>
  );
}
