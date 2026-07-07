# Legends Companion 0.2.3

A big feature-and-polish release.

## New

- **Casting outcomes (Meters → Casts).** A new sub-tab in Meters shows a
  per-caster, per-spell breakdown of your session: attempts, fizzle %, resist %,
  and an inferred land rate, with a "My casts only" filter and low-land
  highlighting. Great for spotting a spell you're getting resisted on or a
  low-level character fizzling.
- **Level-up digest.** When you ding, a card shows the spells and abilities that
  unlock at your new level, with a jump straight to the Spells tab.
- **XP session + level ETA.** The XP overlay tracks a rolling session and
  estimates kills-to-level and time-to-level from your recent rate.
- **Import a log for review.** Point the Fights tab at any log file to replay it
  and review past fights after the fact — no live session required.
- **Timer pre-warnings.** Set a bell to fire N seconds before a timer pops
  (30/60s), so you get a heads-up before a recast or respawn window.
- **Overlay arranging aid.** While unlocked and empty, the timer overlays now
  show dimmed sample bars, so you can size and position them against real
  content instead of a blank box.
- **Trigger editor batch-test.** Paste sample log lines and see which ones your
  pattern matches, live, while editing.

## Improvements & fixes

- **Buff stacking conflicts.** The game's own "did not take hold (Blocked by …)"
  verdicts are captured and surfaced as conflict chips on the Spells tab.
- **Death recap** now includes a summary of the damage that killed you.
- **Fight history retention.** Old fights are pruned automatically (configurable)
  and can be cleared manually.
- **Faster startup.** Database tabs now load on first visit instead of all at
  once at launch.
- **Stance overlay** no longer sticks on "changing…" after a death or zone.
- **Respawn timers** over an hour show the correct seconds.
- **Sounds & data updates.** Bundled sounds are no longer shadowed by a file in
  the launch directory, and the ~17MB data-pack backup is cleaned up after a
  successful update.
- **Trigger loading** skips symlinked directories (no more infinite loops) and
  ignores GINA sound actions with an empty file.
- **Spell stuns** stay overlay-only by default — speaking them would roughly
  double the spoken-alert rate.

## For tinkerers

- New CLI: `eqlog casts <log> [--char NAME] [--min N] [--mine]` prints the same
  caster resist/fizzle/land% report from the terminal.
