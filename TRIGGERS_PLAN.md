# Trigger library v2 — full class/spell population

Goal: ship a generated + curated trigger library covering all 16 classes and
every relevant spell, with cascading enable/disable by archetype → class →
category → individual trigger, per character.

## Research findings (verified)

- **16 classes** (classic 14 + Beastlord, Berserker). Archetypes per the
  game's own scheme: Casters (Enc/Mag/Nec/Wiz), Priests (Clr/Dru/Shm),
  Melee (Ber/Mnk/Rog/War), Hybrids (Brd/Bst/Pal/Rng/SK). Tri-class: every
  character is up to 3 classes at once; character level = lowest.
- **Legends names enemy casts** ("Nixor begins casting Gate.") — verified in
  the real 84k-line log; classic's generic "begins to cast a spell." appears
  zero times. Per-spell enemy-cast triggers are viable.
- **The game ships its spell database**: `spells_us.txt` (74k rows; decoded —
  16 class-level columns, duration formula/cap, beneficial flag, target/resist
  type) + `spells_us_str.txt` (cast-on-you / cast-on-other / wear-off message
  per spell) + `eqstr_us.txt` (hardcoded lines). Extractor:
  `tools/spelldata/extract_spells.py` → 59,114 spells emitted; 2,037 castable
  by players ≤60; 807 castable buffs with durations; 28,333 wear-off messages
  (collapsing to 4,357 distinct strings — collisions must be deduped).
- **Hardcoded strings verified in eqstr_us.txt**: summon (1393), enrage pair
  (1042/1043), invis break (275), FD fall (1456), rez xp (289), encumbered
  (12392), hunger/thirst (12485/12487), mez break ("%1 has been awakened."
  8053 / "by %2." 9037). Bogus lines ruled out ("You feel the need to get
  up." absent).
- **Community curation** (P99/Quarm packs, Fabio's 987-trigger GINA pack,
  class threads): per-class essential sets collected — enchanter mez landing
  lines + durations, charm/root break, FD fail/stand, resist lines, backstab,
  taunt, SoW/Clarity fade lines, etc. Danger-cast taxonomy for enemy casts:
  Death Touch / Complete Heal / Gate / Fear / Charm / Mez / Dispel /
  Lifetap / AoE / Root-Snare / Debuff.
- **Organization model to copy**: EQLogParser decouples enable state from
  definitions (character + node composite key); GINA-style tree with
  tri-state group checkboxes.

## A. Data model (eqlog-triggers)

- `Trigger` gains: `id` (stable slug), `classes: Vec<Class>` (empty = all),
  `source: Generated | Curated | User | GinaImport`, `default_enabled: bool`.
  Category stays the tree path: `"Class/Enchanter/Mez"`, `"Enemy Casts/Gate"`,
  `"Universal/Survival"`.
- **Enable resolution decoupled from definitions** (per character):
  `profile.json` per character: `{ classes: [up to 3], overrides: { <trigger-id|group-path>: bool } }`.
  Effective = most-specific override, else group override (deepest wins), else
  `default_enabled && (trigger.classes ∩ profile.classes ≠ ∅ || classes empty)`.
- **LOADOUTS (user requirement, mirrors the in-game loadout system)**: a
  character profile owns multiple named loadouts; each loadout = name + up to
  3 classes + its own complete overrides map (the enable-state above lives
  PER LOADOUT, not per character). `{ character, level, active_loadout,
  loadouts: [{ name, classes, overrides }] }`. Top-bar dropdown switches the
  active loadout and hot-reloads the running trigger engine (no restart).
  "Duplicate loadout" for cheap variants; class auto-detect can seed a new
  loadout's classes. Migration: a bare single-profile file loads as one
  loadout named "Default".
- **Class auto-detect**: watch "You begin casting X" lines, look up X's
  classes in spell data, intersect over time → suggest the character's 3
  classes automatically (confirmable in UI).

## B. Generation pipeline (`tools/spelldata/`)

Build-time generator (python, committed; output packs committed) emits:

1. `triggers/generated/buffs-<class>.json` — for each castable beneficial
   spell with duration: cast-start timer ("You begin casting X." →
   StartTimer, duration from formula at profile level, warn at 10%/6s min)
   + wear-off Speak (deduped by message; collision → name the likely spell,
   tag all candidates).
2. `triggers/generated/enemy-casts.json` — "^(.+) begins casting (…)\.$"
   grouped by danger taxonomy; merged alternations per group for regex
   efficiency. Tier-1 (default on): Gate, Complete Heal, death touches,
   fears, charms, dispels on raid targets. Everything else present, off.
3. `triggers/curated/universal.json` — the verified hardcoded-string set:
   summon, enrage/enrage-over, invis break, FD fall/stand, mez break, rez,
   death lines, tells (+GM), encumbered, hunger/thirst, resist alerts,
   skill-ups. Tier-1 by default.
4. `triggers/curated/<class>.json` — 16 class packs from community research:
   class-defining moments (mez landing timers with real durations, charm
   break, root break, FD, backstab misses, taunt fail, Yaulp, song fizzle…).
   Tier-1 subset on when the class is in the profile.

Volume estimate: ~60–100 default-on for a typical tri-class profile; ~3–5k
available in the library. RegexSet fast-reject handles this; collision-heavy
groups use merged alternations.

## C. Engine changes

- Trigger ids + enable-resolution layer + profile loading.
- Character level in profile → timer durations computed per level.
- Group-level match dedupe (one line firing N sibling generated triggers →
  one action).

## D. UI (Triggers tab v2)

- Tree with tri-state checkboxes: Archetype → Class → Category → trigger;
  search across names/patterns; per-group counts ("Enchanter · 47 on / 470").
- "My classes" quick setup: pick (or accept auto-detected) 3 classes → one
  click enables Universal + those classes' tier-1 sets.
- Existing: quick-trigger-from-live-line feeds `Custom/` (in progress).

## E. Sequencing

1. Generator emits packs (universal + enemy-casts + per-class) ✚ tests.
2. Engine: ids, profile, enable resolution, dedupe.
3. UI tree + profile setup + auto-detect.
4. App wiring (profile file, level setting) + docs.
