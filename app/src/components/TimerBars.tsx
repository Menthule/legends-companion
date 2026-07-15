import { fmtTimerLeft, type TimerView } from "../hooks";
import { IconTimers, IconWarn } from "./Icons";
import SpellGemIcon, { spellIconId } from "./SpellGemIcon";

export type TimerIconKind = "spell" | "glyph" | "fallback";

export function timerIconKind(icon: string | null | undefined): TimerIconKind {
  const configured = icon?.trim() ?? "";
  if (!configured) return "fallback";
  return spellIconId(configured) != null ? "spell" : "glyph";
}

function TimerIcon({ t, overlay }: { t: TimerView; overlay: boolean }) {
  const configured = t.icon?.trim() ?? "";
  const kind = timerIconKind(configured);
  return (
    <span
      className={`timer-icon-slot${configured ? " configured" : " fallback"}`}
      title={configured ? `${t.name} icon` : undefined}
    >
      {kind === "spell" ? (
        <SpellGemIcon icon={configured} size={overlay ? 20 : 16} />
      ) : kind === "glyph" ? (
        <span className="timer-icon-glyph" aria-hidden="true">
          {configured}
        </span>
      ) : (
        <span className="timer-icon-fallback" aria-hidden="true">
          <IconTimers size={overlay ? 14 : 12} />
        </span>
      )}
    </span>
  );
}

function TimerText({ t }: { t: TimerView }) {
  return (
    <>
      <span className="timer-name">
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
          className={`timer-entry${t.warn ? " warn" : ""}${t.expired ? " expired" : ""}${t.pending ? " pending" : ""}`}
        >
          <TimerIcon t={t} overlay={overlay} />
          <div
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
        </div>
      ))}
    </div>
  );
}
