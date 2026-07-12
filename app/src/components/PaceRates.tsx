import { useMemo, useState } from "react";
import { fmtDuration, useNowMs } from "../hooks";
import {
  completePaceSample,
  paceSnapshot,
  pausePaceSample,
  resetPaceSample,
  resumePaceSample,
  startPaceSample,
  type PaceState,
} from "../lib/pace";

function optionalPercent(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
}

function paceRate(value: number | null, suffix: string): string {
  return value == null ? "Measuring" : `${value.toFixed(1)}${suffix}`;
}

export default function PaceRates({
  pace,
  onChange,
  compact = false,
}: {
  pace: PaceState;
  onChange: (next: PaceState) => void;
  compact?: boolean;
}) {
  const nowMs = useNowMs(1_000);
  const [startAa, setStartAa] = useState("");
  const [endAa, setEndAa] = useState("");
  const [finishing, setFinishing] = useState(false);
  const active = pace.active;
  const snapshot = useMemo(
    () => (active ? paceSnapshot(active, pace.lootMetrics, nowMs) : null),
    [active, nowMs, pace.lootMetrics],
  );

  const start = () => {
    const value = optionalPercent(startAa);
    if (startAa.trim() && value == null) return;
    onChange(startPaceSample(pace, { nowMs: Date.now(), aaStartPercent: value }));
    setFinishing(false);
    setEndAa("");
  };
  const finish = () => {
    const value = optionalPercent(endAa);
    if (endAa.trim() && value == null) return;
    onChange(completePaceSample(pace, { nowMs: Date.now(), aaEndPercent: value }));
    setStartAa("");
    setEndAa("");
    setFinishing(false);
  };

  return (
    <div className={`pace-rates${compact ? " compact" : ""}`}>
      {!active ? (
        <div className="pace-start">
          <div>
            <div className="pace-heading">{compact ? "Start measurement" : "Start a grind sample"}</div>
            <div className="hint">
              {compact
                ? "Enter AA percentage only when you want partial-progress rates."
                : "XP, AA points, and your Mote loot are counted automatically."}
            </div>
          </div>
          <label className="pace-aa-field">
            <span>Starting AA % <em>optional</em></span>
            <input
              type="number"
              min="0"
              max="100"
              step="0.1"
              inputMode="decimal"
              value={startAa}
              onChange={(e) => setStartAa(e.target.value)}
              placeholder="0.0"
              aria-label="Starting AA percentage"
            />
          </label>
          <button className="primary pace-start-btn" onClick={start}>
            {compact ? "Start" : "Start sample"}
          </button>
        </div>
      ) : (
        <>
          <div className="pace-live-head">
            <div>
              <span className="pace-clock num">
                {fmtDuration(Math.floor((snapshot?.elapsedMs ?? 0) / 1000))}
              </span>
              <span className="hint"> active time</span>
            </div>
            <span className={`pace-status ${active.status}`}>{active.status}</span>
            <div className="pace-controls">
              {active.status === "paused" ? (
                <button
                  className="ghost small"
                  onClick={() => onChange(resumePaceSample(pace, Date.now()))}
                >
                  Resume
                </button>
              ) : (
                <button
                  className="ghost small"
                  onClick={() => onChange(pausePaceSample(pace, Date.now()))}
                >
                  Pause
                </button>
              )}
              <button className="primary small" onClick={() => setFinishing(true)}>
                Stop
              </button>
              <button
                className="ghost small"
                onClick={() => onChange(resetPaceSample(pace))}
                title="Discard this sample"
              >
                Discard
              </button>
            </div>
          </div>
          {!compact && <div className="pace-metrics">
            <div className="pace-metric">
              <span>XP</span>
              <strong className="num">{paceRate(snapshot?.xpPerHour ?? null, "%/hr")}</strong>
              <small className="num">{(snapshot?.xpPercent ?? 0).toFixed(2)}% gained</small>
            </div>
            <div className="pace-metric">
              <span>AA</span>
              <strong className="num">
                {paceRate(snapshot?.aaPointsPerHour ?? null, " pts/hr")}
              </strong>
              <small className="num">{snapshot?.aaPointsEarned ?? 0} points earned</small>
            </div>
            {(snapshot?.loot ?? []).map((lootRate) => (
              <div className="pace-metric" key={lootRate.metricId}>
                <span>{lootRate.label}</span>
                <strong className="num">{paceRate(lootRate.perHour, "/hr")}</strong>
                <small className="num">{lootRate.total} looted</small>
              </div>
            ))}
          </div>}
          {finishing && (
            <div className="pace-finish">
              <div>
                <strong>Finish sample</strong>
                <div className="hint">
                  Add your ending AA percentage for an exact AA %/hour result.
                </div>
              </div>
              <label className="pace-aa-field">
                <span>Ending AA % <em>optional</em></span>
                <input
                  autoFocus
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  inputMode="decimal"
                  value={endAa}
                  onChange={(e) => setEndAa(e.target.value)}
                  placeholder="0.0"
                  aria-label="Ending AA percentage"
                />
              </label>
              <button className="primary" onClick={finish}>Save result</button>
              <button className="ghost" onClick={() => setFinishing(false)}>Cancel</button>
            </div>
          )}
        </>
      )}
      {!compact && pace.history.length > 0 && (
        <div className="pace-history">
          <div className="pace-history-head">
            <span>Date</span>
            <span>Duration</span>
            <span>XP/hr</span>
            <span>AA/hr</span>
            <span>Motes/hr</span>
          </div>
          {pace.history.slice(0, 5).map((sample) => {
            const result = paceSnapshot(sample, pace.lootMetrics, sample.endedAtMs ?? nowMs);
            const motes = result.loot.find((row) => row.metricId === "motes");
            return (
              <div className="pace-history-row" key={sample.id}>
                <span>{new Date(sample.startedAtMs).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                <span className="num">{fmtDuration(Math.floor(result.elapsedMs / 1000))}</span>
                <span className="num">{paceRate(result.xpPerHour, "%")}</span>
                <span className="num">
                  {result.aaPercentPerHour != null
                    ? `${result.aaPercentPerHour.toFixed(1)}%`
                    : paceRate(result.aaPointsPerHour, " pts")}
                </span>
                <span className="num">{paceRate(motes?.perHour ?? null, "")}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
