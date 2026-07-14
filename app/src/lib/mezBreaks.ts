// Mez-break attribution (Party Scoreboard "Mez" stat) — a bounded HEURISTIC,
// not ground truth: when an enemy-lane mez timer is running on target T
// (engine names bound timers "<Effect> — <target>"), the FIRST player damage
// event on T claims the break. If the timer bar drops early before any damage
// was seen (event-channel race: the "cancelled" timer event can beat the
// damage log-line event), a short claim window opens instead and the first
// player hit inside it wins. One claim per mez application — re-mezzing the
// target re-arms attribution. Natural expiry never credits anyone.
//
// Honesty note (surfaced in the UI tooltip): this is "first hit after break".
// Killing a mezzed mob counts as breaking its mez (the bar clears on Slain),
// which is deliberate — the nuke on the mezzed mob IS the break.
//
// Fed by lib/sessionLog: `onTimer` from the "timer" app event (stamped with
// the latest log-line ts, since timer events carry no timestamp of their
// own), `onDamage` from the same scoreboard damage fold that already gates
// attackers through isPlayerName. Pure and deterministic for tests.

import { splitTimerTarget, type TimerPayload } from "../types";
import { createLocalStore } from "./localStore";

/** How long after an early bar-drop a hit may still claim the break (secs,
 *  log time). Covers the cancel-before-damage event ordering race. */
export const MEZ_BREAK_WINDOW_SECS = 5;

/** A cancel this close to the timer's natural end is treated as normal
 *  wear-off, not a break (secs). */
export const MEZ_EARLY_MARGIN_SECS = 2;

/** Mez spells whose enemy-lane timers exist in the shipped packs (generated
 *  debuff timers are named by spell and get " — <target>"-bound via the
 *  land-on-other table; see crates/eqlog-triggers/src/buff_lands.rs).
 *  Walking Sleep is the shaman mez in Legends (curated pack comment). */
const MEZ_SPELLS = new Set([
  "mesmerize",
  "mesmerization",
  "enthrall",
  "entrance",
  "dazzle",
  "glamour of kintaz",
  "walking sleep",
]);

/** Is this timer label (target suffix already split off) a mez effect?
 *  Known mez spell names, plus anything the user named "mez" themselves
 *  (curated timers are "Mez (Mesmerize)" style). */
export function isMezEffect(label: string): boolean {
  const lower = label.trim().toLowerCase();
  return MEZ_SPELLS.has(lower) || /\bmez\b/.test(lower);
}

export interface MezBreak {
  attacker: string;
  /** Target as spelled by the timer/damage event. */
  target: string;
  ts: number;
}

/** Subset of the "timer" app-event payload the tracker consumes. */
export interface MezTimerEvent {
  name: string;
  kind: TimerPayload["kind"];
  lane?: TimerPayload["lane"];
  durationSecs?: number;
}

interface ActiveMez {
  /** Lowercased target — grouping key (the log re-capitalizes mob names by
   *  sentence position, same caveat as OverlayTarget's grouping). */
  targetKey: string;
  target: string;
  /** Log-ts when the timer would expire naturally (start ts + duration). */
  endTs: number;
}

export interface MezTracker {
  /** Feed every "timer" app event; `ts` is the latest log-line timestamp. */
  onTimer(ev: MezTimerEvent, ts: number): void;
  /** Feed player damage events (attacker already isPlayerName-gated).
   *  Returns the attributed break when this hit claims one, else null. */
  onDamage(attacker: string, target: string, ts: number): MezBreak | null;
}

export function createMezTracker(): MezTracker {
  /** Running mez timers, keyed by the FULL timer name ("Enthrall — a gnoll"). */
  const active = new Map<string, ActiveMez>();
  /** Targets whose current mez application already credited a break. */
  const claimed = new Set<string>();
  /** targetKey -> claim-window end ts, opened by an unclaimed early cancel. */
  const windows = new Map<string, number>();

  function anyActiveOn(targetKey: string): boolean {
    for (const a of active.values()) {
      if (a.targetKey === targetKey) return true;
    }
    return false;
  }

  return {
    onTimer(ev: MezTimerEvent, ts: number): void {
      if (ev.kind === "started") {
        if (ev.lane !== "enemy") return;
        const { label, target } = splitTimerTarget(ev.name);
        if (!target || !isMezEffect(label)) return;
        const targetKey = target.toLowerCase();
        // Fresh mez application: re-arm attribution for this target.
        active.set(ev.name, {
          targetKey,
          target,
          endTs: ts + (ev.durationSecs ?? 0),
        });
        claimed.delete(targetKey);
        windows.delete(targetKey);
        return;
      }
      if (ev.kind === "cancelled" || ev.kind === "expired") {
        // Cancelled events carry no lane — match by name against what we
        // registered (only mez-with-target timers ever get in).
        const entry = active.get(ev.name);
        if (!entry) return;
        active.delete(ev.name);
        if (
          ev.kind === "cancelled" &&
          ts < entry.endTs - MEZ_EARLY_MARGIN_SECS &&
          !claimed.has(entry.targetKey)
        ) {
          // Bar dropped early with no hit seen yet: let the next player hit
          // (whose log-line event may still be in flight) claim the break.
          windows.set(entry.targetKey, ts + MEZ_BREAK_WINDOW_SECS);
        } else if (!anyActiveOn(entry.targetKey)) {
          // Natural end (or already-claimed break): nothing left to credit.
          claimed.delete(entry.targetKey);
        }
      }
      // "warning" / "landed" don't move attribution state.
    },

    onDamage(attacker: string, target: string, ts: number): MezBreak | null {
      const targetKey = target.toLowerCase();
      const windowEnd = windows.get(targetKey);
      if (windowEnd !== undefined) {
        windows.delete(targetKey); // one shot, claimed or stale
        if (ts <= windowEnd) {
          claimed.add(targetKey);
          return { attacker, target, ts };
        }
      }
      if (anyActiveOn(targetKey) && !claimed.has(targetKey)) {
        claimed.add(targetKey);
        return { attacker, target, ts };
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Spoken-alert toggle: "{attacker} broke mez on {target}" through the normal
// TTS path. OFF by default (alert-fatigue budget) — the Session tab's
// Scoreboard panel owns the checkbox. Same localStorage + custom-event
// pattern as wishlist.
// ---------------------------------------------------------------------------

export const MEZ_SPEAK_KEY = "eqlogs.mezbreak.speak";
export const MEZ_SPEAK_EVENT = "eqlogs-mezbreak-speak-changed";

const speakStore = createLocalStore<boolean>(
  MEZ_SPEAK_KEY,
  MEZ_SPEAK_EVENT,
  (raw) => raw === true,
);

export function loadMezBreakSpeak(): boolean {
  return speakStore.load();
}

export function saveMezBreakSpeak(on: boolean): void {
  speakStore.save(on);
}

export function subscribeMezBreakSpeak(cb: () => void): () => void {
  return speakStore.subscribe(cb);
}
