# Architecture as of 0.2.0

Current-state map of Legends Companion. This supersedes the stale parts of
`PLAN.md` (original design pitch) and `docs/now-sprint.md` (pre-launch
sprint scope) — those stay as history. Feature-level detail:
`RELEASE_NOTES_0.2.0.md`. Agent-facing constraints and gotchas: root
`CLAUDE.md`.

## Big picture

```
game log file ──► eqlog-core (tail → parse → typed events → fights)
                        │
                        ├─► eqlog-triggers (engine: regex → speak/show/
                        │     sound/timers; profiles + loadouts)
                        ├─► eqlog-store (completed fights → SQLite)
                        │
        app/src-tauri (tailing.rs session thread, audio thread,
                        library, reference sqlite, updaters)
                        │  Tauri events / commands
        app/src (React dashboard + 7 overlay windows)
```

Two consumers of the same core: the Tauri app and the `eqlog` CLI
(`parse` / `fights` / `tail` / `triggers` spam-audit / `detect` /
`share`). The CLI is the audit and debugging surface; it runs anywhere,
the app is Windows-only (WebView2, WinRT TTS, overlay windows).

## Rust workspace (cross-platform, WSL-testable)

| Crate | Role |
| --- | --- |
| `eqlog-core` | Poll-based tailer (share-mode open, truncation reopen), line parser → typed events, fight tracker, catch-up replay |
| `eqlog-triggers` | Trigger model (stable slug ids, actions, overlay lanes), engine (timers with level-rescaled durations, multi-instance DoT bars, buff land-on-other binding), pack loading, profiles/loadouts, GINA `.gtp` import, `LCS1:` share strings, class auto-detect |
| `eqlog-store` | Fight-history SQLite (rusqlite bundled) |
| `eqlog-cli` | Terminal binary over all of the above |

`app/src-tauri` is deliberately **outside** this workspace (own
`[workspace]` stanza, no dep inheritance) so the Windows-only app never
blocks WSL `cargo test --workspace`.

## App backend (`app/src-tauri/src`)

- **Session**: `tailing.rs` runs one thread: Tailer → Parser →
  FightTracker + TriggerEngine; 250 ms `recv_timeout` is also the
  timer/fight tick. Emits Tauri events (`trigger-fired`, timers, meters,
  tail-stats canary, `overlay-xp`, …).
- **Audio**: `audio.rs` owns a TTS/sound thread. Silencing is a generation
  counter — a bump invalidates queued utterances and cuts the current one.
  TTS voice selectable by name.
- **Trigger library**: `library.rs` — bundled packs + user triggers →
  trigger tree; per-character profiles with named loadouts; two override
  layers keyed by stable trigger id: enable/disable and speak/alert
  channels. Profile changes hot-rebuild the live engine; **pack JSON on
  disk is only re-read when a session (re)starts**.
- **Reference data**: one bundled sqlite (`refdata/drops.sqlite` resource;
  `assets/data/drops.sqlite` in dev), three query modules — `dropdb.rs`
  (item→mob→zone drop graph), `spelldb.rs` (spells/abilities + class
  levels), `refdb.rs` (vendors, mob browser, recipes, zone almanac,
  kill→respawn for camp timers). House rule: every SQL parameter must be
  referenced; optional filters guard as `(?N = '' OR …)`.
- **Updates, two channels**: `update.rs` = signed app auto-updater
  (tauri-plugin-updater). `datapack.rs` = reference-data channel — fetches
  `data-manifest.json` from the rolling `data-latest` GitHub release,
  sha256-verifies each file, installs atomically. Both surfaced in
  Settings → Updates.
- **Data root**: `data_root.rs` resolves where settings/characters live.
  A writable `data/` dir beside the exe = portable mode (this is why the
  bundled resource dir is `refdata/`, never `data/`). Storage layout per
  `docs/storage-layout.md` (now implemented: `settings.json`,
  `characters/<server>/<char>/…`).

## Frontend (`app/src`)

- `components/Dashboard.tsx` — sidebar in nav groups: **Log** (Live,
  Meters, Fights, Triggers) and **Database** (Drops, Mobs, Recipes,
  Spells, Abilities, Macros), plus Settings.
- Database tabs share global **era + class filters**
  (`lib/refFilters.ts`, one store, localStorage + event sync).
- Log↔database glue lives in the frontend: `lib/wishlist.ts` (starred
  items → drop alerts), camp timers + session kill tallies in
  `FightsTab.tsx` (respawn times fetched from refdb), loot deep links.
- `overlay/` — seven independent overlay windows: Alerts, Buffs, Meter,
  OnOthers, Stance (stance + invocation glyphs), Target, Xp (live per-hour
  rate). Visibility in `overlayState.ts`.
- `mock.ts` / `mockPacks.ts` — browser-only mock backend so UI work runs
  without the Tauri shell.
- Settings sub-tabs: General / Loadouts / Overlays / Appearance / Updates.

## Data pipeline (build order matters)

1. `tools/dropdata/build_drops_db.py` — PEQ dump → `assets/data/drops.sqlite`
   (recreates the file; **wipes the spell tables**).
2. `tools/spelldata/build_spell_db.py` — appends `spells`/`spell_classes`
   from the Legends client spell files. Always re-run after step 1.
3. `tools/spelldata/extract_spells.py` → `spell_summary.json` →
   `generate_packs.py` (generated trigger packs) + `generate_buff_lands.py`
   (engine's land-on-other table).
4. `tools/release/make_data_pack.py` — deterministic `dist-data/` for the
   `data-latest` release channel.

Provenance and caveats (classic-era data vs. Legends live values):
`assets/data/DATA_SOURCES.md`.

## Numbers that gate changes

- Spam audit: `eqlog triggers` over the reference session log; 0.2.0
  default library ≈ 19 spoken alerts/hour (deliberate CC-on-you bump from
  0.1's 10.3). Cite audits in trigger `comments`.
- Parser ~1M lines/s; full library replay ~340k lines/s; alert latency
  dominated by the ~200 ms tail poll.
- Patch-day canary: unclassified-line rate badge instead of silent failure.
