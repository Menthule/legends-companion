#!/usr/bin/env python3
"""Build the offline EverQuest Legends quest catalog from EQL Wiki.

EQL Wiki original content is CC BY-SA 4.0. Every emitted record retains its
page/revision/source metadata so the app can attribute it and distinguish
EQL-verified pages from inherited pages that still need Legends confirmation.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://eqlwiki.com/api.php"
USER_AGENT = "LegendsCompanionQuestBuilder/0.1 (https://github.com/Menthule/legends-companion)"
REPO = Path(__file__).resolve().parents[2]
DEFAULT_OUT = REPO / "app" / "src" / "data" / "quests.json"
SKY_ITEM_SOURCES_PATH = Path(__file__).with_name("sky_item_sources.json")
SKY_ITEM_SOURCES = json.loads(SKY_ITEM_SOURCES_PATH.read_text(encoding="utf-8"))

# Source abbreviations used by the EQL-specific Plane of Sky class tables.
# Keep this explicit: an unfamiliar code should stop the catalog build instead
# of silently publishing a plausible but incorrect drop location.
SKY_SOURCE_CODES = {
    "2-PoS": ("mob-drop", ["Protector of Sky"], "Island 2"),
    "3-Gorga": ("mob-drop", ["Gorgalosk"], "Island 3"),
    "4-KoS": ("mob-drop", ["Keeper of Souls"], "Island 4"),
    "5-SL": ("mob-drop", ["The Spiroc Lord"], "Island 5"),
    "6-BZ": ("mob-drop", ["Bazzt Zzzt"], "Island 6"),
    "7-SotS": ("mob-drop", ["Sister of the Spire"], "Island 7"),
    "8-EoV": ("mob-drop", ["Eye of Veeshan"], "Island 8"),
    "6": ("zone-drop", [], "Island 6"),
    "7": ("zone-drop", [], "Island 7"),
    "7-Trash": ("zone-drop", [], "Island 7 trash mobs"),
}


def api(params: dict[str, str]) -> dict:
    query = urllib.parse.urlencode({"format": "json", **params})
    request = urllib.request.Request(f"{API}?{query}", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def quest_pages() -> list[dict]:
    rows: list[dict] = []
    continuation: str | None = None
    while True:
        params = {
            "action": "query",
            "list": "categorymembers",
            "cmtitle": "Category:Quests",
            "cmnamespace": "0",
            "cmtype": "page",
            "cmprop": "ids|title|type",
            "cmlimit": "500",
        }
        if continuation:
            params["cmcontinue"] = continuation
        payload = api(params)
        rows.extend(payload["query"]["categorymembers"])
        continuation = payload.get("continue", {}).get("cmcontinue")
        if not continuation:
            return rows


def fetch_pages(rows: list[dict]) -> list[dict]:
    pages: list[dict] = []
    for offset in range(0, len(rows), 40):
        batch = rows[offset : offset + 40]
        payload = api({
            "action": "query",
            "prop": "revisions|info|categories",
            "rvprop": "ids|timestamp|content",
            "rvslots": "main",
            "inprop": "url",
            "cllimit": "max",
            "pageids": "|".join(str(row["pageid"]) for row in batch),
        })
        pages.extend(payload["query"]["pages"].values())
        time.sleep(0.08)
    extra = api({
        "action": "query",
        "prop": "revisions|info|categories",
        "rvprop": "ids|timestamp|content",
        "rvslots": "main",
        "inprop": "url",
        "cllimit": "max",
        "titles": "Plane of Sky",
    })
    pages.extend(extra["query"]["pages"].values())
    return pages


def fetch_linked_pages(titles: list[str]) -> dict[str, dict]:
    """Fetch exact linked pages and retain redirect identity for each title."""
    unique_titles = list(dict.fromkeys(title for title in titles if title))
    pages_by_requested_title: dict[str, dict] = {}
    for offset in range(0, len(unique_titles), 40):
        batch = unique_titles[offset : offset + 40]
        payload = api({
            "action": "query",
            "prop": "revisions|info|categories",
            "rvprop": "ids|timestamp|content",
            "rvslots": "main",
            "inprop": "url",
            "cllimit": "max",
            "redirects": "1",
            "titles": "|".join(batch),
        })
        query = payload["query"]
        aliases = {
            row["from"]: row["to"]
            for group in (query.get("normalized", []), query.get("redirects", []))
            for row in group
        }
        pages_by_title = {
            page["title"]: page
            for page in query["pages"].values()
            if "missing" not in page
        }
        for requested_title in batch:
            resolved_title = requested_title
            visited: set[str] = set()
            while resolved_title in aliases and resolved_title not in visited:
                visited.add(resolved_title)
                resolved_title = aliases[resolved_title]
            page = pages_by_title.get(resolved_title)
            if page:
                pages_by_requested_title[requested_title] = page
        time.sleep(0.08)
    return pages_by_requested_title


def linked_entries(text: str) -> list[tuple[str, str]]:
    """Return (display name, wiki page title) without losing link identity."""
    values: list[tuple[str, str]] = []
    for target, label in re.findall(r"\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]", text):
        entry = ((label or target).strip(), target.strip())
        if entry[0] and entry not in values:
            values.append(entry)
    for value in re.findall(r"\{\{:\s*([^}|]+)", text):
        value = value.strip()
        entry = (value, value)
        if value and entry not in values:
            values.append(entry)
    return values


def linked_values(text: str) -> list[str]:
    return [name for name, _ in linked_entries(text)]


def page_wikitext(page: dict) -> str:
    return page.get("revisions", [{}])[0].get("slots", {}).get("main", {}).get("*", "")


def template_invocations(wikitext: str, names: set[str]) -> list[str]:
    """Return matching template bodies while respecting nested braces."""
    bodies: list[str] = []
    starts: list[int] = []
    cursor = 0
    while cursor < len(wikitext) - 1:
        pair = wikitext[cursor : cursor + 2]
        if pair == "{{":
            starts.append(cursor)
            cursor += 2
            continue
        if pair == "}}" and starts:
            start = starts.pop()
            body = wikitext[start + 2 : cursor]
            template_name = split_template_arguments(body)[0].strip().casefold()
            if template_name in names:
                bodies.append(body)
            cursor += 2
            continue
        cursor += 1
    return bodies


def itempage_fields(wikitext: str, field_name: str) -> list[str]:
    values: list[str] = []
    for body in template_invocations(wikitext, {"itempage", "items"}):
        for argument in split_template_arguments(body)[1:]:
            name, separator, value = argument.partition("=")
            if separator and name.strip().casefold() == field_name.casefold() and value.strip():
                values.append(value.strip())
    return values


def is_item_page(page: dict) -> bool:
    page_categories = {row["title"] for row in page.get("categories", [])}
    return (
        "Category:Items" in page_categories
        and bool(template_invocations(page_wikitext(page), {"itempage", "items"}))
    )


def split_template_arguments(text: str) -> list[str]:
    """Split template arguments without splitting pipes inside wiki links."""
    parts: list[str] = []
    start = 0
    link_depth = 0
    template_depth = 0
    index = 0
    while index < len(text):
        pair = text[index : index + 2]
        if pair == "[[":
            link_depth += 1
            index += 2
            continue
        if pair == "]]" and link_depth:
            link_depth -= 1
            index += 2
            continue
        if pair == "{{":
            template_depth += 1
            index += 2
            continue
        if pair == "}}" and template_depth:
            template_depth -= 1
            index += 2
            continue
        if text[index] == "|" and link_depth == 0 and template_depth == 0:
            parts.append(text[start:index].strip())
            start = index + 1
        index += 1
    parts.append(text[start:].strip())
    return parts


def acquisition_source(
    page: dict,
    *,
    kind: str,
    npc_names: list[str],
    location: str,
    source_code: str,
) -> dict:
    revision = page["revisions"][0]
    return {
        "kind": kind,
        "npcNames": npc_names,
        "zone": "Plane of Sky",
        "location": location,
        "chance": None,
        "sourceCode": source_code,
        "sourceLabel": "EverQuest Legends Wiki",
        "sourceUrl": page["fullurl"],
        "sourcePageId": page["pageid"],
        "sourceRevisionId": revision["revid"],
        "sourceRevisionAt": revision["timestamp"],
        "verification": "eql-wiki",
    }


def item_page_source(
    page: dict,
    *,
    kind: str,
    npc_names: list[str],
    zone: str,
    location: str,
    source_code: str,
    chance: float | None = None,
) -> dict:
    revision = page["revisions"][0]
    separator = "&" if "?" in page["fullurl"] else "?"
    return {
        "kind": kind,
        "npcNames": npc_names,
        "zone": zone,
        "location": location,
        "chance": chance,
        "sourceCode": source_code,
        "sourceLabel": "EverQuest Legends Wiki",
        "sourceUrl": f"{page['fullurl']}{separator}oldid={revision['revid']}",
        "sourcePageId": page["pageid"],
        "sourceRevisionId": revision["revid"],
        "sourceRevisionAt": revision["timestamp"],
        "verification": "eql-wiki",
        "authorityId": "eql-wiki",
        "scope": "everquest-legends",
        "completeness": "partial",
    }


def explicit_percent(text: str) -> float | None:
    match = re.search(r"(?<!\d)(\d+(?:\.\d+)?)\s*%", text)
    return float(match.group(1)) if match else None


def item_page_acquisition_sources(page: dict) -> list[dict]:
    """Parse only explicit acquisition fields from an authoritative item page."""
    if not is_item_page(page):
        return []
    wikitext = page_wikitext(page)
    sources: list[dict] = []

    for drops_from in itempage_fields(wikitext, "dropsfrom"):
        zone = ""
        for line in drops_from.splitlines():
            stripped = line.strip()
            entries = linked_entries(stripped)
            if not entries:
                continue
            if not stripped.startswith("*"):
                if stripped.startswith("[["):
                    zone = entries[0][0]
                continue
            if zone:
                sources.append(item_page_source(
                    page,
                    kind="mob-drop",
                    npc_names=[entries[0][0]],
                    zone=zone,
                    location="",
                    chance=explicit_percent(stripped),
                    source_code="item-page:dropsfrom",
                ))

    for sold_by in itempage_fields(wikitext, "soldby"):
        for body in template_invocations(sold_by, {"itemwhererow", "itemwhererowvel"}):
            parts = split_template_arguments(body)[1:]
            if len(parts) < 2:
                continue
            zone_entries = linked_entries(parts[0])
            npc_entries = linked_entries(parts[1])
            if not zone_entries or not npc_entries:
                continue
            area = plain(parts[2]) if len(parts) > 2 else ""
            coordinates = plain(parts[3]) if len(parts) > 3 else ""
            sources.append(item_page_source(
                page,
                kind="vendor",
                npc_names=[npc_entries[0][0]],
                zone=zone_entries[0][0],
                location=" · ".join(value for value in (area, coordinates) if value),
                source_code="item-page:soldby",
            ))

    for player_crafted in itempage_fields(wikitext, "playercrafted"):
        for line in player_crafted.splitlines():
            stripped = line.strip()
            if not re.match(r"^\*(?!\*)\s+", stripped):
                continue
            entries = linked_entries(stripped)
            if not entries or "non-tradeskill" in stripped.casefold():
                continue
            sources.append(item_page_source(
                page,
                kind="crafted",
                npc_names=[],
                zone="",
                location=plain(stripped.removeprefix("*")),
                source_code="item-page:playercrafted",
            ))

    return dedupe_sources(sources)


def dedupe_sources(sources: list[dict]) -> list[dict]:
    unique: dict[tuple, dict] = {}
    for source in sources:
        npc_key = () if source["kind"] == "mob-drop" else tuple(source["npcNames"])
        key = (
            source["kind"],
            npc_key,
            source["zone"],
            source["location"],
            source["chance"],
            source["sourceCode"],
        )
        if key not in unique:
            unique[key] = source
            continue
        known_npcs = unique[key]["npcNames"]
        for npc_name in source["npcNames"]:
            if npc_name not in known_npcs:
                known_npcs.append(npc_name)
    return list(unique.values())


def requirement(
    item_name: str,
    source_page_title: str | None = None,
    acquisition_sources: list[dict] | None = None,
) -> dict:
    return {
        "itemName": item_name,
        "itemId": None,
        "quantity": 1,
        "choiceGroup": None,
        "sourcePageTitle": source_page_title,
        "acquisitionSources": acquisition_sources or [],
    }


def sky_source(page: dict, source_code: str) -> dict:
    try:
        kind, npc_names, location = SKY_SOURCE_CODES[source_code]
    except KeyError as error:
        raise ValueError(f"Unknown Plane of Sky source code: {source_code}") from error
    return acquisition_source(
        page,
        kind=kind,
        npc_names=npc_names,
        location=location,
        source_code=source_code,
    )


def sky_item_sources(item_name: str) -> list[dict]:
    """Return revision-pinned EQL item-page sources for unannotated rows."""
    item = SKY_ITEM_SOURCES.get(item_name)
    if not item:
        return []
    page_title = item_name.replace(" ", "_")
    source_url = (
        f"https://eqlwiki.com/index.php?title={urllib.parse.quote(page_title)}"
        f"&oldid={item['revisionId']}"
    )
    return [
        {
            "kind": "mob-drop",
            "npcNames": [npc_name],
            "zone": "Plane of Sky",
            "location": location,
            "chance": None,
            "sourceCode": "item-page",
            "sourceLabel": "EverQuest Legends Wiki",
            "sourceUrl": source_url,
            "sourcePageId": None,
            "sourceRevisionId": item["revisionId"],
            "sourceRevisionAt": None,
            "verification": "eql-wiki",
        }
        for npc_name, location in item["sources"]
    ]


def sky_requirement_values(text: str, page: dict, *, wind_runes: bool) -> list[dict]:
    """Parse Sky checklist items and retain their trailing source codes."""
    blocks = re.findall(r"<li[^>]*>(.*?)</li>", text, re.I | re.S) or [text]
    rows: list[dict] = []
    for block in blocks:
        entries = linked_entries(block)
        if not entries:
            continue
        source_match = re.search(r"\(([^()]+)\)", block)
        source_code = plain(source_match.group(1)) if source_match else ""
        sources: list[dict]
        if wind_runes:
            sources = [acquisition_source(
                page,
                kind="zone-drop",
                npc_names=[],
                location="All islands",
                source_code="all-sky-mobs",
            )]
        elif source_code:
            sources = [sky_source(page, source_code)]
        else:
            sources = sky_item_sources(entries[0][0])
        for item_name, page_title in entries:
            rows.append(requirement(item_name, page_title, sources))
    return dedupe_requirements(rows)


def dedupe_requirements(rows: list[dict]) -> list[dict]:
    unique: dict[str, dict] = {}
    for row in rows:
        key = row["itemName"]
        if key not in unique:
            unique[key] = row
            continue
        known = unique[key]["acquisitionSources"]
        for source in row["acquisitionSources"]:
            if source not in known:
                known.append(source)
    return list(unique.values())


def plain(text: str) -> str:
    text = re.sub(r"\[\[([^\]|]+)\|([^\]]+)\]\]", r"\2", text)
    text = re.sub(r"\[\[([^\]]+)\]\]", r"\1", text)
    text = re.sub(r"\{\{:\s*([^}|]+).*?\}\}", r"\1", text)
    text = re.sub(r"\{\{.*?\}\}", "", text, flags=re.S)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"'{2,}", "", text)
    return re.sub(r"\s+", " ", text).strip(" |:-\n")


def table_value(wikitext: str, label: str) -> str:
    match = re.search(
        rf"!\s*'*\s*{re.escape(label)}\s*:\s*'*\s*\n\|\s*(.+?)(?=\n\|-|\n\|\}})",
        wikitext,
        re.I | re.S,
    )
    return plain(match.group(1)) if match else ""


def giver_names(wikitext: str) -> list[str]:
    block = table_value(wikitext, "Quest Giver")
    if block:
        return [part.strip() for part in re.split(r",| / | and ", block) if part.strip()]
    patterns = [
        r"(?:Talk to|Find)\s+(?:'''\s*)?(?:\[\[)?([^\]\n.']+)(?:\]\])?.{0,30}\bHail\b",
        r"You say,\s*['\"]Hail,\s*([^'\"]+)",
    ]
    for pattern in patterns:
        match = re.search(pattern, wikitext, re.I)
        if match:
            return [plain(match.group(1))]
    return []


def requirement_values(wikitext: str) -> list[dict]:
    values: list[tuple[str, str]] = []
    for line in wikitext.splitlines():
        if not re.search(r"\b(bring|hand|give|return with|turn in)\b", line, re.I):
            continue
        values.extend(linked_entries(line))
    excluded = {"plane of sky", "reward", "quest", "hail"}
    return dedupe_requirements([
        requirement(item_name, page_title)
        for item_name, page_title in dict.fromkeys(values)
        if item_name.lower() not in excluded
    ])


def reward_values(wikitext: str) -> list[str]:
    match = re.search(r"==\s*Rewards?\s*==(.+?)(?=\n==|\Z)", wikitext, re.I | re.S)
    if not match:
        return []
    return linked_values(match.group(1))[:12]


def categories(page: dict) -> list[str]:
    return [row["title"].removeprefix("Category:") for row in page.get("categories", [])]


def provenance(page: dict) -> dict:
    revision = page["revisions"][0]
    return {
        "sourceLabel": "EverQuest Legends Wiki",
        "sourceUrl": page["fullurl"],
        "sourcePageId": page["pageid"],
        "sourceRevisionId": revision["revid"],
        "sourceRevisionAt": revision["timestamp"],
        "verification": "eql-wiki",
    }


def sky_quests(page: dict, wikitext: str) -> list[dict]:
    title = page["title"]
    if not re.search(r"Plane of Sky Tests?$", title, re.I):
        return []
    class_name = re.sub(r"\s+Plane of Sky Tests?$", "", title, flags=re.I).strip()
    givers = giver_names(wikitext)
    sections = list(re.finditer(r"^==\s*([^=\n]+?)\s*==\s*$", wikitext, re.M))
    rows: list[dict] = []
    for index, heading in enumerate(sections):
        section_title = plain(heading.group(1))
        if "test of" not in section_title.lower():
            continue
        body_end = sections[index + 1].start() if index + 1 < len(sections) else len(wikitext)
        body = wikitext[heading.end() : body_end]
        rewards = []
        reward_match = re.search(r"'''?Reward:?'''?\s*:?(.*?)(?:\n|$)", body, re.I)
        if reward_match:
            rewards = linked_values(reward_match.group(1)) or [plain(reward_match.group(1))]
        requirements: list[str] = []
        for item in re.findall(r"^\|\s*(.+?)\s*\|\|", body, re.M):
            linked = linked_values(item)
            value = linked[0] if linked else plain(item)
            if value and value.lower() not in {"item", "-"}:
                requirements.append(value)
        if not requirements:
            requirements = [row["itemName"] for row in requirement_values(body)]
        quest_name = re.sub(rf"^{re.escape(class_name)}\s+", "", section_title, flags=re.I)
        rows.append({
            "id": f"sky:{class_name.lower().replace(' ', '-')}:{quest_name.lower().replace(' ', '-')}",
            "name": quest_name,
            "summary": f"{class_name} Plane of Sky class quest.",
            "zone": "Plane of Sky",
            "classes": [class_name],
            "minimumLevel": None,
            "givers": givers,
            "aliases": [],
            "requirements": [
                requirement(value)
                for value in dict.fromkeys(requirements)
            ],
            "rewards": list(dict.fromkeys(value for value in rewards if value)),
            "repeatable": True,
            "notes": "Plane of Sky quest behavior and rewards can change; source revision is shown.",
            **provenance(page),
        })
    return rows


def sky_table_quests(page: dict, wikitext: str) -> list[dict]:
    """Expand the current EQL-specific class tables on Plane of Sky."""
    if page["title"] != "Plane of Sky":
        return []
    class_sections = list(re.finditer(
        r"<h3>\s*\[\[([^\]]+)\]\]\s*\(([^)]+)\)\s*</h3>",
        wikitext,
        re.I,
    ))
    rows: list[dict] = []
    for index, section in enumerate(class_sections):
        class_name = plain(section.group(1))
        representative = plain(section.group(2))
        end = class_sections[index + 1].start() if index + 1 < len(class_sections) else len(wikitext)
        body = wikitext[section.end() : end]
        table_match = re.search(r"\{\|\s*class=\"eoTable3\"(.+?)\n\|\}", body, re.S)
        if not table_match:
            continue
        for raw_row in re.split(r"^\|-\s*$", table_match.group(1), flags=re.M):
            cells = [cell.strip() for cell in re.split(r"^\|\s*", raw_row, flags=re.M) if cell.strip()]
            if len(cells) < 6 or cells[0].lower().startswith("quest") or "!!" in cells[0]:
                continue
            quest_name = plain(cells[0])
            tester = plain(cells[1])
            trigger = plain(cells[2])
            requirements = dedupe_requirements([
                *sky_requirement_values(cells[3], page, wind_runes=True),
                *sky_requirement_values(cells[4], page, wind_runes=False),
            ])
            rewards = linked_values(cells[5])
            if not quest_name or "test of" not in quest_name.lower():
                continue
            short_name = re.sub(rf"^{re.escape(class_name)}\s+", "", quest_name, flags=re.I)
            slug = re.sub(r"[^a-z0-9]+", "-", short_name.lower()).strip("-")
            rows.append({
                "id": f"sky:{class_name.lower().replace(' ', '-')}:{slug}",
                "name": short_name,
                "summary": f"{class_name} Plane of Sky class quest. Trigger: {trigger}" if trigger else f"{class_name} Plane of Sky class quest.",
                "zone": "Plane of Sky",
                "classes": [class_name],
                "minimumLevel": 46,
                "givers": [representative],
                "aliases": [tester] if tester and tester.lower() != representative.lower() else [],
                "requirements": requirements,
                "rewards": list(dict.fromkeys(rewards)),
                "repeatable": True,
                "notes": "Current class representative is the hail target; historical tester is retained as an alias.",
                **provenance(page),
            })
    return rows


def regular_quest(page: dict, wikitext: str) -> dict:
    cats = categories(page)
    class_names = [name.removesuffix(" Quests") for name in cats if name.endswith(" Quests") and name != "Quests"]
    minimum = table_value(wikitext, "Minimum Level")
    intro = re.sub(r"\{\|.+?\|\}", "", wikitext, count=1, flags=re.S)
    intro = re.split(r"\n==", intro, maxsplit=1)[0]
    summary = plain(intro)[:280]
    return {
        "id": f"wiki:{page['pageid']}",
        "name": page["title"],
        "summary": summary,
        "zone": table_value(wikitext, "Start Zone"),
        "classes": class_names,
        "minimumLevel": int(minimum) if minimum.isdigit() else None,
        "givers": giver_names(wikitext),
        "aliases": [],
        "requirements": requirement_values(wikitext),
        "rewards": reward_values(wikitext),
        "repeatable": None,
        "notes": "",
        **provenance(page),
    }


def enrich_requirement_sources(quests: list[dict]) -> dict:
    requirements = [row for quest in quests for row in quest["requirements"]]
    linked_titles = [
        row["sourcePageTitle"]
        for row in requirements
        if row.get("sourcePageTitle")
    ]
    pages_by_title = fetch_linked_pages(linked_titles)
    accepted_pages = {
        page["pageid"]: page
        for page in pages_by_title.values()
        if is_item_page(page)
    }
    sources_by_page_id = {
        page_id: item_page_acquisition_sources(page)
        for page_id, page in accepted_pages.items()
    }
    preexisting_count = sum(bool(row["acquisitionSources"]) for row in requirements)
    enriched_count = 0
    for row in requirements:
        if row["acquisitionSources"] or not row.get("sourcePageTitle"):
            continue
        page = pages_by_title.get(row["sourcePageTitle"])
        if not page:
            continue
        sources = sources_by_page_id.get(page["pageid"], [])
        if sources:
            row["acquisitionSources"] = [dict(source) for source in sources]
            enriched_count += 1

    emitted_sources = [source for row in requirements for source in row["acquisitionSources"]]
    source_kinds: dict[str, int] = {}
    for source in emitted_sources:
        source_kinds[source["kind"]] = source_kinds.get(source["kind"], 0) + 1
    sourced_count = sum(bool(row["acquisitionSources"]) for row in requirements)
    unique_requirement_names = {row["itemName"] for row in requirements}
    sourced_requirement_names = {
        row["itemName"] for row in requirements if row["acquisitionSources"]
    }
    return {
        "requirementCount": len(requirements),
        "uniqueRequirementNameCount": len(unique_requirement_names),
        "linkedRequirementCount": len(linked_titles),
        "uniqueLinkedPageTitleCount": len(set(linked_titles)),
        "fetchedLinkedPageCount": len({page["pageid"] for page in pages_by_title.values()}),
        "acceptedItemPageCount": len(accepted_pages),
        "itemPagesWithAcquisitionSourcesCount": sum(bool(rows) for rows in sources_by_page_id.values()),
        "preexistingSourcedRequirementCount": preexisting_count,
        "enrichedRequirementCount": enriched_count,
        "sourcedRequirementCount": sourced_count,
        "unresolvedRequirementCount": len(requirements) - sourced_count,
        "sourcedUniqueRequirementNameCount": len(sourced_requirement_names),
        "unresolvedUniqueRequirementNameCount": (
            len(unique_requirement_names) - len(sourced_requirement_names)
        ),
        "acquisitionSourceCount": len(emitted_sources),
        "acquisitionSourceKinds": dict(sorted(source_kinds.items())),
    }


def build() -> dict:
    members = quest_pages()
    pages = fetch_pages(members)
    quests: list[dict] = []
    sky_pages: list[str] = []
    main_sky = next((page for page in pages if page["title"] == "Plane of Sky"), None)
    if not main_sky:
        raise RuntimeError("Plane of Sky source page was not returned")
    main_revision = main_sky["revisions"][0]
    main_wikitext = main_revision["slots"]["main"]["*"]
    quests.extend(sky_table_quests(main_sky, main_wikitext))
    sky_pages.append(main_sky["title"])
    for page in sorted(pages, key=lambda value: value["title"].lower()):
        if page["title"] == "Plane of Sky" or re.search(r"Plane of Sky Tests?$", page["title"], re.I):
            continue
        revision = page.get("revisions", [{}])[0]
        wikitext = revision.get("slots", {}).get("main", {}).get("*", "")
        quests.append(regular_quest(page, wikitext))
    catalog_audit = enrich_requirement_sources(quests)
    sky_rows = [quest for quest in quests if quest["zone"] == "Plane of Sky" and quest["id"].startswith("sky:")]
    sky_classes = sorted({quest["classes"][0] for quest in sky_rows})
    if len(sky_rows) < 90 or len(sky_classes) < 14:
        raise RuntimeError(
            f"Plane of Sky completeness check failed: {len(sky_rows)} quests, {len(sky_classes)} classes"
        )
    sky_requirements = [row for quest in sky_rows for row in quest["requirements"]]
    sourced_sky_requirements = [row for row in sky_requirements if row["acquisitionSources"]]
    wind_runes_without_sources = [
        row["itemName"] for row in sky_requirements
        if row["itemName"].startswith("Wind Rune ") and not row["acquisitionSources"]
    ]
    if wind_runes_without_sources:
        raise RuntimeError(
            "Plane of Sky source check failed for Wind Runes: "
            + ", ".join(sorted(set(wind_runes_without_sources)))
        )
    if len(sourced_sky_requirements) != len(sky_requirements):
        raise RuntimeError(
            "Plane of Sky source coverage check failed: "
            f"{len(sourced_sky_requirements)}/{len(sky_requirements)} requirements"
        )
    return {
        "schemaVersion": 2,
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "license": "CC BY-SA 4.0",
        "attribution": "Quest content adapted from EverQuest Legends Wiki (https://eqlwiki.com/).",
        "source": "https://eqlwiki.com/Category:Quests",
        "sourcePageCount": len(pages),
        "catalogAudit": catalog_audit,
        "skyAudit": {
            "questCount": len(sky_rows),
            "classes": sky_classes,
            "sourcePages": sky_pages,
            "requirementCount": len(sky_requirements),
            "sourcedRequirementCount": len(sourced_sky_requirements),
            "unresolvedRequirementNames": sorted({
                row["itemName"] for row in sky_requirements if not row["acquisitionSources"]
            }),
        },
        "quests": quests,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    catalog = build()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(catalog, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    print(
        f"wrote {len(catalog['quests'])} quests from {catalog['sourcePageCount']} pages; "
        f"Sky={catalog['skyAudit']['questCount']} across {len(catalog['skyAudit']['classes'])} classes"
    )


if __name__ == "__main__":
    main()
