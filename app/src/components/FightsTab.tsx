// Fight history browser (NOW-sprint item 2): paginated list of persisted
// fights (newest first) with a detail view that reuses the meter table.

import type { ReactNode } from "react";
import { emit } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  analyzeLog,
  confirmDiscard,
  deleteFight,
  exportFight,
  exportSession,
  getConfig,
  getFight,
  listFights,
  pasteParse,
  pickLogFile,
  pruneFights,
  refdbRespawnFor,
  speakText,
} from "../api";
import {
  fmtClock,
  fmtDuration,
  fmtNum,
  useNowMs,
  useTauriEvent,
} from "../hooks";
import { recordConflict } from "../lib/buffConflicts";
import { observedSpellEffect } from "../lib/effects";
import {
  type DamageSummary,
  incomingDamage,
  type IncomingHit,
  summarizeDamage,
} from "../lib/deathRecap";
import {
  isWishlisted,
  loadWishlist,
  onWishlistChanged,
  toggleWishlist,
  type WishlistEntry,
} from "../lib/wishlist";
import { splitPetDamageRows } from "../lib/meterRows";
import {
  applyPaceEvent,
  loadPaceState,
  PACE_STATE_EVENT,
  savePaceState,
  type PaceState,
} from "../lib/pace";
import {
  emptyPlayer,
  isPlayerName,
  saveScoreboard,
  type PlayerScore,
  type Scoreboard,
} from "../lib/scoreboard";
import { IS_MOCK, mockEmit } from "../mock";
import {
  appendXpSession,
  clearXpSession,
  computeLevelEta,
  computeXpStats,
  loadLevelAnchorKnown,
  loadLevelProgress,
  loadXpSession,
  saveLevelAnchorKnown,
  saveLevelProgress,
  type XpSession,
} from "../overlayState";
import type {
  CatchUpPayload,
  AppConfig,
  FightRecord,
  FightUpdatePayload,
  LogLinePayload,
  EffectObservedPayload,
  RespawnInfo,
} from "../types";
import Empty from "./Empty";
import MeterTable, { StatTile } from "./MeterTable";
import PaceRates from "./PaceRates";

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

interface XpEntry {
  id: number;
  ts: number;
  percent: number;
  party: boolean;
  /** Wall-clock ms when observed (stamped by appendXpSession) — anchors the
   *  live XP/hour window. */
  at?: number;
}

interface EffectEntry {
  id: number;
  ts: number;
  kind: "spell";
  spell: string;
  target: string;
  amount: number | null;
  critical: boolean;
}

interface DeathRecap {
  id: number;
  ts: number;
  killer: string;
  lines: { ts: number; message: string; kind: string }[];
  /** Structured incoming-damage summary for the recap window (P25). */
  damage: DamageSummary;
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
const RECAP_WINDOW_SECS = 15;
const RECAP_LINE_CAP = 25;
const RECAP_DAMAGE_CAP = 60;

const PAGE_SIZE = 25;

function publishObservedEffect(payload: EffectObservedPayload): void {
  if (IS_MOCK) mockEmit("effect-observed", payload);
  else void emit("effect-observed", payload);
}

/** Does this hit's flags carry the Finishing Blow AA tag? The Legends parser
 *  puts the "(Finishing Blow)" suffix into `flags.other` (verified:
 *  `You slash a Teir\`Dal priestess for 226 points of damage. (Finishing Blow)`
 *  → MeleeHit flags.other = ["Finishing Blow"]). Finishing Blow is a melee AA,
 *  so it is always YOUR hit and the damage is exact — no correlation needed. */
function hasFinishingBlowFlag(flags: Record<string, unknown> | undefined): boolean {
  const other = flags?.other;
  return (
    Array.isArray(other) &&
    other.some((o) => String(o).toLowerCase() === "finishing blow")
  );
}

/** Extract an outgoing hit for Scoreboard attribution: attacker + amount + a
 *  label (verb/spell/effect → target) for the "highest hit" record. Covers
 *  melee, direct spell damage, and DoT/damage-shield ticks. */
function scoreHit(
  ev: unknown,
): { attacker: string; amount: number; label: string; target: string } | null {
  if (typeof ev !== "object" || ev === null) return null;
  const rec = ev as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === "number" ? x : 0);
  if ("MeleeHit" in rec) {
    const d = rec.MeleeHit as Record<string, unknown>;
    return { attacker: entityName(d.attacker), amount: num(d.amount), label: String(d.verb ?? "hit"), target: entityName(d.target) };
  }
  if ("SpellDamage" in rec) {
    const d = rec.SpellDamage as Record<string, unknown>;
    return { attacker: entityName(d.caster), amount: num(d.amount), label: String(d.spell ?? "spell"), target: entityName(d.target) };
  }
  if ("NonMeleeDamage" in rec) {
    const d = rec.NonMeleeDamage as Record<string, unknown>;
    return { attacker: d.source == null ? "" : entityName(d.source), amount: num(d.amount), label: String(d.effect ?? "dot"), target: entityName(d.target) };
  }
  return null;
}

