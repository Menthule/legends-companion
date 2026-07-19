import { useEffect, useState } from "react";
import { getActiveConditions } from "../api";
import { useTauriEvent } from "../hooks";
import { IS_MOCK } from "../mock";
import {
  OVERLAY_CONDITIONS,
  type ActiveConditionSnapshot,
  type CatchUpPayload,
  type TriggerOverlayPayload,
} from "../types";
import OverlayShell from "./OverlayShell";
import SpellGemIcon, {
  spellIconId,
  spellIconName,
} from "../components/SpellGemIcon";

const HARD_CC = new Set(["stun", "spin", "root", "mez", "charm", "fear"]);

function ordered(values: ActiveConditionSnapshot[]): ActiveConditionSnapshot[] {
  return [...values].sort(
    (a, b) => b.priority - a.priority || a.label.localeCompare(b.label),
  );
}

export default function OverlayConditions() {
  const [conditions, setConditions] = useState<ActiveConditionSnapshot[]>([]);

  useEffect(() => {
    let live = true;
    if (IS_MOCK) {
      setConditions([
        { key: "stun", label: "Stunned", icon: "spell:25", priority: 100 },
        { key: "snare", label: "Snared", icon: "spell:5", priority: 55 },
      ]);
      return () => {
        live = false;
      };
    }
    getActiveConditions().then((values) => live && setConditions(ordered(values)));
    return () => {
      live = false;
    };
  }, []);

  useTauriEvent<ActiveConditionSnapshot[]>("conditions-changed", (values) =>
    setConditions(ordered(values)),
  );
  // Settings previews and browser mock actions bypass the backend state
  // reducer, so interpret the same destination contract locally.
  useTauriEvent<TriggerOverlayPayload>("trigger-overlay", (payload) => {
    if (payload.overlay !== "conditions") return;
    const key = payload.fields.key?.trim();
    if (!key) return;
    const active = !["false", "0", "off"].includes(
      (payload.fields.active ?? "true").trim().toLowerCase(),
    );
    setConditions((current) => {
      const without = current.filter((condition) => condition.key !== key);
      if (!active) return ordered(without);
      return ordered([
        ...without,
        {
          key,
          label: payload.fields.label?.trim() || key,
          icon: payload.fields.icon || payload.trigger?.icon,
          priority:
            typeof payload.config?.priority === "number" ? payload.config.priority : 0,
        },
      ]);
    });
  });
  useTauriEvent<CatchUpPayload>("catch-up", (payload) => {
    if (!payload.active) {
      void getActiveConditions().then((values) => setConditions(ordered(values)));
    }
  });
  useTauriEvent<{ tailing: boolean }>("tailing-changed", (payload) => {
    if (!payload.tailing) setConditions([]);
  });

  return (
    <OverlayShell
      label={OVERLAY_CONDITIONS}
      name="Conditions overlay"
      className="conditions-shell"
    >
      <div className="ov-condition-strip" aria-label="Active character conditions">
        {conditions.map((condition) => (
          <div
            key={condition.key}
            className={`condition-chip ${
              HARD_CC.has(condition.key) ? "condition-hard" : "condition-soft"
            }`}
            title={`${condition.label} · detected from the combat log`}
          >
            {condition.icon &&
            (spellIconId(condition.icon) != null || spellIconName(condition.icon) != null) ? (
              <SpellGemIcon icon={condition.icon} size={30} label={condition.label} />
            ) : (
              <span className="condition-glyph" aria-hidden="true">
                {condition.label.slice(0, 1).toUpperCase()}
              </span>
            )}
            <span>{condition.label}</span>
          </div>
        ))}
      </div>
    </OverlayShell>
  );
}
