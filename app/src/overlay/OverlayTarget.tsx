import { useTimers, type TimerView } from "../hooks";
import { OVERLAY_TARGET, splitTimerTarget } from "../types";
import TimerBars from "../components/TimerBars";
import { sampleTimers } from "../lib/overlaySamples";
import OverlayShell from "./OverlayShell";

interface TargetGroup {
  /** Target name, or null for effects whose timer name carries no target. */
  target: string | null;
  timers: TimerView[];
}

/**
 * Effects you put ON ENEMIES (lane "enemy"): DoTs, mez/root/snare, debuffs.
 * Timers named "<Effect> — <target>" group under a small target-name header
 * (the bar label drops the suffix); timers keyed by spell name only (the v1
 * generated packs) collect under the "(target)" group.
 */
export default function OverlayTarget() {
  const timers = useTimers().filter((t) => t.lane === "enemy");

  // Group by target, preserving the remaining-ascending order inside each
  // group; named-target groups first (ordered by their soonest timer), the
  // unknown-target group last. Grouping is case-insensitive: the log
  // capitalizes the same mob differently by sentence position ("A kor ghoul
  // wizard has taken…" at line start vs "…of a kor ghoul wizard"), so bound
  // timer names can disagree on case for the same mob.
  const groups: TargetGroup[] = [];
  for (const t of timers) {
    const { label, target } = splitTimerTarget(t.name);
    const view = { ...t, name: label };
    const key = target?.toLowerCase() ?? null;
    const g = groups.find(
      (x) => (x.target?.toLowerCase() ?? null) === key,
    );
    if (g) g.timers.push(view);
    else groups.push({ target, timers: [view] });
  }
  groups.sort((a, b) => {
    if ((a.target === null) !== (b.target === null)) {
      return a.target === null ? 1 : -1;
    }
    return a.timers[0].left - b.timers[0].left;
  });

  return (
    <OverlayShell label={OVERLAY_TARGET} name="Target overlay">
      {(unlocked) => (
        <>
          {groups.length > 0 && (
            <div className="ov-timer-stack">
              {groups.map((g) => (
                <div className="ov-target-group" key={g.target ?? "\0none"}>
                  <div className="ov-target-name">{g.target ?? "(target)"}</div>
                  <TimerBars timers={g.timers} overlay />
                </div>
              ))}
            </div>
          )}
          {/* Arrange aid (P10): sample bars while unlocked & empty. */}
          {unlocked && groups.length === 0 && (
            <div className="ov-timer-stack ov-sample">
              <div className="ov-target-group">
                <div className="ov-target-name">a kobold shaman</div>
                <TimerBars
                  timers={sampleTimers("enemy").map((t) => ({
                    ...t,
                    name: t.name.split(" — ")[0],
                  }))}
                  overlay
                />
              </div>
            </div>
          )}
        </>
      )}
    </OverlayShell>
  );
}
