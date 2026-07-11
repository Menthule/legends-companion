import { getCurrentWindow } from "@tauri-apps/api/window";
import { useOverlayEnabled } from "../hooks";
import { toggleOverlayEnabled } from "../overlayState";
import ResizeGrip from "./ResizeGrip";

/** Edit-mode chrome shown on every overlay while arranging: a drag bar with
 *  an inline enable/disable toggle, plus the resize grip. The toggle flips
 *  this overlay's shared visibility flag — disabled overlays stay visible
 *  (dimmed) while arranging so they can be toggled back on, and only actually
 *  hide when you lock (Settings → "Unlock to arrange" off applies it). */
export default function OverlayEditChrome({
  label,
  name,
}: {
  label: string;
  name: string;
}) {
  const enabled = useOverlayEnabled(label);
  return (
    <>
      <div
        className="ov-drag-tag"
        // Explicit startDragging on mousedown — `data-tauri-drag-region` is
        // unreliable in WebView2 (drags die on the first move event), while the
        // imperative call is rock-solid (it's what the resize grip uses). Skip
        // when the mousedown lands on the enable/disable button.
        onMouseDown={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          void getCurrentWindow().startDragging().catch(() => {});
        }}
      >
        <span className="ov-drag-name">{name} — drag</span>
        <button
          type="button"
          className={`ov-enable-toggle${enabled ? " on" : " off"}`}
          onClick={() => toggleOverlayEnabled(label)}
          title={
            enabled
              ? "Enabled — click to hide this overlay when locked"
              : "Hidden when locked — click to enable"
          }
        >
          {enabled ? "shown" : "hidden"}
        </button>
      </div>
      <ResizeGrip label={name} />
    </>
  );
}
