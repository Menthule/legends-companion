// Stance & invocation overlay: a compact always-on card showing the
// character's current martial stance (left) and invocation (right), each
// with a glyph keyed to its name, tracked from log lines (see
// lib/stanceState.ts for the verified line shapes and the "unknown until
// first change" limitation).

import { useEffect, useRef, useState } from "react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { useTauriEvent } from "../hooks";
import { IS_MOCK } from "../mock";
import {
  applyStanceLine,
  EMPTY_STANCE_STATE,
  type StanceState,
} from "../lib/stanceState";
import { OVERLAY_STANCE, type LogLinePayload } from "../types";
import OverlayShell from "./OverlayShell";

// Glyphs adapted from Lucide (https://lucide.dev, ISC license) — a
// professionally drawn mono stroke set matching the app's icon language.
// 24-grid paths, stroke-2, colored by CSS (currentColor).
function svgProps24(size: number) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
}

/** Glyph for a stance by name keyword; a standing figure when unknown. */
function StanceIcon({ name, size = 34 }: { name: string | null; size?: number }) {
  const n = (name ?? "").toLowerCase();
  if (n.includes("strik") || n.includes("aggress") || n.includes("offens")) {
    // Lucide "sword".
    return (
      <svg {...svgProps24(size)}>
        <polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5" />
        <line x1="13" x2="19" y1="19" y2="13" />
        <line x1="16" x2="20" y1="16" y2="20" />
        <line x1="19" x2="21" y1="21" y2="19" />
      </svg>
    );
  }
  if (n.includes("evas") || n.includes("dodg") || n.includes("swift")) {
    // Lucide "wind".
    return (
      <svg {...svgProps24(size)}>
        <path d="M12.8 19.6A2 2 0 1 0 14 16H2" />
        <path d="M17.5 8a2.5 2.5 0 1 1 2 4H2" />
        <path d="M9.8 4.4A2 2 0 1 1 11 8H2" />
      </svg>
    );
  }
  if (
    n.includes("guard") ||
    n.includes("defens") ||
    n.includes("bulwark") ||
    n.includes("stalwart")
  ) {
    // Lucide "shield".
    return (
      <svg {...svgProps24(size)}>
        <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1 1 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      </svg>
    );
  }
  if (n.includes("balanc") || n.includes("center")) {
    // Lucide "scale".
    return (
      <svg {...svgProps24(size)}>
        <path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" />
        <path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" />
        <path d="M7 21h10" />
        <path d="M12 3v18" />
        <path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2" />
      </svg>
    );
  }
  // Unknown stance — Lucide "person-standing".
  return (
    <svg {...svgProps24(size)}>
      <circle cx="12" cy="5" r="1" />
      <path d="m9 20 3-6 3 6" />
      <path d="m6 8 6 2 6-2" />
      <path d="M12 10v4" />
    </svg>
  );
}

/** Glyph for an invocation by name keyword; sparkles when unknown. */
function InvocationIcon({ name, size = 34 }: { name: string | null; size?: number }) {
  const n = (name ?? "").toLowerCase();
  if (n.includes("recover") || n.includes("mend") || n.includes("heal")) {
    // Lucide "heart-pulse".
    return (
      <svg {...svgProps24(size)}>
        <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
        <path d="M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27" />
      </svg>
    );
  }
  if (n.includes("empower") || n.includes("might") || n.includes("strength")) {
    // Lucide "zap".
    return (
      <svg {...svgProps24(size)}>
        <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
      </svg>
    );
  }
  if (n.includes("focus") || n.includes("insight") || n.includes("clarity")) {
    // Lucide "eye".
    return (
      <svg {...svgProps24(size)}>
        <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    );
  }
  if (n.includes("invers") || n.includes("revers")) {
    // Lucide "arrow-down-up".
    return (
      <svg {...svgProps24(size)}>
        <path d="m3 16 4 4 4-4" />
        <path d="M7 20V4" />
        <path d="m21 8-4-4-4 4" />
        <path d="M17 4v16" />
      </svg>
    );
  }
  if (n.includes("ward") || n.includes("protect") || n.includes("aegis")) {
    // Lucide "shield-check".
    return (
      <svg {...svgProps24(size)}>
        <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1 1 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
        <path d="m9 12 2 2 4-4" />
      </svg>
    );
  }
  // Unknown invocation — Lucide "sparkles".
  return (
    <svg {...svgProps24(size)}>
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      <path d="M20 3v4" />
      <path d="M22 5h-4" />
      <path d="M4 17v2" />
      <path d="M5 18H3" />
    </svg>
  );
}

