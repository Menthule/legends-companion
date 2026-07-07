import { getCurrentWindow } from "@tauri-apps/api/window";

/** Bottom-right resize handle shown on an unlocked overlay. Every resizable
 *  overlay uses this so the affordance is identical across all of them. */
export default function ResizeGrip({ label }: { label: string }) {
  return (
    <button
      type="button"
      className="ov-resize-grip"
      onMouseDown={() =>
        getCurrentWindow().startResizeDragging("SouthEast").catch(() => {})
      }
      title={`Resize ${label}`}
      aria-label={`Resize ${label}`}
    />
  );
}
