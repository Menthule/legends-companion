#!/usr/bin/env python3
"""Build the bundled drops-research SQLite from a PEQ (ProjectEQ) SQL dump.

Reads the era-locked PEQ "Luclin release" MySQL dump (SourceForge,
`peq-luclin-release/load_system.sql`) and emits `assets/data/drops.sqlite`
with a slim item → mob → zone drop graph the app's Drops tab queries:

    items      — one row per item, useful stat columns only
                 (+ scroll_spell_id: learnable-scroll spell id, else 0)
    npcs       — one row per NPC (display name cleaned of underscores/#;
                 + named flag, merchant_id, primary faction name)
    npc_zones  — where each NPC spawns (via spawn2 → spawngroup →
                 spawnentry; + avg respawn seconds per npc+zone)
    drops      — (item, npc, effective drop %) from the loottable chain
    zones      — short/long name + era tag (0 classic, 1 kunark, 2 velious,
                 3 luclin/other) so the UI can filter to the Legends era
    vendor_items      — (npc, item) merchant inventories via merchantlist
    recipes           — tradeskill recipes (name, skill, trivial, no_fail)
    recipe_components — (recipe, item, componentcount)
    recipe_results    — (recipe, item, successcount)
    zone_forage       — (zone short name, item, chance)
    zone_fishing      — (zone short name, item, chance)
    zone_connections  — deduped (from_zone, to_zone) via zone_points
    meta       — provenance strings shown in the UI credit line

Effective drop % per (loottable entry, lootdrop entry) is approximated as
`probability% x chance% / 100` (capped 100) — right ballpark for a research
tool, not a loot simulator. NPCs are kept when they spawn somewhere, drop
something, or carry a merchant list, so quest/GM leftovers don't pollute
searches but every real vendor survives.

This data is CLASSIC-ERA EMULATOR data (ProjectEQ, GPL-listed, community
maintained): item stats will not match EverQuest Legends' merged/augmented
itemization, but names, sources, and zones are close. Label it as reference
data in the UI.

Run:  python3 tools/dropdata/build_drops_db.py <path-to-load_system.sql>
"""
import os
import re
import sqlite3
import sys

# Trash mobs read as "a/an/the <thing>" (lowercase article); rares are
# proper-named ("Lord Bergurgle"). This is the reliable EQ "named" signal —
# PEQ's own data only '#'-prefixes a handful of mobs, so the naming
# convention is what actually distinguishes rares. Computed ONCE here so the
# app reads a clean `named` boolean from the DB instead of guessing at runtime.
_ARTICLE_RE = re.compile(r"^(an?|the|some|several|a group of)\s", re.IGNORECASE)


def is_named_mob(raw: str) -> bool:
    """True when a raw npc_types.name denotes a named/rare spawn."""
    if raw.startswith("#"):  # PEQ's explicit named marker — keep it
        return True
    n = raw.lstrip("#!").replace("_", " ").strip()
    if not n or _ARTICLE_RE.match(n):
        return False
    return n[0].isupper()

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(REPO_ROOT, "assets", "data", "drops.sqlite")
SPELLS = os.path.join(REPO_ROOT, "fixtures", "local", "spells_us.txt")


def load_spell_names():
    """id -> spell name from the caret-delimited client spell file."""
    names = {}
    with open(SPELLS, encoding="latin-1") as f:
        for line in f:
            parts = line.split("^", 2)
            if len(parts) >= 2 and parts[0].isdigit() and parts[1]:
                names[int(parts[0])] = parts[1]
    return names

TABLES = {
    "items", "npc_types", "loottable", "loottable_entries",
    "lootdrop", "lootdrop_entries", "spawngroup", "spawnentry",
    "spawn2", "zone",
    "merchantlist", "tradeskill_recipe", "tradeskill_recipe_entries",
    "forage", "fishing", "zone_points",
    "npc_faction", "npc_faction_entries", "faction_list",
}

