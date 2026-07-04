import { useState } from "react";
import { useTauriEvent } from "../hooks";
import { IS_MOCK } from "../mock";
import { classifySeverity } from "../lib/severity";
import {
  OVERLAY_ALERTS,
  type OverlayLockPayload,
  type TriggerFiredPayload,
  type TriggerIdentity,
} from "../types";

const ALERT_TTL_MS = 4000; // visible time before fade-out
const ALERT_FADE_MS = 300;

interface AlertItem {
  id: number;
  text: string;
  trigger: TriggerIdentity | null;
  leaving: boolean;
}

let nextAlertId = 0;

const initiallyUnlocked =
  new URLSearchParams(window.location.search).get("unlocked") === "1";

/** Text alerts only (trigger DisplayText, deaths, …) — timer bars live on
 *  the buffs and target overlays (overlay-lanes spec). Speech is NOT done
 *  here: TTS is owned by the backend audio thread (per-trigger Speak actions
 *  + timer "ending" warnings) so there is a single voice and a single queue
 *  that the Silence kill switch can drain. */
export default function OverlayAlerts() {
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [unlocked, setUnlocked] = useState(initiallyUnlocked);

  useTauriEvent<TriggerFiredPayload>("trigger-fired", (p) => {
    if (p.action.kind !== "displayText") return;
    const id = nextAlertId++;
    // Newest on top, max 5 visible.
    setAlerts((a) =>
      [
        { id, text: p.action.text, trigger: p.trigger, leaving: false },
        ...a,
      ].slice(0, 5),
    );
    window.setTimeout(
      () =>
        setAlerts((a) =>
          a.map((x) => (x.id === id ? { ...x, leaving: true } : x)),
        ),
      ALERT_TTL_MS,
    );
    window.setTimeout(
      () => setAlerts((a) => a.filter((x) => x.id !== id)),
      ALERT_TTL_MS + ALERT_FADE_MS,
    );
  });

  useTauriEvent<OverlayLockPayload>("overlay-lock-changed", (p) => {
    if (p.label === OVERLAY_ALERTS) setUnlocked(!p.clickThrough);
  });

  return (
    <div className={`ov-shell${unlocked ? " unlocked" : ""}`}>
      {unlocked && (
        <div className="ov-drag-tag" data-tauri-drag-region>
          Alerts overlay — drag to arrange, then lock
        </div>
      )}
      <div className="ov-alert-stack">
        {alerts.map((a) => {
          // Tier the pill so a Death Touch never reads like a tell (X6).
          const severity = classifySeverity(a.trigger?.id, a.trigger?.name);
          return (
            <div
              key={a.id}
              className={`alert-pill alert-${severity}${
                a.leaving ? " leaving" : ""
              }`}
              title={a.trigger ? `Trigger: ${a.trigger.name}` : undefined}
            >
              {a.text}
            </div>
          );
        })}
      </div>
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
