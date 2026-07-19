import { useEffect, useRef, useState, type CSSProperties } from "react";
import { getConfig } from "../api";
import { useTauriEvent } from "../hooks";
import { HighlightEvaluator, type HighlightCandidate } from "../lib/highlights";
import { highlightOverlayView } from "../lib/overlayRegistry";
import { IS_MOCK } from "../mock";
import {
  OVERLAY_HIGHLIGHTS,
  type AppConfig,
  type CatchUpPayload,
  type LogLinePayload,
  type TriggerOverlayPayload,
} from "../types";
import OverlayShell from "./OverlayShell";
import SpellGemIcon, {
  spellIconId,
  spellIconName,
} from "../components/SpellGemIcon";

const AGGREGATE_MS = 850;
const DEFAULT_TTL_MS = 5500;
const MAX_ROWS = 4;

interface HighlightRow extends HighlightCandidate {
  id: number;
  total: number;
  hits: number;
  crits: number;
  max: number;
  expiresAt: number;
  leaving: boolean;
}

let nextHighlightId = 0;

function amountOf(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

export default function OverlayHighlights() {
  const evaluator = useRef(new HighlightEvaluator());
  const [rows, setRows] = useState<HighlightRow[]>([]);
  const catchingUp = useRef(false);
  const lastSeen = useRef(new Map<string, number>());

  const push = (
    candidate: HighlightCandidate,
    durationMs = candidate.ttlMs ?? DEFAULT_TTL_MS,
  ) => {
    const now = Date.now();
    const amount = candidate.amount ?? 0;
    const last = lastSeen.current.get(candidate.key) ?? 0;
    const aggregateMs = candidate.aggregateMs ?? AGGREGATE_MS;
    lastSeen.current.set(candidate.key, now);
    setRows((current) => {
      if (!candidate.important && now - last <= aggregateMs) {
        const index = current.findIndex((row) => row.key === candidate.key);
        if (index >= 0) {
          const copy = [...current];
          const existing = copy[index];
          copy[index] = {
            ...existing,
            detail: candidate.detail ?? existing.detail,
            total: existing.total + amount,
            hits: existing.hits + 1,
            crits:
              existing.crits + (candidate.detail?.toLowerCase().includes("critical") ? 1 : 0),
            max: Math.max(existing.max, amount),
            periodic: existing.periodic || candidate.periodic,
            expiresAt: now + durationMs,
            leaving: false,
          };
          return copy;
        }
      }
      const row: HighlightRow = {
        ...candidate,
        id: nextHighlightId++,
        total: amount,
        hits: 1,
        crits: candidate.detail?.toLowerCase().includes("critical") ? 1 : 0,
        max: amount,
        expiresAt: now + durationMs,
        leaving: false,
      };
      return [row, ...current].slice(0, MAX_ROWS);
    });
  };

  useTauriEvent<TriggerOverlayPayload>("trigger-overlay", (payload) => {
    if (catchingUp.current) return;
    const view = highlightOverlayView(payload);
    if (!view) return;
    push(
      {
        key: `trigger:${payload.trigger?.id ?? view.text.toLowerCase()}`,
        text: view.text,
        amount: amountOf(view.value),
        detail: view.detail,
        icon: view.icon,
        color: view.color,
      },
      view.durationMs,
    );
  });

  useTauriEvent<LogLinePayload>("log-line", (line) => {
    if (catchingUp.current) return;
    for (const candidate of evaluator.current.evaluate(line)) push(candidate);
  });
  useTauriEvent<CatchUpPayload>("catch-up", (payload) => {
    catchingUp.current = payload.active;
    if (payload.active) setRows([]);
  });
  useTauriEvent<{ tailing: boolean }>("tailing-changed", (payload) => {
    if (!payload.tailing) setRows([]);
  });
  useTauriEvent<AppConfig>("config-changed", (config) => {
    evaluator.current.setOwners(config.characterName, config.pets);
  });

  useEffect(() => {
    if (!IS_MOCK) {
      void getConfig().then((config) =>
        evaluator.current.setOwners(config.characterName, config.pets),
      ).catch(() => undefined);
    }
    const interval = window.setInterval(() => {
      const now = Date.now();
      setRows((current) =>
        current
          .filter((row) => row.expiresAt + 350 > now)
          .map((row) =>
            row.expiresAt <= now && !row.leaving ? { ...row, leaving: true } : row,
          ),
      );
    }, 150);
    if (IS_MOCK) {
      push({ key: "mock:kick", text: "Kick", amount: 184, icon: "spell:203" });
      push({
        key: "mock:spell",
        text: "Blast of Frost",
        amount: 947,
        detail: "Critical",
        icon: "spell-name:Blast of Frost",
        color: "#ffb454",
      });
    }
    return () => window.clearInterval(interval);
    // Mock seeds once; live rows arrive through app events.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <OverlayShell
      label={OVERLAY_HIGHLIGHTS}
      name="Highlights overlay"
      className="highlights-shell"
    >
      <div className="ov-highlight-stack" aria-label="Combat highlights">
        {rows.map((row) => (
          <div
            key={row.id}
            className={`highlight-card ${row.icon ? "has-icon" : "no-icon"}${row.leaving ? " leaving" : ""}`}
            style={{ "--highlight-accent": row.color } as CSSProperties}
          >
            {row.icon && (
              <span className="highlight-icon">
                {spellIconId(row.icon) != null || spellIconName(row.icon) != null ? (
                  <SpellGemIcon icon={row.icon} size={28} label={`${row.text} icon`} />
                ) : (
                  <span className="highlight-glyph">✦</span>
                )}
              </span>
            )}
            <span className="highlight-copy">
              <strong>{row.text}</strong>
              {(row.detail || row.hits > 1) && (
                <small>
                  {row.hits > 1
                    ? `${row.hits} hits${row.periodic ? " · DoT" : ""}${row.crits ? ` · ${row.crits} crit` : ""} · max ${row.max.toLocaleString()}`
                    : row.detail}
                </small>
              )}
            </span>
            {row.total > 0 && (
              <b className="highlight-value">{row.total.toLocaleString()}</b>
            )}
          </div>
        ))}
      </div>
    </OverlayShell>
  );
}
