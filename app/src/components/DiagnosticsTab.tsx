import { useEffect, useMemo, useState } from "react";
import { discoverLogs, getConfig } from "../api";
import { fmtClock, useTauriEvent } from "../hooks";
import type {
  AppConfig,
  DiscoveredLog,
  LogLinePayload,
  EffectObservedPayload,
  TailStatsPayload,
} from "../types";
import QuickTriggerModal from "./QuickTriggerModal";

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

function eventKind(event: LogLinePayload["event"]): string {
  if (typeof event === "string") return event;
  return Object.keys(event)[0] ?? "Unknown";
}

export default function DiagnosticsTab() {
  const [stats, setStats] = useState<TailStatsPayload | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [logs, setLogs] = useState<DiscoveredLog[]>([]);
  const [lines, setLines] = useState<DebugLine[]>([]);
  const [effects, setEffects] = useState<EffectDebug[]>([]);
  const [quickLine, setQuickLine] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    getConfig().then(setConfig).catch(() => setConfig(null));
    discoverLogs().then(setLogs).catch(() => setLogs([]));
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
      setStatus(`${label} copied.`);
    } catch {
      setStatus(`Could not copy ${label.toLowerCase()}.`);
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

  return (
    <div className="diag-grid">
      <section className="card">
        <div className="card-head">
          <span className="section-title">Parser Health</span>
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
          <strong>{stats ? `${stats.unclassifiedPct.toFixed(1)}%` : "--"}</strong>
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
          <span className="section-title">Active Log</span>
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
        <div className="card-head">
          <span className="section-title">Recent Unrecognized Lines</span>
          {status && <span className="hint">{status}</span>}
        </div>
        <div className="coach-table">
          {lines.length === 0 ? (
            <div className="hint">No unrecognized lines captured in this view.</div>
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
          <span className="section-title">Observed Spell Effects</span>
        </div>
        <div className="coach-table">
          {effects.length === 0 ? (
            <div className="hint">Parsed spell damage will appear here. Trigger output is inspected in the Triggers tab.</div>
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
            setStatus(`Trigger "${name}" saved.`);
          }}
        />
      )}
    </div>
  );
}
