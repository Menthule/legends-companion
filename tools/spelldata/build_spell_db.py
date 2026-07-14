#!/usr/bin/env python3
"""Append spell/ability reference tables to the bundled drops.sqlite.

Reads the EQ Legends client spell file (`fixtures/local/spells_us.txt`,
caret-delimited, 173 fields/row — same file extract_spells.py parses) plus
`spells_us_str.txt` (per-spell log messages) and adds two tables to the
EXISTING `assets/data/drops.sqlite` without touching the drop-research
tables:

    spells         — one row per castable spell/ability: costs, timings,
                     level-50 duration estimate, targeting, log messages.
                     Learned skills absent from spells_us are merged from
                     the maintained ACTIVE_SKILLS catalog below.
    spell_classes  — (spell_id, class, level) for the 16 Legends classes

Column map (0-based field indices, empirically verified against classic
spells: Spirit of Wolf 4500 ms cast / 40 mana / formula 3 cap 360;
Root 2000 ms / 30 mana / resist 1 magic; Superior Healing Clr 30 / 185
mana; Provoke 85 endurance; Unholy Aura Discipline 900 endurance):

    0   id                  30  target type
    1   name                32  casting skill (5 Alteration, 18 Divination,
    4   range                   33 Offense, 41/49/54/70/12 bard instruments)
    8   cast time (ms)      36..51  class min levels (255 unusable,
    10  recast time (ms)            254 NPC-only)
    11  duration formula    96  endurance cost
    12  duration cap        97  endurance timer index
        (ticks, 6 s each)   98  discipline flag (1 disc/combat ability,
    14  mana                        2 rogue poison-craft ability, 0 spell)
    28  beneficial          100 endurance upkeep (per tick)
    29  resist type

Row filter (classic-era relevance; Legends level cap 50):
  * castable by at least one of the 16 classes at level 1..60
  * name non-empty, no " Rk." rank copies, no "N/A"/"AA" placeholders

is_ability heuristic: this file format DOES carry endurance (field 96,
verified above), so is_ability = 1 when endurance cost > 0 OR endurance
upkeep (field 100) > 0 OR the discipline flag (field 98) is non-zero.
The flag catches upkeep-only/free disciplines (e.g. Fearless Discipline,
rogue poison crafting, Mercenary Taunt) that cost no endurance up front;
in this data every endurance-costing row also has the flag set, but both
are checked for safety. Everything else (including bard songs) is a
mana spell (is_ability = 0). Active combat/utility skills such as Kick and
Flying Kick do not exist as class-usable rows in spells_us; maintained rows
use negative IDs and is_ability = 1 so they share the Abilities UI without
colliding with client spell IDs.

duration_secs is a level-50 estimate via extract_spells.calc_duration_ticks
(1 tick = 6 s); 432000 means "permanent until dispelled".

Run:  python3 tools/spelldata/build_spell_db.py
      (assets/data/drops.sqlite must already exist — build it first with
      tools/dropdata/build_drops_db.py)
"""
import os
import sqlite3
import sys

from extract_spells import calc_duration_ticks, load_strings, parse_int

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DB = os.path.join(REPO_ROOT, "assets", "data", "drops.sqlite")
SPELLS = os.path.join(REPO_ROOT, "fixtures", "local", "spells_us.txt")
STRINGS = os.path.join(REPO_ROOT, "fixtures", "local", "spells_us_str.txt")

REFERENCE_LEVEL = 50   # caster level for the duration estimate
MAX_CLASS_LEVEL = 60   # keep spells some class gets at or below this level

# Field 36..51 order (standard EQ class order, Legends' 16-class roster).
CLASSES = [
    "Warrior", "Cleric", "Paladin", "Ranger", "ShadowKnight", "Druid",
    "Monk", "Bard", "Rogue", "Shaman", "Necromancer", "Wizard",
    "Magician", "Enchanter", "Beastlord", "Berserker",
]
CLASS_LEVEL_FIELD_BASE = 36

