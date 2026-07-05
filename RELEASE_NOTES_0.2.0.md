# Legends Companion 0.2.0 — "The Database Update"

Legends Companion grows from a log parser into a full reference companion:
six searchable databases, log-aware loot tools, and a data channel that
updates reference content without reinstalling.

## The Database (new sidebar section)

- **Drops** — search 54k items / 152k drop links from classic-era reference
  data (ProjectEQ): who drops it, where, at what chance; sold-by vendors;
  crafting cross-links; smart search with typed suggestions (effects,
  zones, slots, classes); filter chips; configurable, fully sortable
  columns (incl. damage ratio and haste); item-type icons.
- **Mobs** — any mob's full loot table, level, faction, spawn zones,
  respawn time; per-zone almanac (connections, forage, fishing, named
  mobs).
- **Recipes** — 8.8k tradeskill recipes with per-component farming hints
  (best drop or vendor).
- **Spells & Abilities** — every castable (2k+) with class/level tables,
  costs, cast/recast, resists, and *where to get the scroll* (drops and
  vendors). Abilities = endurance-based disciplines.
- **Macros** — 63 researched, battle-tested in-game socials with a guided
  line-by-line copy flow, plus an 88-entry slash-command reference.
- **Global filters** — era ceiling and multi-class selection (with a
  one-click "my loadout" preset) apply across every database tab.

## Log ↔ database features

- **Wishlist** — star items; when one drops in your log, the app says so.
- **Camp timers** — kill a named mob and a respawn countdown starts
  automatically (persists across restarts, announces when due).
- **Session kills** — per-mob kill counts with live kills/hour.
- **Loot → database deep links** — click any looted item, drop source,
  or vendor to jump to its page.

## Triggers & alerts

- Crowd-control alerts on you — root, snare, mez, fear, charm, spell stun —
  spoken by default, with wear-off calls, using log-verified Legends spell
  texts (alert budget audited: ~19 spoken/hour on the reference log).
- Dead mobs now always clear their DoT bars; re-buffing someone replaces
  the bar instead of stacking duplicates; same-mob timers group correctly
  regardless of log capitalization.
- Buff-bar show threshold (optional): hide long buffs until their last N
  minutes on the overlays.

## Overlays & UX

- Stance & invocation overlay: side-by-side with mono glyphs (Lucide),
  baseline states muted, window auto-sizes to content.
- Alert text size setting; XP overlay live per-hour rate + session reset.
- Settings reorganized into sub-tabs (General / Loadouts / Overlays /
  Appearance / Updates); TTS voice picker with test button.

## Updates

- **App updates**: existing signed auto-updater, now surfaced in
  Settings → Updates.
- **Data updates (new)**: reference database + trigger packs download from
  the `data-latest` release channel — hash-verified, atomic install, no
  reinstall needed.

## Fixes

- Portable-mode false positive that silently redirected app data (dev
  builds); overlay grouping/casing; effect sort with haste; SQLite
  parameter-count errors; Settings width; column alignment; and more.

---

Reference data is classic-era emulator data (ProjectEQ) — a guide to where
to hunt, not exact Legends numbers. See `assets/data/DATA_SOURCES.md`.
