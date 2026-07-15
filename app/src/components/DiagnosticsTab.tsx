import { useEffect, useMemo, useState } from "react";
import {
  discoverLogs,
  getConfig,
  getProfile,
  getTriggerTree,
  setProfile,
  timerTrainingCandidates,
  timerTrainingScan,
} from "../api";
import { fmtClock, useTauriEvent } from "../hooks";
import { activeLoadout, withTimingOverride } from "../resolution";
import {
  effectiveTrainingTiming,
  parseTrainingDuration,
  romanRankValue,
  timerTrainingStatus,
  trainingStatusPriority,
} from "../timerTraining";
import {
  eventKind,
  type AppConfig,
  type CharacterProfile,
  type DiscoveredLog,
  type LogLinePayload,
  type EffectObservedPayload,
  type TailStatsPayload,
  type RankTrainingResult,
  type TimerTrainingReport,
  type TimerTrainingCandidate,
  type TimerTrainingCandidatesReport,
  type TriggerTreeEntry,
} from "../types";
import Empty from "./Empty";
import QuickTriggerModal from "./QuickTriggerModal";
import { useToast } from "./Toast";
import { IS_MOCK } from "../mock";

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

interface ManualTimingEditor {
  report: TimerTrainingReport;
  rank: RankTrainingResult;
  duration: string;
  castTime: string;
}

let seq = 1;

function candidateAsReport(
  batch: TimerTrainingCandidatesReport,
  candidate: TimerTrainingCandidate,
): TimerTrainingReport {
  return {
    triggerId: candidate.triggerId,
    triggerName: candidate.triggerName,
    timerName: candidate.timerName,
    logPath: batch.logPath,
    linesScanned: batch.linesScanned,
    rankedCasts: candidate.ranks.reduce((sum, rank) => sum + rank.castsSeen, 0),
    rejectedSamples: candidate.ranks.reduce(
      (sum, rank) => sum + rank.rejectedSamples,
      0,
    ),
    configuredDurationSecs: candidate.configuredDurationSecs,
    configuredCastTimeSecs: candidate.configuredCastTimeSecs,
    ranks: candidate.ranks,
  };
}

function trainingStatusLabel(status: ReturnType<typeof timerTrainingStatus>): string {
  switch (status) {
    case "drift":
      return "Needs update";
    case "inconsistent":
      return "Review evidence";
    case "collecting":
      return "Collecting";
    case "verified":
      return "Current";
  }
}

