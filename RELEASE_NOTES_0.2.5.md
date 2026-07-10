# Legends Companion 0.2.5

Session insights, global search, and an alert-discipline pass — plus a batch
of parser and regression fixes from a full code/UX review.

## New

- **Insights tab (was Coach).** Session-oriented report: what you killed, what
  did your damage, camp/difficulty efficiency, pet contribution, and previous
  sessions summarized by time, zone, XP, kills, deaths, and top mob.
- **Global search.** One search across logs, mobs, drops, spells, abilities,
  recipes, triggers, and characters. Hailing an NPC in game looks them up
  automatically.
- **Diagnostics tab.** Parser health, active-log confidence, recent
  unrecognized lines, and effect-alert debugging — with copy/trigger-creation
  actions on unrecognized lines.
- **Patch notes in the app.** This list, rendered in its own tab.
- **Global silence hotkey.** `Ctrl+Alt+S` cuts speech and drops queued alerts
  even while the game has focus. The in-app Esc-Esc still works too.
- **Master audio mute.** Settings > General switch that keeps all alert
  speech/sounds off until you flip it back (previews still play).
- **Session recap copy.** One click in Insights copies a postable summary —
  duration, zones, XP and rate, kills/deaths, top mob, best camp pace.
- **Intent-first trigger creation.** A simpler `+ Trigger` starter flow for
  alerts, TTS, timers, and sounds, plus library filters and toolbar rework.

## Improvements & fixes

- **Mob-name parsing.** Mobs whose names end in eagle/tiger/dragon are no
  longer split into a wrong attacker plus a monk-skill verb; fight history and
  damage-taken attribution stay correct.
- **Skill accuracy.** Misses of multi-word skills (Eagle Strike, Round Kick)
  now land on the same meter row as the hits, so Acc% is real again.
- **Alert fatigue.** Ordinary pet swings (`claws`, `strikes`) no longer fire
  per-hit skill alerts; deliberate skills still do. Warn/alarm alert pills now
  scale with your alert-size setting and linger longer (8s alarm vs 4s info),
  and a spam burst can no longer push an alarm off the overlay.
- **Catch-up replay.** Restarting a session no longer pops global search from
  old Hail lines or double-counts replayed XP/kills/deaths into Insights.
- **Zone following.** Timers loads the current zone's rares on zoning again
  regardless of the `Auto zone change` toggle, and manually picking a zone in
  Drops/Mobs sticks instead of snapping back to the live zone.
- **Level progress.** The XP overlay's level bar and the Fights tab's
  `To level` kills/time estimate work again and survive restarts once a ding
  anchors them.
- **Pet memory.** The name learned from the pet leader command is saved to the
  character, so pet damage attribution stops resetting every session.
- **Old fight records.** Fight detail views split pet damage rows again for
  fights stored before the pet-damage field existed.
