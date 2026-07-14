import { fmtTimerLeft, type TimerView } from "../hooks";
import { IconWarn } from "./Icons";
import SpellGemIcon from "./SpellGemIcon";

function TimerText({ t }: { t: TimerView }) {
  return (
    <>
      <span className="timer-name">
        <SpellGemIcon icon={t.icon} size={18} label={`${t.name} spell icon`} />
        {t.warn && (
          <span className="timer-warn-mark">
            <IconWarn />
          </span>
        )}
        {t.name}
      </span>
      {/* Pending (item 12): the cast is in flight — no countdown numerals. */}
      <span className="timer-left">
        {t.pending ? "casting…" : fmtTimerLeft(t.left)}
      </span>
    </>
  );
}

/**
 * Countdown timer bars (DESIGN.md): 18px bars whose width shrinks, label
 * left, remaining right in tabular-nums. Accent fill normally; warning color
 * plus a warn glyph past the threshold; pulse + fade on expiry.
 *
 * Warn rows (dashboard variant) render the label twice: once in `--ink` over
 * the track, and a dark-ink copy clipped to the amber fill, so the ⚠ glyph
 * and label stay readable on both sides of the shrinking fill edge. The
 * overlay variant keeps its single white-on-pill treatment.
 *
 * Pending rows ("casting…", item 12) render dimmed with a slow pulse and no
 * countdown numerals until the backend's "landed" event flips them live.
 * The pulse is a CSS animation, so `prefers-reduced-motion` disables it.
 */
export default function TimerBars({
  timers,
  overlay = false,
}: {
  timers: TimerView[];
  overlay?: boolean;
}) {
  return (
    <div className={`timer-list${overlay ? " overlay" : ""}`}>
      {timers.map((t) => (
        <div
          key={t.name}
          className={`timer-row${t.warn ? " warn" : ""}${t.expired ? " expired" : ""}${t.pending ? " pending" : ""}`}
        >
          <div
            className="timer-fill"
            style={{ width: `${Math.min(100, t.frac * 100)}%` }}
          >
            {t.warn && !overlay && (
              <div className="timer-text timer-text-clip" aria-hidden="true">
                <TimerText t={t} />
              </div>
            )}
          </div>
          <div className="timer-text">
            <TimerText t={t} />
          </div>
        </div>
      ))}
    </div>
  );
}
