#!/usr/bin/env python3
"""Cross-check quest acquisition claims against the bundled classic reference.

This audit never promotes classic data into Legends truth. It reports agreement
and ruleset differences between two authorities while preserving unresolved
items for review.
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DEFAULT_CATALOG = REPO / "app" / "src" / "data" / "quests.json"
DEFAULT_DB = REPO / "assets" / "data" / "drops.sqlite"


def token(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9']+", " ", value.casefold()).strip()
    return re.sub(r"^(?:a|an|the)\s+", "", normalized)


def zone_token(value: str) -> str:
    return token("Plane of Sky" if value == "Plane of Air" else value)


def claim_key(kind: str, npc: str = "", zone: str = "") -> tuple[str, str, str]:
    return kind, token(npc), zone_token(zone)


def classify_claims(
    legends: set[tuple[str, str, str]],
    classic: set[tuple[str, str, str]],
) -> str:
    if not legends and not classic:
        return "unresolved"
    if legends and not classic:
        return "documented"
    if classic and not legends:
        return "classic-only"
    for kind, npc, zone in legends:
        for other_kind, other_npc, other_zone in classic:
            if kind != other_kind:
                continue
            if kind == "crafted":
                return "corroborated"
            if npc and other_npc and npc == other_npc:
                return "corroborated"
            if not npc and zone and zone == other_zone:
                return "corroborated"
    same_method = {row[0] for row in legends} & {row[0] for row in classic}
    return "scope-difference" if same_method else "documented"


def legends_claims(catalog: dict) -> dict[str, set[tuple[str, str, str]]]:
    claims: dict[str, set[tuple[str, str, str]]] = defaultdict(set)
    for quest in catalog["quests"]:
        for requirement in quest["requirements"]:
            name = requirement["itemName"].casefold()
            for source in requirement.get("acquisitionSources", []):
                kind = source.get("kind", "")
                if kind == "zone-drop":
                    claims[name].add(claim_key("mob-drop", zone=source.get("zone", "")))
                elif kind in {"mob-drop", "vendor"}:
                    for npc in source.get("npcNames", []):
                        claims[name].add(claim_key(kind, npc, source.get("zone", "")))
                elif kind == "crafted":
                    claims[name].add(claim_key("crafted"))
    return claims


def classic_claims(database: Path) -> dict[str, set[tuple[str, str, str]]]:
    claims: dict[str, set[tuple[str, str, str]]] = defaultdict(set)
    connection = sqlite3.connect(database)
    try:
        for name, npc, zone in connection.execute("""
            SELECT i.name_lc, n.name, COALESCE(z.long_name, nz.zone, '')
            FROM drops d
            JOIN items i ON i.id = d.item_id
            JOIN npcs n ON n.id = d.npc_id
            LEFT JOIN npc_zones nz ON nz.npc_id = n.id
            LEFT JOIN zones z ON z.short_name = nz.zone
        """):
            claims[name].add(claim_key("mob-drop", npc, zone))
        for name, npc, zone in connection.execute("""
            SELECT i.name_lc, n.name, COALESCE(z.long_name, nz.zone, '')
            FROM vendor_items v
            JOIN items i ON i.id = v.item_id
            JOIN npcs n ON n.id = v.npc_id
            LEFT JOIN npc_zones nz ON nz.npc_id = n.id
            LEFT JOIN zones z ON z.short_name = nz.zone
        """):
            claims[name].add(claim_key("vendor", npc, zone))
        for (name,) in connection.execute("""
            SELECT DISTINCT i.name_lc
            FROM recipe_results rr
            JOIN items i ON i.id = rr.item_id
        """):
            claims[name].add(claim_key("crafted"))
    finally:
        connection.close()
    return claims


def audit(catalog: dict, database: Path) -> dict:
    requirement_names = sorted({
        row["itemName"]
        for quest in catalog["quests"]
        for row in quest["requirements"]
    })
    legends = legends_claims(catalog)
    classic = classic_claims(database)
    rows = []
    counts: dict[str, int] = defaultdict(int)
    for name in requirement_names:
        status = classify_claims(legends[name.casefold()], classic[name.casefold()])
        counts[status] += 1
        rows.append({
            "itemName": name,
            "status": status,
            "legendsClaimCount": len(legends[name.casefold()]),
            "classicClaimCount": len(classic[name.casefold()]),
        })
    return {
        "uniqueRequirementNameCount": len(requirement_names),
        "statusCounts": dict(sorted(counts.items())),
        "items": rows,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument("--database", type=Path, default=DEFAULT_DB)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = audit(json.loads(args.catalog.read_text(encoding="utf-8")), args.database)
    if args.output:
        args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "uniqueRequirementNameCount": result["uniqueRequirementNameCount"],
        "statusCounts": result["statusCounts"],
    }, indent=2))


if __name__ == "__main__":
    main()
