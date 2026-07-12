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


def linked_values(text: str) -> list[str]:
    values: list[str] = []
    for target, label in re.findall(r"\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]", text):
        value = (label or target).strip()
        if value and value not in values:
            values.append(value)
    for value in re.findall(r"\{\{:\s*([^}|]+)", text):
        value = value.strip()
        if value and value not in values:
            values.append(value)
    return values


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
    values: list[str] = []
    for line in wikitext.splitlines():
        if not re.search(r"\b(bring|hand|give|return with|turn in)\b", line, re.I):
            continue
        values.extend(linked_values(line))
    excluded = {"plane of sky", "reward", "quest", "hail"}
    return [
        {"itemName": value, "itemId": None, "quantity": 1, "choiceGroup": None}
        for value in dict.fromkeys(values)
        if value.lower() not in excluded
    ]


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
                {"itemName": value, "itemId": None, "quantity": 1, "choiceGroup": None}
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
            requirements = linked_values(cells[3]) + linked_values(cells[4])
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
                "requirements": [
                    {"itemName": value, "itemId": None, "quantity": 1, "choiceGroup": None}
                    for value in dict.fromkeys(requirements)
                ],
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
    sky_rows = [quest for quest in quests if quest["zone"] == "Plane of Sky" and quest["id"].startswith("sky:")]
    sky_classes = sorted({quest["classes"][0] for quest in sky_rows})
    if len(sky_rows) < 90 or len(sky_classes) < 14:
        raise RuntimeError(
            f"Plane of Sky completeness check failed: {len(sky_rows)} quests, {len(sky_classes)} classes"
        )
    return {
        "schemaVersion": 1,
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "license": "CC BY-SA 4.0",
        "attribution": "Quest content adapted from EverQuest Legends Wiki (https://eqlwiki.com/).",
        "source": "https://eqlwiki.com/Category:Quests",
        "sourcePageCount": len(pages),
        "skyAudit": {
            "questCount": len(sky_rows),
            "classes": sky_classes,
            "sourcePages": sky_pages,
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
