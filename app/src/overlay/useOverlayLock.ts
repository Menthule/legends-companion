import {
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useTauriEvent } from "../hooks";
import { loadOverlayArrange, OVERLAY_ARRANGE_KEY } from "../overlayState";
import type { OverlayLockPayload } from "../types";

// Arrange is transient — overlays always boot LOCKED (click-through, no edit
// chrome) unless the window was opened mid-arrange (?unlocked=1). The
// persisted arrange flag only drives runtime cross-window sync below, never
// the initial state, so a restart while arranging doesn't leave drag chrome
// plastered over the game.
const initiallyUnlocked =
  new URLSearchParams(window.location.search).get("unlocked") === "1";

/** Unlocked/arrange state for one overlay window. Every overlay gets the same
 *  two channels: the per-window "overlay-lock-changed" Tauri event (the
 *  primary path) plus the OVERLAY_ARRANGE_KEY cross-window storage fallback,
 *  so an overlay whose webview was still loading when the one-shot lock event
 *  fired still enters/leaves arrange with the rest. `setUnlocked` is exposed
 *  for the browser-mock toggle only. */
export default function useOverlayLock(
  label: string,
): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [unlocked, setUnlocked] = useState(initiallyUnlocked);

  useTauriEvent<OverlayLockPayload>("overlay-lock-changed", (payload) => {
    if (payload.label === label) setUnlocked(!payload.clickThrough);
  });

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === OVERLAY_ARRANGE_KEY) setUnlocked(loadOverlayArrange());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return [unlocked, setUnlocked];
}
