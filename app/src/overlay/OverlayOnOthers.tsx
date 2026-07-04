import { useState } from "react";
import { useTauriEvent, useTimers } from "../hooks";
import { IS_MOCK } from "../mock";
import { OVERLAY_ONOTHERS, type OverlayLockPayload } from "../types";
import TimerBars from "../components/TimerBars";

const initiallyUnlocked =
  new URLSearchParams(window.location.search).get("unlocked") === "1";

/**
 * "On others" overlay: buff countdown bars for buffs YOU cast on OTHER people
 * (lane "on-others"), each bound to its recipient and labeled "<Buff> —
 * <Target>". Kept separate from your own buffs (the buffs overlay) so a group
 * rebuff doesn't bury your self-buffs. Bars are sorted by remaining ascending
 * (useTimers) and reaped on targeted wear-off or recipient death by the engine.
 */
export default function OverlayOnOthers() {
  const [unlocked, setUnlocked] = useState(initiallyUnlocked);
  const timers = useTimers().filter((t) => t.lane === "on-others");

  useTauriEvent<OverlayLockPayload>("overlay-lock-changed", (p) => {
    if (p.label === OVERLAY_ONOTHERS) setUnlocked(!p.clickThrough);
  });

  return (
    <div className={`ov-shell${unlocked ? " unlocked" : ""}`}>
      {unlocked && (
        <div className="ov-drag-tag" data-tauri-drag-region>
          On-others overlay — drag to arrange, then lock
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
