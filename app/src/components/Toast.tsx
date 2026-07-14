// Shared toast: one transient status message at a time, rendered as the
// app-wide `.toast` pill. Replaces the per-tab toast state + timeout copies
// that had drifted to three different durations.

import { useCallback, useEffect, useState, type ReactNode } from "react";

/** Auto-dismiss for a plain status message. */
const PLAIN_MS = 2600;
/** Longer window when an Undo action is attached. */
const UNDO_MS = 6000;

export interface ToastOptions {
  /** Renders an Undo button (`.toast-undo`); clicking it runs the callback
   *  and dismisses the toast. Extends the auto-dismiss to 6s. */
  undo?: () => void;
}

/**
 * `const [toastNode, showToast] = useToast()` — render `toastNode` once near
 * the end of the tab; call `showToast(message, { undo })` from anywhere. A
 * new message replaces the current one and restarts the timer.
 */
export function useToast(): [
  ReactNode,
  (message: string, opts?: ToastOptions) => void,
] {
  const [toast, setToast] = useState<{
    message: string;
    undo?: () => void;
  } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const h = window.setTimeout(
      () => setToast(null),
      toast.undo ? UNDO_MS : PLAIN_MS,
    );
    return () => window.clearTimeout(h);
  }, [toast]);

  const showToast = useCallback((message: string, opts?: ToastOptions) => {
    setToast({ message, undo: opts?.undo });
  }, []);

  const toastNode: ReactNode = toast ? (
    <div className={`toast${toast.undo ? " toast-undo" : ""}`} role="status">
      {toast.message}
      {toast.undo && (
        <button
          className="ghost small"
          onClick={() => {
            toast.undo?.();
            setToast(null);
          }}
        >
          Undo
        </button>
      )}
    </div>
  ) : null;

  return [toastNode, showToast];
}
