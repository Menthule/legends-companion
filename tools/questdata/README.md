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

Quest requirements intentionally use exact item names unless an identifier is
available from a Legends-verified source. The app matches the numeric ID first
when present and otherwise uses an exact normalized name, including the `+N`
and parenthesized augmentation suffixes written by `/output inventory`.
