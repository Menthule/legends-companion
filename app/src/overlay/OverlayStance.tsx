// Stance & invocation overlay: a compact always-on card showing the
// character's current martial stance and invocation, tracked from log
// lines (see lib/stanceState.ts for the verified line shapes and the
// "unknown until first change" limitation).

import { useState } from "react";
import { useTauriEvent } from "../hooks";
import { IS_MOCK } from "../mock";
import {
  applyStanceLine,
  EMPTY_STANCE_STATE,
  type StanceState,
} from "../lib/stanceState";
import { OVERLAY_STANCE, type LogLinePayload, type OverlayLockPayload } from "../types";

const initiallyUnlocked =
  new URLSearchParams(window.location.search).get("unlocked") === "1";

function Value({
  name,
  changing,
}: {
  name: string | null;
  changing: boolean;
}) {
  if (changing) return <span className="ov-stance-val changing">changing…</span>;
  if (!name) {
    return (
      <span
        className="ov-stance-val unknown"
        title="Known after your next change — the log only records changes."
      >
        —
      </span>
    );
  }
  return <span className="ov-stance-val">{name}</span>;
}

export default function OverlayStance() {
  const [unlocked, setUnlocked] = useState(initiallyUnlocked);
  const [state, setState] = useState<StanceState>(EMPTY_STANCE_STATE);

  useTauriEvent<LogLinePayload>("log-line", (p) => {
    setState((s) => applyStanceLine(s, p.message) ?? s);
  });

  useTauriEvent<OverlayLockPayload>("overlay-lock-changed", (p) => {
    if (p.label === OVERLAY_STANCE) setUnlocked(!p.clickThrough);
  });

  return (
    <div className={`ov-shell${unlocked ? " unlocked" : ""}`}>
      {unlocked && (
        <div className="ov-drag-tag" data-tauri-drag-region>
          Stance overlay — drag to arrange, then lock
        </div>
      )}
      <div className="ov-stance">
        <div className="ov-stance-row">
          <span className="ov-stance-label">Stance</span>
          <Value name={state.stance} changing={state.stanceChanging} />
        </div>
        <div className="ov-stance-row">
          <span className="ov-stance-label">Invocation</span>
          <Value name={state.invocation} changing={state.invocationChanging} />
        </div>
      </div>
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
