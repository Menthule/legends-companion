import { useEffect, useMemo, useState } from "react";
import { fmtDuration, useNowMs } from "../hooks";
import {
  loadPaceState,
  paceSnapshot,
  PACE_STATE_EVENT,
  PACE_STATE_KEY,
  type PaceState,
} from "../lib/pace";
import { OVERLAY_PACE } from "../types";
import OverlayShell from "./OverlayShell";

function rate(value: number | null, suffix: string): string {
  return value == null ? "--" : `${value.toFixed(1)}${suffix}`;
}

export default function OverlayPace() {
  const [state, setState] = useState<PaceState>(() => loadPaceState());
  const nowMs = useNowMs(1_000);

  useEffect(() => {
    const reload = () => setState(loadPaceState());
    const onStorage = (event: StorageEvent) => {
      if (event.key === PACE_STATE_KEY) reload();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(PACE_STATE_EVENT, reload);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(PACE_STATE_EVENT, reload);
    };
  }, []);

  const sample = state.active ?? state.history[0] ?? null;
  const snapshot = useMemo(
    () => (sample ? paceSnapshot(sample, state.lootMetrics, nowMs) : null),
    [nowMs, sample, state.lootMetrics],
  );
  const motes = snapshot?.loot.find((row) => row.metricId === "motes");
  const completed = sample?.status === "completed";

  return (
    <OverlayShell label={OVERLAY_PACE} name="Pace overlay">
      <div className="opace pill">
        <div className="opace-head">
          <span>{completed ? "LAST RUN" : "PACE"}</span>
          <span className="num">
            {snapshot ? fmtDuration(Math.floor(snapshot.elapsedMs / 1000)) : "READY"}
          </span>
        </div>
        {snapshot ? (
          <div className="opace-rows">
            <div className="opace-row">
              <span>XP</span>
              <strong className="num">{rate(snapshot.xpPerHour, "%/hr")}</strong>
            </div>
            <div className="opace-row">
              <span>AA</span>
              <strong className="num">
                {snapshot.aaPercentPerHour != null
                  ? `${snapshot.aaPercentPerHour.toFixed(1)}%/hr`
                  : rate(snapshot.aaPointsPerHour, " pts/hr")}
              </strong>
            </div>
            <div className="opace-row">
              <span>MOTES</span>
              <strong className="num">
                {motes ? `${motes.total} · ${rate(motes.perHour, "/hr")}` : "--"}
              </strong>
            </div>
          </div>
        ) : (
          <div className="opace-empty">Start a sample in Session → Rates</div>
        )}
      </div>
    </OverlayShell>
  );
}
