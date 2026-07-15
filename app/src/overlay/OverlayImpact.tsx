import { useEffect, useRef, useState } from "react";
import {
  getCurrentWindow,
  LogicalPosition,
  LogicalSize,
} from "@tauri-apps/api/window";
import { useTauriEvent } from "../hooks";
import { IS_MOCK } from "../mock";
import { impactOverlayView } from "../lib/overlayRegistry";
import { impactDefaultSize } from "../lib/impactSizing";
import {
  OVERLAY_IMPACT,
  type ImpactEvent,
  type ImpactPayload,
  type TriggerOverlayPayload,
} from "../types";
import { ImpactPresentation } from "./ImpactPresentation";
import OverlayShell from "./OverlayShell";

// How long an impact lingers before it fades out.
const IMPACT_TTL_MS = 2600;
const IMPACT_FADE_MS = 450;
const IMPACT_SCALE_VERSION_KEY = "eqlogs.overlay.impactScaleVersion";
const IMPACT_SCALE_VERSION = "2";

interface Shown {
  payload: ImpactPayload;
  leaving: boolean;
}

/** Impact overlay: the channel for big dramatic moments. It is entirely
 *  TRIGGER-DRIVEN — the backend emits an `impact` event whenever a trigger's
 *  Impact action fires, carrying a `style` (slash / big-number / level /
 *  badge / medal / loot-chest / monster-rip) plus template-expanded text. Nothing about a
 *  specific moment is hardcoded here; its trigger decides the look. */
export default function OverlayImpact() {
  const [shown, setShown] = useState<Shown | null>(null);
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

  // Window-state persistence keeps the old 380x210 geometry forever unless
  // we migrate it. Resize only that legacy footprint once; a player who later
  // chooses a smaller custom size is never overridden.
  useEffect(() => {
    if (IS_MOCK) return;
    try {
      if (localStorage.getItem(IMPACT_SCALE_VERSION_KEY) === IMPACT_SCALE_VERSION) {
        return;
      }
    } catch {
      return;
    }
    const migrate = async () => {
      const appWindow = getCurrentWindow();
      const [physicalSize, physicalPosition] = await Promise.all([
        appWindow.outerSize(),
        appWindow.outerPosition(),
      ]);
      const scale = window.devicePixelRatio || 1;
      const width = physicalSize.width / scale;
      const height = physicalSize.height / scale;
      if (width <= 500 && height <= 300) {
        const target = impactDefaultSize(
          window.screen.availWidth,
          window.screen.availHeight,
        );
        const left = physicalPosition.x / scale;
        const top = physicalPosition.y / scale;
        const centerX = left + width / 2;
        const centerY = top + height / 2;
        const screen = window.screen as Screen & {
          availLeft?: number;
          availTop?: number;
        };
        const minX = screen.availLeft ?? 0;
        const minY = screen.availTop ?? 0;
        const maxX = minX + window.screen.availWidth - target.width;
        const maxY = minY + window.screen.availHeight - target.height;
        await appWindow.setSize(new LogicalSize(target.width, target.height));
        await appWindow.setPosition(
          new LogicalPosition(
            Math.max(minX, Math.min(maxX, centerX - target.width / 2)),
            Math.max(minY, Math.min(maxY, centerY - target.height / 2)),
          ),
        );
      }
      try {
        localStorage.setItem(IMPACT_SCALE_VERSION_KEY, IMPACT_SCALE_VERSION);
      } catch {
        // The static Tauri default still covers new installs.
      }
    };
    void migrate().catch(() => {});
  }, []);

  // Mock: cycle one of each style so all render in browser dev.
  useEffect(() => {
    if (!IS_MOCK) return;
    const demos: ImpactEvent[] = [
      { style: "slash", headline: "FINISHING BLOW", big: "1,204", sub: "You → Baron Telyx V`Zher" },
      { style: "big-number", headline: "CRITICAL", big: "947", sub: "Blast of Frost → a Teir`Dal ranger", color: "#ffb454" },
      { style: "level", headline: "LEVEL UP", big: "32", sub: "Ding!" },
      { style: "badge", headline: "ACHIEVEMENT", big: "Dragon Slayer", sub: "Veeshan's Peak", glyph: "★" },
      { style: "medal", headline: "AA PROC", big: "Divine Intervention", sub: "saved you from death", glyph: "✦" },
      {
        style: "loot-chest",
        headline: "YOU LOOTED",
        big: "Large Sky Sapphire",
        sub: "1/2 for Test of Wind",
      },
      {
        style: "monster-rip",
        headline: "RIP",
        big: "Splitpaw assassin",
        sub: "3 remaining for Hollow Skull Quest",
      },
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
  return (
    <OverlayShell
      label={OVERLAY_IMPACT}
      name="Impact overlay"
      className="impact-shell"
    >
      {p && (
        <ImpactPresentation
          key={p.id}
          payload={p}
          leaving={leaving}
        />
      )}
    </OverlayShell>
  );
}
