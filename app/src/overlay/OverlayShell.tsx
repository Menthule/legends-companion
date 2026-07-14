import type { ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useOverlayEnabled } from "../hooks";
import { IS_MOCK } from "../mock";
import OverlayEditChrome from "./OverlayEditChrome";
import useOverlayLock from "./useOverlayLock";

/** Shared window shell for every overlay. Owns the scaffold each overlay used
 *  to copy-paste: the unlocked/arrange state (useOverlayLock), the ov-shell
 *  className (arrange chrome + disabled dim), the OverlayEditChrome render,
 *  uniform body-drag while unlocked, and the browser-mock lock toggle.
 *  Children are the pill content only; pass a function child to render
 *  against the current unlocked state (arrange aids, fit effects). */
export default function OverlayShell({
  label,
  name,
  className,
  children,
}: {
  /** Tauri window label (OVERLAY_* constant). */
  label: string;
  /** Display name for the edit chrome, e.g. "Pace overlay". */
  name: string;
  /** Extra ov-shell classes (e.g. Impact's "impact-shell"). */
  className?: string;
  children: ReactNode | ((unlocked: boolean) => ReactNode);
}) {
  const [unlocked, setUnlocked] = useOverlayLock(label);
  const enabled = useOverlayEnabled(label);

  return (
    <div
      className={`ov-shell${className ? ` ${className}` : ""}${
        unlocked ? " unlocked" : ""
      }${unlocked && !enabled ? " ov-disabled" : ""}`}
      // Uniform body drag while unlocked, via imperative startDragging —
      // `data-tauri-drag-region` is unreliable in WebView2 (drags die on the
      // first move event) and only hits when the mousedown target carries the
      // attribute itself, so child-covered pill areas were spotty. Buttons
      // (enable toggle, resize grip, mock toggle) keep their own behavior.
      onMouseDown={(e) => {
        if (!unlocked) return;
        if ((e.target as HTMLElement).closest("button")) return;
        try {
          void getCurrentWindow().startDragging().catch(() => {});
        } catch {
          // Browser mock: no Tauri window to drag.
        }
      }}
    >
      {unlocked && <OverlayEditChrome label={label} name={name} />}
      {typeof children === "function" ? children(unlocked) : children}
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
