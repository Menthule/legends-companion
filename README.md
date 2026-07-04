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
- **CLI** — parse historical logs, summarize fights, or tail the live log from
  a terminal, no GUI required.

Legends Companion is **log-only**: it parses
`Logs\eqlog_<Character>_<server>.txt`, the same file the in-game `/log`
command appends to. No injection, no memory reading, no network calls to the
game. (The CLI binary keeps its original name, `eqlog`.)

## Trust & performance

Numbers you can verify yourself from this repository (the parser benchmarks
and the spam audit run against the real 84,672-line log fixture in
`fixtures/`):

- **Log-only, zero ban risk.** The app opens exactly one game file — the
  plain-text log — read-only. No memory reading, no injection, no packets.
  If reading your own log file were bannable, so would Notepad be.
- **Fast enough that you'll never notice it.** The parser handles
  **~1,000,000 lines/second**, and replaying the *entire* bundled trigger
  library (1,647 triggers across 50 packs) still processes
  **~340,000 lines/second**. End-to-end alert latency is dominated by the
  log-file poll interval (~200 ms), not by parsing or matching — the game
  writes a line, and you hear about it well under half a second later.
- **Audited alert discipline: 10.3 spoken alerts/hour.** Replaying that same
  84k-line real play session through the full default library produces 10.3
  text-to-speech alerts per hour. Alert fatigue is a design bug; we measure
  it so you don't have to hand-mute your way to sanity.
- **~10 MB installed.** A Tauri app on the WebView2 runtime Windows already
  ships — not an 8 GB Electron bundle.
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
| `crates/eqlog-triggers` | Trigger data model + engine, GINA `.gtp` import                    |
| `crates/eqlog-cli`      | `eqlog` terminal binary (`parse`, `fights`, `tail`)                |
| `app/`                  | Tauri v2 desktop app (React + TypeScript + Vite)                   |
| `fixtures/`             | Real log excerpts used by the test suite                           |
| `triggers/`             | Trigger library (`curated/` + `generated/` packs, used by CLI/tests) |
| `PLAN.md`               | Design notes and roadmap                                           |

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

## Roadmap

- **M0 — parser core**: parse full real logs into typed events; CLI that tails
  the live log. *(done — this is `eqlog-core` + `eqlog-cli`)*
- **M1 — alerts**: Tauri shell, live tail → trigger engine, TTS + sound
  alerts, trigger config UI.
- **M2 — overlays**: text-alert and timer-bar overlay windows, click-through +
  edit mode, saved layouts.
- **M3 — meters**: live DPS/heal/tank overlay meter, fight history browser,
  "paste parse to chat" export.
- **M4 — ecosystem**: GINA `.gtp` import, loot log + `/random` roll tracker,
  multi-character support.

## License

MIT — see [LICENSE](LICENSE). Not affiliated with or endorsed by Daybreak
Game Company. EverQuest is a trademark of Daybreak Game Company LLC.
