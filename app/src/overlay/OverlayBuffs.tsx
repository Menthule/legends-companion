import {
  underBuffThreshold,
  useBuffThresholdMins,
  useTimers,
} from "../hooks";
import { OVERLAY_BUFFS } from "../types";
import TimerBars from "../components/TimerBars";
import { sampleTimers } from "../lib/overlaySamples";
import OverlayShell from "./OverlayShell";

/**
 * Your own buff countdown bars (lane "buff"), sorted by remaining ascending
 * (useTimers sorts). Lane "other" timers (recast windows, respawns, user
 * timers without a lane) ride along here so no countdown is orphaned now
 * that the alerts overlay is text-only.
 */
export default function OverlayBuffs() {
  // Your own buffs + generic "other" timers. Enemy timers go to the target
  // overlay; buffs you cast on OTHER people go to the "on others" overlay.
  // Long buffs stay hidden until under the show threshold (Settings).
  const thresholdMins = useBuffThresholdMins();
  const timers = useTimers().filter(
    (t) =>
      t.lane !== "enemy" &&
      t.lane !== "on-others" &&
      underBuffThreshold(t, thresholdMins),
  );

  return (
    <OverlayShell label={OVERLAY_BUFFS} name="Buffs overlay">
      {(unlocked) => (
        <>
          {timers.length > 0 && (
            <div className="ov-timer-stack">
              <TimerBars timers={timers} overlay />
            </div>
          )}
          {/* Arrange aid (P10): show sample bars while unlocked & empty so the
              box isn't blank to size/position against. */}
          {unlocked && timers.length === 0 && (
            <div className="ov-timer-stack ov-sample">
              <TimerBars timers={sampleTimers("buff")} overlay />
            </div>
          )}
        </>
      )}
    </OverlayShell>
  );
}
