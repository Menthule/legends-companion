# Storage layout & character switching

Status: **spec / not yet implemented.** Implement as one unit *after* the
"On others" buff mini-bars land (overlapping files: `config.rs`,
`library.rs`, `Dashboard.tsx`).

## Goals

- Legible, portable, backup-friendly data folder ("easy for others to install").
- Correct multi-character / multi-server identity (EQ names aren't global).
- One shared trigger library; per-character/loadout enable + TTS/alert state.
- Shallow, predictable settings cascade — no "override anything anywhere."

## Data root resolution (portable-with-fallback)

1. If a writable `data/` directory exists next to the executable → **portable
   mode**, use it. (Zip-and-move, USB, backup — the GINA / EQLogParser model.)
2. Otherwise → OS app-config dir (`AppData\Roaming\com.legendscompanion.app`
   on Windows). This is today's behavior and the safe default when installed
   under `Program Files` (can't write next to the exe there).

A first run with no `data/` next to the exe stays in the OS dir. A user who
wants portability creates an empty `data/` (or we add a "Make portable"
button that creates it and migrates into it).

## Directory tree

```
<data-root>/
  settings.json                 # global app settings (see cascade below)
  characters/
    <server>/                   # server slug from the log filename
      <character>/              # character name slug
        profile.json            # level, active loadout name, pets, per-char overrides
        loadouts/
          raiding.json          # classes + per-trigger enable + tts/alert, keyed by trigger ID
          soloing.json
  triggers/                     # USER-created / imported packs ONLY
    my-triggers.json
  fights.db
  app.log
  sounds/                       # user-added sounds
```

The **bundled 2,177-trigger library ships with the app** (read-only, refreshed
on every app update) — it never lives under `data/`. Only user packs do.

## Character identity = (server, character)

- Derived from the log filename: `eqlog_<Character>_<server>.txt`
  (`discover.rs::parse_log_filename` already returns exactly this).
- Serverless `eqlog_<Name>.txt` → server bucket `"default"`.
- Slugify both for the path (lowercase, filesystem-safe); keep the display
  name in `profile.json`.
- Fixes the current latent bug: profiles keyed by name only would collide for
  same-named characters on different servers.

## One shared library + enable/disable (NOT per-character trigger files)

- Trigger *definitions* live once (bundled library + user packs). Updates flow
  to every character on app update; no frozen copies, no MB of duplicated JSON.
- The per-character axis is **enable/disable + TTS/alert**, keyed by **trigger
  ID** (never array index — a library reorder must not scramble settings),
  stored in the active loadout file.
- User-created triggers are global (available to all characters); each loadout
  enables/disables them like any bundled trigger. "Necro-only" = enabled in the
  necro loadout, off elsewhere.

## Loadouts as separate files

- Each loadout is its own file under `characters/<server>/<char>/loadouts/`.
- Benefits: a loadout is individually **shareable** (drop in a friend's
  `raiding.json`); each toggle writes a small file, not the whole character.
- `profile.json` stores only the **active loadout name** + character-level
  state; it does not embed loadout bodies.

## Settings cascade (shallow)

- **Global** (`settings.json`): theme, default logs dir, active character
  pointer, portable flag, global TTS voice/volume, overlay defaults.
- **Per-character override** — a *small allowlist only*: the character's own
  log file/path, its pet names. Nothing else is overridable per character.
- **Per-loadout**: trigger enable + TTS/alert only (that's the loadout's whole
  job). No general app settings at loadout level.

Rule of thumb: if it's not in the allowlist, it's global. Keeps support sane.

## Character switching (UI + backend)

Characters change rarely; loadouts change often. So:

- **Loadout switcher stays prominent** in the top bar (unchanged).
- **Character selector is a quieter control** beside it — a dropdown populated
  from `discover.rs::scan()` (each discovered `eqlog_*` = one character, shown
  as `Character · server`). Rarely touched, so it doesn't compete visually.
- Backend `set_active_character(server, character)`:
  1. Point `log_path` at that character's log file.
  2. Set the active character; load `characters/<server>/<char>/profile.json`
     (fresh default if absent).
  3. If tailing, rebuild the engine for the new profile (reuse
     `rebuild_if_tailing`), and re-emit `config-changed` / `profile-changed`.
- Switching character implicitly switches which log is tailed — 1:1 with the
  log file. No separate "which log" picker needed once a character is chosen.

## Migration from the current flat layout

Precedent: the `com.eqlogs.app → com.legendscompanion.app` copy-forward.

1. On first run of the new version, if `characters/` doesn't exist but the old
   flat files do (`config.json`, `triggers.json`, `profiles/<name>.json`):
   - Read the current `character_name` + `log_path`; derive `(server,
     character)` from the log filename (fall back to `default` server).
   - Move `profiles/<name>.json` → `characters/<server>/<char>/profile.json`,
     splitting its embedded loadouts out into `loadouts/*.json`.
   - Move `triggers.json` → `triggers/my-triggers.json` (user pack).
   - Fold `config.json` into `settings.json` (global keys) + the character's
     allowlisted overrides.
2. Keep the old files in place (copy, don't delete) for one version as a
   safety net, exactly as the legacy-dir migration does.
3. Write atomically (temp + rename) throughout — a crash mid-migration must
   never destroy loadouts.

## Out of scope (for now)

- Cloud sync / multi-machine merge.
- Per-loadout general settings.
- Cross-character shared custom-trigger *scoping* (all user triggers are global;
  revisit only if users ask for per-character trigger libraries).
