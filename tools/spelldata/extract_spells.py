#!/usr/bin/env python3
"""Extract trigger-relevant spell data from EverQuest Legends client files.

Parses the modern (post-2018 "trimmed") caret-delimited spells_us.txt format
(EQ Legends ships 173 fields/row; field indices 0-52 match EQSpellParser's
"current" format and were verified empirically against classic spells) plus
spells_us_str.txt (per-spell log messages) and emits a JSON summary suitable
for auto-generating trigger packs: buff wear-off alerts, buff duration
timers, and enemy-cast warnings, tagged by class.

Column map (empirically verified — see tools/spelldata/README notes in repo
docs or the task report):
    0   id
    1   name
    4   range
    5   AE range
    8   cast time (ms)
    9   recovery time (ms)
    10  recast time (ms)
    11  duration formula
    12  duration cap (ticks; 1 tick = 6 s)
    14  mana
    28  beneficial (1) / detrimental (0)
    29  resist type (0 unresistable, 1 magic, 2 fire, 3 cold, 4 poison,
        5 disease, ...)
    30  target type (see TARGET_TYPES)
    36..51  class min levels, 255 = unusable (254 = NPC-only copies)
    84  bard song window flag

spells_us_str.txt columns:
    0 SPELLINDEX  1 CASTERMETXT  2 CASTEROTHERTXT  3 CASTEDMETXT
    4 CASTEDOTHERTXT  5 SPELLGONE

Usage:
    python3 extract_spells.py [--spells PATH] [--strings PATH]
                              [--out PATH] [--level N] [--max-level N]

Defaults read from <repo>/fixtures/local/ and write
<repo>/fixtures/local/spell_summary.json.
"""

import argparse
import json
import os
import sys
from collections import Counter

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

CLASSES = [
    "warrior", "cleric", "paladin", "ranger", "shadowknight", "druid",
    "monk", "bard", "rogue", "shaman", "necromancer", "wizard",
    "magician", "enchanter", "beastlord", "berserker",
]
CLASS_LEVEL_FIELD_BASE = 36  # fields 36..51

TARGET_TYPES = {
    1: "line_of_sight", 2: "caster_ae", 3: "group_v1", 4: "pb_ae",
    5: "single", 6: "self", 8: "targeted_ae", 9: "animal", 10: "undead",
    11: "summoned", 13: "lifetap", 14: "pet", 15: "corpse", 16: "plant",
    17: "giant", 18: "dragon", 20: "targeted_ae_lifetap",
    21: "targeted_ae_undead", 25: "targeted_ae_summoned", 32: "hatelist",
    33: "hatelist2", 34: "chest", 36: "pb_ae_players", 37: "pb_ae_npc",
    38: "pet2", 39: "no_pets", 40: "ae_players", 41: "group",
    42: "directional_ae", 43: "single_in_group", 44: "frontal_ae",
    45: "target_ring_ae", 46: "targets_target", 47: "pet_owner",
    50: "targeted_ae_no_players_pets", 51: "single", 52: "single_or_tt",
}

RESIST_TYPES = {
    0: "unresistable", 1: "magic", 2: "fire", 3: "cold", 4: "poison",
    5: "disease", 6: "chromatic", 7: "prismatic", 8: "physical",
    9: "corruption",
}


