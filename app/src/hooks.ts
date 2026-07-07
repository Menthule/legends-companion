import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { IS_MOCK, mockListen } from "./mock";
import type { TimerLane, TimerPayload } from "./types";
import {
  BUFF_THRESHOLD_EVENT,
  BUFF_THRESHOLD_KEY,
  isOverlayEnabled,
  loadBuffThresholdMins,
  OVERLAY_VIS_EVENT,
  OVERLAY_VIS_KEY,
} from "./overlayState";

/**
 * Subscribe to an app event for the lifetime of the component. In Tauri this
 * is a real Tauri event; in mock mode it is the in-page mock bus. The handler
 * ref is kept fresh so callers can pass inline closures without re-subscribing.
 */
export function useTauriEvent<T>(name: string, handler: (payload: T) => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (IS_MOCK) {
      return mockListen<T>(name, (p) => handlerRef.current(p));
    }
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    listen<T>(name, (e) => handlerRef.current(e.payload))
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((err) => console.error(`listen(${name}) failed`, err));
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [name]);
}

/** Format seconds as m:ss. */
export function fmtDuration(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const sec = String(s % 60).padStart(2, "0");
  const h = Math.floor(s / 3600);
  // Roll minutes into hours once we cross 60 min, so long spans (per-level
  // ETA, multi-hour respawns, session length) read as H:MM:SS instead of a
  // runaway minute count like "988:09". Sub-hour output is unchanged (M:SS).
  if (h > 0) {
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    return `${h}:${m}:${sec}`;
  }
  return `${Math.floor(s / 60)}:${sec}`;
}

/** Timer countdown label: `m:ss` above a minute, `Ns` below. */
export function fmtTimerLeft(left: number): string {
  if (left >= 60) return fmtDuration(left);
  return `${Math.max(0, Math.ceil(left))}s`;
}

/** Format a unix timestamp as local HH:MM:SS. */
export function fmtClock(ts: number): string {
  const d = new Date(ts * 1000);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

/** Compact number: 12345 -> 12.3k */
export function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

// ---------------------------------------------------------------------------
// Series color slots — assigned to a combatant on first appearance and never
// repainted when the roster re-sorts (DESIGN.md).
// ---------------------------------------------------------------------------

export function useSeriesSlots(names: string[]): (name: string) => number {
  const ref = useRef<Map<string, number>>(new Map());
  for (const n of names) {
    if (!ref.current.has(n)) ref.current.set(n, ref.current.size % 8);
  }
  return (name: string) => ref.current.get(name) ?? 0;
}

// ---------------------------------------------------------------------------
// Countdown timers shared by the dashboard card and the alerts overlay.
// ---------------------------------------------------------------------------

interface InternalTimer {
  name: string;
  durationSecs: number;
  warnAtSecs: number | null;
  endsAt: number; // Date.now() ms
  forcedWarn: boolean;
  lane: TimerLane;
  /** While set (Date.now() ms), the bar is in the "casting…" pending state.
   *  Cleared by the backend "landed" event; the timestamp is a fallback so
   *  a missed event can never leave a bar stuck pending. */
  pendingUntil: number | null;
}

export interface TimerView {
  name: string;
  durationSecs: number;
  /** Seconds remaining (>= 0). */
  left: number;
  /** 0..1 fraction remaining. */
  frac: number;
  warn: boolean;
  expired: boolean;
  /** Cast in progress (item 12): render dimmed/pulsing, no numerals. */
  pending: boolean;
  /** Overlay lane routing (buffs overlay vs target overlay). */
  lane: TimerLane;
}

const EXPIRE_LINGER_MS = 1200; // pulse + fade before the row is removed

export function useTimers(): TimerView[] {
  const [items, setItems] = useState<InternalTimer[]>([]);
  const [, setTick] = useState(0);

  useTauriEvent<TimerPayload>("timer", (p) => {
    if (p.kind === "started") {
      const duration = p.durationSecs ?? 0;
      const endsAt = Date.now() + (duration - (p.elapsedSecs ?? 0)) * 1000;
      const pending = p.pendingSecs ?? 0;
      setItems((prev) => [
        ...prev.filter((x) => x.name !== p.name),
        {
          name: p.name,
          durationSecs: duration,
          warnAtSecs: p.warnAtSecs ?? null,
          endsAt,
          forcedWarn: false,
          lane: p.lane ?? "other",
          pendingUntil: pending > 0 ? Date.now() + pending * 1000 : null,
        },
      ]);
    } else if (p.kind === "landed") {
      // Cast completed: flip the pending bar to a normal countdown.
      setItems((prev) =>
        prev.map((x) => (x.name === p.name ? { ...x, pendingUntil: null } : x)),
      );
    } else if (p.kind === "warning") {
      setItems((prev) =>
        prev.map((x) => (x.name === p.name ? { ...x, forcedWarn: true } : x)),
      );
    } else if (p.kind === "cancelled") {
      // Cancelled early (wear-off / mob death): drop the bar right away —
      // no expiry pulse, the effect simply ended ahead of the countdown.
      setItems((prev) => prev.filter((x) => x.name !== p.name));
    } else {
      // expired from the backend: snap to zero, let the pulse/fade play out
      setItems((prev) =>
        prev.map((x) =>
          x.name === p.name ? { ...x, endsAt: Math.min(x.endsAt, Date.now()) } : x,
        ),
      );
    }
  });

  const active = items.length > 0;
  useEffect(() => {
    if (!active) return;
    const h = window.setInterval(() => {
      const now = Date.now();
      setItems((prev) =>
        prev.some((x) => now > x.endsAt + EXPIRE_LINGER_MS)
          ? prev.filter((x) => now <= x.endsAt + EXPIRE_LINGER_MS)
          : prev,
      );
      setTick((t) => t + 1);
    }, 250);
    return () => window.clearInterval(h);
  }, [active]);

  const now = Date.now();
  return items
    .map((x) => {
      const left = Math.max(0, (x.endsAt - now) / 1000);
      const expired = left <= 0;
      // The landed event drives the flip; the timestamp comparison is the
      // fallback so a dropped event can't strand a bar in "casting…".
      const pending = !expired && x.pendingUntil != null && now < x.pendingUntil;
      return {
        name: x.name,
        durationSecs: x.durationSecs,
        left,
        frac: x.durationSecs > 0 ? left / x.durationSecs : 0,
        warn:
          !expired &&
          !pending &&
          (x.forcedWarn || (x.warnAtSecs != null && left <= x.warnAtSecs)),
        expired,
        pending,
        lane: x.lane,
      };
    })
    .sort((a, b) => a.left - b.left);
}

/**
 * Wall-clock ms, re-rendering every `intervalMs` — for live rates (XP/hour)
 * that must keep moving between events.
 */
export function useNowMs(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const h = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(h);
  }, [intervalMs]);
  return now;
}

