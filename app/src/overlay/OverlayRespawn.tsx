import { useEffect, useMemo, useState } from "react";
import { useNowMs } from "../hooks";
import { IS_MOCK } from "../mock";
import { OVERLAY_RESPAWN } from "../types";
import {
  activeTimers,
  loadTimers,
  subscribeTimers,
  type Timer,
  windowRemainingSecs,
} from "../lib/timers";
import OverlayShell from "./OverlayShell";
// Canonical countdown (h:mm:ss past an hour) — the same formatter the
// Timers tab uses, so the overlay and the tab agree on hour-long timers
// (a local copy here used to drop the seconds, making "1:05" for 1h05m
// read like 1m05s).
import { fmtCountdown } from "../lib/format";

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
        warnSecs: 0,
        warnAnnounced: false,
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
        warnSecs: 0,
        warnAnnounced: false,
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
        warnSecs: 0,
        warnAnnounced: false,
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

  useEffect(() => {
    if (IS_MOCK) return;
    return subscribeTimers(() => setTimers(loadTimers()));
  }, []);

  // Tick every second so the bars and countdowns advance smoothly.
  const nowMs = useNowMs(1000);
  const active = useMemo(() => activeTimers(timers, nowMs), [timers, nowMs]);

  return (
    <OverlayShell label={OVERLAY_RESPAWN} name="Timer overlay">
      <div className="orsp pill">
        <div className="orsp-title">
          <span>Timers</span>
          <span className="num">{active.length}</span>
        </div>
        {active.length === 0 ? (
          <div className="orsp-empty">No active timers</div>
        ) : (
          active.map((t) => {
            const up = t.remainingSecs <= 0;
            // Show the remaining spawn window for variance targets (P41).
            const windowLeft = windowRemainingSecs(t, nowMs);
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
                    {t.kind === "respawn" && t.timingContext && (
                      <span className="orsp-context">{t.timingContext}</span>
                    )}
                  </span>
                  <span className="orsp-count num">
                    {up && windowLeft !== null
                      ? `UP · ${fmtCountdown(windowLeft)}`
                      : fmtCountdown(t.remainingSecs)}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </OverlayShell>
  );
}