function Cell({
  label,
  name,
  changing,
  baseline,
  icon,
}: {
  label: string;
  name: string | null;
  changing: boolean;
  /** True when this is the resting default (Balanced / Recovery) — muted
   *  so only NON-baseline states draw the eye with the accent color. */
  baseline: boolean;
  icon: React.ReactNode;
}) {
  return (
    <div className={`ov-stance-cell${changing ? " changing" : ""}`}>
      <span className={`ov-stance-icon${baseline ? " baseline" : ""}`}>{icon}</span>
      <span className="ov-stance-meta">
        <span className="ov-stance-label">{label}</span>
        {changing ? (
          <span className="ov-stance-val changing">changing…</span>
        ) : name ? (
          <span className="ov-stance-val">{name}</span>
        ) : (
          <span
            className="ov-stance-val unknown"
            title="Known after your next change — the log only records changes."
          >
            —
          </span>
        )}
      </span>
    </div>
  );
}

/** The stance card body; `unlocked` comes from the shell so the grow-to-fit
 *  effect can re-run when the in-flow drag tag adds height above the card. */
function StanceCard({ unlocked }: { unlocked: boolean }) {
  const [state, setState] = useState<StanceState>(EMPTY_STANCE_STATE);
  const cardRef = useRef<HTMLDivElement>(null);

  // GROW the window when the card doesn't fit: saved geometry can predate
  // layout changes (icons, longer names) and would clip the pill. Grow-only
  // — never shrink — so a user who enlarged the resizable window keeps
  // their size. Re-runs when `unlocked` flips because the in-flow drag tag
  // adds height above the card.
  useEffect(() => {
    if (IS_MOCK) return;
    const el = cardRef.current;
    if (!el) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      // r.right/r.bottom include the card's offset inside the window, so
      // the right/bottom margins stay symmetric with the left/top.
      const needW = Math.ceil(r.right) + 14;
      const needH = Math.ceil(r.bottom) + 10;
      if (needW <= window.innerWidth && needH <= window.innerHeight) {
        return; // already fits — leave the user's size alone
      }
      getCurrentWindow()
        .setSize(
          new LogicalSize(
            Math.max(needW, window.innerWidth),
            Math.max(needH, window.innerHeight),
          ),
        )
        .catch(() => {});
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [unlocked]);

  useTauriEvent<LogLinePayload>("log-line", (p) => {
    setState((s) => applyStanceLine(s, p.message) ?? s);
  });

  return (
    <div className="ov-stance" ref={cardRef}>
      <Cell
        label="Stance"
        name={state.stance}
        changing={state.stanceChanging}
        baseline={(state.stance ?? "").toLowerCase().includes("balanc")}
        icon={<StanceIcon name={state.stance} />}
      />
      <div className="ov-stance-divider" aria-hidden="true" />
      <Cell
        label="Invocation"
        name={state.invocation}
        changing={state.invocationChanging}
        baseline={(state.invocation ?? "").toLowerCase().includes("recover")}
        icon={<InvocationIcon name={state.invocation} />}
      />
    </div>
  );
}

export default function OverlayStance() {
  return (
    <OverlayShell label={OVERLAY_STANCE} name="Stance overlay">
      {(unlocked) => <StanceCard unlocked={unlocked} />}
    </OverlayShell>
  );
}
