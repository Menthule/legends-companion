import { useEffect, useState } from "react";
import { getConfig } from "../api";
import {
  fmtDuration,
  fmtNum,
  useSeriesSlots,
  useTauriEvent,
} from "../hooks";
import { IS_MOCK } from "../mock";
import {
  METER_SOURCES_KEY,
  loadMeterSources,
} from "../overlayState";
import {
  OVERLAY_METER,
  type FightUpdatePayload,
  type OverlayLockPayload,
} from "../types";

const TOP_N = 5;
/** "My sources" micro-rows shown under the player's bar (item 15). */
const MY_SOURCES_N = 4;

const initiallyUnlocked =
  new URLSearchParams(window.location.search).get("unlocked") === "1";
/** Mock screenshots: ?sources=1 forces the my-sources section on. */
const forceSources =
  IS_MOCK && new URLSearchParams(window.location.search).get("sources") === "1";

export default function OverlayMeter() {
  const [fight, setFight] = useState<FightUpdatePayload | null>(null);
  const [unlocked, setUnlocked] = useState(initiallyUnlocked);
  const [character, setCharacter] = useState("");
  const [sourcesOn, setSourcesOn] = useState(
    () => forceSources || loadMeterSources(),
  );

  useTauriEvent<FightUpdatePayload>("fight-update", setFight);
  useTauriEvent<OverlayLockPayload>("overlay-lock-changed", (p) => {
    if (p.label === OVERLAY_METER) setUnlocked(!p.clickThrough);
  });

  useEffect(() => {
    getConfig()
      .then((c) => setCharacter(c.characterName))
      .catch(() => setCharacter(""));
    // The locked overlay is click-through, so its toggle lives in Settings
    // (another window); the storage event carries the change across.
    const onStorage = (e: StorageEvent) => {
      if (e.key === METER_SOURCES_KEY) {
        setSourcesOn(forceSources || loadMeterSources());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const rows = (fight?.rows ?? []).slice(0, TOP_N);
  const slotOf = useSeriesSlots(rows.map((r) => r.name));
  const maxTotal = rows.reduce((m, r) => Math.max(m, r.total), 0);
  const isYou = (name: string) =>
    character.length > 0 && name.toLowerCase() === character.toLowerCase();

  return (
    <div className={`ov-shell${unlocked ? " unlocked" : ""}`}>
      {unlocked && (
        <div className="ov-drag-tag" data-tauri-drag-region>
          Meter overlay — drag to arrange, then lock
        </div>
      )}
      <div className="om pill">
        <div className="om-title" data-tauri-drag-region>
          <span>{fight ? fight.target : "Damage"}</span>
          <span className="num">
            {fight ? fmtDuration(fight.durationSecs) : "—"}
          </span>
        </div>
        {rows.map((r) => {
          const slot = slotOf(r.name);
          const mySources =
            sourcesOn && isYou(r.name)
              ? (r.sources ?? []).slice(0, MY_SOURCES_N)
              : [];
          return (
            <div className="om-group" key={r.name}>
              <div className="om-row">
                <div
                  className="om-fill"
                  style={{
                    width: `${maxTotal > 0 ? (r.total / maxTotal) * 100 : 0}%`,
                    background: `var(--series-${slot + 1})`,
                  }}
                />
                <div className="om-text">
                  <span className="om-name">
                    {r.name}
                    {r.pet && <span className="om-pet">+pet</span>}
                  </span>
                  <span className="om-vals">
                    {fmtNum(r.dps)} · {r.pct.toFixed(0)}%
                  </span>
                </div>
              </div>
              {/* Only the player's bar expands on the overlay; everyone
                  else stays single-row (full breakdown on the dashboard). */}
              {mySources.map((s) => (
                <div className="om-sub-row" key={s.name}>
                  <div
                    className="om-sub-fill"
                    style={{
                      width: `${maxTotal > 0 ? (s.total / maxTotal) * 100 : 0}%`,
                      background: `var(--series-${slot + 1})`,
                    }}
                  />
                  <div className="om-sub-text">
                    <span className="om-sub-name">{s.name}</span>
                    <span className="om-sub-val">{fmtNum(s.total)}</span>
                  </div>
                </div>
              ))}
            </div>
          );
        })}
        {rows.length === 0 && (
          <div className="om-empty">Waiting for combat</div>
        )}
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