# Learned skill buttons are not represented as class-usable rows in the
# client spell file. Keep this deliberately small: active, class-granted
# skills that belong beside disciplines in the Abilities browser. Levels are
# from the EverQuest Legends class skill tables (reviewed 2026-07-14):
# https://eqlwiki.com/Skills plus the linked class pages.
# Negative IDs reserve a namespace that cannot collide with client spell IDs.
#
# Row fields: (id, name, classes-and-levels, recast_ms, target_type,
#              beneficial). A zero recast means the reference only documents
# a shared/named timer, not a reliable numeric cooldown.
ACTIVE_SKILLS = [
    (-1, "Bash", (("Warrior", 6), ("Paladin", 6),
                  ("ShadowKnight", 6)), 8_000, 5, 0),
    (-2, "Kick", (("Warrior", 1), ("Ranger", 5), ("Monk", 1),
                  ("Bard", 17)), 0, 5, 0),
    (-3, "Cleave", (("Warrior", 5),), 12_000, 5, 0),
    (-4, "Smite", (("Paladin", 9),), 0, 5, 0),
    (-5, "Reave", (("ShadowKnight", 9),), 0, 5, 0),
    (-6, "Backstab", (("Rogue", 10),), 10_000, 5, 0),
    (-7, "Frenzy", (("Berserker", 1),), 0, 5, 0),
    (-8, "Mend", (("Monk", 1),), 0, 6, 1),
    (-9, "Round Kick", (("Monk", 5),), 0, 5, 0),
    (-10, "Tiger Claw", (("Monk", 10),), 0, 5, 0),
    (-11, "Feign Death", (("Monk", 17),), 0, 6, 1),
    (-12, "Eagle Strike", (("Monk", 20),), 0, 5, 0),
    (-13, "Dragon Punch", (("Monk", 25),), 0, 5, 0),
    (-14, "Tail Rake", (("Monk", 25),), 0, 5, 0),
    (-15, "Flying Kick", (("Monk", 30),), 0, 5, 0),
]


def append_active_skills(spell_rows: list, class_rows: list) -> None:
    """Merge maintained learned skills, deferring to real ability rows."""
    real_ability_names = {
        row[1].casefold() for row in spell_rows if row[3] == 1
    }
    for sid, name, classes, recast_ms, target_type, beneficial in ACTIVE_SKILLS:
        if name.casefold() in real_ability_names:
            continue
        spell_rows.append((
            sid, name, name.lower(), 1,
            0, 0, 0, recast_ms, 0, 0, target_type, 0, 0, beneficial,
            "", "", "",
        ))
        class_rows.extend((sid, cls, lvl) for cls, lvl in classes)


def validate_active_skills(db: sqlite3.Connection) -> None:
    """Fail the build if a maintained skill or class mapping was lost."""
    for _, name, expected_classes, _, _, _ in ACTIVE_SKILLS:
        row = db.execute(
            "SELECT id FROM spells WHERE name = ? AND is_ability = 1 "
            "ORDER BY id < 0 DESC LIMIT 1",
            (name,),
        ).fetchone()
        if row is None:
            raise RuntimeError(f"missing maintained active skill: {name}")
        actual_classes = tuple(db.execute(
            "SELECT class, level FROM spell_classes WHERE spell_id = ? "
            "ORDER BY class",
            (row[0],),
        ).fetchall())
        expected_sorted = tuple(sorted(expected_classes))
        if actual_classes != expected_sorted:
            raise RuntimeError(
                f"bad class mappings for {name}: "
                f"expected {expected_sorted}, got {actual_classes}"
            )