/**
 * The buff-bar show threshold (minutes, 0 = always show), kept live across
 * windows: the Settings control writes localStorage, overlay windows hear
 * the cross-window "storage" event, and the Settings window itself hears
 * the custom same-window event.
 */
export function useBuffThresholdMins(): number {
  const [mins, setMins] = useState(() => loadBuffThresholdMins());
  useEffect(() => {
    const refresh = () => setMins(loadBuffThresholdMins());
    const onStorage = (e: StorageEvent) => {
      if (e.key === BUFF_THRESHOLD_KEY) refresh();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(BUFF_THRESHOLD_EVENT, refresh);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(BUFF_THRESHOLD_EVENT, refresh);
    };
  }, []);
  return mins;
}

/**
 * Buff-bar show-threshold filter: bars in the buff and on-others lanes stay
 * hidden until under `mins` minutes remaining (a 1-hour buff shouldn't hold
 * a bar for its whole run). Pending ("casting…") bars always show — the
 * brief flash confirms the timer registered before it goes dormant. Enemy
 * and "other" lane timers (DoTs, CC, recasts) are never filtered, and
 * `mins <= 0` disables the filter entirely.
 */
export function underBuffThreshold(t: TimerView, mins: number): boolean {
  if (mins <= 0) return true;
  if (t.lane !== "buff" && t.lane !== "on-others") return true;
  return t.pending || t.left <= mins * 60;
}

/**
 * Live enabled/disabled state of one overlay, kept in sync with the shared
 * visibility store across windows ("storage") and within a window
 * (OVERLAY_VIS_EVENT). Overlays use this to dim themselves when disabled in
 * arrange mode; the toggle lives in the overlay edit chrome.
 */
export function useOverlayEnabled(label: string): boolean {
  const [enabled, setEnabled] = useState(() => isOverlayEnabled(label));
  useEffect(() => {
    const update = () => setEnabled(isOverlayEnabled(label));
    const onStorage = (e: StorageEvent) => {
      if (e.key === OVERLAY_VIS_KEY) update();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(OVERLAY_VIS_EVENT, update);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(OVERLAY_VIS_EVENT, update);
    };
  }, [label]);
  return enabled;
}
