import { useEffect, useState } from "react";
import { useTauriEvent, useOverlayEnabled } from "../hooks";
import { IS_MOCK } from "../mock";
import OverlayEditChrome from "./OverlayEditChrome";
import { OVERLAY_SCOREBOARD, type OverlayLockPayload } from "../types";
import { loadOverlayArrange, OVERLAY_ARRANGE_KEY } from "../overlayState";
import {
  dpsOf,
  loadScoreboard,
  scoreRows,
  SCOREBOARD_EVENT,
  SCOREBOARD_KEY,
  type Scoreboard,
} from "../lib/scoreboard";

// Arrange is transient — always boot LOCKED; the persisted flag only drives
// runtime cross-window sync, not initial state (a restart mid-arrange must not
// leave drag chrome over the game).
const initiallyUnlocked =
  new URLSearchParams(window.location.search).get("unlocked") === "1";

const MOCK_BOARD: Scoreboard = IS_MOCK
  ? {
      you: { name: "You", killingBlows: 42, finishingBlows: 11, highestHit: 1204, highestHitLabel: "reave → a ranger", totalDamage: 84210, deaths: 1, curStreak: 8, bestStreak: 14, firstTs: 0, lastTs: 900 },
      sliq: { name: "Sliq", killingBlows: 38, finishingBlows: 19, highestHit: 940, highestHitLabel: "Blast of Frost", totalDamage: 79110, deaths: 0, curStreak: 12, bestStreak: 12, firstTs: 0, lastTs: 900 },
      thaggar: { name: "Thaggar", killingBlows: 27, finishingBlows: 6, highestHit: 705, highestHitLabel: "slash", totalDamage: 41880, deaths: 2, curStreak: 0, bestStreak: 9, firstTs: 0, lastTs: 900 },
    }
  : {};

function fmtCompact(n: number): string {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** Scoreboard overlay: the party competition. A compact per-player leaderboard
 *  — killing blows, finishing blows, biggest hit, DPS — sorted by killing
 *  blows, you highlighted. Fed from localStorage (FightsTab writes it); the
 *  storage event syncs across windows. Beating an all-time record fires a
 *  trophy on the Impact overlay. */
export default function OverlayScoreboard() {
  const [board, setBoard] = useState<Scoreboard>(() =>
    IS_MOCK ? MOCK_BOARD : loadScoreboard(),
  );
  const [unlocked, setUnlocked] = useState(initiallyUnlocked);
  const enabled = useOverlayEnabled(OVERLAY_SCOREBOARD);

  useTauriEvent<OverlayLockPayload>("overlay-lock-changed", (p) => {
    if (p.label === OVERLAY_SCOREBOARD) setUnlocked(!p.clickThrough);
  });

  useEffect(() => {
    if (IS_MOCK) return;
    const refresh = () => setBoard(loadScoreboard());
    const onStorage = (e: StorageEvent) => {
      if (e.key === SCOREBOARD_KEY) refresh();
      if (e.key === OVERLAY_ARRANGE_KEY) setUnlocked(loadOverlayArrange());
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(SCOREBOARD_EVENT, refresh);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(SCOREBOARD_EVENT, refresh);
    };
  }, []);

  const rows = scoreRows(board);

  return (
    <div
      className={`ov-shell${unlocked ? " unlocked" : ""}${
        unlocked && !enabled ? " ov-disabled" : ""
      }`}
    >
      {unlocked && (
        <OverlayEditChrome label={OVERLAY_SCOREBOARD} name="Scoreboard overlay" />
      )}
      <div className="ov-score pill" data-tauri-drag-region>
        <div className="ovs-head">
          <span className="ovs-title">Scoreboard</span>
        </div>
        {rows.length === 0 ? (
          <div className="ovs-empty">No kills yet</div>
        ) : (
          <table className="ovs-table">
            <thead>
              <tr>
                <th className="ovs-name">Player</th>
                <th title="Killing blows">KB</th>
                <th title="Finishing Blows (AA)">FB</th>
                <th title="Biggest hit">Hit</th>
                <th title="Damage per second (engagement span)">DPS</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name} className={r.name === "You" ? "ovs-you" : ""}>
                  <td className="ovs-name">{r.name}</td>
                  <td className="num">{r.killingBlows}</td>
                  <td className="num">{r.finishingBlows}</td>
                  <td className="num" title={r.highestHitLabel}>
                    {r.highestHit ? r.highestHit.toLocaleString() : "—"}
                  </td>
                  <td className="num">{fmtCompact(dpsOf(r))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {IS_MOCK && (
        <button className="ov-mock-toggle" onClick={() => setUnlocked((u) => !u)}>
          {unlocked ? "lock" : "unlock"}
        </button>
      )}
    </div>
  );
}
