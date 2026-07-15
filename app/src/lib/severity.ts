// Alert severity fallback for legacy/imported actions that do not carry an
// explicit Alerts-overlay severity. New bundled alerts encode presentation in
// their action config; this policy keeps older triggers predictable.
//
// The id embeds the trigger's category slug, e.g.
//   "universal/survival/you-died"
//   "class/enchanter/cc/..."     (crowd control)
// so classification is primarily a stable-id/category test, with a narrow
// name fallback for imported triggers.

export type Severity = "info" | "warn" | "alarm";

/** Explicit survival states and failed escape mechanics that demand action. */
const ALARM_ID_FRAGMENTS = [
  "universal/survival/summoned",
  "universal/survival/enraged",
  "universal/survival/invis-dropping",
  "universal/survival/you-died",
  "universal/survival/slain-by",
  "class/monk/fd/",
  "class/necromancer/fd/",
];

/** Imported failed-Feign alerts may not have a stable curated id. */
const ALARM_NAME = /(?:feign death|\bfd\b).*(?:fail|broke|broken|ended|over)/i;

/** Crowd-control application, break, and expiry are always the warn tier. */
const WARN_ID_FRAGMENTS = [
  "/cc/",
  "crowd-control",
  "universal/survival/stunned",
  "enemy-casts/fear",
  "enemy-casts/charm",
  "enemy-casts/mesmerize",
  "enemy-casts/root-snare",
  "enemy-casts/stun",
];

/** Semantic fallback for GINA/shared triggers without curated ids. */
const WARN_NAME = /\b(?:mez|mezzed|mesmeriz(?:e|ed|ation)|charm(?:ed)?|root(?:ed)?|snar(?:e|ed)|stun(?:ned)?|fear(?:ed)?|slow(?:ed)?|walking sleep)\b/i;

/**
 * Classify a fired trigger. `id`/`name` may be null when the engine doesn't
 * know the trigger's identity; unknown alerts fall through to "info".
 */
export function classifySeverity(
  id: string | null | undefined,
  name: string | null | undefined,
): Severity {
  const i = (id ?? "").toLowerCase();
  const n = name ?? "";

  // CC wins over generic danger wording: a charm/mez/root event should have
  // one consistent visual tier whether it lands, breaks, or wears off.
  if (WARN_ID_FRAGMENTS.some((f) => i.includes(f)) || WARN_NAME.test(n)) {
    return "warn";
  }
  if (ALARM_ID_FRAGMENTS.some((f) => i.includes(f)) || ALARM_NAME.test(n)) {
    return "alarm";
  }
  return "info";
}
