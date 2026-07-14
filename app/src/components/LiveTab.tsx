import { useEffect, useMemo, useRef, useState } from "react";
import { setOverride, shareImport } from "../api";
import { fmtClock, useTauriEvent } from "../hooks";
import {
  eventKind,
  type LogLinePayload,
  type TriggerFiredPayload,
  type TriggerIdentity,
} from "../types";
import { IS_MOCK } from "../mock";
import { classifySeverity } from "../lib/severity";
import Empty from "./Empty";
import QuickTriggerModal from "./QuickTriggerModal";

const MAX_ROWS = 500;
const MAX_ARCHIVE_ROWS = 5000;
const ARCHIVE_PREVIEW_ROWS = 120;
const SHARE_RE = /LCS1:[A-Za-z0-9+/_=-]+/;

interface Row extends LogLinePayload {
  id: number;
  /** Set on alert rows (trigger-fired feed entries): who fired. */
  trigger?: TriggerIdentity | null;
}

let nextId = 0;

const DAMAGE_KINDS = new Set([
  "MeleeHit",
  "SpellDamage",
  "NonMeleeDamage",
  "DamageShield",
]);

const CAST_KINDS = new Set([
  "CastBegin",
  "CastInterrupted",
  "CastFizzled",
  "Resisted",
  "SpellResist",
  "WornOff",
]);

const LOOT_KINDS = new Set(["Loot", "XpGain", "LevelUp", "Faction", "Roll"]);

interface ChipInfo {
  label: string;
  cls: string;
  /** Damage the player dealt renders in --ink. */
  dealt: boolean;
}

function classify(kind: string, message: string): ChipInfo {
  if (kind === "Alert") return { label: "alert", cls: "alert", dealt: false };
  if (DAMAGE_KINDS.has(kind)) {
    // Damage you take gets the serious status chip.
    if (/\bYOU\b/.test(message)) {
      return { label: "taken", cls: "taken", dealt: false };
    }
    const dealt = message.startsWith("You ");
    if (kind === "MeleeHit") return { label: "melee", cls: "damage", dealt };
    if (kind === "SpellDamage") return { label: "spell", cls: "damage", dealt };
    return { label: "dmg", cls: "damage", dealt };
  }
  switch (kind) {
    case "MeleeMiss":
      return { label: "miss", cls: "muted", dealt: false };
    case "Heal":
      return { label: "heal", cls: "heal", dealt: false };
    case "Slain":
      return { label: "slain", cls: "death", dealt: false };
    case "Loot":
      return { label: "loot", cls: "loot", dealt: false };
    case "Chat":
      return { label: "chat", cls: "chat", dealt: false };
    case "Faction":
      return { label: "faction", cls: "faction", dealt: false };
    case "CastBegin":
    case "CastInterrupted":
      return { label: "cast", cls: "cast", dealt: false };
    case "SpellResist":
      return { label: "resist", cls: "cast", dealt: false };
    case "BuffBlocked":
      // A stacking conflict (P11) — informative, not spam.
      return { label: "blocked", cls: "cast", dealt: false };
    case "System":
    case "Loading":
    case "Unclassified":
      return { label: "system", cls: "muted", dealt: false };
    default:
      return {
        label: kind.toLowerCase().slice(0, 8),
        cls: "muted",
        dealt: false,
      };
  }
}

// ---------------------------------------------------------------------------
// Event-kind filter groups (chip row above the feed)
// ---------------------------------------------------------------------------

type GroupId =
  | "combat"
  | "taken"
  | "misses"
  | "heals"
  | "casts"
  | "deaths"
  | "alerts"
  | "chat"
  | "loot"
  | "system";

const GROUPS: { id: GroupId; label: string; hue: string }[] = [
  { id: "combat", label: "Combat", hue: "damage" },
  { id: "taken", label: "Damage taken", hue: "taken" },
  { id: "misses", label: "Misses", hue: "muted" },
  { id: "heals", label: "Heals", hue: "heal" },
  { id: "casts", label: "Casts", hue: "cast" },
  { id: "deaths", label: "Deaths", hue: "death" },
  { id: "alerts", label: "Alerts", hue: "alert" },
  { id: "chat", label: "Chat", hue: "chat" },
  { id: "loot", label: "Loot & XP", hue: "loot" },
  { id: "system", label: "System & other", hue: "muted" },
];

