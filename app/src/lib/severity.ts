// Alert severity classification (APP_REVIEW X6): a Death Touch must not render
// like a tell. Maps a fired trigger's identity (id slug + display name) to one
// of three tiers so the overlay and live feed can weight it visually.
//
// The id embeds the trigger's category slug, e.g.
//   "enemy-casts/..."            (dangerous enemy cast)
//   "universal/survival/you-died"
//   "class/enchanter/cc/..."     (crowd control)
// so most classification is a slug substring test, with a name-regex fallback
// for danger casts whose id is generic.

export type Severity = "info" | "warn" | "alarm";

/** Slug fragments that mark a top-tier danger regardless of class. */
const ALARM_ID_FRAGMENTS = [
  "enemy-casts",
  "death",
  "summoned",
  "enraged",
  "you-died",
];

/** Names that read as lethal even when the id is generic/custom. */
const ALARM_NAME = /death|gate|complete heal|harm touch/i;

/** Slug fragments for "act soon, not lethal" alerts. */
const WARN_ID_FRAGMENTS = ["/cc/", "crowd-control", "defense", "wear-off"];

/** Names for wear-off warnings (re-mez / re-buff prompts). */
const WARN_NAME = /worn off/i;

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

  if (ALARM_ID_FRAGMENTS.some((f) => i.includes(f)) || ALARM_NAME.test(n)) {
    return "alarm";
  }
  if (WARN_ID_FRAGMENTS.some((f) => i.includes(f)) || WARN_NAME.test(n)) {
    return "warn";
  }
  return "info";
}
