import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import build_quest_catalog as catalog


PAGE = {
    "pageid": 34191,
    "fullurl": "https://eqlwiki.com/Plane_of_Sky",
    "revisions": [{
        "revid": 151528,
        "timestamp": "2026-06-29T00:48:36Z",
    }],
}


class SkyRequirementParserTests(unittest.TestCase):
    def test_expands_a_trailing_mob_source_code(self):
        rows = catalog.sky_requirement_values(
            "<li>'''{{SkyNoDrop|[[Silvery Ring]]}}''' (4-KoS)</li>",
            PAGE,
            wind_runes=False,
        )

        self.assertEqual(rows[0]["sourcePageTitle"], "Silvery Ring")
        self.assertEqual(rows[0]["acquisitionSources"][0]["npcNames"], ["Keeper of Souls"])
        self.assertEqual(rows[0]["acquisitionSources"][0]["location"], "Island 4")
        self.assertIsNone(rows[0]["acquisitionSources"][0]["chance"])

    def test_expands_a_source_code_inside_formatting(self):
        rows = catalog.sky_requirement_values(
            "<li>'''{{SkyNoDrop|[[Azarack Skin]]}} (2-PoS)'''</li>",
            PAGE,
            wind_runes=False,
        )

        self.assertEqual(rows[0]["acquisitionSources"][0]["npcNames"], ["Protector of Sky"])

    def test_assigns_wind_runes_to_all_sky_mobs(self):
        rows = catalog.sky_requirement_values(
            "<li>[[Wind Rune Meda]]</li>",
            PAGE,
            wind_runes=True,
        )

        source = rows[0]["acquisitionSources"][0]
        self.assertEqual(source["kind"], "zone-drop")
        self.assertEqual(source["zone"], "Plane of Sky")
        self.assertEqual(source["location"], "All islands")
        self.assertEqual(source["sourceCode"], "all-sky-mobs")

    def test_rejects_an_unknown_sky_source_code(self):
        with self.assertRaisesRegex(ValueError, "Unknown Plane of Sky source code"):
            catalog.sky_requirement_values(
                "<li>[[Mystery Item]] (9-Unknown)</li>",
                PAGE,
                wind_runes=False,
            )

    def test_uses_revision_pinned_item_sources_when_the_table_has_no_code(self):
        rows = catalog.sky_requirement_values(
            "<li>[[Efreeti Great Staff]]</li>",
            PAGE,
            wind_runes=False,
        )

        sources = rows[0]["acquisitionSources"]
        self.assertEqual(
            [source["npcNames"][0] for source in sources],
            ["Eye of Veeshan", "Noble Dojorn"],
        )
        self.assertTrue(all("oldid=138922" in source["sourceUrl"] for source in sources))


class GeneratedCatalogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = json.loads(catalog.DEFAULT_OUT.read_text(encoding="utf-8"))
        cls.quests = {quest["id"]: quest for quest in cls.data["quests"]}

    def test_catalog_uses_schema_v2_and_reports_sky_coverage(self):
        self.assertEqual(self.data["schemaVersion"], 2)
        self.assertEqual(self.data["skyAudit"]["requirementCount"], 219)
        self.assertEqual(self.data["skyAudit"]["sourcedRequirementCount"], 219)
        self.assertEqual(self.data["skyAudit"]["unresolvedRequirementNames"], [])

    def test_known_missing_sky_items_have_authoritative_sources(self):
        smash = self.quests["sky:shadow-knight:test-of-smash"]
        silvery = next(row for row in smash["requirements"] if row["itemName"] == "Silvery Ring")
        self.assertEqual(silvery["acquisitionSources"][0]["npcNames"], ["Keeper of Souls"])

        incapacitation = self.quests["sky:enchanter:test-of-incapacitation"]
        sapphire = next(
            row for row in incapacitation["requirements"]
            if row["itemName"] == "Large Sky Sapphire"
        )
        self.assertEqual(sapphire["acquisitionSources"][0]["npcNames"], ["Eye of Veeshan"])

    def test_every_sky_wind_rune_has_a_source(self):
        runes = [
            row
            for quest_id, quest in self.quests.items()
            if quest_id.startswith("sky:")
            for row in quest["requirements"]
            if row["itemName"].startswith("Wind Rune ")
        ]
        self.assertEqual(len(runes), 94)
        self.assertTrue(all(row["acquisitionSources"] for row in runes))


if __name__ == "__main__":
    unittest.main()
