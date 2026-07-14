// Session log tracker (APP_REVIEW X10, moved out of FightsTab): in-memory
// loot log, /random roll tracker, spell-effect totals, per-mob kill tallies,
// XP session mirror, death recaps, and the party scoreboard — accumulated for
// the whole app run from the "log-line" stream. This lives in a lib module
// (the lib/pace.ts pattern: module-level state fed by events, components
// subscribe) so accumulation keeps working no matter which tab is mounted.
//
// Dashboard calls startSessionLog() once on mount; components read the
// immutable snapshot via useSessionLog(). User-facing notices (wishlist
// drops, learned buff conflicts) surface through onSessionNotice — Dashboard
// pipes them into the app toast.

import { useSyncExternalStore } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getConfig, refdbRespawnFor, speakText } from "../api";
import { IS_MOCK, mockEmit, mockListen } from "../mock";
import { recordConflict } from "./buffConflicts";
import {
  type DamageSummary,
  incomingDamage,
  type IncomingHit,
  summarizeDamage,
} from "./deathRecap";
import { observedSpellEffect } from "./effects";
import {
  applySessionDelta,
  applyAllTimeDelta,
  factionStore,
  type FactionSessionRow,
} from "./factionLedger";
import {
  applyPaceEvent,
  loadPaceState,
  type PaceEvent,
  savePaceState,
} from "./pace";
import {
  applySkillUp,
  beginSkillSession,
  skillStore,
} from "./skillUps";
import {
  applyWalletGain,
  emptyWallet,
  walletGainFromEvent,
  type WalletState,
} from "./wallet";
import {
  createMezTracker,
  loadMezBreakSpeak,
  type MezBreak,
} from "./mezBreaks";
import {
  emptyPlayer,
  isPlayerName,
  saveScoreboard,
  type PlayerScore,
  type Scoreboard,
} from "./scoreboard";
import { isWishlisted } from "./wishlist";
import {
  appendXpSession,
  clearXpSession,
  loadLevelAnchorKnown,
  loadLevelProgress,
  loadXpSession,
  saveLevelAnchorKnown,
  saveLevelProgress,
  type XpSession,
} from "../overlayState";
import type {
  AppConfig,
  CatchUpPayload,
  EffectObservedPayload,
  LogLinePayload,
  RespawnInfo,
  TimerPayload,
} from "../types";

// ---------------------------------------------------------------------------
// Entry types (session-scoped, reset on app restart).
// ---------------------------------------------------------------------------

export interface LootEntry {
  id: number;
  ts: number;
  item: string;
  qty: number;
  /** Looter (normalized "You" or a player/pet name). */
  who: string;
  /** Corpse the item came off, when the line carried one. */
  corpse: string | null;
}

