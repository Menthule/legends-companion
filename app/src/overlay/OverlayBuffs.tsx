import { useState } from "react";
import { useTauriEvent, useTimers } from "../hooks";
import { IS_MOCK } from "../mock";
import { OVERLAY_BUFFS, type OverlayLockPayload } from "../types";
import TimerBars from "../components/TimerBars";

const initiallyUnlocked =
  new URLSearchParams(window.location.search).get("unlocked") === "1";

/**
 * Your own buff countdown bars (lane "buff"), sorted by remaining ascending
 * (useTimers sorts). Lane "other" timers (recast windows, respawns, user
 * timers without a lane) ride along here so no countdown is orphaned now
 * that the alerts overlay is text-only.
 */
export default function OverlayBuffs() {
  const [unlocked, setUnlocked] = useState(initiallyUnlocked);
  // Your own buffs + generic "other" timers. Enemy timers go to the target
  // overlay; buffs you cast on OTHER people go to the "on others" overlay.
  const timers = useTimers().filter(
    (t) => t.lane !== "enemy" && t.lane !== "on-others",
  );

  useTauriEvent<OverlayLockPayload>("overlay-lock-changed", (p) => {
    if (p.label === OVERLAY_BUFFS) setUnlocked(!p.clickThrough);
  });

  return (
    <div className={`ov-shell${unlocked ? " unlocked" : ""}`}>
      {unlocked && (
        <div className="ov-drag-tag" data-tauri-drag-region>
          Buffs overlay — drag to arrange, then lock
        </div>
      )}
      {timers.length > 0 && (
        <div className="ov-timer-stack">
          <TimerBars timers={timers} overlay />
        </div>
      )}
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
