# Legends Companion 0.2.1 — "Timers"

The camp-respawn feature grows into a first-class **Timers** surface, and the
parser learns to read the game's own rare/named marker so it stops missing
lowercase-article rares like "a ghoul sentinel".

## Timers (new sidebar tab)

- **Timers tab** — a dedicated home for every countdown: kill-detected rare
  respawns, one-tap placeholder tracking, and your own custom timers
  (get-off-at-X, egg timers, ability cooldowns). Replaces the old ad-hoc
  camp list.
- **Kill-detected rare respawns that self-correct** — when you kill a rare,
  its respawn timer starts automatically and re-syncs off the game's
  `- a rare creature -` consider tag rather than guessing from the name.
- **Unified overlay** — the respawn overlay is folded into the shared
  overlay system with the other lanes; edit chrome + a resize grip make
  every overlay window draggable and resizable in place.
- **All session state in localStorage** — nothing is written to the
  reference database, so data updates never wipe your timers.

## Parser

- **Rare/named detection via consider lines** — `<name> - a rare creature -`
  is now parsed as an authoritative rare marker. Legends breaks the classic
  "lowercase article = trash" convention (it has lowercase-article rares),
  so the tag is the reliable signal. `(Lvl: N)` consider lines are
  intercepted before the system-noise filter so the rare tag survives, with
  no regression for non-consider `(Lvl:)` lines.
- The offline mob database also computes the `named` flag from the naming
  convention plus PEQ's explicit `#` marker, so the two paths agree.

## Under the hood

- `cargo test --workspace` and the frontend typecheck stay green.
- Auto-updates from the previous version as usual: you'll get an
  "Install & restart" prompt on launch.