def keep_name(name: str) -> bool:
    """Drop rank copies and placeholder/test junk."""
    if not name:
        return False
    if " Rk." in name:
        return False
    if name.startswith(("N/A", "AA")):
        return False
    # Live-file leftovers: internal QA spells ("BetaTestSpell01 Test Heal
    # 20k Group 199990010 Subgroup...") are castable-flagged and slip the
    # other filters.
    lower = name.lower()
    if lower.startswith(("betatest", "test ")) or " test " in lower:
        return False
    return True


def main() -> int:
    if not os.path.exists(DB):
        print(f"missing {DB} — run tools/dropdata/build_drops_db.py first",
              file=sys.stderr)
        return 2

    strings = load_strings(STRINGS)

    spell_rows = []
    class_rows = []
    with open(SPELLS, encoding="latin-1") as f:
        for line in f:
            fl = line.rstrip("\r\n").split("^")
            if len(fl) < 173:
                continue
            name = fl[1].strip()
            if not keep_name(name):
                continue

            classes = []
            for i, cls in enumerate(CLASSES):
                lvl = parse_int(fl[CLASS_LEVEL_FIELD_BASE + i])
                if 1 <= lvl <= MAX_CLASS_LEVEL:
                    classes.append((cls, lvl))
            if not classes:
                continue

            sid = parse_int(fl[0])
            mana = parse_int(fl[14])
            endurance = parse_int(fl[96])
            end_upkeep = parse_int(fl[100])
            disc_flag = parse_int(fl[98])
            is_ability = 1 if (endurance > 0 or end_upkeep > 0
                               or disc_flag != 0) else 0

            ticks = calc_duration_ticks(parse_int(fl[11]), parse_int(fl[12]),
                                        REFERENCE_LEVEL)
            casted_me, casted_other, spell_gone, _, _ = \
                strings.get(sid, ("", "", "", "", ""))

            spell_rows.append((
                sid, name, name.lower(), is_ability,
                mana, endurance,
                parse_int(fl[8]), parse_int(fl[10]),
                ticks * 6,
                parse_int(fl[4]), parse_int(fl[30]), parse_int(fl[29]),
                parse_int(fl[32]), 1 if fl[28] == "1" else 0,
                casted_me, casted_other, spell_gone,
            ))
            class_rows.extend((sid, cls, lvl) for cls, lvl in classes)

    append_active_skills(spell_rows, class_rows)

    db = sqlite3.connect(DB)
    db.executescript(
        """
        DROP TABLE IF EXISTS spells;
        DROP TABLE IF EXISTS spell_classes;
        CREATE TABLE spells(
            id INTEGER PRIMARY KEY, name TEXT, name_lc TEXT,
            is_ability INTEGER,
            mana INTEGER, endurance INTEGER,
            cast_time_ms INTEGER, recast_ms INTEGER,
            duration_secs INTEGER,
            spell_range INTEGER, target_type INTEGER, resist_type INTEGER,
            skill INTEGER, beneficial INTEGER,
            cast_on_you TEXT, cast_on_other TEXT, wear_off TEXT);
        CREATE TABLE spell_classes(
            spell_id INTEGER, class TEXT, level INTEGER,
            PRIMARY KEY (spell_id, class));
        CREATE INDEX spells_name_idx ON spells(name_lc);
        CREATE INDEX spell_classes_idx ON spell_classes(class, level);
        """
    )
    db.executemany(
        "INSERT INTO spells VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        spell_rows,
    )
    db.executemany("INSERT INTO spell_classes VALUES (?,?,?)", class_rows)
    db.commit()
    validate_active_skills(db)

    n_abil = db.execute(
        "SELECT COUNT(*) FROM spells WHERE is_ability = 1").fetchone()[0]
    print(f"  spells: {len(spell_rows)} rows "
          f"({len(spell_rows) - n_abil} spells, {n_abil} abilities)",
          file=sys.stderr)
    print(f"  spell_classes: {len(class_rows)} rows", file=sys.stderr)
    db.execute("VACUUM")
    db.close()
    print(f"wrote {DB} ({os.path.getsize(DB) // 1024} KB)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