CLASSIC = {
    "qeynos", "qeynos2", "qrg", "qeytoqrg", "highpass", "highkeep",
    "freportn", "freportw", "freporte", "runnyeye", "qey2hh1",
    "northkarana", "southkarana", "eastkarana", "beholder", "blackburrow",
    "paw", "rivervale", "kithicor", "commons", "ecommons", "erudnint",
    "erudnext", "nektulos", "cshome", "lavastorm", "halas", "everfrost",
    "soldunga", "soldungb", "soltemple", "misty", "nro", "sro", "befallen",
    "oasis", "tox", "neriaka", "neriakb", "neriakc", "najena", "innothule",
    "feerrott", "cazicthule", "oggok", "rathemtn", "lakerathe", "grobb",
    "gukta", "gfaydark", "akanon", "steamfont", "lfaydark", "crushbone",
    "mistmoore", "kaladima", "felwithea", "felwitheb", "unrest", "kedge",
    "guktop", "gukbottom", "kaladimb", "butcher", "oot", "cauldron",
    "airplane", "fearplane", "permafrost", "kerraridge", "hateplane",
    "arena", "arena2", "erudsxing", "qcat", "hole", "paineel",
}
KUNARK = {
    "fieldofbone", "warslikswood", "droga", "cabwest", "cabeast",
    "swampofnohope", "firiona", "lakeofillomen", "dreadlands",
    "burningwood", "kaesora", "sebilis", "citymist", "skyfire",
    "frontiermtns", "overthere", "emeraldjungle", "trakanon", "timorous",
    "kurn", "karnor", "chardok", "dalnir", "charasis", "nurga", "veeshan",
}
VELIOUS = {
    "iceclad", "frozenshadow", "velketor", "kael", "skyshrine",
    "thurgadina", "thurgadinb", "eastwastes", "westwastes", "greatdivide",
    "wakening", "cobaltscar", "crystal", "necropolis", "templeveeshan",
    "sirens", "mischiefplane", "growthplane", "sleeper", "stonebrunt",
    "warrens",
}


def zone_era(short_name: str) -> int:
    if short_name in CLASSIC:
        return 0
    if short_name in KUNARK:
        return 1
    if short_name in VELIOUS:
        return 2
    return 3


def parse_values(s: str):
    """Parse one MySQL `(...)` tuple body into a list of str/None values."""
    vals, i, n = [], 0, len(s)
    while i < n:
        c = s[i]
        if c in ", ":
            i += 1
            continue
        if c == "'":
            i += 1
            buf = []
            while i < n:
                c = s[i]
                if c == "\\" and i + 1 < n:
                    nxt = s[i + 1]
                    buf.append({"n": "\n", "r": "\r", "t": "\t", "0": "\0"}.get(nxt, nxt))
                    i += 2
                    continue
                if c == "'":
                    i += 1
                    break
                buf.append(c)
                i += 1
            # Some strings in the old dumps are double-escaped ("Erud\\\'s"),
            # which leaves a stray backslash before the quote after one
            # unescape pass. A backslash-quote never occurs in real EQ names.
            vals.append("".join(buf).replace("\\'", "'"))
        else:
            j = i
            while j < n and s[j] != ",":
                j += 1
            tok = s[i:j].strip()
            vals.append(None if tok == "NULL" else tok)
            i = j
    return vals


