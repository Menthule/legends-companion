# Quest catalog

`build_quest_catalog.py` generates the app's offline quest catalog from the
EverQuest Legends Wiki `Category:Quests` through its MediaWiki API.

```bash
python3 tools/questdata/build_quest_catalog.py
```

The generated records retain source page and revision metadata. EQL Wiki
original content is licensed CC BY-SA 4.0; the app displays attribution and a
direct source link. Imported wiki records remain reference data, not a claim
that every inherited quest has been verified on the current Legends patch.

The Plane of Sky page contains current EQL-specific tables for all 16 classes.
The importer expands those tables into individual quests, retains both the
current representative and historical tester names for hail lookup, and emits
an explicit `skyAudit` count, class list, and source-page list.

Catalog schema v2 retains each requirement's linked wiki page title and an
`acquisitionSources` array. For Plane of Sky, the importer expands the source
codes written next to quest items (`3-Gorga`, `4-KoS`, `5-SL`, `6-BZ`,
`7-SotS`, `8-EoV`, and related island-only forms) into verified mob/island
locations. Wind Runes receive the page's documented zone-wide source: all
Plane of Sky mobs. Source records keep the EQL page and revision provenance;
drop chance remains null when the source does not publish one.

The build fails on unknown Sky source codes, missing Wind Rune sources, or
Sky source coverage below 100%. The main Plane of Sky table supplies most
sources; `sky_item_sources.json` carries revision-pinned EQL item-page sources
for rows without an inline code. `skyAudit` records coverage and unresolved
item names so future gaps fail the build rather than being guessed.

After quest parsing, the builder batch-fetches each exact linked requirement
page. It accepts acquisition data only when the destination is an EQL item
page (`Itempage` plus `Category:Items`). Explicit `dropsfrom` zone and
mob rows, `soldby` `ItemWhereRow` records, and first-level `playercrafted`
methods become revision-pinned sources. It does not infer acquisition from
prose, `relatedquests`, recipes that consume an item, ambiguous lone links, or
similarly named pages. Existing curated Sky sources take precedence and are
never overwritten by this enrichment pass.

`catalogAudit` reports linked and accepted item-page counts, occurrence and
unique-name coverage, unresolved requirements, and emitted source kinds.
Item-page sources are marked partial because wiki acquisition lists may
grow; mobs sharing an exact item, method, and zone are compacted into one
source record's `npcNames` list without fuzzy matching.

Run `python3 tools/questdata/audit_quest_sources.py` to cross-check exact item
names and acquisition methods against the bundled classic reference database.
The audit reports corroborated, Legends-documented, classic-only,
scope-difference, and unresolved states. A classic disagreement is never
promoted into a Legends conflict or silently merged into the catalog.

Quest requirements intentionally use exact item names unless an identifier is
available from a Legends-verified source. The app matches the numeric ID first
when present and otherwise uses an exact normalized name, including the `+N`
and parenthesized augmentation suffixes written by `/output inventory`.
