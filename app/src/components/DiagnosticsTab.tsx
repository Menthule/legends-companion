import { useEffect, useMemo, useState } from "react";
import {
  discoverLogs,
  getConfig,
  getProfile,
  getTriggerTree,
  setProfile,
  timerTrainingScan,
} from "../api";
import { fmtClock, useTauriEvent } from "../hooks";
import { activeLoadout, withTimingOverride } from "../resolution";
import {
  eventKind,
  type AppConfig,
  type DiscoveredLog,
  type LogLinePayload,
  type EffectObservedPayload,
  type TailStatsPayload,
  type RankTrainingResult,
  type TimerTrainingReport,
  type TriggerTreeEntry,
} from "../types";
import Empty from "./Empty";
import QuickTriggerModal from "./QuickTriggerModal";
import { useToast } from "./Toast";

interface DebugLine {
  id: number;
  ts: number;
  message: string;
  kind: string;
}

interface EffectDebug {
  id: number;
  kind: string;
  spell: string;
  target: string;
  amount: number | null;
}

let seq = 1;

export default function DiagnosticsTab() {
  const [stats, setStats] = useState<TailStatsPayload | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [logs, setLogs] = useState<DiscoveredLog[]>([]);
  const [lines, setLines] = useState<DebugLine[]>([]);
  const [effects, setEffects] = useState<EffectDebug[]>([]);
  const [quickLine, setQuickLine] = useState<string | null>(null);
  const [rankedTimers, setRankedTimers] = useState<TriggerTreeEntry[]>([]);
  const [trainingTriggerId, setTrainingTriggerId] = useState("");
  const [trainingReport, setTrainingReport] = useState<TimerTrainingReport | null>(null);
  const [trainingBusy, setTrainingBusy] = useState(false);
  const [trainingError, setTrainingError] = useState<string | null>(null);
  const [appliedRanks, setAppliedRanks] = useState<Set<string>>(new Set());
  const [toastNode, showToast] = useToast();

  useEffect(() => {
    getConfig().then(setConfig).catch(() => setConfig(null));
    discoverLogs().then(setLogs).catch(() => setLogs([]));
    getTriggerTree()
      .then((tree) => {
        const timers = tree
          .filter((entry) => entry.timer && entry.pattern.includes("rank"))
          .sort((a, b) => a.name.localeCompare(b.name));
        setRankedTimers(timers);
        setTrainingTriggerId((current) => current || timers[0]?.id || "");
      })
      .catch(() => setRankedTimers([]));
  }, []);

  useTauriEvent<TailStatsPayload>("tail-stats", setStats);
  useTauriEvent<LogLinePayload>("log-line", (p) => {
    const kind = eventKind(p.event);
    if (kind === "Unclassified") {
      setLines((prev) => [
        { id: seq++, ts: p.ts, message: p.message, kind },
        ...prev,
      ].slice(0, 80));
    }
  });
  useTauriEvent<EffectObservedPayload>("effect-observed", (p) => {
    setEffects((prev) => [
      {
        id: seq++,
        kind: p.kind,
        spell: p.spell,
        target: p.target,
        amount: p.amount ?? null,
      },
      ...prev,
    ].slice(0, 40));
  });

  const newest = useMemo(
    () =>
      logs
        .filter((l) => l.modifiedTs != null)
        .sort((a, b) => (b.modifiedTs ?? 0) - (a.modifiedTs ?? 0))[0] ?? null,
    [logs],
  );
  const active = logs.find((l) => l.path === config?.logPath) ?? null;

  async function copyText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      showToast(`${label} copied`);
    } catch {
      showToast(`Could not copy ${label.toLowerCase()}`);
    }
  }

  function diagnosticsBundle(): string {
    return [
      "Legends Companion diagnostics",
      `Character: ${config?.characterName || "Unknown"}`,
      `Configured log: ${config?.logPath || "Unknown"}`,
      `Active discovered log: ${active ? `${active.character} / ${active.server}` : "Unknown"}`,
      `Newest discovered log: ${newest ? `${newest.character} / ${newest.server}` : "Unknown"}`,
      `Unrecognized rate: ${stats ? `${stats.unclassifiedPct.toFixed(1)}%` : "Unknown"}`,
      "",
      "Recent unrecognized lines:",
      ...lines.slice(0, 25).map((line) => `[${fmtClock(line.ts)}] ${line.message}`),
    ].join("\n");
  }

  async function runTimerTraining() {
    if (!trainingTriggerId) return;
    setTrainingBusy(true);
    setTrainingError(null);
    setTrainingReport(null);
    setAppliedRanks(new Set());
    try {
      setTrainingReport(await timerTrainingScan(trainingTriggerId));
    } catch (error) {
      setTrainingError(String(error));
    } finally {
      setTrainingBusy(false);
    }
  }

  async function applyTimerTraining(result: RankTrainingResult) {
    if (!trainingReport || !result.canApply) return;
    try {
      const profile = await getProfile();
      const loadout = activeLoadout(profile);
      const rank = result.rank.trim().toUpperCase();
      const existing = loadout.timing_overrides?.[trainingReport.triggerId]?.[rank] ?? {};
      const timing = {
        ...existing,
        ...(result.suggestedDurationSecs != null
          ? { duration_secs: result.suggestedDurationSecs }
          : {}),
        ...(result.suggestedCastTimeSecs != null
          ? { cast_time_secs: result.suggestedCastTimeSecs }
          : {}),
      };
      await setProfile(
        withTimingOverride(profile, trainingReport.triggerId, rank, timing),
      );
      setAppliedRanks((current) => new Set(current).add(rank));
      showToast(`Applied ${trainingReport.timerName} ${rank} timing to ${loadout.name}.`);
    } catch (error) {
      setTrainingError(`Could not apply timing: ${String(error)}`);
    }
  }

  function formatDuration(seconds: number | null): string {
    if (seconds == null) return "—";
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function formatRange(min: number | null, max: number | null): string {
    if (min == null || max == null) return "—";
    return min === max ? formatDuration(min) : `${formatDuration(min)}–${formatDuration(max)}`;
  }

  return (
    <div className="diag-grid">
      <section className="card">
        <div className="card-head">
          <span className="section-title">Parser health</span>
          <button
            className="ghost small"
            onClick={() => void copyText(diagnosticsBundle(), "Diagnostics")}
          >
            Copy diagnostics
          </button>
        </div>
        <div className="coach-kv">
          <span>Recent window</span>
          <strong>rolling parser sample</strong>
          <span>Unrecognized</span>
          <strong>{stats ? `${stats.unclassifiedPct.toFixed(1)}%` : "—"}</strong>
          <span>Status</span>
          <strong>
            {!stats
              ? "Waiting"
              : stats.unclassifiedPct >= 10
                ? "Needs review"
                : stats.unclassifiedPct >= 3
                  ? "Watch"
                  : "Good"}
          </strong>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <span className="section-title">Active log</span>
        </div>
        <div className="coach-kv">
          <span>Configured</span>
          <strong>{active ? `${active.character} / ${active.server}` : config?.characterName || "Unknown"}</strong>
          <span>Newest file</span>
          <strong>{newest ? `${newest.character} / ${newest.server}` : "No logs found"}</strong>
          <span>Confidence</span>
          <strong>{newest && active && newest.path !== active.path ? "Mismatch possible" : "Aligned"}</strong>
        </div>
      </section>

      <section className="card diag-span">
        <div className="card-head timer-training-head">
          <div>
            <span className="section-title">Ranked timer training</span>
            <span className="tmr-badge timing">Read-only test run</span>
          </div>
          <button
            className="primary small"
            disabled={!trainingTriggerId || trainingBusy}
            onClick={() => void runTimerTraining()}
          >
            {trainingBusy ? "Scanning history…" : "Test run"}
          </button>
        </div>
        <div className="timer-training-toolbar">
          <label className="field">
            <span>Ranked ability</span>
            <select
              value={trainingTriggerId}
              disabled={trainingBusy || rankedTimers.length === 0}
              onChange={(event) => {
                setTrainingTriggerId(event.target.value);
                setTrainingReport(null);
                setTrainingError(null);
                setAppliedRanks(new Set());
              }}
            >
              {rankedTimers.length === 0 && <option value="">No rank-aware timers found</option>}
              {rankedTimers.map((timer) => (
                <option value={timer.id} key={timer.id}>{timer.name}</option>
              ))}
            </select>
          </label>
          {trainingReport && (
            <div className="timer-training-summary">
              <strong>{trainingReport.rankedCasts.toLocaleString()}</strong> ranked casts
              <span>·</span>
              <strong>{trainingReport.linesScanned.toLocaleString()}</strong> lines scanned
              <span>·</span>
              <strong>{trainingReport.rejectedSamples.toLocaleString()}</strong> rejected
            </div>
          )}
        </div>
        {trainingError && <div className="error-banner">{trainingError}</div>}
        {trainingReport && (
          <div className="timer-training-table">
            <div className="timer-training-row header" aria-hidden="true">
              <span>Rank</span>
              <span>Evidence</span>
              <span>Duration</span>
              <span>Cast</span>
              <span>Confidence</span>
              <span />
            </div>
            {trainingReport.ranks.length === 0 ? (
              <Empty
                title="No ranked history found"
                body={`No ${trainingReport.timerName} rank casts could be trained from this log.`}
              />
            ) : (
              trainingReport.ranks.map((result) => {
                const applied = appliedRanks.has(result.rank);
                return (
                  <div className="timer-training-row" key={result.rank}>
                    <strong>{trainingReport.timerName} {result.rank}</strong>
                    <span title={`${result.castsSeen} casts seen; ${result.rejectedSamples} rejected`}>
                      {result.cleanSamples} clean / {result.castsSeen} casts
                    </span>
                    <span>
                      <strong>{formatDuration(result.suggestedDurationSecs)}</strong>
                      <small>{formatRange(result.observedMinSecs, result.observedMaxSecs)}</small>
                    </span>
                    <span>
                      <strong>{formatDuration(result.suggestedCastTimeSecs)}</strong>
                      <small>{formatRange(result.observedCastMinSecs, result.observedCastMaxSecs)}</small>
                    </span>
                    <span className={`training-confidence ${result.confidence}`} title={result.reason}>
                      {result.confidence}
                    </span>
                    <button
                      className={applied ? "ghost small" : "primary small"}
                      disabled={!result.canApply || applied}
                      onClick={() => void applyTimerTraining(result)}
                    >
                      {applied ? "Applied" : "Apply"}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        )}
      </section>

      <section className="card diag-span">
        <div className="card-head">
          <span className="section-title">Recent unrecognized lines</span>
        </div>
        <div className="coach-table">
          {lines.length === 0 ? (
            <Empty
              title="No unrecognized lines"
              body="Log lines the parser cannot classify are captured here as they stream in."
            />
          ) : (
            lines.map((line) => (
              <div className="coach-row diag-line" key={line.id}>
                <strong className="num">{fmtClock(line.ts)}</strong>
                <span>{line.kind}</span>
                <code>{line.message}</code>
                <span className="diag-actions">
                  <button
                    className="ghost small"
                    onClick={() => setQuickLine(line.message)}
                  >
                    Trigger
                  </button>
                  <button
                    className="ghost small"
                    onClick={() => void copyText(line.message, "Line")}
                  >
                    Copy
                  </button>
                </span>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="card diag-span">
        <div className="card-head">
          <span className="section-title">Observed spell effects</span>
        </div>
        <div className="coach-table">
          {effects.length === 0 ? (
            <Empty
              title="No spell effects yet"
              body="Parsed spell damage will appear here. Trigger output is inspected in the Triggers tab."
            />
          ) : (
            effects.map((e) => (
              <div className="coach-row compact" key={e.id}>
                <strong>Spell: {e.spell}</strong>
                <span>{e.target}</span>
                <span>{e.amount == null ? "no damage amount" : e.amount}</span>
              </div>
            ))
          )}
        </div>
      </section>
      {quickLine && (
        <QuickTriggerModal
          message={quickLine}
          onClose={() => setQuickLine(null)}
          onSaved={(name) => {
            setQuickLine(null);
            showToast(`Trigger “${name}” saved`);
          }}
        />
      )}
      {toastNode}
    </div>
  );
}