def calc_duration_ticks(formula: int, cap: int, level: int) -> int:
    """Classic EQ buff duration formula -> duration in ticks (1 tick = 6 s).

    Semantics (verified against EQSpellParser Spell.CalcDuration and
    sanity-checked empirically: SoW formula 3 cap 360 -> 36 min at 50+;
    Root formula 2 cap 8 -> 48 s; Courage formula 11 cap 270 -> 27 min):
    the formula produces a level-scaled tick count which is then clamped
    to the cap (field 12) when the cap is non-zero.
    """
    if formula == 0:
        value = 0
    elif formula == 1:
        value = max(level // 2, 1)
    elif formula == 2:
        value = max((level // 2) + 5, 6)
    elif formula == 3:
        value = level * 30
    elif formula == 4:
        value = 50
    elif formula == 5:
        value = 2
    elif formula == 6:
        value = level // 2
    elif formula == 7:
        value = level
    elif formula == 8:
        value = level + 10
    elif formula == 9:
        value = level * 2 + 10
    elif formula == 10:
        value = level * 30 + 10
    elif formula == 11:
        value = (level + 3) * 30
    elif formula == 12:
        value = max(level // 2, 1)
    elif formula == 13:
        value = level * 4 + 10
    elif formula == 14:
        value = level * 5 + 10
    elif formula == 15:
        value = (level * 5 + 50) * 2
    elif formula == 50:
        value = 72000  # "permanent" (until dispelled/zoned)
    elif formula == 3600:
        value = 3600
    else:
        value = cap
    if cap > 0 and value > cap:
        value = cap
    return value


def parse_int(s: str) -> int:
    try:
        return int(s)
    except ValueError:
        try:
            return int(float(s))
        except ValueError:
            return 0


def load_strings(path: str) -> dict:
    """spell id -> (casted_me, casted_other, spell_gone, caster_me, caster_other)."""
    out = {}
    with open(path, encoding="latin-1") as f:
        for line in f:
            if line.startswith("#"):
                continue
            fl = line.rstrip("\r\n").split("^")
            if len(fl) < 6:
                continue
            try:
                sid = int(fl[0])
            except ValueError:
                continue
            out[sid] = (fl[3], fl[4], fl[5], fl[1], fl[2])
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--spells",
                    default=os.path.join(REPO_ROOT, "fixtures", "local", "spells_us.txt"))
    ap.add_argument("--strings",
                    default=os.path.join(REPO_ROOT, "fixtures", "local", "spells_us_str.txt"))
    ap.add_argument("--out",
                    default=os.path.join(REPO_ROOT, "fixtures", "local", "spell_summary.json"))
    ap.add_argument("--level", type=int, default=50,
                    help="reference caster level for duration estimate (default 50)")
    ap.add_argument("--max-level", type=int, default=60,
                    help="include spells any class can cast at or below this level (default 60)")
    args = ap.parse_args()

    strings = load_strings(args.strings)

    spells = []
    total_rows = 0
    per_class = Counter()
    n_wear_off = 0
    n_cast_msgs = 0

    with open(args.spells, encoding="latin-1") as f:
        for line in f:
            fl = line.rstrip("\r\n").split("^")
            if len(fl) < 173:
                continue
            total_rows += 1
            sid = parse_int(fl[0])
            name = fl[1].strip()

            classes = {}
            for i, cls in enumerate(CLASSES):
                lvl = parse_int(fl[CLASS_LEVEL_FIELD_BASE + i])
                if 1 <= lvl <= args.max_level:
                    classes[cls] = lvl

            casted_me, casted_other, spell_gone, caster_me, caster_other = \
                strings.get(sid, ("", "", "", "", ""))

            has_msgs = bool(casted_me or casted_other or spell_gone)
            if not classes and not has_msgs:
                continue
            if not name:
                continue

            beneficial = fl[28] == "1"
            formula = parse_int(fl[11])
            cap = parse_int(fl[12])
            ticks = calc_duration_ticks(formula, cap, args.level)

            entry = {
                "id": sid,
                "name": name,
                "classes": classes,
                "beneficial": beneficial,
                "target_type": TARGET_TYPES.get(parse_int(fl[30]),
                                                f"unknown_{fl[30]}"),
                "resist_type": RESIST_TYPES.get(parse_int(fl[29]),
                                                f"unknown_{fl[29]}"),
                "cast_time_secs": parse_int(fl[8]) / 1000.0,
                "recast_time_secs": parse_int(fl[10]) / 1000.0,
                "duration_formula": formula,
                "duration_cap_ticks": cap,
                "duration_secs_estimate": ticks * 6,
                "bard_song": fl[84] == "1",
                "wear_off_message": spell_gone,
                "cast_on_you_message": casted_me,
                "cast_on_other_message": casted_other,
            }
            spells.append(entry)

            for cls in classes:
                per_class[cls] += 1
            if spell_gone:
                n_wear_off += 1
            if casted_me or casted_other:
                n_cast_msgs += 1

    summary = {
        "source": {
            "spells_file": args.spells,
            "strings_file": args.strings,
            "reference_level": args.level,
            "max_class_level": args.max_level,
        },
        "counts": {
            "total_rows_in_file": total_rows,
            "spells_emitted": len(spells),
            "with_wear_off_message": n_wear_off,
            "with_cast_message": n_cast_msgs,
            "castable_by_some_class": sum(1 for s in spells if s["classes"]),
            "per_class": dict(sorted(per_class.items())),
        },
        "spells": spells,
    }

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=1)

    c = summary["counts"]
    print(f"rows in file:            {c['total_rows_in_file']}", file=sys.stderr)
    print(f"spells emitted:          {c['spells_emitted']}", file=sys.stderr)
    print(f"  with wear-off message: {c['with_wear_off_message']}", file=sys.stderr)
    print(f"  with cast message:     {c['with_cast_message']}", file=sys.stderr)
    print(f"  castable by a class:   {c['castable_by_some_class']}", file=sys.stderr)
    for cls, n in sorted(per_class.items()):
        print(f"    {cls:13} {n}", file=sys.stderr)
    print(f"wrote {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