/** Same classification the kind chips use, folded into filterable groups. */
function groupOf(kind: string, message: string): GroupId {
  if (kind === "Alert") return "alerts";
  if (kind === "SpellDamageTaken") return "taken";
  if (DAMAGE_KINDS.has(kind)) {
    return /\bYOU\b/.test(message) ? "taken" : "combat";
  }
  // All whiff lines (miss / parry / dodge / riposte / block) parse to
  // MeleeMiss — their own filter group, they are the loudest combat spam.
  if (kind === "MeleeMiss") return "misses";
  if (kind === "Heal") return "heals";
  if (CAST_KINDS.has(kind)) return "casts";
  if (kind === "Slain") return "deaths";
  if (kind === "Chat") return "chat";
  if (LOOT_KINDS.has(kind)) return "loot";
  return "system";
}

const YOU_RE = /\byou(rs?|rself)?\b/i;

/** "Mine only": lines that mention You/your or the current character. */
function involvesYou(message: string, character: string): boolean {
  if (YOU_RE.test(message)) return true;
  return (
    character.length > 0 &&
    message.toLowerCase().includes(character.toLowerCase())
  );
}

// ---------------------------------------------------------------------------
// Filter persistence
// ---------------------------------------------------------------------------

const FILTERS_KEY = "eqlogs.liveFilters.v1";

interface StoredFilters {
  off: GroupId[];
  mineOnly: boolean;
  /** Persisted like the other toolbar toggles; default on. */
  autoScroll: boolean;
}

function loadStoredFilters(): StoredFilters {
  try {
    const raw = window.localStorage.getItem(FILTERS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<StoredFilters>;
      return {
        off: Array.isArray(p.off)
          ? (p.off.filter((g) => GROUPS.some((x) => x.id === g)) as GroupId[])
          : [],
        mineOnly: p.mineOnly === true,
        autoScroll: p.autoScroll !== false,
      };
    }
  } catch {
    // corrupted storage: fall through to defaults
  }
  return { off: [], mineOnly: false, autoScroll: true };
}

/** Mock-only demo hooks: ?qtdemo=1 opens the quick-trigger modal on a seeded
 *  row; ?qtdemo=hover pins one row's hover affordance visible (screenshots). */
const QT_DEMO: string | null = IS_MOCK
  ? new URLSearchParams(window.location.search).get("qtdemo")
  : null;

/** Mock-only: ?mutedemo=1 opens the mute context menu on the first alert
 *  row so the right-click affordance can be screenshotted. */
const MUTE_DEMO: boolean = IS_MOCK
  ? new URLSearchParams(window.location.search).get("mutedemo") === "1"
  : false;

