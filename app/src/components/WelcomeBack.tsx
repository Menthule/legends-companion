// Welcome-back briefing ("Where was I?"): a one-card orientation summary
// shown on app start when the character was last seen 12+ hours ago. Pure
// read-only stitching of existing stores (lib/welcomeBack.ts); every line
// deep-links to the tab that owns it. Dismissable per gap; a Settings toggle
// (General → Log & character) disables it entirely.

import { useEffect, useState } from "react";
import { openDrops, openMobs, openTimers } from "../lib/deepLinks";
import { fmtDuration } from "../lib/format";
import { getSessionLogSnapshot } from "../lib/sessionLog";
import { loadTimers } from "../lib/timers";
import { loadWishlist } from "../lib/wishlist";
import {
  buildWelcomeBackSummary,
  dismissWelcomeBack,
  fmtAway,
  latestSessionRow,
  loadWelcomeBackPrefs,
  onWelcomeBackPrefsChanged,
  shouldShowWelcomeBack,
  type WelcomeBackSummary,
} from "../lib/welcomeBack";
import { loadLevelAnchorKnown, loadLevelProgress } from "../overlayState";

/** Settle delay after mount / after catch-up ends, so replayed loot and the
 *  persisted stores are all in before the summary is computed. */
const SETTLE_MS = 1200;

function computeSummary(character: string): WelcomeBackSummary | null {
  const nowMs = Date.now();
  const row = latestSessionRow(character);
  if (!row) return null;
  const prefs = loadWelcomeBackPrefs();
  if (!shouldShowWelcomeBack(prefs, row.endedMs, nowMs)) return null;
  return buildWelcomeBackSummary({
    nowMs,
    row,
    timers: loadTimers(),
    loot: getSessionLogSnapshot().loot,
    wishlist: loadWishlist().map((e) => e.name),
    levelProgress: loadLevelAnchorKnown() ? loadLevelProgress() : null,
  });
}

export default function WelcomeBack({
  character,
  level,
  catchingUp,
  onOpenSession,
}: {
  character: string;
  /** Profile level for the "then" line; null/0 = unknown. */
  level: number | null;
  /** Replay in progress — wait for it to settle before summarizing. */
  catchingUp: boolean;
  /** The Session tab isn't a deep-link target; Dashboard switches directly. */
  onOpenSession: () => void;
}) {
  const [summary, setSummary] = useState<WelcomeBackSummary | null>(null);

  // Compute after things settle: on mount, when the character loads/changes,
  // and again when a catch-up replay finishes (that's when replayed wishlist
  // loot lands in the session log). Recomputing keeps the same qualifying
  // gap, so an already-visible card just gains lines.
  useEffect(() => {
    if (catchingUp) return;
    const h = window.setTimeout(() => setSummary(computeSummary(character)), SETTLE_MS);
    return () => window.clearTimeout(h);
  }, [catchingUp, character]);

  // Live-hide when the Settings toggle turns the feature off (and re-check
  // when it turns back on).
  useEffect(
    () =>
      onWelcomeBackPrefsChanged(() => {
        setSummary((prev) => {
          const prefs = loadWelcomeBackPrefs();
          if (!prev) return prefs.enabled ? computeSummary(character) : null;
          return shouldShowWelcomeBack(prefs, prev.lastEndedMs, Date.now())
            ? prev
            : null;
        });
      }),
    [character],
  );

  if (!summary) return null;

  const dismiss = () => {
    dismissWelcomeBack(summary.lastEndedMs);
    setSummary(null);
  };

  const thenBits: string[] = [];
  if (level && level > 0) {
    thenBits.push(
      summary.levelProgress !== null
        ? `level ${level} · ${Math.round(summary.levelProgress)}% in`
        : `level ${level}`,
    );
  } else if (summary.levelProgress !== null) {
    thenBits.push(`${Math.round(summary.levelProgress)}% into the level`);
  }
  if (summary.xpGained > 0) {
    thenBits.push(`+${summary.xpGained.toFixed(1)}% XP that session`);
  }

  const timerNames = summary.expiredTimers
    .slice(0, 3)
    .map((t) => t.label)
    .join(", ");
  const extraTimers = summary.expiredTimers.length - 3;
  const dropText = summary.wishlistDrops
    .slice(0, 3)
    .map((d) => (d.qty > 1 ? `${d.item} ×${d.qty}` : d.item))
    .join(", ");
  const extraDrops = summary.wishlistDrops.length - 3;

  return (
    <div className="card wb-card" role="status" aria-label="Welcome back briefing">
      <div className="wb-head">
        <span className="section-title">Where was I?</span>
        <span className="wb-away">
          Last played {fmtAway(summary.awayMs)}
          {summary.durationSecs > 0 && ` — ${fmtDuration(summary.durationSecs)} session`}
        </span>
        <span className="spacer" />
        <button className="ghost small" onClick={dismiss}>
          Dismiss
        </button>
      </div>
      <div className="wb-rows">
        <button className="wb-row" onClick={onOpenSession} title="Open the Session tab">
          <span className="wb-row-label">Then</span>
          <span className="wb-row-text">
            {summary.zone || "Unknown zone"}
            {thenBits.length > 0 && ` — ${thenBits.join(", ")}`}
          </span>
        </button>
        {summary.topMob && summary.kills > 0 && (
          <button
            className="wb-row"
            onClick={() => openMobs(summary.topMob)}
            title="Look this mob up in the Mobs database"
          >
            <span className="wb-row-label">Killing</span>
            <span className="wb-row-text">
              {summary.topMob} ×{summary.topMobKills}
              {summary.killsPerHour !== null &&
                ` — ${Math.round(summary.killsPerHour)} kills/hr overall`}
            </span>
          </button>
        )}
        {summary.expiredTimers.length > 0 && (
          <button className="wb-row" onClick={openTimers} title="Open the Timers tab">
            <span className="wb-row-label">Timers</span>
            <span className="wb-row-text">
              {summary.expiredTimers.length === 1
                ? "1 camp timer popped while you were away: "
                : `${summary.expiredTimers.length} camp timers popped while you were away: `}
              {timerNames}
              {extraTimers > 0 && ` and ${extraTimers} more`}
            </span>
          </button>
        )}
        {summary.wishlistDrops.length > 0 && (
          <button
            className="wb-row"
            onClick={() => openDrops(summary.wishlistDrops[0].item)}
            title="Look this item up in the Drops database"
          >
            <span className="wb-row-label">Drops</span>
            <span className="wb-row-text">
              Watched drops since you left: {dropText}
              {extraDrops > 0 && ` and ${extraDrops} more`}
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
