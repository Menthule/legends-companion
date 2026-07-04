// First-run welcome card (NOW-sprint item 4): shown when no config exists
// yet (empty log path). Lists auto-discovered log files as one-click
// choices, explains /log on, and links to Settings for manual setup.

import { useEffect, useState } from "react";
import { discoverLogs, getConfig, setConfig } from "../api";
import { displayPath, DEFAULT_LOG_DIR, type DiscoveredLog } from "../types";

function fmtAge(ts: number | null): string {
  if (ts === null) return "";
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (secs < 90) return "updated just now";
  if (secs < 3600) return `updated ${Math.round(secs / 60)} min ago`;
  if (secs < 172800) return `updated ${Math.round(secs / 3600)} h ago`;
  return `updated ${Math.round(secs / 86400)} days ago`;
}

export default function WelcomeCard({
  onChosen,
  onOpenSettings,
}: {
  /** Called with the character name after a log is picked and saved. */
  onChosen: (characterName: string) => void;
  onOpenSettings: () => void;
}) {
  const [logs, setLogs] = useState<DiscoveredLog[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    discoverLogs()
      .then(setLogs)
      .catch(() => setLogs([]));
  }, []);

  async function choose(log: DiscoveredLog) {
    setSaving(true);
    setError(null);
    try {
      const current = await getConfig();
      await setConfig({
        ...current,
        logPath: log.path,
        characterName: log.character,
      });
      onChosen(log.character);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card welcome-card">
      <div className="welcome-title">Welcome to Legends Companion</div>
      <p className="welcome-body">
        This app reads the plain-text log file EverQuest Legends writes — no
        memory reading, nothing injected. Pick your character&apos;s log to
        get started.
      </p>

      {logs === null ? (
        <div className="hint">Looking for log files…</div>
      ) : logs.length > 0 ? (
        <div className="welcome-logs">
          {logs.map((l) => (
            <button
              key={l.path}
              className="welcome-log"
              disabled={saving}
              onClick={() => void choose(l)}
              title={displayPath(l.path)}
            >
              <span className="welcome-log-char">{l.character || "Unknown"}</span>
              <span className="welcome-log-meta">
                {l.server ? `${l.server} — ` : ""}
                {fmtAge(l.modifiedTs) || displayPath(l.path)}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="welcome-body">
          No log files were found in the default Logs folder
          {" "}
          (<code className="welcome-code">{displayPath(DEFAULT_LOG_DIR)}</code>).
        </p>
      )}

      <p className="welcome-body">
        No log yet? In game, type{" "}
        <code className="welcome-code">/log on</code> in the chat window — the
        game starts writing{" "}
        <code className="welcome-code">eqlog_&lt;Character&gt;_&lt;server&gt;.txt</code>{" "}
        and it will show up here. (Logging can reset after patches; re-check
        it if lines stop.)
      </p>

      {error && <div className="error-banner">{error}</div>}

      <div className="welcome-foot">
        <button className="ghost" onClick={onOpenSettings}>
          Choose a file manually in Settings
        </button>
      </div>
    </div>
  );
}