export default function DiagnosticsTab() {
  const [stats, setStats] = useState<TailStatsPayload | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [logs, setLogs] = useState<DiscoveredLog[]>([]);
  const [lines, setLines] = useState<DebugLine[]>([]);
  const [effects, setEffects] = useState<EffectDebug[]>([]);
  const [quickLine, setQuickLine] = useState<string | null>(null);
  const [rankedTimers, setRankedTimers] = useState<TriggerTreeEntry[]>([]);
  const [trainingProfile, setTrainingProfile] = useState<CharacterProfile | null>(null);
  const [candidateReport, setCandidateReport] = useState<TimerTrainingCandidatesReport | null>(null);
  const [candidateBusy, setCandidateBusy] = useState(false);
  const [trainingQuery, setTrainingQuery] = useState("");
  const [showAllRanked, setShowAllRanked] = useState(false);
  const [manualEditor, setManualEditor] = useState<ManualTimingEditor | null>(null);
  const [trainingTriggerId, setTrainingTriggerId] = useState("");
  const [trainingReport, setTrainingReport] = useState<TimerTrainingReport | null>(null);
  const [trainingBusy, setTrainingBusy] = useState(false);
  const [trainingError, setTrainingError] = useState<string | null>(null);
  const [appliedRanks, setAppliedRanks] = useState<Set<string>>(new Set());
  const [toastNode, showToast] = useToast();

  useEffect(() => {
    getConfig().then(setConfig).catch(() => setConfig(null));
    getProfile().then(setTrainingProfile).catch(() => setTrainingProfile(null));
    discoverLogs().then(setLogs).catch(() => setLogs([]));
    getTriggerTree()
      .then((tree) => {
        const timers = tree
          .filter((entry) => entry.timer && entry.pattern.includes("rank"))
          .sort((a, b) =>
            Number(b.effectiveEnabled) - Number(a.effectiveEnabled) ||
            a.name.localeCompare(b.name),
          );
        setRankedTimers(timers);
        setTrainingTriggerId((current) => current || timers[0]?.id || "");
      })
      .catch(() => setRankedTimers([]));
  }, []);

  useEffect(() => {
    if (IS_MOCK) void scanTimerCandidates();
    // Mock screenshots should exercise the evidence-first state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const candidateRows = useMemo(() => {
    if (!candidateReport) return [];
    const query = trainingQuery.trim().toLowerCase();
    return candidateReport.candidates
      .flatMap((candidate) => {
        const report = candidateAsReport(candidateReport, candidate);
        return candidate.ranks.map((rank) => {
          const timing = effectiveTrainingTiming(trainingProfile, report, rank);
          return {
            report,
            rank,
            timing,
            status: timerTrainingStatus(timing, rank),
          };
        });
      })
      .filter(
        (row) =>
          !query ||
          row.report.timerName.toLowerCase().includes(query) ||
          row.rank.rank.toLowerCase().includes(query),
      )
      .sort(
        (a, b) =>
          trainingStatusPriority(a.status) - trainingStatusPriority(b.status) ||
          a.report.timerName.localeCompare(b.report.timerName) ||
          romanRankValue(b.rank.rank) - romanRankValue(a.rank.rank),
      );
  }, [candidateReport, trainingProfile, trainingQuery]);

  const candidateCounts = useMemo(
    () =>
      candidateRows.reduce(
        (counts, row) => {
          counts[row.status] += 1;
          return counts;
        },
        { drift: 0, inconsistent: 0, collecting: 0, verified: 0 },
      ),
    [candidateRows],
  );

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

  async function scanTimerCandidates() {
    setCandidateBusy(true);
    setTrainingError(null);
    setTrainingReport(null);
    setManualEditor(null);
    try {
      const report = await timerTrainingCandidates();
      setCandidateReport(report);
      const first = report.candidates[0];
      if (first) setTrainingTriggerId(first.triggerId);
    } catch (error) {
      setTrainingError(String(error));
    } finally {
      setCandidateBusy(false);
    }
  }

  async function runTimerTraining(triggerId = trainingTriggerId) {
    if (!triggerId) return;
    setTrainingTriggerId(triggerId);
    setTrainingBusy(true);
    setTrainingError(null);
    setTrainingReport(null);
    setAppliedRanks(new Set());
    try {
      setTrainingReport(await timerTrainingScan(triggerId));
    } catch (error) {
      setTrainingError(String(error));
    } finally {
      setTrainingBusy(false);
    }
  }

  async function saveTimerTiming(
    report: TimerTrainingReport,
    result: RankTrainingResult,
    durationSecs: number,
    castTimeSecs: number | null,
    source: "observed" | "manual",
  ) {
    try {
      const profile = await getProfile();
      const loadout = activeLoadout(profile);
      const rank = result.rank.trim().toUpperCase();
      const existing = loadout.timing_overrides?.[report.triggerId]?.[rank] ?? {};
      const timing = {
        ...existing,
        duration_secs: durationSecs,
        ...(castTimeSecs != null ? { cast_time_secs: castTimeSecs } : {}),
      };
      const next = withTimingOverride(profile, report.triggerId, rank, timing);
      await setProfile(next);
      setTrainingProfile(next);
      setAppliedRanks((current) => new Set(current).add(`${report.triggerId}:${rank}`));
      setManualEditor(null);
      showToast(
        `${source === "observed" ? "Applied" : "Saved"} ${report.timerName} ${rank} timing to ${loadout.name}.`,
      );
    } catch (error) {
      setTrainingError(`Could not apply timing: ${String(error)}`);
    }
  }

  async function applyTimerTraining(
    report: TimerTrainingReport,
    result: RankTrainingResult,
  ) {
    if (!result.canApply || result.suggestedDurationSecs == null) return;
    await saveTimerTiming(
      report,
      result,
      result.suggestedDurationSecs,
      result.suggestedCastTimeSecs,
      "observed",
    );
  }

  async function saveManualTiming() {
    if (!manualEditor) return;
    const duration = parseTrainingDuration(manualEditor.duration);
    const castTime = manualEditor.castTime.trim()
      ? parseTrainingDuration(manualEditor.castTime)
      : null;
    if (duration == null || duration <= 0) {
      setTrainingError("Enter a duration in seconds or m:ss.");
      return;
    }
    if (manualEditor.castTime.trim() && castTime == null) {
      setTrainingError("Enter cast time in seconds or m:ss, or leave it blank.");
      return;
    }
    setTrainingError(null);
    await saveTimerTiming(
      manualEditor.report,
      manualEditor.rank,
      duration,
      castTime,
      "manual",
    );
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
            <span className="section-title">Ranked spell timers</span>
            <span className="tmr-badge timing">Log evidence</span>
          </div>
          <button
            className="primary small"
            disabled={candidateBusy}
            onClick={() => void scanTimerCandidates()}
          >
            {candidateBusy
              ? "Scanning history…"
              : candidateReport
                ? "Refresh"
                : "Find my ranked spells"}
          </button>
        </div>
        {trainingError && <div className="error-banner">{trainingError}</div>}
        {!candidateReport && !candidateBusy && (
          <Empty
            title="Find the ranked spells you actually cast"
            body="Scan the active log to surface new ranks, compare their current timers, and update them without searching the full trigger library."
          />
        )}
        {candidateReport && (
          <>
            <div className="timer-candidate-toolbar">
              <input
                value={trainingQuery}
                onChange={(event) => setTrainingQuery(event.target.value)}
                placeholder="Filter observed spells…"
                aria-label="Filter observed ranked spells"
              />
              <div className="timer-candidate-counts">
                <span className="training-confidence inconsistent">
                  {candidateCounts.drift + candidateCounts.inconsistent} needs review
                </span>
                <span className="training-confidence">
                  {candidateCounts.collecting} collecting
                </span>
                <span className="training-confidence good">
                  {candidateCounts.verified} current
                </span>
              </div>
            </div>
            <div className="timer-candidate-list">
              {candidateRows.length === 0 ? (
                <Empty
                  title={trainingQuery ? "No matching ranked spells" : "No ranked casts found"}
                  body={
                    trainingQuery
                      ? "Clear the filter to see every observed ranked spell."
                      : "Cast a ranked buff or debuff, then refresh this scan."
                  }
                />
              ) : (
                candidateRows.map(({ report, rank, timing, status }) => {
                  const key = `${report.triggerId}:${rank.rank}`;
                  const applied = appliedRanks.has(key);
                  return (
                    <div className={`timer-candidate-row ${status}`} key={key}>
                      <span className="timer-candidate-name">
                        <strong>{report.timerName} {rank.rank}</strong>
                        <small>{trainingStatusLabel(status)}</small>
                      </span>
                      <span>
                        <small>Current</small>
                        <strong>{formatDuration(timing.durationSecs)}</strong>
                      </span>
                      <span>
                        <small>Observed</small>
                        <strong>{formatDuration(rank.suggestedDurationSecs)}</strong>
                      </span>
                      <span>
                        <small>Evidence</small>
                        <strong>{rank.cleanSamples} clean / {rank.castsSeen} casts</strong>
                      </span>
                      <span className={`training-confidence ${status === "drift" ? "inconsistent" : rank.confidence}`}>
                        {trainingStatusLabel(status)}
                      </span>
                      <span className="timer-candidate-actions">
                        <button
                          className="ghost small"
                          onClick={() =>
                            setManualEditor({
                              report,
                              rank,
                              duration: String(timing.durationSecs),
                              castTime: timing.castTimeSecs > 0 ? String(timing.castTimeSecs) : "",
                            })
                          }
                        >
                          Set manually
                        </button>
                        <button
                          className={status === "drift" ? "primary small" : "ghost small"}
                          disabled={!rank.canApply || rank.suggestedDurationSecs == null || applied}
                          onClick={() => void applyTimerTraining(report, rank)}
                        >
                          {applied ? "Updated" : "Use observed"}
                        </button>
                        <button
                          className="ghost small"
                          disabled={trainingBusy}
                          onClick={() => void runTimerTraining(report.triggerId)}
                        >
                          Review
                        </button>
                      </span>
                    </div>
                  );
                })
              )}
            </div>
            <div className="timer-training-meta">
              {candidateReport.linesScanned.toLocaleString()} lines scanned
              <button
                className="ghost small"
                onClick={() => setShowAllRanked((current) => !current)}
              >
                {showAllRanked ? "Hide all timers" : "Choose from all timers"}
              </button>
            </div>
          </>
        )}
        {manualEditor && (
          <div className="timer-manual-editor">
            <strong>{manualEditor.report.timerName} {manualEditor.rank.rank}</strong>
            <label className="field">
              <span>Duration</span>
              <input
                value={manualEditor.duration}
                onChange={(event) =>
                  setManualEditor((current) =>
                    current ? { ...current, duration: event.target.value } : current,
                  )
                }
                placeholder="1:42"
                autoFocus
              />
            </label>
            <label className="field">
              <span>Cast time <small>(optional)</small></span>
              <input
                value={manualEditor.castTime}
                onChange={(event) =>
                  setManualEditor((current) =>
                    current ? { ...current, castTime: event.target.value } : current,
                  )
                }
                placeholder="2"
              />
            </label>
            <button className="primary small" onClick={() => void saveManualTiming()}>
              Save timing
            </button>
            <button className="ghost small" onClick={() => setManualEditor(null)}>
              Cancel
            </button>
          </div>
        )}
        {showAllRanked && (
          <div className="timer-all-ranked">
            <select
              value={trainingTriggerId}
              disabled={trainingBusy || rankedTimers.length === 0}
              onChange={(event) => setTrainingTriggerId(event.target.value)}
            >
              {rankedTimers.length === 0 && <option value="">No rank-aware timers found</option>}
              {rankedTimers.map((timer) => (
                <option value={timer.id} key={timer.id}>
                  {timer.effectiveEnabled ? "Active · " : ""}{timer.name}
                </option>
              ))}
            </select>
            <button
              className="ghost small"
              disabled={!trainingTriggerId || trainingBusy}
              onClick={() => void runTimerTraining()}
            >
              {trainingBusy ? "Analyzing…" : "Analyze selected"}
            </button>
          </div>
        )}
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
                const applied = appliedRanks.has(`${trainingReport.triggerId}:${result.rank}`);
                const timing = effectiveTrainingTiming(trainingProfile, trainingReport, result);
                return (
                  <div className="timer-training-row" key={result.rank}>
                    <strong>{trainingReport.timerName} {result.rank}</strong>
                    <span title={`${result.castsSeen} casts seen; ${result.rejectedSamples} rejected`}>
                      {result.cleanSamples} clean / {result.castsSeen} casts
                    </span>
                    <span>
                      <strong>
                        {formatDuration(timing.durationSecs)} → {formatDuration(result.suggestedDurationSecs)}
                      </strong>
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
                      onClick={() => void applyTimerTraining(trainingReport, result)}
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
