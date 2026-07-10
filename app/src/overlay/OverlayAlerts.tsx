import { useEffect, useState } from "react";
import { useTauriEvent } from "../hooks";
import { ALERT_SIZE_KEY, loadAlertSizePx } from "../overlayState";
import { useOverlayEnabled } from "../hooks";
import { IS_MOCK } from "../mock";
import OverlayEditChrome from "./OverlayEditChrome";
import { classifySeverity, type Severity } from "../lib/severity";
import {
  OVERLAY_ALERTS,
  type OverlayLockPayload,
  type ProcAlertPayload,
  type TriggerFiredPayload,
  type TriggerIdentity,
} from "../types";

// Visible time before fade-out, by severity: the dangerous tiers linger so
// a Death Touch can't scroll off in the same 4 s as routine spam.
const ALERT_TTL_MS: Record<Severity, number> = {
  info: 4000,
  warn: 6000,
  alarm: 8000,
};
const ALERT_FADE_MS = 300;

interface AlertItem {
  id: number;
  text: string;
  trigger: TriggerIdentity | null;
  severity: Severity;
  leaving: boolean;
}

let nextAlertId = 0;

const initiallyUnlocked =
  new URLSearchParams(window.location.search).get("unlocked") === "1";

function titleCaseWords(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function normalizeAlertText(text: string): string {
  const raw = text.trim().replace(/\s+/g, " ");
  const lower = raw.toLowerCase();
  const known: Record<string, string> = {
    rooted: "Root: On",
    "root off": "Root: Off",
    "root broke": "Root: Broke",
    stunned: "Stun: On",
    "stun over": "Stun: Off",
    snared: "Snare: On",
    "snare off": "Snare: Off",
    slowed: "Slow: On",
    "slow off": "Slow: Off",
    mezzed: "Mez: On",
    "mez off": "Mez: Off",
    charmed: "Charm: On You",
    "charm over": "Charm: Off You",
    "charm broke": "Charm: Broke",
  };
  if (known[lower]) return known[lower];

  const rootedTarget = /^(.+) rooted$/i.exec(raw);
  if (rootedTarget) return `Root: ${rootedTarget[1]}`;

  const offTarget = /^(.+?) off(?: (.+))?$/i.exec(raw);
  if (offTarget) {
    const effect = titleCaseWords(offTarget[1]);
    return offTarget[2] ? `${effect}: Off ${offTarget[2]}` : `${effect}: Off`;
  }

  return raw;
}

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
    const normalizedText = normalizeAlertText(text);
    const severity = classifySeverity(trigger?.id, trigger?.name);
    const ttl = ALERT_TTL_MS[severity];
    // Newest on top, max 5 visible. When full, evict the oldest NON-alarm
    // pill first: a burst of routine spam must not push a Death Touch off.
    setAlerts((a) => {
      const next = [
        { id, text: normalizedText, trigger, severity, leaving: false },
        ...a,
      ];
      if (next.length <= 5) return next;
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].severity !== "alarm") {
          return [...next.slice(0, i), ...next.slice(i + 1)];
        }
      }
      return next.slice(0, 5);
    });
    window.setTimeout(
      () =>
        setAlerts((a) =>
          a.map((x) => (x.id === id ? { ...x, leaving: true } : x)),
        ),
      ttl,
    );
    window.setTimeout(
      () => setAlerts((a) => a.filter((x) => x.id !== id)),
      ttl + ALERT_FADE_MS,
    );
  };

  useTauriEvent<TriggerFiredPayload>("trigger-fired", (p) => {
    if (p.action.kind !== "displayText") return;
    pushAlert(p.action.text, p.trigger);
  });

  useTauriEvent<ProcAlertPayload>("proc-alert", (p) => {
    if (!p?.spell) return;
    const crit = p.critical ? " crit" : "";
    const amt =
      typeof p.amount === "number" && Number.isFinite(p.amount)
        ? ` ${Math.round(p.amount)}${crit}`
        : crit;
    const label =
      p.kind === "skill" ? "Skill" : p.kind === "spell" ? "Spell" : "Proc";
    pushAlert(`${label}: ${p.spell}${amt}`, {
      id: `system/${p.kind}-alert`,
      name: `${label} alert`,
    });
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
        {alerts.map((a) => (
          // Tier the pill so a Death Touch never reads like a tell (X6).
          <div
            key={a.id}
            className={`alert-pill alert-${a.severity}${
              a.leaving ? " leaving" : ""
            }`}
            title={a.trigger ? `Trigger: ${a.trigger.name}` : undefined}
          >
            {a.text}
          </div>
        ))}
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