export interface RollEntry {
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

export interface EffectEntry {
  id: number;
  ts: number;
  kind: "spell";
  spell: string;
  target: string;
  amount: number | null;
  critical: boolean;
}

export interface DeathRecap {
  id: number;
  ts: number;
  killer: string;
  lines: { ts: number; message: string; kind: string }[];
  /** Structured incoming-damage summary for the recap window (P25). */
  damage: DamageSummary;
}

/** One skill-up seen this session (value is the new ABSOLUTE skill level;
 *  delta is vs the persisted previous value, null on first sighting). */
export interface SkillUpEntry {
  id: number;
  ts: number;
  skill: string;
  value: number;
  delta: number | null;
}

/** Per-mob session kill tally (camp efficiency v1). */
export interface KillTally {
  name: string;
  kills: number;
  /** Wall-clock ms of the first kill — anchors the live kills/hour rate. */
  firstAtMs: number;
}

export const SESSION_CAP = 200;
export const RECAP_CAP = 20;
const RECAP_WINDOW_SECS = 15;
const RECAP_LINE_CAP = 25;
const RECAP_DAMAGE_CAP = 60;

export interface SessionLogSnapshot {
  loot: LootEntry[];
  rolls: RollEntry[];
  effects: EffectEntry[];
  recaps: DeathRecap[];
  kills: Record<string, KillTally>;
  /** Session coin income (Money lines + auto-sold loot), reset per app run. */
  wallet: WalletState;
  /** Per-faction net standing movement this session (lowercased key). */
  factions: Record<string, FactionSessionRow>;
  /** Skill-ups this session, newest first (capped at SESSION_CAP). */
  skillUps: SkillUpEntry[];
  xp: XpSession;
  /** Position within the current level; only trustworthy after this app sees
   *  a ding (P9). Both persist so the XP overlay and later sessions keep it. */
  levelProgress: number;
  levelAnchorKnown: boolean;
  /** Any live (non-replayed) log line seen this run — enables session export. */
  hasActivity: boolean;
}

// ---------------------------------------------------------------------------
// Store plumbing.
// ---------------------------------------------------------------------------

let snap: SessionLogSnapshot = {
  loot: [],
  rolls: [],
  effects: [],
  recaps: [],
  kills: {},
  wallet: emptyWallet(),
  factions: {},
  skillUps: [],
  xp: loadXpSession(),
  levelProgress: loadLevelProgress(),
  levelAnchorKnown: loadLevelAnchorKnown(),
  hasActivity: false,
};

const listeners = new Set<() => void>();

function notify(): void {
  for (const cb of [...listeners]) cb();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function set(patch: Partial<SessionLogSnapshot>): void {
  snap = { ...snap, ...patch };
}

export function getSessionLogSnapshot(): SessionLogSnapshot {
  return snap;
}

/** Live session-log snapshot for React components. */
export function useSessionLog(): SessionLogSnapshot {
  return useSyncExternalStore(subscribe, getSessionLogSnapshot);
}

/** User-facing notices from session tracking (wishlist drop landed, buff
 *  conflict learned). Dashboard subscribes and shows them as toasts. */
const noticeListeners = new Set<(message: string) => void>();

export function onSessionNotice(cb: (message: string) => void): () => void {
  noticeListeners.add(cb);
  return () => {
    noticeListeners.delete(cb);
  };
}

function notice(message: string): void {
  for (const cb of [...noticeListeners]) cb(message);
}

/** Reset the persisted XP session (the Session tab's Reset button). */
export function resetXpSession(): void {
  clearXpSession();
  set({ xp: loadXpSession() });
  notify();
}

// Log-line span of this run, for session export.
const bounds: { startTs: number | null; endTs: number | null } = {
  startTs: null,
  endTs: null,
};

export function sessionBounds(): { startTs: number | null; endTs: number | null } {
  return { ...bounds };
}

// Party Scoreboard: per-player session stats (reset each run). Flushed to
// localStorage on a timer; the overlay reads it. (Record-break trophies were
// dropped — Impact moments are trigger-driven now, not scoreboard-driven.)
let scoreboard: Scoreboard = {};
let scoreDirty = false;

export function sessionScoreboard(): Scoreboard {
  return { ...scoreboard };
}

// Mez-break attribution (lib/mezBreaks heuristic): fed enemy-lane timer
// events + the same player-damage fold the scoreboard uses. Timer events
// carry no timestamp, so they're stamped with the latest log-line ts.
const mezTracker = createMezTracker();
let lastLogTs = 0;

/** Credit a mez break on the Party Scoreboard; the spoken line is OFF by
 *  default (alert-fatigue budget) and toggled in the Scoreboard panel.
 *  Muted during catch-up like every other side-effectful announcement. */
function creditMezBreak(brk: MezBreak): void {
  const pl = bumpPlayer(brk.attacker);
  pl.mezBreaks++;
  scoreDirty = true;
  if (!catchingUp && loadMezBreakSpeak()) {
    void speakText(`${brk.attacker} broke mez on ${brk.target}`);
  }
}

// Respawn reference data, fetched once per mob name per app run for the
// kills panel's Respawn column. Camp/respawn TIMERS themselves live entirely
// in the Timers tab (lib/timers.ts) — this store only tallies kills.
const respawnCache = new Map<string, RespawnInfo | null>();
const respawnPending = new Set<string>();

/** Cached refdb lookup (null = unknown mob or not fetched yet). */
export function respawnFor(name: string): RespawnInfo | null {
  return respawnCache.get(name.toLowerCase()) ?? null;
}

// Replay catch-up (item 13): the backend suppresses trigger audio for
// replayed lines; side-effectful features here must stay quiet too — no
// late "X dropped!" speech, no wall-clock anchors for hours-old events.
let catchingUp = false;

// Config mirror: your character name + configured pets, for damage/kill
// attribution.
let character = "";
let ownedNames = new Set<string>();

function syncConfig(config: AppConfig): void {
  character = config.characterName;
  ownedNames = new Set(
    [config.characterName, ...(config.pets ?? [])]
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length > 0),
  );
}

// ---------------------------------------------------------------------------
// Event helpers.
// ---------------------------------------------------------------------------

/** Read a serde-encoded eqlog-core Entity: "You" (bare string) or
 *  { Named: "<name>" }. */
function entityName(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "Named" in e) {
    return String((e as { Named: unknown }).Named);
  }
  return "?";
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

function publishObservedEffect(payload: EffectObservedPayload): void {
  if (IS_MOCK) mockEmit("effect-observed", payload);
  else void emit("effect-observed", payload);
}

/** Subscribe to an app event for the app's lifetime (Tauri event in the real
 *  app, the in-page mock bus in browser mode). */
function onAppEvent<T>(name: string, handler: (payload: T) => void): void {
  if (IS_MOCK) {
    mockListen<T>(name, handler);
    return;
  }
  void listen<T>(name, (e) => handler(e.payload)).catch((err) =>
    console.error(`listen(${name}) failed`, err),
  );
}

function applyPace(event: PaceEvent): void {
  const prev = loadPaceState();
  const next = applyPaceEvent(prev, event);
  if (next !== prev) savePaceState(next);
}

// ---------------------------------------------------------------------------
// Accumulation.
// ---------------------------------------------------------------------------

let sessionSeq = 0;
/** Skill-up-session index claimed lazily on the first LIVE skill-up of this
 *  app run (idle runs never advance the stuck-skill counter). */
let skillSessionIndex: number | null = null;
let recentLines: { ts: number; message: string; kind: string }[] = [];
// Structured incoming-damage ring for the death recap (P25).
let recentDamage: ({ ts: number } & IncomingHit)[] = [];

function bumpPlayer(name: string): PlayerScore {
  const k = name.toLowerCase();
  const found = scoreboard[k];
  if (found) return found;
  const created = emptyPlayer(name);
  scoreboard[k] = created;
  return created;
}

function handleNamedSlain(victim: string): void {
  const key = victim.toLowerCase();
  // Session kill tally (camp efficiency v1).
  const cur = snap.kills[key];
  set({
    kills: {
      ...snap.kills,
      [key]: cur
        ? { ...cur, kills: cur.kills + 1 }
        : { name: victim, kills: 1, firstAtMs: Date.now() },
    },
  });
  // Respawn lookup once per name for the kills panel's Respawn column.
  if (!respawnCache.has(key) && !respawnPending.has(key)) {
    respawnPending.add(key);
    void refdbRespawnFor(victim).then((info) => {
      respawnPending.delete(key);
      respawnCache.set(key, info);
      // Bump the snapshot so kills panels re-read the cache.
      snap = { ...snap };
      notify();
    });
  }
}

function publishEffect(entry: EffectEntry): void {
  set({ effects: [entry, ...snap.effects].slice(0, SESSION_CAP) });
  publishObservedEffect({
    kind: entry.kind,
    spell: entry.spell,
    target: entry.target,
    amount: entry.amount,
    critical: entry.critical,
  });
}

function handleLogLine(p: LogLinePayload): void {
  const before = snap;
  lastLogTs = p.ts;
  if (!catchingUp) {
    if (bounds.startTs === null) set({ hasActivity: true });
    bounds.startTs = bounds.startTs === null ? p.ts : Math.min(bounds.startTs, p.ts);
    bounds.endTs = bounds.endTs === null ? p.ts : Math.max(bounds.endTs, p.ts);
  }
  const ev = p.event;
  const kind =
    typeof ev === "string" ? ev : Object.keys(ev ?? {})[0] ?? "Unknown";
  recentLines = [
    ...recentLines.filter((l) => p.ts - l.ts <= RECAP_WINDOW_SECS),
    { ts: p.ts, message: p.message, kind },
  ].slice(-RECAP_LINE_CAP);
  // "Skill: Reave" was formerly hardcoded here; it is now the curated,
  // per-taste-toggleable trigger `skills/melee/reave` (default OFF) in
  // triggers/curated/skills.json — see the "everything configurable"
  // principle. Removed so it no longer double-fires as a built-in alert.
  if (typeof ev !== "object" || ev === null) {
    if (snap !== before) notify();
    return;
  }
  if ("MeleeHit" in ev) {
    const d = (ev as Record<string, unknown>).MeleeHit as Record<string, unknown>;
    const attacker = entityName(d.attacker);
    const flags = d.flags as Record<string, unknown> | undefined;
    // Finishing Blow AA: the hit line is tagged "(Finishing Blow)". We count
    // it toward the Scoreboard leaderboard here; the DRAMATIC moment (the
    // slash on the Impact overlay) is NOT hardcoded — it's the curated
    // `impact/finishing-blow` trigger, so it's fully user-configurable like
    // every other alert/impact.
    if (hasFinishingBlowFlag(flags)) {
      bumpPlayer(attacker).finishingBlows++;
      scoreDirty = true;
    }
  }
  // Track incoming damage for the death recap (P25) — any damage event
  // aimed at You, kept to the recap window.
  const hit = incomingDamage(ev);
  if (hit && hit.amount > 0) {
    recentDamage = [
      ...recentDamage.filter((h) => p.ts - h.ts <= RECAP_WINDOW_SECS),
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
    scoreDirty = true;
    // Mez-break attribution: first player hit on a mezzed target (or right
    // after its mez bar dropped early) claims the break.
    if (sh.target) {
      const brk = mezTracker.onDamage(sh.attacker, sh.target, p.ts);
      if (brk) creditMezBreak(brk);
    }
  }
  if ("SpellDamage" in ev) {
    const d = (ev as Record<string, unknown>).SpellDamage as Record<string, unknown>;
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
        id: sessionSeq++,
        ts: p.ts,
        ...observed,
      };
      publishEffect(entry);
    }
  }
  // Session wallet: Money lines plus the auto-sell figure riding on Loot
  // (`sold_for`). Replayed lines stay out — plat/hour anchors to Date.now(),
  // and hours-old coin at "now" is wrong by construction (kill-tally rule).
  if (!catchingUp) {
    const gain = walletGainFromEvent(ev);
    if (gain) {
      set({
        wallet: applyWalletGain(snap.wallet, {
          id: sessionSeq++,
          ts: p.ts,
          atMs: Date.now(),
          ...gain,
        }),
      });
    }
  }
  if ("Loot" in ev) {
    const d = (ev as Record<string, unknown>).Loot as Record<string, unknown>;
    const entry: LootEntry = {
      id: sessionSeq++,
      ts: p.ts,
      item: String(d.item ?? "?"),
      qty: typeof d.quantity === "number" ? d.quantity : 1,
      who: entityName(d.looter),
      corpse: d.corpse == null ? null : String(d.corpse),
    };
    set({ loot: [entry, ...snap.loot].slice(0, SESSION_CAP) });
    applyPace({
      kind: "loot",
      item: entry.item,
      quantity: entry.qty,
      looter: entry.who,
      atMs: Date.now(),
      replayed: catchingUp,
    });
    // Wishlist drop alert: spoken + toast (star items in the Drops tab).
    // Muted during catch-up: a replayed loot line is old news.
    if (!catchingUp && isWishlisted(entry.item)) {
      void speakText(`${entry.item} dropped!`);
      notice(`Wishlist drop: ${entry.item}!`);
    }
  } else if ("Roll" in ev) {
    const d = (ev as Record<string, unknown>).Roll as Record<string, unknown>;
    const roller = String(d.roller ?? "").trim();
    const entry: RollEntry = {
      id: sessionSeq++,
      ts: p.ts,
      roller: roller || "Unknown",
      min: typeof d.min === "number" ? d.min : 0,
      max: typeof d.max === "number" ? d.max : 0,
      result: typeof d.result === "number" ? d.result : 0,
    };
    set({ rolls: [entry, ...snap.rolls].slice(0, SESSION_CAP) });
  } else if ("XpGain" in ev) {
    const d = (ev as Record<string, unknown>).XpGain as Record<string, unknown>;
    const percent = typeof d.percent === "number" ? d.percent : 0;
    const entry: XpEntry = {
      id: p.ts * 1000 + sessionSeq++,
      ts: p.ts,
      percent,
      party: d.party === true,
    };
    // appendXpSession stamps the wall-clock receipt time (`at`) and caps
    // the list; use its return so the live rate window works here too.
    // Replayed gains skip the stamp — anchoring an old gain at "now"
    // would corrupt the live XP/hour rate.
    set({ xp: appendXpSession(entry, { stampNow: !catchingUp }) });
    applyPace({ kind: "xp", percent, atMs: Date.now(), replayed: catchingUp });
    // Advance level position on live gains only — replaying old gains would
    // double-count against the persisted position (P9).
    if (!catchingUp && snap.levelAnchorKnown) {
      const next = Math.min(100, snap.levelProgress + percent);
      saveLevelProgress(next);
      set({ levelProgress: next });
    }
  } else if ("AaPointGain" in ev) {
    const d = (ev as Record<string, unknown>).AaPointGain as Record<string, unknown>;
    const points = typeof d.points === "number" ? d.points : 1;
    applyPace({ kind: "aa-point", points, atMs: Date.now(), replayed: catchingUp });
  } else if ("LevelUp" in ev) {
    // Ding: you're at 0% of the new level. From here, later XP gains can
    // estimate time/kills to the next ding without any manual percent entry.
    // Live only: a replayed ding's gains since it already sit in the
    // persisted position.
    if (!catchingUp) {
      saveLevelAnchorKnown(true);
      saveLevelProgress(0);
      set({ levelAnchorKnown: true, levelProgress: 0 });
    }
  } else if ("Slain" in ev) {
    const d = (ev as Record<string, unknown>).Slain as Record<string, unknown>;
    if (entityName(d.victim) === "You") {
      const recap: DeathRecap = {
        id: sessionSeq++,
        ts: p.ts,
        killer: d.killer == null ? "Unknown" : entityName(d.killer),
        lines: recentLines.filter((l) => p.ts - l.ts <= RECAP_WINDOW_SECS),
        damage: summarizeDamage(
          recentDamage.filter((h) => p.ts - h.ts <= RECAP_WINDOW_SECS),
        ),
      };
      set({ recaps: [recap, ...snap.recaps].slice(0, RECAP_CAP) });
      // Scoreboard: your death breaks your killstreak.
      const yp = bumpPlayer("You");
      yp.deaths++;
      yp.curStreak = 0;
      scoreDirty = true;
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
        scoreDirty = true;
      } else {
        // NPC kill: tally it. Replayed kills stay out of the tally (a
        // Date.now()-anchored hours-old kill is wrong by construction).
        if (!catchingUp) handleNamedSlain(victim);
        // Scoreboard: credit the killing blow to the slaying player.
        const killer = d.killer == null ? "" : entityName(d.killer);
        if (killer && isPlayerName(killer, ownedNames)) {
          const kp = bumpPlayer(killer);
          kp.killingBlows++;
          kp.curStreak++;
          if (kp.curStreak > kp.bestStreak) kp.bestStreak = kp.curStreak;
          kp.lastTs = p.ts;
          scoreDirty = true;
        }
      }
    }
  } else if ("BuffBlocked" in ev) {
    // The game's own stacking verdict (P11): learn the conflicting pair so
    // the Spells tab can warn about it. Notice only on a NEW pair, live only.
    const d = (ev as Record<string, unknown>).BuffBlocked as Record<string, unknown>;
    const spell = String(d.spell ?? "").trim();
    const blocker = String(d.blocker ?? "").trim();
    if (spell && blocker) {
      const learned = recordConflict(spell, blocker);
      if (learned && !catchingUp) {
        notice(`Learned: ${spell} won't stack with ${blocker}`);
      }
    }
  } else if ("Faction" in ev) {
    // Faction ledger: session map + per-character all-time (since tracking
    // began — the log only ever carries deltas). Live only: the persisted
    // all-time map would double-count every catch-up replay after a restart.
    const d = (ev as Record<string, unknown>).Faction as Record<string, unknown>;
    const faction = String(d.faction ?? "").trim();
    const delta = typeof d.delta === "number" ? d.delta : 0;
    if (faction && !catchingUp) {
      set({ factions: applySessionDelta(snap.factions, faction, delta, p.ts) });
      const store = factionStore(character);
      store.save(applyAllTimeDelta(store.load(), faction, delta, Date.now()));
    }
  } else if ("SkillUp" in ev) {
    // Skill tracker: value is the new ABSOLUTE skill level. Live ups count
    // toward tonight's list + the stuck heuristic; replayed ups only refresh
    // the persisted value (absolute, so replay can't double-count).
    const d = (ev as Record<string, unknown>).SkillUp as Record<string, unknown>;
    const skill = String(d.skill ?? "").trim();
    const value = typeof d.value === "number" ? d.value : 0;
    if (skill) {
      const store = skillStore(character);
      let state = store.load();
      if (!catchingUp) {
        if (skillSessionIndex === null) {
          const begun = beginSkillSession(state);
          state = begun.state;
          skillSessionIndex = begun.index;
        }
        const applied = applySkillUp(state, skill, value, {
          live: true,
          nowMs: Date.now(),
          sessionIndex: skillSessionIndex,
        });
        state = applied.state;
        set({
          skillUps: [
            { id: sessionSeq++, ts: p.ts, skill, value, delta: applied.delta },
            ...snap.skillUps,
          ].slice(0, SESSION_CAP),
        });
      } else {
        state = applySkillUp(state, skill, value, {
          live: false,
          nowMs: Date.now(),
          sessionIndex: 0,
        }).state;
      }
      store.save(state);
    }
  }
  if (snap !== before) notify();
}

