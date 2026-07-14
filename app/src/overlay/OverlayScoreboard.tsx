import { useEffect, useState } from "react";
import { IS_MOCK } from "../mock";
import { OVERLAY_SCOREBOARD } from "../types";
import {
  dpsOf,
  loadScoreboard,
  scoreRows,
  subscribeScoreboard,
  type Scoreboard,
} from "../lib/scoreboard";
import OverlayShell from "./OverlayShell";
// Canonical compact number — the same abbreviation the meters use, so the
// scoreboard's DPS agrees with the meter overlay (a local copy here used
// to round differently: "12k" where the meters said "12.3k").
import { fmtNum } from "../lib/format";

const MOCK_BOARD: Scoreboard = IS_MOCK
  ? {
      you: { name: "You", killingBlows: 42, finishingBlows: 11, highestHit: 1204, highestHitLabel: "reave → a ranger", totalDamage: 84210, deaths: 1, curStreak: 8, bestStreak: 14, firstTs: 0, lastTs: 900 },
      sliq: { name: "Sliq", killingBlows: 38, finishingBlows: 19, highestHit: 940, highestHitLabel: "Blast of Frost", totalDamage: 79110, deaths: 0, curStreak: 12, bestStreak: 12, firstTs: 0, lastTs: 900 },
      thaggar: { name: "Thaggar", killingBlows: 27, finishingBlows: 6, highestHit: 705, highestHitLabel: "slash", totalDamage: 41880, deaths: 2, curStreak: 0, bestStreak: 9, firstTs: 0, lastTs: 900 },
    }
  : {};

/** Scoreboard overlay: the party competition. A compact per-player leaderboard
 *  — killing blows, finishing blows, biggest hit, DPS — sorted by killing
 *  blows, you highlighted. Fed from localStorage (FightsTab writes it); the
 *  storage event syncs across windows. Beating an all-time record fires a
 *  trophy on the Impact overlay. */
export default function OverlayScoreboard() {
  const [board, setBoard] = useState<Scoreboard>(() =>
    IS_MOCK ? MOCK_BOARD : loadScoreboard(),
  );

  useEffect(() => {
    if (IS_MOCK) return;
    return subscribeScoreboard(() => setBoard(loadScoreboard()));
  }, []);

  const rows = scoreRows(board);

  return (
    <OverlayShell label={OVERLAY_SCOREBOARD} name="Scoreboard overlay">
      <div className="ov-score pill">
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
                  <td className="num">{fmtNum(dpsOf(r))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </OverlayShell>
  );
}
