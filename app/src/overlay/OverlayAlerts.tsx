import { useEffect, useState } from "react";
import { useTauriEvent } from "../hooks";
import { ALERT_SIZE_KEY, loadAlertSizePx } from "../overlayState";
import { IS_MOCK } from "../mock";
import { getProfile } from "../api";
import { activeLoadout } from "../resolution";
import { classifySeverity, type Severity } from "../lib/severity";
import {
  alertOverlayView,
  type AlertOverlayView,
} from "../lib/overlayRegistry";
import {
  OVERLAY_ALERTS,
  type CharacterProfile,
  type TriggerFiredPayload,
  type TriggerIdentity,
  type TriggerOverlayPayload,
} from "../types";
import OverlayShell from "./OverlayShell";
import SpellGemIcon, {
  spellIconId,
  spellIconName,
} from "../components/SpellGemIcon";

/** Pull the active loadout's per-trigger severity overrides into a plain map. */
function severityMapOf(profile: CharacterProfile | null): Record<string, Severity> {
  if (!profile) return {};
  const raw = activeLoadout(profile).severity_overrides ?? {};
  const out: Record<string, Severity> = {};
  for (const [id, sev] of Object.entries(raw)) {
    if (sev === "info" || sev === "warn" || sev === "alarm") out[id] = sev;
  }
  return out;
}

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
  value?: string;
  trigger: TriggerIdentity | null;
  severity: Severity;
  icon?: string;
  color?: string;
  fontSize?: number;
  leaving: boolean;
}

let nextAlertId = 0;

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
  const [sizePx, setSizePx] = useState(() => loadAlertSizePx());
  // Per-trigger severity overrides from the active loadout — a trigger the
  // auto-classifier reads wrong (e.g. "Bond of Death off" → alarm) can be
  // dialled to a quieter tier from the Triggers tab. Refreshed on every
  // profile-changed (which the tier chip triggers).
  const [sevOverrides, setSevOverrides] = useState<Record<string, Severity>>({});

  // The Settings window writes the size; the storage event carries it here.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === ALERT_SIZE_KEY) setSizePx(loadAlertSizePx());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Load the severity overrides once, then keep them fresh via profile-changed.
  useEffect(() => {
    if (IS_MOCK) return;
    let live = true;
    getProfile()
      .then((p) => live && setSevOverrides(severityMapOf(p)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  useTauriEvent<CharacterProfile>("profile-changed", (p) =>
    setSevOverrides(severityMapOf(p)),
  );

  const pushAlert = (
    text: string,
    trigger: TriggerIdentity | null,
    presentation: Partial<AlertOverlayView> = {},
  ) => {
    const id = nextAlertId++;
    const normalizedText = normalizeAlertText(text);
    const override = trigger?.id ? sevOverrides[trigger.id] : undefined;
    const severity =
      override ??
      presentation.severity ??
      classifySeverity(trigger?.id, trigger?.name);
    const ttl = presentation.durationMs ?? ALERT_TTL_MS[severity];
    // Newest on top, max 5 visible. When full, evict the oldest NON-alarm
    // pill first: a burst of routine spam must not push a Death Touch off.
    setAlerts((a) => {
      const next = [
        {
          id,
          text: normalizedText,
          value: presentation.value,
          trigger,
          severity,
          icon: presentation.icon ?? trigger?.icon ?? undefined,
          color: presentation.color,
          fontSize: presentation.fontSize,
          leaving: false,
        },
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

  useTauriEvent<TriggerOverlayPayload>("trigger-overlay", (p) => {
    const view = alertOverlayView(p);
    if (view) pushAlert(view.text, p.trigger, view);
  });

  // Camp respawn (FightsTab): a timed mob is back up. Visual only — the
  // announcement is deliberately NOT spoken. trigger:null → neutral pill.
  useTauriEvent<{ name: string }>("camp-respawn", (p) => {
    if (p?.name) pushAlert(`${p.name} up`, null);
  });

  return (
    <OverlayShell label={OVERLAY_ALERTS} name="Alerts overlay">
      <div className="ov-alert-stack" style={{ fontSize: sizePx }}>
        {alerts.map((a) => (
          // Tier the pill so a Death Touch never reads like a tell (X6).
          <div
            key={a.id}
            className={`alert-pill alert-${a.severity}${
              a.leaving ? " leaving" : ""
            }`}
            style={{ color: a.color, fontSize: a.fontSize }}
            title={a.trigger ? `Trigger: ${a.trigger.name}` : undefined}
          >
            {a.icon &&
              (spellIconId(a.icon) != null || spellIconName(a.icon) != null ? (
                <SpellGemIcon icon={a.icon} size={20} label={`${a.text} spell icon`} />
              ) : (
                <span className="alert-icon">{a.icon}</span>
              ))}
            <span className="alert-label">{a.text}</span>
            {a.value && <span className="alert-value">{a.value}</span>}
          </div>
        ))}
      </div>
    </OverlayShell>
  );
}