def read_dump(path: str):
    """Yield (table, values) rows for the tables we want; also collect the
    column order per table from the CREATE TABLE blocks."""
    columns = {}
    cur_create = None
    with open(path, encoding="latin-1") as f:
        for line in f:
            if line.startswith("CREATE TABLE "):
                name = line.split()[2].strip("`(")
                cur_create = name if name in TABLES else None
                if cur_create:
                    columns[cur_create] = []
                continue
            if cur_create:
                stripped = line.strip()
                if stripped.startswith(")"):
                    cur_create = None
                elif stripped and not stripped.startswith(("PRIMARY", "KEY", "UNIQUE")):
                    columns[cur_create].append(stripped.split()[0].strip("`"))
                continue
            if line.startswith("INSERT INTO "):
                table = line.split()[2].strip("`")
                if table not in TABLES:
                    continue
                open_p = line.index("(")
                body = line.rstrip()
                assert body.endswith(");"), f"multi-line insert in {table}"
                yield table, columns, parse_values(body[open_p + 1:-2])


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    dump = sys.argv[1]

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    if os.path.exists(OUT):
        os.remove(OUT)
    db = sqlite3.connect(OUT)
    db.executescript(
        """
        CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE zones(
            short_name TEXT PRIMARY KEY, long_name TEXT, era INTEGER);
        CREATE TABLE items(
            id INTEGER PRIMARY KEY, name TEXT, name_lc TEXT,
            itemtype INTEGER, slots INTEGER, classes INTEGER, races INTEGER,
            ac INTEGER, hp INTEGER, mana INTEGER,
            astr INTEGER, asta INTEGER, aagi INTEGER, adex INTEGER,
            awis INTEGER, aint INTEGER, acha INTEGER,
            damage INTEGER, delay INTEGER, magic INTEGER,
            no_drop INTEGER, no_rent INTEGER, loregroup INTEGER,
            weight INTEGER, reqlevel INTEGER, source_count INTEGER,
            haste INTEGER,
            proc_name TEXT, click_name TEXT, worn_name TEXT, focus_name TEXT,
            effects_lc TEXT,
            scroll_spell_id INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX items_name ON items(name_lc);
        CREATE TABLE npcs(
            id INTEGER PRIMARY KEY, name TEXT, level INTEGER,
            loottable_id INTEGER,
            named INTEGER NOT NULL DEFAULT 0,
            merchant_id INTEGER NOT NULL DEFAULT 0,
            faction TEXT);
        CREATE TABLE npc_zones(
            npc_id INTEGER, zone TEXT, spawns INTEGER,
            respawn_secs INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(npc_id, zone));
        CREATE TABLE drops(
            item_id INTEGER, npc_id INTEGER, chance REAL,
            PRIMARY KEY(item_id, npc_id));
        CREATE TABLE vendor_items(
            npc_id INTEGER, item_id INTEGER,
            PRIMARY KEY(npc_id, item_id));
        CREATE TABLE recipes(
            id INTEGER PRIMARY KEY, name TEXT, name_lc TEXT,
            tradeskill INTEGER, trivial INTEGER, no_fail INTEGER);
        CREATE TABLE recipe_components(
            recipe_id INTEGER, item_id INTEGER, componentcount INTEGER);
        CREATE TABLE recipe_results(
            recipe_id INTEGER, item_id INTEGER, successcount INTEGER);
        CREATE TABLE zone_forage(zone TEXT, item_id INTEGER, chance INTEGER);
        CREATE TABLE zone_fishing(zone TEXT, item_id INTEGER, chance INTEGER);
        CREATE TABLE zone_connections(
            from_zone TEXT, to_zone TEXT,
            PRIMARY KEY(from_zone, to_zone));
        -- Secondary indexes on the NON-leading join columns. The composite PKs
        -- above only autoindex their leading column, so app queries that filter
        -- the other side (who-drops-this, sold-by, npcs-in-zone, recipe lookups)
        -- otherwise full-scan 150k+/33k/21k/32k-row tables on every keystroke.
        -- recipe_components/recipe_results have no PK at all -> index both cols.
        CREATE INDEX drops_npc ON drops(npc_id);
        CREATE INDEX vendor_items_item ON vendor_items(item_id);
        CREATE INDEX npc_zones_zone ON npc_zones(zone);
        CREATE INDEX recipe_components_recipe ON recipe_components(recipe_id);
        CREATE INDEX recipe_components_item ON recipe_components(item_id);
        CREATE INDEX recipe_results_recipe ON recipe_results(recipe_id);
        CREATE INDEX recipe_results_item ON recipe_results(item_id);
        """
    )

    # Pass over the dump, accumulating the relational pieces in memory
    # (all comfortably small at this era's scale).
    items = {}            # id -> row dict
    npcs = {}             # id -> (name, level, loottable_id,
                          #        merchant_id, npc_faction_id)
    lt_entries = {}       # loottable_id -> [(lootdrop_id, mult, prob)]
    ld_entries = {}       # lootdrop_id -> [(item_id, chance)]
    group_npcs = {}       # spawngroupID -> [npcID]
    npc_zone_counts = {}  # (npc_id, zone) -> spawn point count
    npc_zone_respawn = {} # (npc_id, zone) -> [respawn secs sum, spawn count]
    zones = {}            # short -> long
    zone_by_idnum = {}    # zoneidnumber -> short_name
    merchant_lists = {}   # merchantid -> [item_id]
    recipes = {}          # id -> (name, tradeskill, trivial, nofail)
    recipe_parts = {}     # recipe_id -> [(item_id, componentcount,
                          #               successcount)]
    forage_rows = {}      # (zoneid, item_id) -> max chance
    fishing_rows = {}     # (zoneid, item_id) -> max chance
    zone_links = set()    # (from short_name, target zoneidnumber)
    npc_factions = {}     # npc_faction.id -> primaryfaction
    faction_names = {}    # faction_list.id -> name

    for table, columns, vals in read_dump(dump):
        cols = columns[table]
        row = dict(zip(cols, vals))
        if table == "items":
            items[int(row["id"])] = row
        elif table == "npc_types":
            npcs[int(row["id"])] = (
                row["name"] or "", int(row["level"] or 0),
                int(row["loottable_id"] or 0),
                int(row["merchant_id"] or 0),
                int(row["npc_faction_id"] or 0),
            )
        elif table == "loottable_entries":
            lt_entries.setdefault(int(row["loottable_id"]), []).append(
                (int(row["lootdrop_id"]),
                 float(row["multiplier"] or 1), float(row["probability"] or 0))
            )
        elif table == "lootdrop_entries":
            ld_entries.setdefault(int(row["lootdrop_id"]), []).append(
                (int(row["item_id"]), float(row["chance"] or 0))
            )
        elif table == "spawnentry":
            group_npcs.setdefault(int(row["spawngroupID"]), []).append(
                int(row["npcID"])
            )
        elif table == "zone":
            zones[row["short_name"]] = row["long_name"] or row["short_name"]
            zone_by_idnum[int(row["zoneidnumber"] or 0)] = row["short_name"]
        elif table == "merchantlist":
            merchant_lists.setdefault(int(row["merchantid"]), []).append(
                int(row["item"])
            )
        elif table == "tradeskill_recipe":
            recipes[int(row["id"])] = (
                row["name"] or "", int(row["tradeskill"] or 0),
                int(row["trivial"] or 0), int(row["nofail"] or 0),
            )
        elif table == "tradeskill_recipe_entries":
            recipe_parts.setdefault(int(row["recipe_id"]), []).append(
                (int(row["item_id"]), int(row["componentcount"] or 0),
                 int(row["successcount"] or 0))
            )
        elif table in ("forage", "fishing"):
            acc = forage_rows if table == "forage" else fishing_rows
            key = (int(row["zoneid"] or 0), int(row["Itemid"] or 0))
            chance = int(row["chance"] or 0)
            if chance > acc.get(key, -1):
                acc[key] = chance
        elif table == "zone_points":
            zone_links.add((row["zone"] or "",
                            int(row["target_zone_id"] or 0)))
        elif table == "npc_faction":
            npc_factions[int(row["id"])] = int(row["primaryfaction"] or 0)
        elif table == "faction_list":
            faction_names[int(row["id"])] = row["name"] or ""

    # spawn2 needs spawnentry fully loaded; re-read just spawn2 rows.
    for table, columns, vals in read_dump(dump):
        if table != "spawn2":
            continue
        row = dict(zip(columns[table], vals))
        zone = row["zone"] or ""
        respawn = int(row["respawntime"] or 0)
        for npc_id in group_npcs.get(int(row["spawngroupID"] or 0), []):
            key = (npc_id, zone)
            npc_zone_counts[key] = npc_zone_counts.get(key, 0) + 1
            acc = npc_zone_respawn.setdefault(key, [0, 0])
            acc[0] += respawn
            acc[1] += 1

    # Effective drop chances: item -> npc -> max chance seen.
    npc_by_loottable = {}
    for npc_id, (_, _, lt, _m, _f) in npcs.items():
        if lt:
            npc_by_loottable.setdefault(lt, []).append(npc_id)
    drop_rows = {}
    for lt_id, entries in lt_entries.items():
        for ld_id, mult, prob in entries:
            for item_id, chance in ld_entries.get(ld_id, []):
                eff = min(100.0, (prob * chance) / 100.0 * max(mult, 1))
                if eff <= 0:
                    continue
                for npc_id in npc_by_loottable.get(lt_id, []):
                    key = (item_id, npc_id)
                    if eff > drop_rows.get(key, 0.0):
                        drop_rows[key] = eff

    # NPCs worth keeping: they spawn somewhere, drop something, or sell
    # something (merchant NPCs stay even when they never drop loot).
    spawning = {npc_id for (npc_id, _z) in npc_zone_counts}
    dropping = {npc_id for (_i, npc_id) in drop_rows}
    selling = {npc_id for npc_id, (_n, _l, _lt, m, _f) in npcs.items()
               if m in merchant_lists}
    keep_npcs = spawning | dropping | selling

    def clean_npc_name(raw: str) -> str:
        return raw.lstrip("#!").replace("_", " ").strip()

    def faction_name(npc_faction_id: int):
        """Primary faction name for an npc_faction id, else None."""
        primary = npc_factions.get(npc_faction_id, 0)
        return faction_names.get(primary) if primary > 0 else None

    db.executemany(
        "INSERT INTO zones VALUES (?,?,?)",
        [(s, l, zone_era(s)) for s, l in sorted(zones.items())],
    )
    db.executemany(
        "INSERT OR REPLACE INTO npcs VALUES (?,?,?,?,?,?,?)",
        [(i, clean_npc_name(n), lvl, lt,
          1 if is_named_mob(n) else 0, m, faction_name(f))
         for i, (n, lvl, lt, m, f) in npcs.items() if i in keep_npcs],
    )
    db.executemany(
        "INSERT OR REPLACE INTO npc_zones VALUES (?,?,?,?)",
        [(i, z, c, round(npc_zone_respawn[(i, z)][0]
                         / max(npc_zone_respawn[(i, z)][1], 1)))
         for (i, z), c in npc_zone_counts.items()],
    )
    db.executemany(
        "INSERT OR REPLACE INTO drops VALUES (?,?,?)",
        [(i, n, round(c, 2)) for (i, n), c in drop_rows.items()
         if n in keep_npcs],
    )
    db.executemany(
        "INSERT OR REPLACE INTO vendor_items VALUES (?,?)",
        [(npc_id, item_id)
         for npc_id, (_n, _l, _lt, m, _f) in npcs.items()
         if npc_id in keep_npcs
         for item_id in merchant_lists.get(m, [])],
    )
    db.executemany(
        "INSERT OR REPLACE INTO recipes VALUES (?,?,?,?,?,?)",
        [(rid, name, name.lower(), skill, trivial, nofail)
         for rid, (name, skill, trivial, nofail) in recipes.items()],
    )
    db.executemany(
        "INSERT INTO recipe_components VALUES (?,?,?)",
        [(rid, item_id, comp)
         for rid, parts in recipe_parts.items()
         for item_id, comp, _succ in parts if comp > 0],
    )
    db.executemany(
        "INSERT INTO recipe_results VALUES (?,?,?)",
        [(rid, item_id, succ)
         for rid, parts in recipe_parts.items()
         for item_id, _comp, succ in parts if succ > 0],
    )
    # forage/fishing/zone_points key zones by zoneidnumber; rows whose id
    # maps to no zone row (e.g. the global fishing table at zoneid 0) drop.
    db.executemany(
        "INSERT INTO zone_forage VALUES (?,?,?)",
        [(zone_by_idnum[zid], item_id, chance)
         for (zid, item_id), chance in sorted(forage_rows.items())
         if zid in zone_by_idnum],
    )
    db.executemany(
        "INSERT INTO zone_fishing VALUES (?,?,?)",
        [(zone_by_idnum[zid], item_id, chance)
         for (zid, item_id), chance in sorted(fishing_rows.items())
         if zid in zone_by_idnum],
    )
    db.executemany(
        "INSERT OR IGNORE INTO zone_connections VALUES (?,?)",
        [(src, zone_by_idnum[tgt]) for src, tgt in sorted(zone_links)
         if src and tgt in zone_by_idnum and zone_by_idnum[tgt] != src],
    )

    source_counts = {}
    for (item_id, npc_id) in drop_rows:
        if npc_id in keep_npcs:
            source_counts[item_id] = source_counts.get(item_id, 0) + 1

    def num(row, key):
        v = row.get(key)
        try:
            return int(float(v)) if v not in (None, "") else 0
        except ValueError:
            return 0

    spell_names = load_spell_names()

    def effect_name(row, key):
        """Spell name for an effect-id column (>0 and known), else None."""
        sid = num(row, key)
        return spell_names.get(sid) if sid > 0 else None

    item_rows = []
    for item_id, row in items.items():
        name = (row.get("Name") or "").strip()
        if not name:
            continue
        proc = effect_name(row, "proceffect")
        click = effect_name(row, "clickeffect")
        worn = effect_name(row, "worneffect")
        focus = effect_name(row, "focuseffect")
        effects_lc = " ".join(
            e.lower() for e in (proc, click, worn, focus) if e
        )
        item_rows.append((
            item_id, name, name.lower(),
            num(row, "itemtype"), num(row, "slots"), num(row, "classes"),
            num(row, "races"), num(row, "ac"), num(row, "hp"),
            num(row, "mana"), num(row, "astr"), num(row, "asta"),
            num(row, "aagi"), num(row, "adex"), num(row, "awis"),
            num(row, "aint"), num(row, "acha"), num(row, "damage"),
            num(row, "delay"), num(row, "magic"),
            # EQEmu convention: nodrop/norent columns are 0 when the flag
            # applies ("NO DROP" items have nodrop = 0). Normalize.
            1 if num(row, "nodrop") == 0 else 0,
            1 if num(row, "norent") == 0 else 0,
            num(row, "loregroup"),
            num(row, "weight"), num(row, "reqlevel"),
            source_counts.get(item_id, 0),
            num(row, "haste"),
            proc, click, worn, focus, effects_lc,
            # scrolltype 7 = learnable spell scroll (EQEmu effect type);
            # in this dump scrolleffect > 0 occurs only with scrolltype 7.
            num(row, "scrolleffect")
            if num(row, "scrolltype") == 7 and num(row, "scrolleffect") > 0
            else 0,
        ))
    db.executemany(
        "INSERT OR REPLACE INTO items VALUES "
        "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,"
        "?,?,?,?,?,?,?)",
        item_rows,
    )

    db.executemany(
        "INSERT INTO meta VALUES (?,?)",
        [
            ("source", "ProjectEQ (PEQ) Luclin-era database release, 2006-11-30"),
            ("source_url", "https://sourceforge.net/projects/projecteq/"),
            ("note", "Classic-era emulator reference data. EverQuest Legends "
                     "drop tables and item stats may differ."),
        ],
    )
    db.commit()
    for t in ("items", "npcs", "npc_zones", "drops", "zones",
              "vendor_items", "recipes", "recipe_components",
              "recipe_results", "zone_forage", "zone_fishing",
              "zone_connections"):
        n = db.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        print(f"  {t}: {n} rows", file=sys.stderr)
    db.execute("VACUUM")
    db.close()
    print(f"wrote {OUT} ({os.path.getsize(OUT) // 1024} KB)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
