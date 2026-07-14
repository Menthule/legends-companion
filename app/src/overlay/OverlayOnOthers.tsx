import {
  underBuffThreshold,
  useBuffThresholdMins,
  useTimers,
} from "../hooks";
import { OVERLAY_ONOTHERS } from "../types";
import TimerBars from "../components/TimerBars";
import { sampleTimers } from "../lib/overlaySamples";
import OverlayShell from "./OverlayShell";

/**
 * "On others" overlay: buff countdown bars for buffs YOU cast on OTHER people
 * (lane "on-others"), each bound to its recipient and labeled "<Buff> —
 * <Target>". Kept separate from your own buffs (the buffs overlay) so a group
 * rebuff doesn't bury your self-buffs. Bars are sorted by remaining ascending
 * (useTimers) and reaped on targeted wear-off or recipient death by the engine.
 */
export default function OverlayOnOthers() {
  // Long buffs stay hidden until under the show threshold (Settings).
  const thresholdMins = useBuffThresholdMins();
  const timers = useTimers().filter(
    (t) => t.lane === "on-others" && underBuffThreshold(t, thresholdMins),
  );

  return (
    <OverlayShell label={OVERLAY_ONOTHERS} name="On-others overlay">
      {(unlocked) => (
        <>
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
        </>
      )}
    </OverlayShell>
  );
}
