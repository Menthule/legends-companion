import { useEffect, useMemo, useState } from "react";
import { useNowMs, useTauriEvent } from "../hooks";
import { useOverlayEnabled } from "../hooks";
import { IS_MOCK } from "../mock";
import OverlayEditChrome from "./OverlayEditChrome";
import { OVERLAY_RESPAWN, type OverlayLockPayload } from "../types";
import {
  activeTimers,
  loadTimers,
  TIMERS_KEY,
  type Timer,
} from "../lib/timers";
import {
  loadOverlayArrange,
  OVERLAY_ARRANGE_KEY,
} from "../overlayState";

const initiallyUnlocked =
  new URLSearchParams(window.location.search).get("unlocked") === "1" ||
  loadOverlayArrange();

/** ss / m:ss / h:mm — compact countdown. */
function fmtCountdown(secs: number): string {
  if (secs <= 0) return "UP";
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return `${m}:${String(s).padStart(2, "0")}`;
  const h = Math.floor(m / 60);
  return `${h}:${String(m % 60).padStart(2, "0")}`;
}

const MOCK_TIMERS: Timer[] = IS_MOCK
  ? [
      {
        id: "m1",
        kind: "respawn",
        label: "a ghoul sentinel",
        zoneShort: "gukbottom",
        zoneLong: "Ruins of Old Guk",
        startedAt: Date.now() - 200_000,
        durationSecs: 1680,
        varianceSecs: 0,
        repeat: false,
        ttsOnPop: false,
        announced: false,
        source: "auto",
      },
      {
        id: "m2",
        kind: "custom",
        label: "Gate reuse",
        zoneShort: null,
        zoneLong: null,
        startedAt: Date.now() - 30_000,
        durationSecs: 200,
        varianceSecs: 0,
        repeat: true,
        ttsOnPop: true,
        announced: false,
        source: "manual",
      },
      {
        id: "m3",
        kind: "custom",
        label: "Get off — bedtime",
        zoneShort: null,
        zoneLong: null,
        startedAt: Date.now() - 6_000,
        durationSecs: 12,
        varianceSecs: 0,
        repeat: false,
        ttsOnPop: true,
        announced: false,
        source: "manual",
      },
    ]
  : [];

/** Unified timer panel: every active timer (respawn + custom) with a live
 *  draining bar, soonest-to-due on top and color-coded by urgency. Data comes
 *  from localStorage (written by the Timers tab); the `storage` event syncs
 *  new kills/timers across windows and the 1 s tick advances the bars.
 *  Persistent — distinct from the alerts-overlay "X up" flash that fires only
 *  at the pop moment. */
export default function OverlayRespawn() {
  const [timers, setTimers] = useState<Timer[]>(() =>
    IS_MOCK ? MOCK_TIMERS : loadTimers(),
  );
  const [unlocked, setUnlocked] = useState(initiallyUnlocked);
  const enabled = useOverlayEnabled(OVERLAY_RESPAWN);

  useTauriEvent<OverlayLockPayload>("overlay-lock-changed", (p) => {
    if (p.label === OVERLAY_RESPAWN) setUnlocked(!p.clickThrough);
  });

  useEffect(() => {
    if (IS_MOCK) return;
    const onStorage = (e: StorageEvent) => {
      if (e.key === TIMERS_KEY) setTimers(loadTimers());
      if (e.key === OVERLAY_ARRANGE_KEY) setUnlocked(loadOverlayArrange());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Tick every second so the bars and countdowns advance smoothly.
  const nowMs = useNowMs(1000);
  const active = useMemo(() => activeTimers(timers, nowMs), [timers, nowMs]);

  return (
    <div
      className={`ov-shell${unlocked ? " unlocked" : ""}${unlocked && !enabled ? " ov-disabled" : ""}`}
    >
      {unlocked && (
        <OverlayEditChrome label={OVERLAY_RESPAWN} name="Timer overlay" />
      )}
      <div className="orsp pill" data-tauri-drag-region>
        <div className="orsp-title">
          <span>Timers</span>
          <span className="num">{active.length}</span>
        </div>
        {active.length === 0 ? (
          <div className="orsp-empty">No active timers</div>
        ) : (
          active.map((t) => {
            const up = t.remainingSecs <= 0;
            return (
              <div
                className={`orsp-row s-${t.state} k-${t.kind}${up ? " up" : ""}`}
                key={t.id}
              >
                <div
                  className="orsp-fill"
                  style={{ width: `${t.progress * 100}%` }}
                />
                <div className="orsp-text">
                  <span className="orsp-name">
                    <span className={`orsp-kind k-${t.kind}`} aria-hidden="true" />
                    {t.label}
                  </span>
                  <span className="orsp-count num">
                    {fmtCountdown(t.remainingSecs)}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
      {IS_MOCK && (
        <button
          className="ov-mock-toggle"
          onClick={() => setUnlocked((u) => !u)}
        >
          {unlocked ? "lock" : "unlock"}
        </button>
      )}
    </div>
  );
}
