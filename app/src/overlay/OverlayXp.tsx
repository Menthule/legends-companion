import { useEffect, useMemo, useState } from "react";
import { fmtClock, fmtDuration, useNowMs, useTauriEvent } from "../hooks";
import { useOverlayEnabled } from "../hooks";
import { IS_MOCK } from "../mock";
import OverlayEditChrome from "./OverlayEditChrome";
import {
  OVERLAY_XP,
  type OverlayLockPayload,
} from "../types";
import {
  computeLevelEta,
  computeXpStats,
  loadLevelProgress,
  loadOverlayArrange,
  loadXpSession,
  OVERLAY_ARRANGE_KEY,
  type XpSession,
  XP_LEVEL_PROGRESS_KEY,
  XP_SESSION_KEY,
} from "../overlayState";

const initiallyUnlocked =
  new URLSearchParams(window.location.search).get("unlocked") === "1" ||
  loadOverlayArrange();
export default function OverlayXp() {
  const [session, setSession] = useState<XpSession>(() => loadXpSession());
  const [levelProgress, setLevelProgress] = useState<number>(() =>
    loadLevelProgress(),
  );
  const [unlocked, setUnlocked] = useState(initiallyUnlocked);
  const enabled = useOverlayEnabled(OVERLAY_XP);

  useTauriEvent<OverlayLockPayload>("overlay-lock-changed", (p) => {
    if (p.label === OVERLAY_XP) setUnlocked(!p.clickThrough);
  });

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === XP_SESSION_KEY) setSession(loadXpSession());
      if (e.key === XP_LEVEL_PROGRESS_KEY) setLevelProgress(loadLevelProgress());
      if (e.key === OVERLAY_ARRANGE_KEY) setUnlocked(loadOverlayArrange());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Live XP rate: the window extends to "now" (ticking every 15 s), so the
  // rate decays between kills instead of freezing at the last gain.
  const nowMs = useNowMs();
  const stats = useMemo(
    () => ({ ...computeXpStats(session, nowMs), last: session.rows[0] ?? null }),
    [session, nowMs],
  );
  const recentSession = useMemo(
    () => ({ total: stats.total, count: stats.count, rows: [] }),
    [stats.total, stats.count],
  );
  const eta = useMemo(
    () => computeLevelEta(recentSession, levelProgress, stats.perHour),
    [recentSession, levelProgress, stats.perHour],
  );


  return (
    <div className={`ov-shell${unlocked ? " unlocked" : ""}${unlocked && !enabled ? " ov-disabled" : ""}`}>
      {unlocked && (
        <OverlayEditChrome label={OVERLAY_XP} name="XP overlay" />
      )}
      <div className="oxp pill" data-tauri-drag-region>
        <div className="oxp-title">
          <span>XP 10m</span>
          <span className="num">{stats.total.toFixed(2)}%</span>
        </div>
        <div className="oxp-grid">
          <div>
            <span className="oxp-val num">
              {stats.perHour === null ? "--" : `${stats.perHour.toFixed(2)}%`}
            </span>
            <span className="oxp-label">per hour</span>
          </div>
          <div>
            <span className="oxp-val num">
              {stats.perLevelHours === null
                ? "--"
                : fmtDuration(Math.round(stats.perLevelHours * 3600))}
            </span>
            <span className="oxp-label">per level</span>
          </div>
        </div>
        {eta.kills !== null && (
          <div className="oxp-tolevel">
            <span className="oxp-label">to level</span>
            <span className="num">
              ~{eta.kills} kill{eta.kills === 1 ? "" : "s"}
              {eta.mins !== null && ` · ~${fmtDuration(Math.round(eta.mins * 60))}`}
            </span>
          </div>
        )}
        {stats.last ? (
          <div className="oxp-last">
            <span className="num">+{stats.last.percent.toFixed(2)}%</span>
            <span>{stats.last.party ? "party" : "solo"}</span>
            <span className="num">{fmtClock(stats.last.ts)}</span>
          </div>
        ) : (
          <div className="oxp-empty">Waiting for XP</div>
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
