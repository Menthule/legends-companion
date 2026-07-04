# tools/spelldata — spell data extraction & trigger pack generation

Pipeline that turns the EverQuest Legends client's own spell database into
the committed trigger packs under `triggers/generated/`, and validates the
whole trigger library (generated + hand-curated).

All scripts are Python 3 stdlib-only.

## Inputs (not committed — copy from the game client into `fixtures/local/`)

| file | source | contents |
|---|---|---|
| `spells_us.txt` | game client | 74k caret-delimited spell rows (class levels, duration formula/cap, beneficial flag, target/resist type) |
| `spells_us_str.txt` | game client | per-spell log messages: cast-on-you / cast-on-other / wear-off |
| `eqlog_full.txt` | a real play session | 84k-line Legends log used for spot-verification |

## Regenerating the packs

```sh
# 1. Extract the spell summary (writes fixtures/local/spell_summary.json, ~28 MB)
python3 tools/spelldata/extract_spells.py

# 2. Generate the packs (writes triggers/generated/*.json)
python3 tools/spelldata/generate_packs.py

# 3. Validate the whole library (curated + generated)
python3 tools/spelldata/check_packs.py
```

Each step reads the previous step's output from its default location;
`--help` on any script lists the path overrides.

## What gets generated

- **`triggers/generated/enemy-casts.json`** — "`<mob> begins casting
  <spell>.`" alerts, one merged-alternation trigger per danger category
  (category path `Enemy Casts/<Danger Type>`). Tier-1 categories default
  on: Gate (both the named form and the classic "begins to cast the gate
  spell." eqstr 1038), Complete Heal, death touch (Cazic Touch), fears,
  charms, mezzes, dispels, dragon breath AoEs, Avatar Power/Snare,
  Gravity Flux. Tier-2 categories (minor heals, Harm Touch, Tainted
  Breath, lifetaps incl. Cancelling of Life, root/snare, stuns, debuffs,
  mob self-buffs, and an any-cast catch-all) are present but default off
  — spam-audited with `eqlog triggers` against the real fixture log so
  trash-mob casts don't flood TTS. The per-category spell name lists are
  curated in `generate_packs.py` (`TIER1_GROUPS` / `TIER2_GROUPS`) and
  intersected against the spell data so a typo fails loudly at
  generation time.

- **`triggers/generated/buffs-<class>.json`** (16 files) — for every
  castable beneficial duration spell (level ≤ 60, duration ≥ 30 s,
  non-permanent), a "`You begin casting <Spell>.`" → StartTimer trigger
  per class that gets it (duration estimated at level 50, capped; warning
  at min(10 s, 15%); `duration_formula`/`duration_cap_ticks` are emitted
  on the action so the engine rescales the duration to the profile's
  level, and `lane: "buff"` routes the bar to the buffs overlay), plus
  deduplicated wear-off Speak triggers — ONE per distinct
  wear-off message, named after the alphabetically-first colliding
  castable spell (unless `WEAR_OFF_LIKELY` overrides the announced name,
  e.g. Spirit of Wolf) and placed in that spell's first class's file
  with the full class union in `classes`. Wear-offs whose message is
  shared by more than 3 spells anywhere in the data default off (too
  ambiguous to voice); the collision count is recorded in `comments`.

- **`triggers/generated/debuffs-<class>.json`** (16 files) — for every
  castable detrimental duration spell (duration ≥ 18 s, non-permanent), a
  "`You begin casting <Spell>.`" → StartTimer trigger with
  `lane: "enemy"` (target overlay), same level-rescaling metadata as the
  buff packs, plus ONE wear-off companion per spell wired to the Legends
  "`Your <Spell> spell has worn off of <target>.`" line: CancelTimer +
  DisplayText re-announce (no Speak — curated packs own wear-off TTS).
  Default ON only for CC (mez/root/snare, `CC_SPELLS`) and class-defining
  DoTs (`DEFAULT_ON_DOTS`); ending warnings (`warn_at_secs`) are emitted
  for CC only, since the app speaks them. (class, spell) pairs the
  curated packs already time (`CURATED_COVERED`: enchanter mez trio +
  base Root, shaman Walking Sleep, wizard Root) are skipped so one cast
  never starts two bars. v1 keys enemy timers by spell name only — two
  mobs under the same spell share one bar, and the first wear-off cancels
  it (documented gap; per-target names use the `<Spell> — <target>`
  convention the frontend groups by).

## What is hand-curated (NOT regenerated — edit the JSON directly)

- **`triggers/curated/universal.json`** — the verified universal set from
  `docs/research-triggers.md` (tier 1 on, tier 2 off by default).
- **`triggers/curated/<class>.json`** (16 files) — per-class essentials.
  Shared triggers (FD, mez break, charm break…) live in ONE file and tag
  every relevant class via `classes`; file placement is organizational
  only. When adding/removing curated triggers, update `EXPECTED_CURATED`
  in `check_packs.py`.

## Pack schema (v2 additions)

Triggers carry optional fields on top of the original format (serde
defaults keep old packs valid): `id` (stable slug), `classes` (exact
names: Warrior, Cleric, Paladin, Ranger, ShadowKnight, Druid, Monk, Bard,
Rogue, Shaman, Necromancer, Wizard, Magician, Enchanter, Beastlord,
Berserker; empty = all), `default_enabled` (bool, default true) and
`source` (`generated` | `curated` | `user` | `gina`). `enabled` remains
the pack-level hard switch; effective enablement is the character
profile's override resolution AND `enabled`.

## Regex constraints

The real matcher is the Rust `regex` crate: **no lookarounds, no
backreferences** — only alternation, anchors, and non-capturing groups.
`check_packs.py` enforces this and smoke-compiles every pattern with
Python `re` after expanding the engine's `{C}` token. Spell names are
escaped with a metacharacter-only escaper (Python's `re.escape` also
escapes spaces/`-`/`&`, which the Rust crate rejects or mangles).

## Verification

`check_packs.py` also cross-checks generated counts against a fresh
re-derivation from `spell_summary.json`, pins the curated pack sizes, and
requires a set of patterns to match real lines in
`fixtures/local/eqlog_full.txt` (both fixture-dependent stages are
skipped with a note when the fixtures are absent, e.g. in CI).
