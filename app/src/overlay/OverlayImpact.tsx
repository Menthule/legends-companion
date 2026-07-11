import { useEffect, useRef, useState } from "react";
import { useTauriEvent, useOverlayEnabled } from "../hooks";
import { IS_MOCK } from "../mock";
import OverlayEditChrome from "./OverlayEditChrome";
import { impactOverlayView } from "../lib/overlayRegistry";
import {
  OVERLAY_IMPACT,
  type ImpactEvent,
  type ImpactPayload,
  type OverlayLockPayload,
  type TriggerOverlayPayload,
} from "../types";
import { loadOverlayArrange, OVERLAY_ARRANGE_KEY } from "../overlayState";

// How long an impact lingers before it fades out.
const IMPACT_TTL_MS = 2600;
const IMPACT_FADE_MS = 450;

// Arrange is a transient mode — overlays always boot LOCKED (click-through,
// no edit chrome). The persisted flag only drives runtime cross-window sync
// (the storage listener below), never the initial state, so a restart while
// arranging doesn't leave drag chrome plastered over the game.
const initiallyUnlocked =
  new URLSearchParams(window.location.search).get("unlocked") === "1";

interface Shown {
  payload: ImpactPayload;
  leaving: boolean;
}

/** Inline slab medal for badge/medal styles (CSP blocks external assets, so
 *  it's hand-drawn). Bold but restrained: a geometric disc + ring + ribbon. */
function Medal({ glyph }: { glyph: string }) {
  return (
    <div className="ov-medal" aria-hidden="true">
      <svg viewBox="0 0 48 48" width="100%" height="100%">
        <polygon className="ov-medal-ribbon" points="17,4 24,20 31,4" />
        <circle className="ov-medal-disc" cx="24" cy="30" r="13" />
        <circle className="ov-medal-ring" cx="24" cy="30" r="13" />
      </svg>
      <span className="ov-medal-glyph">{glyph}</span>
    </div>
  );
}

/** Impact overlay: the channel for big dramatic moments. It is entirely
 *  TRIGGER-DRIVEN — the backend emits an `impact` event whenever a trigger's
 *  Impact action fires, carrying a `style` (slash / big-number / level /
 *  badge / medal) plus template-expanded text. Nothing about any specific
 *  moment (Finishing Blow, level-up, AA procs, crits) is hardcoded here; each
 *  is a curated/user trigger that decides its own look. */
export default function OverlayImpact() {
  const [shown, setShown] = useState<Shown | null>(null);
  const [unlocked, setUnlocked] = useState(initiallyUnlocked);
  const enabled = useOverlayEnabled(OVERLAY_IMPACT);
  const fadeTimer = useRef<number | undefined>(undefined);
  const dropTimer = useRef<number | undefined>(undefined);
  const nextId = useRef(0);

  const fire = (payload: ImpactPayload, durationMs = IMPACT_TTL_MS) => {
    window.clearTimeout(fadeTimer.current);
    window.clearTimeout(dropTimer.current);
    setShown({ payload, leaving: false });
    fadeTimer.current = window.setTimeout(
      () => setShown((s) => (s ? { ...s, leaving: true } : s)),
      durationMs,
    );
    dropTimer.current = window.setTimeout(
      () => setShown(null),
      durationMs + IMPACT_FADE_MS,
    );
  };

  useTauriEvent<ImpactEvent>("impact", (p) => {
    if (p?.style) fire({ ...p, id: nextId.current++ });
  });

  useTauriEvent<TriggerOverlayPayload>("trigger-overlay", (p) => {
    const view = impactOverlayView(p);
    if (view) {
      fire({ ...view.event, id: nextId.current++ }, view.durationMs);
    }
  });

  useTauriEvent<OverlayLockPayload>("overlay-lock-changed", (p) => {
    if (p.label === OVERLAY_IMPACT) setUnlocked(!p.clickThrough);
  });

  useEffect(() => {
    if (IS_MOCK) return;
    const onStorage = (e: StorageEvent) => {
      if (e.key === OVERLAY_ARRANGE_KEY) setUnlocked(loadOverlayArrange());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Mock: cycle one of each style so all render in browser dev.
  useEffect(() => {
    if (!IS_MOCK) return;
    const demos: ImpactEvent[] = [
      { style: "slash", headline: "FINISHING BLOW", big: "1,204", sub: "You → Baron Telyx V`Zher" },
      { style: "big-number", headline: "CRITICAL", big: "947", sub: "Blast of Frost → a Teir`Dal ranger", color: "#ffb454" },
      { style: "level", headline: "LEVEL UP", big: "32", sub: "Ding!" },
      { style: "medal", headline: "AA PROC", big: "Divine Intervention", sub: "saved you from death", glyph: "✦" },
    ];
    let i = 0;
    fire({ ...demos[0], id: nextId.current++ });
    const iv = window.setInterval(() => {
      i = (i + 1) % demos.length;
      fire({ ...demos[i], id: nextId.current++ });
    }, 3000);
    return () => window.clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const p = shown?.payload;
  const leaving = shown?.leaving ?? false;
  const accent = p?.color
    ? ({ "--impact-accent": p.color } as React.CSSProperties)
    : undefined;
  const style = p?.style ?? "badge";

  return (
    <div
      className={`ov-shell${unlocked ? " unlocked" : ""}${
        unlocked && !enabled ? " ov-disabled" : ""
      }`}
    >
      {unlocked && <OverlayEditChrome label={OVERLAY_IMPACT} name="Impact overlay" />}

      {p && (
        <div
          key={p.id}
          className={`ov-impact impact-${style}${leaving ? " leaving" : ""}`}
          style={accent}
          data-tauri-drag-region
        >
          {p.headline && <div className="ovi-headline">{p.headline}</div>}

          {style === "slash" && p.big != null && (
            <div className="ovf-strike">
              <span className="ovf-num whole">{p.big}</span>
              <span className="ovf-num top" aria-hidden="true">{p.big}</span>
              <span className="ovf-num bottom" aria-hidden="true">{p.big}</span>
              <span className="ovf-blade" aria-hidden="true" />
            </div>
          )}

          {(style === "big-number" || style === "level") && p.big != null && (
            <div className="ovi-big">{p.big}</div>
          )}

          {(style === "badge" || style === "medal") && (
            <>
              <Medal glyph={p.glyph ?? "✦"} />
              {p.big && <div className="ovi-name">{p.big}</div>}
            </>
          )}

          {/* Fallback for any unknown style: at least show the focal text. */}
          {style !== "slash" &&
            style !== "big-number" &&
            style !== "level" &&
            style !== "badge" &&
            style !== "medal" &&
            p.big && <div className="ovi-big">{p.big}</div>}

          {p.sub && <div className="ovi-sub">{p.sub}</div>}
        </div>
      )}

      {IS_MOCK && (
        <button className="ov-mock-toggle" onClick={() => setUnlocked((u) => !u)}>
          {unlocked ? "lock" : "unlock"}
        </button>
      )}
    </div>
  );
}
