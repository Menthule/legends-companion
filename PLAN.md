# Legends Companion (formerly EQLogs) — EverQuest Legends log companion

A log-only (no memory reading, zero ban risk) companion app for EverQuest Legends:
regex triggers with TTS/sound/timer alerts, live damage meters, loot/raid tracking,
GINA trigger-pack import. Personal tool first; may open-source later.

## Ground truth

- Game install: `C:\Users\Public\Daybreak Game Company\Installed Games\EverQuest Legends`
- Log file: `Logs\eqlog_<Char>_<server>.txt` (currently `eqlog_Nyasha_oggok.txt`)
- Format: classic EQ — `[Thu Jul 02 23:32:46 2026] <message>`, fixed-width 27-char
  timestamp prefix, one event per line, appended live, local time.
- Native in-game alerting exists (`AudioTriggers/` text→wav) but no regex, TTS,
  overlays, or meters.
- Only existing Legends tool: BasaBots EQL ($3/mo, closed, reads game memory).
  No free/open log-only tool exists yet. Legends launches 2026-07-28.

## Tech stack

- **Tauri v2** — Rust core + web frontend (React + TypeScript + Vite).
- **Rust core** (`eqlog-core` crate, UI-independent, unit-testable):
  - Tailer: poll loop (~200 ms), open with full share flags
    (`OpenOptionsExt::share_mode(READ|WRITE|DELETE)` on Windows), seek-to-end on
    start, reopen on truncation (`len < pos`). `notify` crate only for
    delete/rename lifecycle, never for content. (This is the proven EQLogParser
    pattern — FileSystemWatcher-style APIs are unreliable for appended content.)
  - Parser: `regex` line classifiers → typed events (Hit, Miss, Heal, CastStart,
    Death, Slain, Loot, Roll, Chat, Tell, XP, Faction, ZoneChange, Stun, Resist,
    WornOff, LevelUp…). Watch for backtick pet/mob names (`Torvin`s warder`),
    `actual (potential)` overheal syntax, `(Critical)`-style trailing flags.
  - Fight tracker: segment by target death / idle timeout; aggregate DPS/HPS/
    damage-taken per entity with pet→owner attribution.
- **Trigger engine**: user regexes with capture groups → actions: TTS
  (`tts` crate, WinRT backend), sound file (`rodio`), overlay text, countdown
  timer + timer-ending warning. Trigger folders, enable-per-character.
- **Overlays**: Tauri WebviewWindows — `transparent`, `decorations: false`,
  `alwaysOnTop`, `setIgnoreCursorEvents(true)` for click-through; "unlock to
  arrange" edit mode toggles click-through off. Layout persisted.
- **Dashboard**: normal window (second monitor) for meters, fight history,
  trigger management, loot log.
- **Storage**: SQLite (`rusqlite`) for fight history + loot; JSON for triggers/
  settings. GINA `.gtp` import = zip of XML (`zip` + `quick-xml`).

## Dev workflow (WSL + Windows)

- `eqlog-core` develops/tests fine in WSL (pure Rust + log fixtures copied from
  the real log).
- The Tauri app must build/run on Windows (WebView2, TTS, overlays). Plan:
  Rust + Node toolchains on the Windows side; run dev/build via `powershell.exe`
  from WSL, or keep the repo on a Windows path if `/mnt/c` I/O gets painful.

## Milestones

- **M0 — parser core**: `eqlog-core` crate; parse the full real 83k-line log into
  typed events with tests; simple CLI that tails the live log and prints events.
- **M1 — alerts**: Tauri shell, live tail → event bus → trigger engine, TTS +
  sound alerts, config UI for triggers.
- **M2 — overlays**: text alert + timer-bar overlay windows, click-through +
  edit mode, layout save.
- **M3 — meters**: fight tracker, live DPS/heal/tank overlay meter, fight
  history browser (SQLite), "paste parse to chat" export.
- **M4 — ecosystem**: GINA `.gtp` import, loot log + /random roll tracker,
  multi-character support.

## Reference implementations

- EQLogParser (kauffman12, C#/WPF, Apache-2.0) — log tailing
  (`src/control/util/LogReader.cs`), parsing patterns (`src/parsing/*.cs`),
  overlay edit-lock UX.
- rumstil/eqlogparser — clean typed-event parser architecture.
- ACT OverlayPlugin — web-tech overlay design.
