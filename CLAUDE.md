# Legends Companion — agent context

Log-only EverQuest Legends companion (Tauri v2). Rust workspace + Windows
desktop app. Read `RELEASE_NOTES_0.2.0.md` for current feature scope,
`docs/architecture-0.2.md` for the architecture, `DESIGN.md` for visual
design tokens. `PLAN.md` and `docs/now-sprint.md` are historical.

## Architecture map

**Cargo workspace** (`Cargo.toml` members — cross-platform, tested in WSL):

- `crates/eqlog-core` — log tailer (poll-based, share-mode open, truncation
  reopen), line parser → typed events, fight tracker, catch-up replay.
- `crates/eqlog-triggers` — trigger model (`model.rs`: stable slug ids,
  actions, lanes), engine (`engine.rs`: regex matching, timers with
  level-rescaled durations, multi-instance DoT bars), pack loading
  (`packs.rs`), per-character profiles/loadouts (`profile.rs`,
  `storage.rs`), GINA `.gtp` import (`gina.rs`), share strings `LCS1:`
  (`share.rs`), class auto-detect (`classdetect.rs`), buff land-on-other
  binding (`buff_lands.rs`).
- `crates/eqlog-store` — SQLite fight-history persistence (rusqlite,
  bundled).
- `crates/eqlog-cli` — `eqlog` binary: `parse`, `fights`, `tail`,
  `triggers` (spam audit), `detect`, `share export/import`.

**`app/src-tauri/src`** (Windows-only app shell — OUTSIDE the workspace):

- `commands.rs` — Tauri command surface: share, log discovery, tail session
  lifecycle. `lib.rs` registers everything.
- `tailing.rs` — the live session thread: Tailer → Parser → FightTracker +
  TriggerEngine; `recv_timeout(250ms)` doubles as the timer tick; emits
  Tauri events, forwards audio.
- `audio.rs` — dedicated TTS/sound thread (WinRT `tts` + `rodio`). Silence
  uses a **generation counter**: commands carry the generation at enqueue
  time; `silence()` bumps it, stale queue entries drop, current utterance is
  cut. Voice switching by display name ("" = system default).
- `library.rs` — trigger library v2: multi-pack load, trigger tree,
  per-character profiles + loadouts, per-trigger enable overrides AND
  speak/alert channel overrides, live-engine rebuild on profile change.
- `dropdb.rs` / `spelldb.rs` / `refdb.rs` — read-only queries over the ONE
  bundled sqlite (`refdata/drops.sqlite` resource; `assets/data/drops.sqlite`
  in dev). dropdb = item→mob→zone drop graph; spelldb = `spells` /
  `spell_classes` (Abilities tab = `is_ability = 1`); refdb = vendors, mob
  browser, recipes, zone almanac, kill→respawn lookups.
- `datapack.rs` — data-update channel: fetches `data-manifest.json` from the
  rolling `data-latest` GitHub release, sha256-verifies, installs atomically.
- `data_root.rs` — data-dir resolution. **PORTABLE-MODE TRAP:** a *writable*
  `data/` directory beside the executable switches the whole app into
  portable mode and silently redirects app data there. This is why the
  bundled resource dir is named `refdata/` — NEVER name a shipped directory
  `data/` next to the exe.
- `update.rs` — signed app auto-updater (tauri-plugin-updater; endpoint +
  pubkey in `tauri.conf.json`).
- Also: `config.rs` (settings), `discover.rs` (first-run log scan),
  `meters.rs` (live meter aggregation), `store.rs` (fight-history wiring),
  `sounds.rs`, `logging.rs` (rotating app.log).

**`app/src`** (React + TS + Vite):

- `components/Dashboard.tsx` — sidebar nav in groups: **Log** (Live, Meters,
  Fights, Triggers), **Database** (Drops, Mobs, Recipes, Spells, Abilities,
  Macros), ungrouped Settings.
- `components/SettingsTab.tsx` — sub-tabs: General / Loadouts / Overlays /
  Appearance / Updates (app updater + data channel).
- `components/FightsTab.tsx` — fight history plus camp timers (kill →
  respawn countdown, localStorage-persisted) and session kill tallies.
- `overlay/` — one file per overlay window: Alerts, Buffs, Meter, OnOthers,
  Stance (stance + invocation), Target, Xp.
- `lib/refFilters.ts` — GLOBAL era + class filters shared by every Database
  tab (localStorage + custom-event sync). `lib/wishlist.ts` — starred-item
  drop alerts (same sync pattern). `overlayState.ts` — overlay visibility.
  `lib/stanceState.ts` — stance/invocation from verified log lines.
