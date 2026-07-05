# Legends Companion

A free, open-source companion app for **EverQuest Legends** (formerly named
*EQLogs*). Legends Companion reads only the plain-text log file the game
writes to disk — it never touches game memory, so there is nothing to detect
and nothing to ban.

## Features

- **Triggers** — match log lines with regexes (capture groups supported) and
  fire text-to-speech, sound files, on-screen text, and countdown timers with
  timer-ending warnings. Organize triggers into folders, enable per character,
  and keep multiple **loadouts** (named class/override set-ups) you can switch
  between mid-session.
- **Live meters** — DPS, healing, and damage-taken meters with pet→owner
  attribution (yes, including backtick pets like ``Torvin`s warder``), segmented
  into fights automatically.
- **In-game overlays** — transparent, click-through, always-on-top windows for
  alerts, timer bars, and meters; an "unlock to arrange" mode lets you drag
  them wherever you like.
- **GINA import** — bring your existing GINA trigger packs (`.gtp`) with you.
- **The Database** — six searchable reference tabs (Drops, Mobs, Recipes,
  Spells, Abilities, Macros) built from bundled classic-era ProjectEQ data
  plus the game client's own spell files (~17 MB sqlite): who drops an item
  and where, full mob loot tables and spawn zones, tradeskill recipes with
  farming hints, every castable spell/discipline with class-level tables and
  scroll sources, and researched in-game socials with a guided copy flow.
  Global **era** and **class** filters apply across every tab.
- **Log ↔ database tools** — star items on a **wishlist** and the app speaks
  up when one drops in your log; killing a named mob starts an automatic
  **camp respawn timer** (persists across restarts, announces when due);
  per-mob **session kill counts** with live kills/hour; click any looted item
  to jump to its database page.
- **Crowd-control alerts** — root, snare, mez, fear, charm, and spell stun
  *on you* are spoken by default (with wear-off calls), using log-verified
  Legends spell texts. Every trigger has per-loadout speak/alert toggles, so
  you tune the noise instead of living with it.
- **More overlays** — XP tracking with live per-hour rate, a stance &
  invocation status overlay, and an optional buff-bar threshold that hides
  long buffs until their last N minutes.
- **Updates without reinstalling** — the reference database and trigger packs
  update from a rolling `data-latest` channel (Settings → Updates,
  hash-verified, atomic install), separate from the signed app auto-updater.
- **CLI** — parse historical logs, summarize fights, or tail the live log from
  a terminal, no GUI required.

Legends Companion is **log-only**: it parses
`Logs\eqlog_<Character>_<server>.txt`, the same file the in-game `/log`
command appends to. No injection, no memory reading, no network calls to the
game. (The CLI binary keeps its original name, `eqlog`.)

## Trust & performance

Numbers you can verify yourself from this repository (the parser benchmarks
and the spam audit replay a real 84,672-line play session; the repo ships
excerpts of it in `fixtures/`, the full log stays local because it contains
private chat):

- **Log-only, zero ban risk.** The app opens exactly one game file — the
  plain-text log — read-only. No memory reading, no injection, no packets.
  If reading your own log file were bannable, so would Notepad be.
- **Fast enough that you'll never notice it.** The parser handles
  **~1,000,000 lines/second**, and replaying the *entire* bundled trigger
  library (1,733 triggers across 51 packs) still processes
  **~340,000 lines/second**. End-to-end alert latency is dominated by the
  log-file poll interval (~200 ms), not by parsing or matching — the game
  writes a line, and you hear about it well under half a second later.
- **Audited alert discipline: ~19 spoken alerts/hour.** Replaying that same
  84k-line real play session through the full default library produces about
  19 text-to-speech alerts per hour. (0.1 shipped at 10.3/hour; the increase
  is deliberate — crowd-control-on-you alerts now speak by default because
  missing a mez is worse than hearing about it, and every trigger has
  per-loadout speak/alert toggles to tune it back down.) Alert fatigue is a
  design bug; we measure it so you don't have to hand-mute your way to
  sanity.
- **Small install.** A Tauri app on the WebView2 runtime Windows already
  ships — not an 8 GB Electron bundle. The single biggest thing in the
  install is the 17 MB reference database.
- **100% line classification** on the reference fixture, and a built-in
  patch-day canary: if a game update changes the log grammar, the app shows
  an "unrecognized lines" warning badge instead of silently going quiet.
- **MIT-licensed and fully open source.** Every trigger pack, every parser
  rule, and the release pipeline are in this repository. Don't trust the
  installer? Build it yourself in two commands.

## Install (for players)

1. Download the latest installer (`.exe`) from the
   [GitHub Releases](../../releases/latest) page.
2. Run it. **Windows SmartScreen will warn you** — the installer is not
   code-signed (signing certificates cost hundreds of dollars a year, which
   doesn't make sense for a free hobby tool). Click **More info → Run anyway**.
   If you'd rather not trust a prebuilt binary, see
   [Build from source](#build-from-source) below — the entire app builds from
   this repository.
3. In game, turn on logging: type `/log on` in the chat window. (Logging stays
   on until you turn it off or the game resets it, so it's worth re-checking
   after patches.)
4. Launch Legends Companion and, in **Settings**, select your character's log
   **file** (`eqlog_<Character>_<server>.txt`) inside the game's Logs folder:

   ```
   C:\Users\Public\Daybreak Game Company\Installed Games\EverQuest Legends\Logs\eqlog_<Character>_<server>.txt
   ```

   Legends Companion follows that file live as the game writes to it. If you
   play multiple characters, switch the file in Settings when you switch
   characters.

Upgrading from an older **EQLogs** install? Your settings, triggers, and
character profiles migrate automatically the first time Legends Companion
starts.

## CLI quickstart

The `eqlog` binary works on any OS and is handy for after-the-fact analysis:

```sh
# Parse a whole log: coverage summary + event histogram
# (add --json for one ParsedLine JSON object per line)
eqlog parse "C:\...\Logs\eqlog_Nyasha_oggok.txt"

# Summarize fights: per-entity damage, DPS, damage taken, heals
# (defaults: --char Nyasha --pet Vibarn=Nyasha; repeat --pet PET=OWNER)
eqlog fights "C:\...\Logs\eqlog_Nyasha_oggok.txt" --char Nyasha

# Follow the live log, print events, and fire triggers to the console
# (loads the triggers/ library when present; override with --triggers PATH)
eqlog tail "C:\...\Logs\eqlog_Nyasha_oggok.txt" --char Nyasha

# Audit the trigger library against a log: which triggers fired, how often,
# and the spoken-alerts-per-hour number quoted above
eqlog triggers "C:\...\Logs\eqlog_Nyasha_oggok.txt" --classes Enchanter --level 16
```

Build it from source with `cargo build --release -p eqlog-cli` (the binary
lands at `target/release/eqlog`), or grab `eqlog.exe` from a release.

## Build from source

Prerequisites:

- **Rust** (stable) — <https://rustup.rs>
- **Node.js 20+** — only needed for the desktop app

The Rust core and CLI build and test on any OS:

```sh
cargo test --workspace
cargo build --release -p eqlog-cli
```

The desktop app is a Tauri v2 application:

```sh
cd app
npm install
npm run tauri dev     # develop
npm run tauri build   # produces the NSIS installer under
                      # app/src-tauri/target/release/bundle/nsis/
```

> **Note:** the core crates and CLI are cross-platform, but the desktop app
> targets Windows (WebView2, WinRT text-to-speech, overlay windows). Building
> it on Linux requires webkit2gtk and won't exercise the Windows-only pieces —
> develop the app itself on Windows.

## Project layout

| Path                    | What it is                                                         |
| ----------------------- | ------------------------------------------------------------------ |
| `crates/eqlog-core`     | Log tailer, line parser → typed events, fight tracker (pure Rust)  |
| `crates/eqlog-triggers` | Trigger data model + engine, GINA `.gtp` import, share strings     |
| `crates/eqlog-store`    | SQLite fight-history persistence                                   |
| `crates/eqlog-cli`      | `eqlog` terminal binary (`parse`, `fights`, `tail`, `triggers`, …) |
| `app/`                  | Tauri v2 desktop app (React + TypeScript + Vite)                   |
| `assets/data/`          | Bundled reference database (`drops.sqlite`) + provenance notes     |
| `fixtures/`             | Real log excerpts used by the test suite                           |
| `triggers/`             | Trigger library (`curated/` + `generated/` packs, used by CLI/tests) |
| `tools/dropdata`        | Builds `drops.sqlite` from the ProjectEQ database dump             |
| `tools/spelldata`       | Spell tables + generated trigger packs from client spell data      |
| `tools/release`         | Packages the `data-latest` reference-data update channel           |
| `docs/`                 | Specs and design notes (see `docs/architecture-0.2.md`)            |

## Trigger packs

Triggers are plain JSON files. A pack is a list of triggers, each with a regex
pattern (capture groups can be spoken back in TTS text or shown in overlay
text) and one or more actions:

```json
{
  "name": "My pack",
  "triggers": [
    {
      "name": "Dangerous enemy cast",
      "pattern": "^(\\w[\\w`' ]*) begins casting (Cancelling of Life|Engulfing Darkness)\\.",
      "enabled": true,
      "category": "Combat/Enemy Casts",
      "actions": [
        { "Speak": { "template": "${2} incoming" } }
      ]
    },
    {
      "name": "Mez cast timer",
      "pattern": "^You begin casting Walking Sleep\\.",
      "enabled": true,
      "category": "Combat/Crowd Control",
      "actions": [
        { "StartTimer": { "name": "Walking Sleep", "duration_secs": 48, "warn_at_secs": 6 } }
      ]
    }
  ]
}
```

The available actions are `Speak`, `DisplayText` (both take a `template` that
can reference captures like `${1}` or `${name}`), `PlaySound` (takes a
`path`), and `StartTimer` (takes `name`, `duration_secs`, an optional
`warn_at_secs`, and — on generated buff timers — optional
`duration_formula`/`duration_cap_ticks` metadata the engine uses to rescale
the duration to your character's level).

A ready-made trigger library lives in [`triggers/`](triggers/) —
hand-curated universal and per-class packs under `curated/` plus
spell-data-generated buff timers and enemy-cast alerts under `generated/`.
The CLI's `tail` command loads the whole library automatically when run
from a checkout, and per-character profiles pick which triggers are active
(classes, level, overrides). You can also import GINA `.gtp` packs directly
from the Settings screen.

## Reference data

The Database tabs are powered by **classic-era emulator data**: the
[ProjectEQ](https://sourceforge.net/projects/projecteq/) content database of
the open-source EQEmu project, plus spell tables extracted from the Legends
client's own spell files. That means drop chances, loot tables, and spawn
info are a guide to *where to hunt* — EverQuest Legends re-itemizes gear and
retunes spells, so treat the numbers as reference, not gospel. Full
provenance and rebuild instructions live in
[`assets/data/DATA_SOURCES.md`](assets/data/DATA_SOURCES.md).

When the reference data or bundled trigger packs improve, the app pulls the
update itself: **Settings → Updates** checks the rolling `data-latest`
release channel, verifies file hashes, and installs atomically — no
reinstall, no losing your own triggers or overrides.

## Roadmap

- **M0 — parser core**: parse full real logs into typed events; CLI that tails
  the live log. *(done — this is `eqlog-core` + `eqlog-cli`)*
- **M1 — alerts**: Tauri shell, live tail → trigger engine, TTS + sound
  alerts, trigger config UI. *(done)*
- **M2 — overlays**: text-alert and timer-bar overlay windows, click-through +
  edit mode, saved layouts. *(done)*
- **M3 — meters**: live DPS/heal/tank overlay meter, fight history browser,
  "paste parse to chat" export. *(done)*
- **M4 — ecosystem**: GINA `.gtp` import, loot log, trigger sharing,
  multi-character loadouts. *(done)*
- **0.2 — the Database update**: reference databases, wishlist drop alerts,
  camp timers, CC alerts, data-update channel. *(done — see
  [RELEASE_NOTES_0.2.0.md](RELEASE_NOTES_0.2.0.md))*

## License

MIT — see [LICENSE](LICENSE). Not affiliated with or endorsed by Daybreak
Game Company. EverQuest is a trademark of Daybreak Game Company LLC.
