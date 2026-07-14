// The 16 EverQuest Legends classes — the ONE roster definition. types.ts,
// lib/refFilters.ts, and SpellsTab used to each carry their own copy of this
// ordered, DB-spelling-sensitive list; any roster or spelling change happens
// here and nowhere else.
//
// Spellings are exactly what the reference DB and trigger packs store —
// NOTE: "ShadowKnight" with no space (spell_classes.class, pack `classes`
// arrays).

/** The 16 Legends classes in bitmask order (bit i = 1 << i). */
export const CLASS_FULL = [
  "Warrior", "Cleric", "Paladin", "Ranger", "ShadowKnight", "Druid",
  "Monk", "Bard", "Rogue", "Shaman", "Necromancer", "Wizard",
  "Magician", "Enchanter", "Beastlord", "Berserker",
];

/** Display codes, same bitmask order as CLASS_FULL. */
export const CLASS_ABBR = [
  "WAR", "CLR", "PAL", "RNG", "SHD", "DRU", "MNK", "BRD",
  "ROG", "SHM", "NEC", "WIZ", "MAG", "ENC", "BST", "BER",
];

export const CLASS_NAME_TO_BIT: Record<string, number> = Object.fromEntries(
  CLASS_FULL.map((n, i) => [n, i]),
);

/** The same roster alphabetically — for pickers (loadout class dropdowns,
 *  trigger class filters). */
export const CLASS_NAMES: readonly string[] = [...CLASS_FULL].sort();
