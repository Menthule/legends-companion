# Legends Companion 0.2.2

Bugfix release.

- **Durations over an hour now format correctly.** A multi-hour span (XP
  "per level" ETA, long rare respawns, session length) rendered as a runaway
  minute count — e.g. a 16.5-hour per-level estimate showed as `988:09`. It
  now reads `16:28:09` (H:MM:SS). Anything under an hour is unchanged.