- `mock.ts` / `mockPacks.ts` — browser-only mock backend for UI dev.

## Hard constraints

- **`app/src-tauri` does NOT compile in WSL** (WebView2, WinRT TTS,
  overlay windows are Windows-only). Write that Rust carefully and
  deliberately; the orchestrator builds on Windows. The four workspace
  crates DO build and test in WSL — `cargo test --workspace` must stay
  green.
- **Frontend typecheck must run from `app/`**: `cd app && npx tsc --noEmit`.
  From the repo root, `npx tsc` resolves the unrelated npm placeholder
  package literally named `tsc` — not TypeScript.
- **Rust `regex` crate has no lookarounds** (no `(?=`, `(?<=`, `(?!`).
  Rewrite trigger patterns accordingly.
- **SQLite fixed-parameter discipline**: every `?N` in a prepared statement
  must be referenced — rusqlite/SQLite rejects unused bindings. Guard
  optional filters as `(?N = '' OR col = ?N)` / `(?N = 0 OR …)` (see
  `refdb.rs` header for the house style).
- **`app/src-tauri` is outside the cargo workspace** (it declares its own
  `[workspace]`): it cannot use `workspace = true` dependency inheritance —
  pin versions in its own `Cargo.toml`.
- **Trigger pack JSON is read at load time only** (tail-session start /
  app start). Editing files under `triggers/` does nothing to a running
  session — restart tailing or the app.
- **Never touch `/mnt/c`.** The Windows build tree is synced by the
  orchestrator, not by you.

## Dev loop (Windows build)

- rsync the WSL tree to `C:\Users\getow\Projects\eqlogs` excluding `.git`,
  `target`, `node_modules`, `dist`, `.claude`.
- `npm run tauri dev` there (via `powershell.exe` with
  `C:\Program Files\nodejs` and `%USERPROFILE%\.cargo\bin` on PATH, using
  `npm.cmd`): the tauri dev watcher rebuilds Rust and hot-reloads the
  frontend.
- `npm run tauri build` produces the NSIS installer under
  `app/src-tauri/target/release/bundle/nsis/`.

## Data pipeline (order matters)

1. `tools/dropdata/build_drops_db.py` — PEQ `load_system.sql` dump →
   `assets/data/drops.sqlite` (items, npcs, zones, vendors, recipes, zone
   almanac). **Deletes and recreates the whole file**, wiping the spell
   tables — so ALWAYS follow with step 2.
2. `tools/spelldata/build_spell_db.py` — appends `spells` + `spell_classes`
   from the Legends client files (`fixtures/local/spells_us.txt` +
   `spells_us_str.txt`). Idempotent; only drops/recreates its own two
   tables.
3. `tools/spelldata/extract_spells.py` → `fixtures/local/spell_summary.json`,
   consumed by `generate_packs.py` (enemy-casts + per-class buff/debuff
   trigger packs under `triggers/generated/`) and `generate_buff_lands.py`
   (spell → land-on-other suffix table for the engine).
4. `tools/release/make_data_pack.py` — builds `dist-data/` (drops.sqlite,
   triggers.zip, data-manifest.json) for the rolling `data-latest` GitHub
   release the app's data channel consumes. Deterministic output.

`fixtures/local/` is gitignored (full real log + client spell files live
there, not in the public repo).

## Conventions

- **Alert-fatigue budget.** Any change to default-on spoken triggers must be
  spam-audited:
  `cargo run -p eqlog-cli -- triggers fixtures/local/eqlog_full.txt --char Nyasha --classes Enchanter,Cleric,Wizard --level 16`.
  Keep spoken alerts/hour reasonable (0.2.0 ships at ~19/hour, a deliberate
  bump for CC-on-you alerts) and cite the audit in trigger `comments`.
- **Trigger `comments` carry verification provenance** ("Verified in Legends
  log: '…'"). Preserve and extend them; they are the evidence trail.
- **Curated trigger ids are stable API** (e.g.
  `class/enchanter/cc/mez-broken`). User overrides (enable + speak/alert)
  are keyed by id — renaming a trigger's id orphans every user's overrides.
  Never rename ids on shipped triggers.
- **Design tokens and visual rules live in `DESIGN.md`** (dark-first,
  dev-tool aesthetic, no fantasy theming). Follow it for any UI work.
- Tests must stay green: `cargo test --workspace` (WSL-safe) and
  `cd app && npx tsc --noEmit`.
