// Quick-create entry point (Live tab): a thin modal wrapper around the
// shared TriggerEditor, prefilled from the clicked log line.

import { useCallback, useEffect, useRef, useState } from "react";
import { appendTriggers, confirmDiscard, getTriggerTree } from "../api";
import type { Trigger } from "../types";
import Modal from "./Modal";
import TriggerEditor from "./TriggerEditor";

// Kept for test/import continuity — the pattern builder now lives in the
// template library (W16's canonical builder).
export { buildPattern } from "../lib/triggerTemplates";

interface Props {
  /** The raw log line the trigger is being created from. */
  message: string;
  onClose(): void;
  /** `location` is the tree path the trigger landed in ("Custom › …"). */
  onSaved(name: string, location: string): void;
}

/** "Saved to" path for a user trigger: Custom › <category segments>. */
export function savedLocation(category: string | null | undefined): string {
  const segs = (category ?? "")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  if (segs[0]?.toLowerCase() === "custom") segs.shift();
  return ["Custom", ...segs].join(" › ");
}

export default function QuickTriggerModal({ message, onClose, onSaved }: Props) {
  const dirty = useRef(false);
  const [existing, setExisting] = useState<
    { name: string; category: string | null; pattern: string }[]
  >([]);

  useEffect(() => {
    getTriggerTree()
      .then((entries) =>
        setExisting(
          entries
            .filter((e) => e.effectiveEnabled)
            .map((e) => ({ name: e.name, category: e.category, pattern: e.pattern })),
        ),
      )
      .catch(() => {});
  }, []);

  // Every discard path (Escape, scrim, Close, Cancel) checks for edits
  // first — a full modal of work must never vanish silently. Passed to
  // Modal AS onClose so the shared Escape/scrim paths honor the guard.
  const maybeClose = useCallback(async () => {
    if (
      dirty.current &&
      !(await confirmDiscard("Discard this trigger? Your edits will be lost."))
    ) {
      return;
    }
    onClose();
  }, [onClose]);

  async function onSave(trigger: Trigger, companion: Trigger | null) {
    // Atomic server-side append (P15): no client-side read-modify-write, so a
    // save can't clobber a concurrent import.
    await appendTriggers(companion ? [trigger, companion] : [trigger]);
    onSaved(trigger.name, savedLocation(trigger.category));
  }

  return (
    <Modal
      label="New trigger from live line"
      onClose={() => void maybeClose()}
      className="modal-wide"
    >
      <div className="card-head">
        <span className="section-title">New trigger from line</span>
        <button className="ghost small" onClick={() => void maybeClose()}>
          Close
        </button>
      </div>
      <TriggerEditor
        initial={null}
        initialLine={message}
        variant="modal"
        existing={existing}
        onDirtyChange={(d) => {
          dirty.current = d;
        }}
        onCancel={() => void maybeClose()}
        onSave={onSave}
      />
    </Modal>
  );
}
