import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { fmtClock, fmtDuration, useNowMs, useTauriEvent } from "../hooks";
import { IS_MOCK } from "../mock";
import {
  OVERLAY_XP,
  type OverlayLockPayload,
} from "../types";
import {
  computeXpStats,
  loadOverlayArrange,
  loadXpSession,
  OVERLAY_ARRANGE_KEY,
  type SharedXpRow,
  XP_SESSION_KEY,
} from "../overlayState";

const initiallyUnlocked =
  new URLSearchParams(window.location.search).get("unlocked") === "1" ||
  loadOverlayArrange();
export default function OverlayXp() {
  const [rows, setRows] = useState<SharedXpRow[]>(() => loadXpSession());
  const [unlocked, setUnlocked] = useState(initiallyUnlocked);

  useTauriEvent<OverlayLockPayload>("overlay-lock-changed", (p) => {
    if (p.label === OVERLAY_XP) setUnlocked(!p.clickThrough);
  });

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === XP_SESSION_KEY) setRows(loadXpSession());
      if (e.key === OVERLAY_ARRANGE_KEY) setUnlocked(loadOverlayArrange());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Live XP rate: the window extends to "now" (ticking every 15 s), so the
  // rate decays between kills instead of freezing at the last gain.
  const nowMs = useNowMs();
  const stats = useMemo(
    () => ({ ...computeXpStats(rows, nowMs), last: rows[0] ?? null }),
    [rows, nowMs],
  );

  function startResize() {
    getCurrentWindow().startResizeDragging("SouthEast").catch(() => {});
  }

  return (
    <div className={`ov-shell${unlocked ? " unlocked" : ""}`}>
      {unlocked && (
        <>
          <div className="ov-drag-tag ov-xp-drag" data-tauri-drag-region>
            XP overlay - drag here
          </div>
          <button
            type="button"
            className="ov-resize-grip"
            onMouseDown={startResize}
            title="Resize XP overlay"
            aria-label="Resize XP overlay"
          />
        </>
      )}
      <div className="oxp pill" data-tauri-drag-region>
        <div className="oxp-title">
          <span>Session XP</span>
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
              {stats.ttlHours === null
                ? "--"
                : fmtDuration(Math.round(stats.ttlHours * 3600))}
            </span>
            <span className="oxp-label">to level</span>
          </div>
        </div>
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
