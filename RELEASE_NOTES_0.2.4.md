# Legends Companion 0.2.4

Focused combat-alert and trigger quality release.

## New

- **Proc, skill, and spell effect alerts.** Weapon procs, skill hits, and spell
  damage now show in the alerts overlay with explicit prefixes such as
  `Proc: Lifedraw`, `Skill: Reave`, and `Spell: Reaving Strike`. Visual alerts
  are on by default; TTS is available but off by default.
- **Session effects card.** The Fights tab tracks recent procs, skills, and
  spell effects during the session, grouped with hit counts and damage.
- **Webhook trigger action support.** Trigger actions can now post a templated
  message to a named webhook configured locally, without storing endpoint URLs
  in shared trigger packs.
- **Zone-scoped trigger support.** Trigger profiles can scope triggers or whole
  trigger categories to specific zones.

## Improvements & fixes

- **Consistent alert wording.** Crowd-control alerts now render in a consistent
  `Effect: State` style, including root, stun, snare, slow, mez, and charm.
- **Charm clarity.** Being charmed (`Charm: On You`) is visually distinct from
  your charm ending on a target (`Charm: Off <target>`).
- **Rolling XP rate.** Session XP and time-per-level now use a recent
  ten-minute window instead of the whole retained session.
- **Generated spell ranks.** Generated trigger packs accept optional Roman
  numeral ranks on modern spell lines.
- **Debuff targeting.** Same-named mobs refresh the same visible debuff bar
  instead of creating duplicate mob groups for repeated DoTs.
- **Slow/debuff coverage.** Generated debuff timers include ranked spell text
  and improved apostrophe/backtick matching.