export default function LiveTab({
  character,
  searchRequest,
  tailing = false,
  onStartTailing,
}: {
  character: string;
  searchRequest?: { query: string; seq: number } | null;
  /** Whether the tail session is running (drives the empty-state CTA). */
  tailing?: boolean;
  /** Start tailing from the empty state — same path as the Session menu. */
  onStartTailing?: () => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [archiveRows, setArchiveRows] = useState<Row[]>([]);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveQuery, setArchiveQuery] = useState("");
  const [filter, setFilter] = useState("");
  const [autoScroll, setAutoScroll] = useState<boolean>(
    () => loadStoredFilters().autoScroll,
  );
  const [offGroups, setOffGroups] = useState<Set<GroupId>>(
    () => new Set(loadStoredFilters().off),
  );
  const [mineOnly, setMineOnly] = useState<boolean>(
    () => loadStoredFilters().mineOnly,
  );
  /** Row-id watermark while paused (rows with id >= this are buffered). */
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const [quickLine, setQuickLine] = useState<Row | null>(null);
  const [toast, setToast] = useState<{ message: string; undo?: () => void } | null>(
    null,
  );
  const [shareCandidate, setShareCandidate] = useState<string | null>(null);
  /** Right-click context menu on an alert row ("Mute this trigger"). */
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    trigger: TriggerIdentity;
  } | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  // Mirror pausedAt into a ref so the log-line handler's setRows updater reads
  // the current watermark without a stale closure.
  const pausedAtRef = useRef<number | null>(null);
  pausedAtRef.current = pausedAt;

  useEffect(() => {
    if (!searchRequest?.query) return;
    setArchiveOpen(true);
    setArchiveQuery(searchRequest.query);
  }, [searchRequest?.seq]);

  const pushRow = (row: Omit<Row, "id">): void => {
    setRows((prev) => {
      const next = [...prev, { ...row, id: nextId++ }];
      if (next.length <= MAX_ROWS) return next;
      // While paused, never evict the frozen (pre-pause) rows the user is
      // reading — trim only the post-pause overflow so a burst of log spam
      // can't scroll the snapshot out of the buffer (P16). The frozen set is
      // bounded (the watermark is fixed while paused), so the buffer still
      // stays capped at MAX_ROWS overall.
      const cutoff = pausedAtRef.current;
      if (cutoff !== null) {
        const frozen = next.filter((r) => r.id < cutoff);
        const fresh = next.filter((r) => r.id >= cutoff);
        const keepFresh = Math.max(0, MAX_ROWS - frozen.length);
        return [...frozen, ...fresh.slice(fresh.length - keepFresh)];
      }
      return next.slice(next.length - MAX_ROWS);
    });
  };

  useTauriEvent<LogLinePayload>("log-line", (p) => {
    const match = SHARE_RE.exec(p.message);
    if (match) setShareCandidate(match[0]);
    setArchiveRows((prev) => {
      const next = [...prev, { ...p, id: nextId++ }];
      return next.length > MAX_ARCHIVE_ROWS
        ? next.slice(next.length - MAX_ARCHIVE_ROWS)
        : next;
    });
    pushRow(p);
  });

  // Trigger identity (NOW-sprint item 7): fired alerts appear inline in the
  // feed, named, so "what was that?!" is answerable — and right-click mutes.
  useTauriEvent<TriggerFiredPayload>("trigger-fired", (p) => {
    if (p.action.kind !== "displayText" && p.action.kind !== "speak") return;
    pushRow({
      ts: Date.now() / 1000,
      message: p.action.text,
      event: "Alert",
      trigger: p.trigger,
    });
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(
        FILTERS_KEY,
        JSON.stringify({ off: [...offGroups], mineOnly, autoScroll }),
      );
    } catch {
      // storage unavailable: filters just won't persist
    }
  }, [offGroups, mineOnly, autoScroll]);

  useEffect(() => {
    if (!toast) return;
    const h = window.setTimeout(() => setToast(null), toast.undo ? 6000 : 3200);
    return () => window.clearTimeout(h);
  }, [toast]);

  // Close the context menu on any click or Escape anywhere.
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  async function muteTrigger(t: TriggerIdentity) {
    setCtxMenu(null);
    try {
      await setOverride(t.id, false);
      setToast({
        message: `Muted “${t.name}”`,
        undo: () => {
          setToast(null);
          setOverride(t.id, null).catch(() => {});
        },
      });
    } catch (e) {
      setToast({ message: String(e) });
    }
  }

  async function importShareCandidate() {
    if (!shareCandidate) return;
    try {
      const result = await shareImport(shareCandidate);
      setToast({ message: `Imported ${result.imported} shared trigger${result.imported === 1 ? "" : "s"}` });
      setShareCandidate(null);
    } catch (e) {
      setToast({ message: `Share import failed: ${String(e)}` });
    }
  }

  const paused = pausedAt !== null;

  useEffect(() => {
    if (!paused && autoScroll && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [rows, autoScroll, paused]);

  // Mock-only: pin the mute context menu open on the first alert row.
  const muteDemoDone = useRef(false);
  useEffect(() => {
    if (!MUTE_DEMO || muteDemoDone.current) return;
    const alert = rows.find((r) => eventKind(r.event) === "Alert" && r.trigger);
    if (!alert || !alert.trigger) return;
    muteDemoDone.current = true;
    setCtxMenu({ x: 420, y: 260, trigger: alert.trigger });
  }, [rows]);

  // Mock-only: open the quick-trigger modal on a seeded row for screenshots.
  const demoDone = useRef(false);
  useEffect(() => {
    if (QT_DEMO !== "1" || demoDone.current || rows.length === 0) return;
    demoDone.current = true;
    const r =
      // Prefer a line with numbers and a leading name so both convenience
      // toggles are demonstrable; fall back to any line.
      rows.find(
        (x) => /\d/.test(x.message) && /^(?!You\b)[A-Z][a-z]+/.test(x.message),
      ) ??
      rows.find((x) => /\d/.test(x.message)) ??
      rows[0];
    setQuickLine(r);
  }, [rows]);

  const needle = filter.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        const kind = eventKind(r.event);
        if (offGroups.has(groupOf(kind, r.message))) return false;
        if (mineOnly && !involvesYou(r.message, character)) return false;
        if (
          needle &&
          !r.message.toLowerCase().includes(needle) &&
          !kind.toLowerCase().includes(needle)
        ) {
          return false;
        }
        return true;
      }),
    [rows, offGroups, mineOnly, character, needle],
  );
  const shown = paused ? filtered.filter((r) => r.id < pausedAt!) : filtered;
  const newCount = filtered.length - shown.length;
  const archiveNeedle = archiveQuery.trim().toLowerCase();
  const archiveFiltered = useMemo(
    () =>
      archiveRows.filter((r) => {
        if (!archiveNeedle) return true;
        const kind = eventKind(r.event).toLowerCase();
        return (
          r.message.toLowerCase().includes(archiveNeedle) ||
          kind.includes(archiveNeedle)
        );
      }),
    [archiveRows, archiveNeedle],
  );
  const archivePreview = archiveFiltered.slice(-ARCHIVE_PREVIEW_ROWS);

  // Mock-only: pin one row's "+ Trigger" affordance visible for screenshots.
  const demoHoverId =
    QT_DEMO === "hover" && shown.length > 0
      ? ([...shown].reverse().find((x) => /\d/.test(x.message))?.id ??
        shown[shown.length - 1].id)
      : null;

  function toggleGroup(id: GroupId) {
    setOffGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function togglePause() {
    if (paused) {
      setPausedAt(null);
      // Jump back to live even when auto-scroll is off.
      window.requestAnimationFrame(() => {
        if (feedRef.current) {
          feedRef.current.scrollTop = feedRef.current.scrollHeight;
        }
      });
    } else {
      setPausedAt(nextId);
    }
  }

  async function copyArchive() {
    const text = archiveFiltered
      .map((r) => `[${fmtClock(r.ts)}] ${eventKind(r.event)} ${r.message}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setToast({ message: `Copied ${archiveFiltered.length} archived line${archiveFiltered.length === 1 ? "" : "s"}` });
    } catch {
      setToast({ message: "Could not copy archive results" });
    }
  }

  return (
    <div className="card feed-card">
      <div className="toolbar">
        <input
          type="text"
          placeholder="Filter by message or event type"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <label className="check-row">
          <input
            type="checkbox"
            className="switch"
            checked={mineOnly}
            onChange={(e) => setMineOnly(e.target.checked)}
          />
          Mine only
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            className="switch"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />
          Auto-scroll
        </label>
        <button
          className={paused ? "primary" : "ghost"}
          onClick={togglePause}
          title={
            paused
              ? "Resume the live feed"
              : "Freeze the feed while inspecting; new lines keep buffering"
          }
        >
          {paused ? "Resume" : "Pause"}
        </button>
        <button className="ghost" onClick={() => setRows([])}>
          Clear
        </button>
        <span className="hint num">
          {shown.length}/{rows.length} lines
        </span>
      </div>
      {shareCandidate && (
        <div className="inline-banner">
          <span>Shared trigger detected</span>
          <button className="primary small" onClick={() => void importShareCandidate()}>
            Import
          </button>
          <button className="ghost small" onClick={() => setShareCandidate(null)}>
            Dismiss
          </button>
        </div>
      )}
      <div className="chip-row" role="group" aria-label="Event kind filters">
        {GROUPS.map((g) => (
          <button
            key={g.id}
            className={`kchip k-${g.hue}${offGroups.has(g.id) ? " off" : ""}`}
            aria-pressed={!offGroups.has(g.id)}
            onClick={() => toggleGroup(g.id)}
          >
            {g.label}
          </button>
        ))}
        {offGroups.size > 0 && (
          <button
            className="kchip-reset"
            onClick={() => setOffGroups(new Set())}
          >
            Show all
          </button>
        )}
      </div>
      <div className={`archive-panel${archiveOpen ? " open" : ""}`}>
        <div className="archive-head">
          <button
            type="button"
            className="collapsible-toggle"
            onClick={() => setArchiveOpen((v) => !v)}
            aria-expanded={archiveOpen}
          >
            <span className="collapsible-chevron" aria-hidden="true">
              {archiveOpen ? "▾" : "▸"}
            </span>
            <span className="section-title">Session archive</span>
            <span className="collapsible-count num">{archiveRows.length}</span>
          </button>
          {archiveOpen && (
            <>
              <input
                type="text"
                className="archive-search"
                placeholder="Search archived lines"
                value={archiveQuery}
                onChange={(e) => setArchiveQuery(e.target.value)}
              />
              <button className="ghost small" onClick={() => void copyArchive()}>
                Copy results
              </button>
            </>
          )}
        </div>
        {archiveOpen && (
          <div className="archive-results">
            {archivePreview.length === 0 ? (
              <div className="hint">No archived lines match.</div>
            ) : (
              archivePreview.map((r) => (
                <div className="archive-row" key={r.id}>
                  <span className="feed-time">{fmtClock(r.ts)}</span>
                  <span className="chip chip-muted">{eventKind(r.event).toLowerCase()}</span>
                  <span>{r.message}</span>
                </div>
              ))
            )}
            {archiveFiltered.length > archivePreview.length && (
              <div className="hint">
                Showing latest {archivePreview.length} of {archiveFiltered.length} matches.
              </div>
            )}
          </div>
        )}
      </div>
      <div className="feed" ref={feedRef}>
        {shown.length === 0 &&
          (rows.length === 0 && !tailing && onStartTailing ? (
            // Not tailing yet: a persistent primary CTA instead of copy
            // pointing at the collapsed Session menu (first-run dead end).
            <Empty
              title="Not tailing yet"
              body="Start tailing to follow the log — every parsed line streams here in real time."
              action={
                <button className="primary" onClick={onStartTailing}>
                  Start tailing
                </button>
              }
            />
          ) : (
            <Empty
              title={rows.length === 0 ? "Waiting for log lines" : "No matches"}
              body={
                rows.length === 0
                  ? "Tailing is running — parsed lines stream here as the game writes them."
                  : "Nothing in the current buffer matches the active filters."
              }
            />
          ))}
        {shown.map((r) => {
          const kind = eventKind(r.event);
          const chip = classify(kind, r.message);
          const isAlert = kind === "Alert";
          // Tint the ALERT chip by severity (X6): alarm/warn get their own
          // chip color; everything else keeps the default accent alert chip.
          const alertSev =
            isAlert && r.trigger
              ? classifySeverity(r.trigger.id, r.trigger.name)
              : null;
          const chipCls =
            alertSev === "alarm"
              ? "chip-alarm"
              : alertSev === "warn"
                ? "chip-warn"
                : `chip-${chip.cls}`;
          return (
            <div
              className={`feed-row${r.id === demoHoverId ? " demo-hover" : ""}`}
              key={r.id}
              onContextMenu={(e) => {
                e.preventDefault();
                if (isAlert) {
                  if (r.trigger) {
                    // Clamp to the viewport so a right-click near an edge
                    // doesn't open the menu partly off-screen (P35).
                    const MENU_W = 240;
                    const MENU_H = 48;
                    const x = Math.max(
                      4,
                      Math.min(e.clientX, window.innerWidth - MENU_W),
                    );
                    const y = Math.max(
                      4,
                      Math.min(e.clientY, window.innerHeight - MENU_H),
                    );
                    setCtxMenu({ x, y, trigger: r.trigger });
                  }
                } else {
                  setQuickLine(r);
                }
              }}
            >
              <span className="feed-time">{fmtClock(r.ts)}</span>
              <span className={`chip ${chipCls}`}>{chip.label}</span>
              <span
                className={`feed-msg${chip.dealt ? " dealt" : ""}`}
                title={
                  isAlert && r.trigger
                    ? `Trigger: ${r.trigger.name} — right-click to mute`
                    : undefined
                }
              >
                {r.message}
                {isAlert && r.trigger && (
                  <span className="feed-trig-name">{r.trigger.name}</span>
                )}
              </span>
              {!isAlert && (
                <button
                  className="row-trig"
                  title="Create a trigger from this line"
                  onClick={() => setQuickLine(r)}
                >
                  +<span className="row-trig-label"> Trigger</span>
                </button>
              )}
              {/* Alert rows get a keyboard-focusable Mute pill mirroring the
                  "+ Trigger" affordance — right-click alone was undiscoverable
                  and unreachable without a mouse (P35). */}
              {isAlert && r.trigger && (
                <button
                  className="row-trig row-mute"
                  title={`Mute “${r.trigger.name}”`}
                  onClick={() => void muteTrigger(r.trigger!)}
                >
                  Mute
                </button>
              )}
            </div>
          );
        })}
      </div>
      {paused && newCount > 0 && (
        <button className="new-pill num" onClick={togglePause}>
          {newCount} new — jump to live
        </button>
      )}
      {ctxMenu && (
        <div
          className="ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          role="menu"
        >
          <button
            role="menuitem"
            onClick={() => void muteTrigger(ctxMenu.trigger)}
          >
            Mute “{ctxMenu.trigger.name}”
          </button>
        </div>
      )}
      {quickLine && (
        <QuickTriggerModal
          message={quickLine.message}
          onClose={() => setQuickLine(null)}
          onSaved={(name, location) => {
            setQuickLine(null);
            setToast({ message: `Trigger “${name}” saved to ${location}` });
          }}
        />
      )}
      {toast && (
        <div className={`toast${toast.undo ? " toast-undo" : ""}`} role="status">
          {toast.message}
          {toast.undo && (
            <button className="ghost small" onClick={toast.undo}>
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}
