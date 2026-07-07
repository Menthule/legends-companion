import { useEffect, useState } from "react";
import { useTauriEvent } from "../hooks";
import { ALERT_SIZE_KEY, loadAlertSizePx } from "../overlayState";
import { useOverlayEnabled } from "../hooks";
import { IS_MOCK } from "../mock";
import OverlayEditChrome from "./OverlayEditChrome";
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
  const enabled = useOverlayEnabled(OVERLAY_ALERTS);
  const [sizePx, setSizePx] = useState(() => loadAlertSizePx());

  // The Settings window writes the size; the storage event carries it here.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === ALERT_SIZE_KEY) setSizePx(loadAlertSizePx());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const pushAlert = (text: string, trigger: TriggerIdentity | null) => {
    const id = nextAlertId++;
    // Newest on top, max 5 visible.
    setAlerts((a) => [{ id, text, trigger, leaving: false }, ...a].slice(0, 5));
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
  };

  useTauriEvent<TriggerFiredPayload>("trigger-fired", (p) => {
    if (p.action.kind !== "displayText") return;
    pushAlert(p.action.text, p.trigger);
  });

  // Camp respawn (FightsTab): a timed mob is back up. Visual only — the
  // announcement is deliberately NOT spoken. trigger:null → neutral pill.
  useTauriEvent<{ name: string }>("camp-respawn", (p) => {
    if (p?.name) pushAlert(`${p.name} up`, null);
  });

  useTauriEvent<OverlayLockPayload>("overlay-lock-changed", (p) => {
    if (p.label === OVERLAY_ALERTS) setUnlocked(!p.clickThrough);
  });

  return (
    <div className={`ov-shell${unlocked ? " unlocked" : ""}${unlocked && !enabled ? " ov-disabled" : ""}`}>
      {unlocked && (
        <OverlayEditChrome label={OVERLAY_ALERTS} name="Alerts overlay" />
      )}
      <div className="ov-alert-stack" style={{ fontSize: sizePx }}>
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
