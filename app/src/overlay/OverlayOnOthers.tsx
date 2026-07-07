import { useState } from "react";
import {
  underBuffThreshold,
  useBuffThresholdMins,
  useTauriEvent,
  useTimers,
} from "../hooks";
import { useOverlayEnabled } from "../hooks";
import { IS_MOCK } from "../mock";
import OverlayEditChrome from "./OverlayEditChrome";
import { OVERLAY_ONOTHERS, type OverlayLockPayload } from "../types";
import TimerBars from "../components/TimerBars";
import { sampleTimers } from "../lib/overlaySamples";

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
  const enabled = useOverlayEnabled(OVERLAY_ONOTHERS);
  // Long buffs stay hidden until under the show threshold (Settings).
  const thresholdMins = useBuffThresholdMins();
  const timers = useTimers().filter(
    (t) => t.lane === "on-others" && underBuffThreshold(t, thresholdMins),
  );

  useTauriEvent<OverlayLockPayload>("overlay-lock-changed", (p) => {
    if (p.label === OVERLAY_ONOTHERS) setUnlocked(!p.clickThrough);
  });

  return (
    <div className={`ov-shell${unlocked ? " unlocked" : ""}${unlocked && !enabled ? " ov-disabled" : ""}`}>
      {unlocked && (
        <OverlayEditChrome label={OVERLAY_ONOTHERS} name="On-others overlay" />
      )}
      {timers.length > 0 && (
        <div className="ov-timer-stack">
          <TimerBars timers={timers} overlay />
        </div>
      )}
      {/* Arrange aid (P10): sample bars while unlocked & empty. */}
      {unlocked && timers.length === 0 && (
        <div className="ov-timer-stack ov-sample">
          <TimerBars timers={sampleTimers("on-others")} overlay />
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