function effectName(entry: Pick<EffectEntry, "spell">): string {
  return `Spell: ${entry.spell}`;
}

function effectAmountText(
  entry: Pick<EffectEntry, "amount" | "critical">,
): string {
  if (entry.amount == null) return entry.critical ? "crit" : "";
  return `${fmtNum(entry.amount)}${entry.critical ? " crit" : ""}`;
}

// ---------------------------------------------------------------------------
// Camp timers (kill → respawn countdown) + session kill tallies.
// ---------------------------------------------------------------------------

/** Per-mob session kill tally (camp efficiency v1). */
interface KillTally {
  name: string;
  kills: number;
  /** Wall-clock ms of the first kill — anchors the live kills/hour rate. */
  firstAtMs: number;
}

const KILL_ROW_CAP = 30;

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
  const [toast, setToast] = useState<string | null>(null);
  // Offline log import / raid replay (P26): a read-only set of fights parsed
  // from a chosen file, shown in place of live history until closed.
  const [imported, setImported] = useState<{
    file: string;
    fights: FightRecord[];
  } | null>(null);
  const [importing, setImporting] = useState(false);
  const [exportingSession, setExportingSession] = useState(false);
  const [hasSessionActivity, setHasSessionActivity] = useState(false);
  const prevActive = useRef(false);
  const demoSeeded = useRef(false);
  const sessionBounds = useRef<{ startTs: number | null; endTs: number | null }>({
    startTs: null,
    endTs: null,
  });
  // Session-scope loot + rolls (newest first). Captured for the whole app run
  // regardless of which tab is showing (this component stays mounted).
  const [loot, setLoot] = useState<LootEntry[]>([]);
  const [rolls, setRolls] = useState<RollEntry[]>([]);
  const [effects, setEffects] = useState<EffectEntry[]>([]);
  const [ownedNames, setOwnedNames] = useState<Set<string>>(() => new Set());
  const [xp, setXp] = useState<XpSession>(() => loadXpSession());
  const [pace, setPace] = useState<PaceState>(() => loadPaceState());
  // Position within the current level is only trustworthy after this app sees
  // a ding; before then, per-level ETA stays blank instead of asking for input.
  // Both persist (P9) so the XP overlay and later sessions keep the position.
  const [levelProgress, setLevelProgress] = useState(() => loadLevelProgress());
  const [levelAnchorKnown, setLevelAnchorKnown] = useState(() =>
    loadLevelAnchorKnown(),
  );
  const [recaps, setRecaps] = useState<DeathRecap[]>([]);
  const sessionSeq = useRef(0);
  // Party Scoreboard: per-player session stats (reset each run). Flushed to
  // localStorage on a timer; the overlay reads it. (Record-break trophies were
  // dropped — Impact moments are trigger-driven now, not scoreboard-driven.)
  const scoreboard = useRef<Scoreboard>({});
  const scoreDirty = useRef(false);
  const recentLines = useRef<{ ts: number; message: string; kind: string }[]>([]);
  // Structured incoming-damage ring for the death recap (P25).
  const recentDamage = useRef<({ ts: number } & IncomingHit)[]>([]);
  // Replay catch-up (item 13): the backend suppresses trigger audio for
  // replayed lines; side-effectful features here must stay quiet too — no
  // late "X dropped!" speech, no camp timers anchored at Date.now() for
  // hours-old kills, no wall-clock XP anchors that corrupt the live rate.
  const catchingUp = useRef(false);

  // Wishlist (drop alerts): mirrors the localStorage store, live-updated by
  // Drops-tab stars and this tab's remove buttons via onWishlistChanged.
  const [wishlist, setWishlist] = useState<WishlistEntry[]>(() => loadWishlist());
  useEffect(() => onWishlistChanged(() => setWishlist(loadWishlist())), []);

  useEffect(() => {
    const reload = () => setPace(loadPaceState());
    window.addEventListener(PACE_STATE_EVENT, reload);
    return () => window.removeEventListener(PACE_STATE_EVENT, reload);
  }, []);

  // Session kill tallies (camp efficiency v1). Respawn reference data is
  // fetched once per mob name per app run (cached in a ref) for the kills
  // card's Respawn column. Camp/respawn TIMERS themselves now live entirely
  // in the Timers tab (lib/timers.ts) — this component only tallies kills.
  const [kills, setKills] = useState<Record<string, KillTally>>({});
  const respawnCache = useRef(new Map<string, RespawnInfo | null>());
  const respawnPending = useRef(new Set<string>());
  // Bumped when a lazy respawn lookup resolves so the kills card re-renders.
  const [, setRespawnTick] = useState(0);

  const syncOwnedNames = useCallback((config: AppConfig) => {
    setOwnedNames(
      new Set(
        [config.characterName, ...(config.pets ?? [])]
          .map((name) => name.trim().toLowerCase())
          .filter((name) => name.length > 0),
      ),
    );
  }, []);

  useEffect(() => {
    void getConfig().then(syncOwnedNames).catch(() => setOwnedNames(new Set()));
  }, [syncOwnedNames]);

  useTauriEvent<AppConfig>("config-changed", syncOwnedNames);

  const handleNamedSlain = useCallback((victim: string) => {
    const key = victim.toLowerCase();
    // Session kill tally (camp efficiency v1).
    setKills((prev) => {
      const cur = prev[key];
      return {
        ...prev,
        [key]: cur
          ? { ...cur, kills: cur.kills + 1 }
          : { name: victim, kills: 1, firstAtMs: Date.now() },
      };
    });
    // Respawn lookup once per name for the kills card's Respawn column.
    if (!respawnCache.current.has(key) && !respawnPending.current.has(key)) {
      respawnPending.current.add(key);
      void refdbRespawnFor(victim).then((info) => {
        respawnPending.current.delete(key);
        respawnCache.current.set(key, info);
        setRespawnTick((t) => t + 1);
      });
    }
  }, []);

  useTauriEvent<CatchUpPayload>("catch-up", (p) => {
    catchingUp.current = p.active;
  });

  // Scoreboard: fresh per app run (all-time records persist separately), and
  // flushed to localStorage once a second when dirty so the overlay updates
  // without a write per hit.
  useEffect(() => {
    scoreboard.current = {};
    saveScoreboard({});
    const iv = window.setInterval(() => {
      if (!scoreDirty.current) return;
      scoreDirty.current = false;
      saveScoreboard({ ...scoreboard.current });
    }, 1000);
    return () => window.clearInterval(iv);
  }, []);

  useTauriEvent<LogLinePayload>("log-line", (p) => {
    if (!catchingUp.current) {
      const bounds = sessionBounds.current;
      if (bounds.startTs === null) setHasSessionActivity(true);
      bounds.startTs = bounds.startTs === null ? p.ts : Math.min(bounds.startTs, p.ts);
      bounds.endTs = bounds.endTs === null ? p.ts : Math.max(bounds.endTs, p.ts);
    }
    // Scoreboard helpers (capture live ownedNames/catchingUp each render).
    const bumpPlayer = (name: string): PlayerScore => {
      const k = name.toLowerCase();
      const found = scoreboard.current[k];
      if (found) return found;
      const created = emptyPlayer(name);
      scoreboard.current[k] = created;
      return created;
    };
    const ev = p.event;
    const kind =
      typeof ev === "string" ? ev : Object.keys(ev ?? {})[0] ?? "Unknown";
    recentLines.current = [
      ...recentLines.current.filter((l) => p.ts - l.ts <= RECAP_WINDOW_SECS),
      { ts: p.ts, message: p.message, kind },
    ].slice(-RECAP_LINE_CAP);
    const publishEffect = (entry: EffectEntry) => {
      setEffects((prev) => [entry, ...prev].slice(0, SESSION_CAP));
      const payload: EffectObservedPayload = {
        kind: entry.kind,
        spell: entry.spell,
        target: entry.target,
        amount: entry.amount,
        critical: entry.critical,
      };
      publishObservedEffect(payload);
    };
    // "Skill: Reave" was formerly hardcoded here; it is now the curated,
    // per-taste-toggleable trigger `skills/melee/reave` (default OFF) in
    // triggers/curated/skills.json — see the "everything configurable"
    // principle. Removed so it no longer double-fires as a built-in alert.
    if (typeof ev !== "object" || ev === null) return;
    if ("MeleeHit" in ev) {
      const d = ev.MeleeHit as Record<string, unknown>;
      const attacker = entityName(d.attacker);
      const flags = d.flags as Record<string, unknown> | undefined;
      // Finishing Blow AA: the hit line is tagged "(Finishing Blow)". We count
      // it toward the Scoreboard leaderboard here; the DRAMATIC moment (the
      // slash on the Impact overlay) is NOT hardcoded — it's the curated
      // `impact/finishing-blow` trigger, so it's fully user-configurable like
      // every other alert/impact.
      if (hasFinishingBlowFlag(flags)) {
        bumpPlayer(attacker).finishingBlows++;
        scoreDirty.current = true;
      }
    }
    // Track incoming damage for the death recap (P25) — any damage event
    // aimed at You, kept to the recap window.
    const hit = incomingDamage(ev);
    if (hit && hit.amount > 0) {
      recentDamage.current = [
        ...recentDamage.current.filter((h) => p.ts - h.ts <= RECAP_WINDOW_SECS),
        { ts: p.ts, ...hit },
      ].slice(-RECAP_DAMAGE_CAP);
    }
    // Scoreboard: attribute outgoing damage + the "highest hit" record to the
    // attacking player (you, a groupmate, or an owned pet — not mobs).
    const sh = scoreHit(ev);
    if (sh && sh.amount > 0 && isPlayerName(sh.attacker, ownedNames)) {
      const pl = bumpPlayer(sh.attacker);
      pl.totalDamage += sh.amount;
      pl.lastTs = p.ts;
      if (pl.firstTs === 0) pl.firstTs = p.ts;
      if (sh.amount > pl.highestHit) {
        pl.highestHit = sh.amount;
        pl.highestHitLabel = sh.target ? `${sh.label} → ${sh.target}` : sh.label;
      }
      scoreDirty.current = true;
    }
    if ("SpellDamage" in ev) {
      const d = ev.SpellDamage as Record<string, unknown>;
      const caster = entityName(d.caster);
      const spell = String(d.spell ?? "").trim();
      const amount = typeof d.amount === "number" ? d.amount : 0;
      const target = entityName(d.target);
      if (
        (caster === "You" || caster === character) &&
        target !== "You" &&
        spell &&
        amount > 0
      ) {
        const flags = d.flags as Record<string, unknown> | undefined;
        const observed = observedSpellEffect(
          spell,
          target,
          amount,
          flags?.critical === true,
        );
        const entry: EffectEntry = {
          id: sessionSeq.current++,
          ts: p.ts,
          ...observed,
        };
        publishEffect(entry);
      }
    }
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
      setPace((prev) => {
        const next = applyPaceEvent(prev, {
          kind: "loot",
          item: entry.item,
          quantity: entry.qty,
          looter: entry.who,
          atMs: Date.now(),
          replayed: catchingUp.current,
        });
        if (next !== prev) savePaceState(next);
        return next;
      });
      // Wishlist drop alert: spoken + toast (star items in the Drops tab).
      // Muted during catch-up: a replayed loot line is old news.
      if (!catchingUp.current && isWishlisted(entry.item)) {
        void speakText(`${entry.item} dropped!`);
        setToast(`Wishlist drop: ${entry.item}!`);
      }
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
    } else if ("XpGain" in ev) {
      const d = ev.XpGain as Record<string, unknown>;
      const percent = typeof d.percent === "number" ? d.percent : 0;
      const entry: XpEntry = {
        id: p.ts * 1000 + sessionSeq.current++,
        ts: p.ts,
        percent,
        party: d.party === true,
      };
      // appendXpSession stamps the wall-clock receipt time (`at`) and caps
      // the list; use its return so the live rate window works here too.
      // Replayed gains skip the stamp — anchoring an old gain at "now"
      // would corrupt the live XP/hour rate.
      setXp(appendXpSession(entry, { stampNow: !catchingUp.current }));
      setPace((prev) => {
        const next = applyPaceEvent(prev, {
          kind: "xp",
          percent,
          atMs: Date.now(),
          replayed: catchingUp.current,
        });
        if (next !== prev) savePaceState(next);
        return next;
      });
      // Advance level position on live gains only — replaying old gains would
      // double-count against the persisted position (P9).
      if (!catchingUp.current && levelAnchorKnown) {
        setLevelProgress((prev) => {
          const next = Math.min(100, prev + percent);
          saveLevelProgress(next);
          return next;
        });
      }
    } else if ("AaPointGain" in ev) {
      const d = ev.AaPointGain as Record<string, unknown>;
      const points = typeof d.points === "number" ? d.points : 1;
      setPace((prev) => {
        const next = applyPaceEvent(prev, {
          kind: "aa-point",
          points,
          atMs: Date.now(),
          replayed: catchingUp.current,
        });
        if (next !== prev) savePaceState(next);
        return next;
      });
    } else if ("LevelUp" in ev) {
      // Ding: you're at 0% of the new level. From here, later XP gains can
      // estimate time/kills to the next ding without any manual percent entry.
      // Live only: a replayed ding's gains since it already sit in the
      // persisted position.
      if (!catchingUp.current) {
        setLevelAnchorKnown(true);
        setLevelProgress(0);
        saveLevelAnchorKnown(true);
        saveLevelProgress(0);
      }
    } else if ("Slain" in ev) {
      const d = ev.Slain as Record<string, unknown>;
      if (entityName(d.victim) === "You") {
        const recap: DeathRecap = {
          id: sessionSeq.current++,
          ts: p.ts,
          killer: d.killer == null ? "Unknown" : entityName(d.killer),
          lines: recentLines.current.filter((l) => p.ts - l.ts <= RECAP_WINDOW_SECS),
          damage: summarizeDamage(
            recentDamage.current.filter((h) => p.ts - h.ts <= RECAP_WINDOW_SECS),
          ),
        };
        setRecaps((prev) => [recap, ...prev].slice(0, 20));
        // Scoreboard: your death breaks your killstreak.
        const yp = bumpPlayer("You");
        yp.deaths++;
        yp.curStreak = 0;
        scoreDirty.current = true;
      } else if (
        typeof d.victim === "object" &&
        d.victim !== null &&
        "Named" in d.victim
      ) {
        const victim = entityName(d.victim);
        // Player-shaped names (one capitalized word — "Torvin") are dead
        // GROUPMATES, not camp kills; mobs carry articles or multiple
        // words. Same heuristic as the curated ally-slain trigger.
        const looksLikePlayer = /^[A-Z][a-z]+$/.test(victim);
        if (looksLikePlayer) {
          // Groupmate died — their killstreak resets, deaths tick up.
          const dp = bumpPlayer(victim);
          dp.deaths++;
          dp.curStreak = 0;
          scoreDirty.current = true;
        } else {
          // NPC kill: tally it and (when the refdb knows the mob) start or reset
          // its camp timer. Replayed kills stay out of the camp timer (a
          // Date.now()-anchored hours-old kill is wrong by construction).
          if (!catchingUp.current) handleNamedSlain(victim);
          // Scoreboard: credit the killing blow to the slaying player.
          const killer = d.killer == null ? "" : entityName(d.killer);
          if (killer && isPlayerName(killer, ownedNames)) {
            const kp = bumpPlayer(killer);
            kp.killingBlows++;
            kp.curStreak++;
            if (kp.curStreak > kp.bestStreak) kp.bestStreak = kp.curStreak;
            kp.lastTs = p.ts;
            scoreDirty.current = true;
          }
        }
      }
    } else if ("BuffBlocked" in ev) {
      // The game's own stacking verdict (P11): learn the conflicting pair so
      // the Spells tab can warn about it. Toast only on a NEW pair, live only.
      const d = ev.BuffBlocked as Record<string, unknown>;
      const spell = String(d.spell ?? "").trim();
      const blocker = String(d.blocker ?? "").trim();
      if (spell && blocker) {
        const learned = recordConflict(spell, blocker);
        if (learned && !catchingUp.current) {
          setToast(`Learned: ${spell} won't stack with ${blocker}`);
        }
      }
    }
  });

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
      // Imported fights carry negative ids and aren't stored — format locally.
      const text = await pasteParse(f.id >= 0 ? f.id : null, {
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

  async function deleteOne(f: FightRecord) {
    try {
      await deleteFight(f.id);
      if (selected?.id === f.id) setSelected(null);
      load(page);
      setToast(`Deleted “${f.target}”`);
    } catch {
      setToast("Could not delete that fight");
    }
  }

  async function clearHistory() {
    if (
      !(await confirmDiscard(
        "Delete ALL saved fights? This can't be undone.",
      ))
    ) {
      return;
    }
    try {
      const n = await pruneFights({ keepLastN: 0 });
      setSelected(null);
      setPage(0);
      load(0);
      setToast(`Cleared ${n} fight${n === 1 ? "" : "s"} from history`);
    } catch {
      setToast("Could not clear history");
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
      setToast("Could not export that fight");
    }
  }

  async function exportCurrentSession() {
    const { startTs, endTs } = sessionBounds.current;
    if (startTs === null || endTs === null) {
      setToast("No session activity to export yet");
      return;
    }
    const safeCharacter = character.replace(/[^\w-]+/g, "_") || "character";
    const day = new Date().toISOString().slice(0, 10);
    setExportingSession(true);
    try {
      const path = await save({
        defaultPath: `legends-session-${safeCharacter}-${day}.json`,
        filters: [
          { name: "Legends Companion session", extensions: ["json"] },
        ],
      });
      if (typeof path !== "string") return;
      await exportSession({
        path,
        character,
        startTs,
        endTs,
        details: {
          xp,
          pace,
          level: { progress: levelProgress, anchorKnown: levelAnchorKnown },
          kills: Object.values(kills),
          effects,
          deathRecaps: recaps.map(({ id, ts, killer, damage }) => ({
            id,
            ts,
            killer,
            damage,
          })),
          loot,
          rolls,
          scoreboard: scoreboard.current,
          captureLimits: {
            collectionRows: SESSION_CAP,
            deathRecaps: 20,
            rawLogLinesIncluded: false,
          },
        },
      });
      setToast("Session exported");
    } catch (e) {
      setToast(`Could not export session: ${String(e)}`);
    } finally {
      setExportingSession(false);
    }
  }

  async function importLog() {
    let path: string | null = null;
    try {
      path = await pickLogFile();
    } catch (e) {
      setToast(`Could not open the file picker: ${e}`);
      return;
    }
    if (!path) return;
    setImporting(true);
    try {
      const parsed = await analyzeLog(path);
      const file = path.split(/[\\/]/).pop() ?? path;
      setSelected(null);
      setImported({ file, fights: parsed });
      setToast(
        `Imported ${parsed.length} fight${parsed.length === 1 ? "" : "s"} from ${file}`,
      );
    } catch (e) {
      setToast(`Import failed: ${e}`);
    } finally {
      setImporting(false);
    }
  }

  async function copyTellParse(f: FightRecord) {
    const target = window.prompt("Send parse to player");
    if (!target) return;
    const who = target.trim();
    if (!who) return;
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
      setToast(`Tell parse copied for ${who}`);
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

  function splitPetRows(rows: FightRecord["rows"]): FightRecord["rows"] {
    return splitPetDamageRows(
      rows,
      selected?.durationSecs ?? 0,
      selected?.totalDamage ?? 0,
    );
  }

  // ---- detail view ----
  if (selected) {
    const dps = yourDps(selected);
    const detailRows = splitPetRows(selected.rows);
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
            onClick={() => void copyTellParse(selected)}
            title="Copy this fight as /tell lines"
          >
            Copy tell
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
          {detailRows.length === 0 ? (
            <Empty title="No damage rows" body="This fight recorded no damage contributions." />
          ) : (
            <MeterTable rows={detailRows} />
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
        count={total}
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
            {fights && fights.length > 0 && (
              <button className="ghost small" onClick={() => void clearHistory()}>
                Clear history
              </button>
            )}
          </span>
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
                    <button
                      className="ghost small"
                      onClick={(e) => {
                        e.stopPropagation();
                        void copyTellParse(f);
                      }}
                      title="Copy this fight as /tell lines"
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
      <SessionSection
        loot={loot}
        rolls={rolls}
        effects={effects}
        xp={xp}
        pace={pace}
        onSetPace={(next) => {
          savePaceState(next);
          setPace(next);
        }}
        levelProgress={levelProgress}
        levelAnchorKnown={levelAnchorKnown}
        recaps={recaps}
        wishlist={wishlist}
        kills={kills}
        respawnFor={(name) => respawnCache.current.get(name.toLowerCase()) ?? null}
        onResetXp={() => {
          clearXpSession();
          setXp(loadXpSession());
        }}
        canExport={hasSessionActivity}
        exporting={exportingSession}
        onExport={() => void exportCurrentSession()}
      />
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
  effects,
  xp,
  pace,
  onSetPace,
  levelProgress,
  levelAnchorKnown,
  recaps,
  wishlist,
  kills,
  respawnFor,
  onResetXp,
  canExport,
  exporting,
  onExport,
}: {
  loot: LootEntry[];
  rolls: RollEntry[];
  effects: EffectEntry[];
  xp: XpSession;
  pace: PaceState;
  onSetPace: (next: PaceState) => void;
  levelProgress: number;
  levelAnchorKnown: boolean;
  recaps: DeathRecap[];
  wishlist: WishlistEntry[];
  kills: Record<string, KillTally>;
  /** Cached refdb lookup (null/absent = unknown mob or not fetched yet). */
  respawnFor: (name: string) => RespawnInfo | null;
  onResetXp: () => void;
  canExport: boolean;
  exporting: boolean;
  onExport: () => void;
}) {
  const [lootQuery, setLootQuery] = useState("");
  const [tab, setTab] = useState<"rates" | "xp" | "kills" | "effects" | "deaths" | "loot" | "wishlist" | "rolls">("rates");

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
  const effectRows = useMemo(() => {
    const bySpell = new Map<
      string,
      {
        kind: EffectEntry["kind"];
        spell: string;
        count: number;
        damage: number;
        hasDamage: boolean;
        crits: number;
        lastTs: number;
      }
    >();
    for (const p of effects) {
      const key = `${p.kind}:${p.spell.toLowerCase()}`;
      const cur = bySpell.get(key);
      if (cur) {
        cur.count += 1;
        cur.damage += p.amount ?? 0;
        cur.hasDamage = cur.hasDamage || p.amount != null;
        cur.crits += p.critical ? 1 : 0;
        cur.lastTs = Math.max(cur.lastTs, p.ts);
      } else {
        bySpell.set(key, {
          kind: p.kind,
          spell: p.spell,
          count: 1,
          damage: p.amount ?? 0,
          hasDamage: p.amount != null,
          crits: p.critical ? 1 : 0,
          lastTs: p.ts,
        });
      }
    }
    return [...bySpell.values()]
      .sort((a, b) => b.count - a.count || b.damage - a.damage || b.lastTs - a.lastTs)
      .slice(0, 12);
  }, [effects]);
  // Live XP rate: the window extends to "now" (ticking every 15 s), so the
  // rate decays between kills instead of freezing at the last gain.
  const nowMs = useNowMs();
  const xpStats = useMemo(() => computeXpStats(xp, nowMs), [xp, nowMs]);
  const progressPct = levelAnchorKnown ? Math.min(100, Math.max(0, levelProgress)) : 0;
  // Kills/time to ding from the anchored position and the 10m rate window.
  const levelEta = useMemo(
    () =>
      computeLevelEta(
        { total: xpStats.total, count: xpStats.count, rows: [] },
        progressPct,
        xpStats.perHour,
      ),
    [xpStats.total, xpStats.count, xpStats.perHour, progressPct],
  );

  // Session kills, most-killed first (camp efficiency v1).
  const killRows = useMemo(
    () =>
      Object.values(kills)
        .sort((a, b) => b.kills - a.kills || a.name.localeCompare(b.name))
        .slice(0, KILL_ROW_CAP),
    [kills],
  );

  return (
    <div className="session-tabs-card card">
      <div className="session-tabs settings-tabs">
        {[
          ["rates", "Rates", pace.history.length],
          ["xp", "XP", xp.count],
          ["kills", "Kills", killRows.length],
          ["effects", "Effects", effects.length],
          ["deaths", "Death recaps", recaps.length],
          ["loot", "Loot", loot.length],
          ["wishlist", "Wishlist", wishlist.length],
          ["rolls", "Rolls", rolls.length],
        ].map(([id, label, count]) => (
          <button
            key={id}
            className={`settings-tab${tab === id ? " active" : ""}`}
            onClick={() => setTab(id as typeof tab)}
          >
            {label}
            <span className="pill">{count}</span>
          </button>
        ))}
        <span className="spacer" />
        <button
          className="ghost small"
          onClick={onExport}
          disabled={!canExport || exporting}
          title="Save this session's fights, XP, kills, effects, loot, and rolls"
        >
          {exporting ? "Exporting…" : "Export session"}
        </button>
      </div>
      {tab === "rates" && (
        <Collapsible title="Rates" count={pace.history.length} storageKey="rates">
          <PaceRates pace={pace} onChange={onSetPace} />
        </Collapsible>
      )}
      {tab === "xp" && <Collapsible
        title="XP"
        count={xp.count}
        storageKey="xp"
        headerAside={
          xp.rows.length > 0 ? (
            <button className="ghost small" onClick={onResetXp}>
              Reset
            </button>
          ) : undefined
        }
      >
        {xp.rows.length === 0 ? (
          <Empty
            title="No XP yet"
            body="XP gains seen this session appear here with an hourly estimate."
          />
        ) : (
          <>
            <div className="stat-tiles compact">
              <StatTile value={`${xpStats.total.toFixed(2)}%`} label="XP gained 10m" />
              <StatTile
                value={xpStats.perHour === null ? "—" : `${xpStats.perHour.toFixed(2)}%`}
                label="XP/hour"
              />
              <StatTile
                value={
                  xpStats.perLevelHours === null
                    ? "—"
                    : fmtDuration(Math.round(xpStats.perLevelHours * 3600))
                }
                label="Per level"
              />
            </div>
            <div className="xp-tolevel">
              <div className="xp-tolevel-head">
                <span className="xp-tolevel-label">To level</span>
                <span className="xp-tolevel-vals num">
                  {!levelAnchorKnown || levelEta.kills === null
                    ? "—"
                    : `~${levelEta.kills} kill${levelEta.kills === 1 ? "" : "s"}`}
                  {levelAnchorKnown &&
                    levelEta.kills !== null &&
                    levelEta.mins !== null &&
                    ` · ~${fmtDuration(Math.round(levelEta.mins * 60))}`}
                </span>
              </div>
              <div
                className="xp-progress"
                role="progressbar"
                aria-valuenow={Math.round(progressPct)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Progress into current level"
              >
                <div
                  className="xp-progress-fill"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <div className="hint">
                {levelAnchorKnown
                  ? `${progressPct.toFixed(1)}% into level since the last ding seen by the app.`
                  : "No level ETA yet. It will start after the app sees your next ding."}
              </div>
            </div>
            <div className="session-loot">
              <div className="session-loot-row session-loot-head" aria-hidden="true">
                <span>Time</span>
                <span>XP</span>
                <span>Type</span>
              </div>
              {xp.rows.slice(0, 20).map((x) => (
                <div className="session-loot-row" key={x.id}>
                  <span className="session-time num">{fmtClock(x.ts)}</span>
                  <span className="num">{x.percent.toFixed(2)}%</span>
                  <span>{x.party ? "party" : "solo"}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </Collapsible>}

      {tab === "kills" && <Collapsible
        title="Kills"
        count={killRows.length}
        storageKey="kills"
      >
        {killRows.length === 0 ? (
          <Empty
            title="No kills yet"
            body="NPC kills seen this session tally here per mob, with a live kills/hour rate."
          />
        ) : (
          <div className="session-loot">
            <div className="kills-row session-loot-head" aria-hidden="true">
              <span>Mob</span>
              <span className="num">Kills</span>
              <span className="num">Kills/hr</span>
              <span className="num">Respawn</span>
            </div>
            {killRows.map((k) => {
              const elapsedMs = nowMs - k.firstAtMs;
              // Under a minute of data the rate is meaningless noise.
              const rate =
                elapsedMs >= 60_000 ? k.kills / (elapsedMs / 3_600_000) : null;
              const info = respawnFor(k.name);
              return (
                <div className="kills-row" key={k.name.toLowerCase()}>
                  <span className="session-item">{k.name}</span>
                  <span className="num">{k.kills}</span>
                  <span className="num">
                    {rate === null ? "—" : rate.toFixed(1)}
                  </span>
                  <span className="num">
                    {info && info.respawnSecs > 0
                      ? fmtDuration(info.respawnSecs)
                      : "—"}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </Collapsible>}

      {tab === "effects" && <Collapsible
        title="Effects"
        count={effects.length}
        storageKey="effects"
      >
        {effects.length === 0 ? (
          <Empty
            title="No effects yet"
            body="Parsed skill riders and direct spell hits from you appear here. Alerts and TTS are configured through triggers."
          />
        ) : (
          <>
            <div className="session-loot">
              <div className="kills-row session-loot-head" aria-hidden="true">
                <span>Effect</span>
                <span className="num">Hits</span>
                <span className="num">Damage</span>
                <span className="num">Last</span>
              </div>
              {effectRows.map((p) => (
                <div className="kills-row" key={`${p.kind}:${p.spell}`}>
                  <span className="session-item">{effectName(p)}</span>
                  <span className="num">
                    {p.count}
                    {p.crits > 0 ? ` / ${p.crits} crit` : ""}
                  </span>
                  <span className="num">{p.hasDamage ? fmtNum(p.damage) : "—"}</span>
                  <span className="num">{fmtClock(p.lastTs)}</span>
                </div>
              ))}
            </div>
            <div className="session-loot">
              <div className="session-loot-row session-loot-head" aria-hidden="true">
                <span>Time</span>
                <span>Effect</span>
                <span>Target</span>
              </div>
              {effects.slice(0, 20).map((p) => (
                <div className="session-loot-row" key={p.id}>
                  <span className="session-time num">{fmtClock(p.ts)}</span>
                  <span className="session-item">
                    {effectName(p)}{" "}
                    {effectAmountText(p) && (
                      <span className="session-qty num">{effectAmountText(p)}</span>
                    )}
                  </span>
                  <span className="session-who">{p.target}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </Collapsible>}

      {tab === "deaths" && <Collapsible title="Death recaps" count={recaps.length} storageKey="deaths">
        {recaps.length === 0 ? (
          <Empty
            title="No deaths yet"
            body="When you die, the last few combat lines are captured here for review."
          />
        ) : (
          <div className="death-recaps">
            {recaps.map((r) => (
              <div className="death-recap" key={r.id}>
                <div className="roll-group-head">
                  <span>
                    {fmtClock(r.ts)} · slain by {r.killer}
                  </span>
                  <span className="hint num">
                    {r.damage.totalTaken > 0
                      ? `${fmtNum(r.damage.totalTaken)} taken`
                      : `${r.lines.length} lines`}
                  </span>
                </div>
                {r.damage.bySource.length > 0 && (
                  <div className="death-damage">
                    {r.damage.bySource.slice(0, 5).map((s) => (
                      <div className="death-dmg-row" key={s.source}>
                        <span className="death-dmg-src">{s.source}</span>
                        <span className="death-dmg-bar-wrap">
                          <span
                            className="death-dmg-bar"
                            style={{
                              width: `${
                                r.damage.totalTaken > 0
                                  ? (s.amount / r.damage.totalTaken) * 100
                                  : 0
                              }%`,
                            }}
                          />
                        </span>
                        <span className="death-dmg-amt num">
                          {fmtNum(s.amount)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="death-lines">
                  {r.lines.map((line, ix) => (
                    <div className="death-line" key={`${r.id}-${ix}`}>
                      <span className="session-time num">{fmtClock(line.ts)}</span>
                      <span className="chip chip-muted">{line.kind.toLowerCase()}</span>
                      <span>{line.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Collapsible>}

      {tab === "loot" && <Collapsible
        title="Loot"
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
                  <button
                    className="session-item-link"
                    title="Look up in the Drops database"
                    onClick={() =>
                      window.dispatchEvent(
                        new CustomEvent("eqlogs-open-drops", { detail: l.item }),
                      )
                    }
                  >
                    {l.item}
                  </button>
                </span>
                <span className="session-who" title={l.corpse ?? undefined}>
                  {l.who}
                </span>
              </div>
            ))}
          </div>
        )}
      </Collapsible>}

      {tab === "wishlist" && <Collapsible
        title="Wishlist"
        count={wishlist.length}
        storageKey="wishlist"
      >
        {wishlist.length === 0 ? (
          <Empty
            title="Wishlist is empty"
            body="Star items in the Drops tab to build a wishlist — when one drops, you get a spoken alert here."
          />
        ) : (
          <>
            <div className="session-loot">
              {wishlist.map((w) => (
                <div
                  className="session-loot-row wishlist-row"
                  key={w.name.toLowerCase()}
                >
                  <span className="session-item">{w.name}</span>
                  <button
                    className="ghost small"
                    onClick={() => toggleWishlist(w.name)}
                    title="Remove from wishlist"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            <div className="hint">
              Star items in the Drops tab to add more.
            </div>
          </>
        )}
      </Collapsible>}

      {tab === "rolls" && <Collapsible title="Rolls" count={rolls.length} storageKey="rolls">
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
      </Collapsible>}
    </div>
  );
}