// ---------------------------------------------------------------------------
// Startup.
// ---------------------------------------------------------------------------

let started = false;

/** Start accumulating (idempotent). Called once from Dashboard on mount —
 *  overlay windows never call it, so they don't double-track. */
export function startSessionLog(): void {
  if (started) return;
  started = true;
  void getConfig()
    .then(syncConfig)
    .catch(() => {
      ownedNames = new Set();
    });
  onAppEvent<AppConfig>("config-changed", syncConfig);
  onAppEvent<CatchUpPayload>("catch-up", (p) => {
    catchingUp = p.active;
  });
  onAppEvent<LogLinePayload>("log-line", handleLogLine);
  // Mez-break attribution follows the enemy-lane mez timer bars. Timer
  // events have no timestamp of their own — stamp with the latest log ts.
  onAppEvent<TimerPayload>("timer", (p) => mezTracker.onTimer(p, lastLogTs));
  // Scoreboard: fresh per app run (all-time records persist separately), and
  // flushed to localStorage once a second when dirty so the overlay updates
  // without a write per hit.
  scoreboard = {};
  saveScoreboard({});
  window.setInterval(() => {
    if (!scoreDirty) return;
    scoreDirty = false;
    saveScoreboard({ ...scoreboard });
  }, 1000);
}
