import unittest

from tools.questdata.audit_quest_sources import claim_key, classify_claims, token


class QuestSourceAuditTests(unittest.TestCase):
    def test_normalizes_articles_without_fuzzy_matching(self):
        self.assertEqual(token("The Keeper of Souls"), "keeper of souls")
        self.assertNotEqual(token("Keeper of Soul"), token("Keeper of Souls"))

    def test_corroborates_only_matching_acquisition_methods(self):
        legends = {claim_key("mob-drop", "Keeper of Souls", "Plane of Sky")}
        classic = {claim_key("mob-drop", "the Keeper of Souls", "Plane of Air")}
        self.assertEqual(classify_claims(legends, classic), "corroborated")
        self.assertEqual(
            classify_claims({claim_key("vendor", "Keeper of Souls")}, classic),
            "documented",
        )

    def test_preserves_ruleset_differences_and_missing_states(self):
        legends = {claim_key("mob-drop", "Bazzt Zzzt", "Plane of Sky")}
        classic = {claim_key("mob-drop", "The Spiroc Lord", "Plane of Air")}
        self.assertEqual(classify_claims(legends, classic), "scope-difference")
        self.assertEqual(classify_claims(legends, set()), "documented")
        self.assertEqual(classify_claims(set(), classic), "classic-only")
        self.assertEqual(classify_claims(set(), set()), "unresolved")


if __name__ == "__main__":
    unittest.main()
