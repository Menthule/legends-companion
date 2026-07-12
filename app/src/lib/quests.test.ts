import { describe, expect, it } from "vitest";
import {
  matchQuestRequirements,
  loadQuestCatalog,
  normalizeInventoryItem,
  questsForGiver,
  searchQuests,
  type InventorySnapshot,
  type QuestRecord,
} from "./quests";

const base: QuestRecord = {
  id: "q1", name: "Test", summary: "", zone: "Plane of Sky", classes: ["Monk"],
  minimumLevel: 46, givers: ["Holwin"], aliases: ["Old Tester"],
  requirements: [], rewards: [], repeatable: true, notes: "", sourceLabel: "Wiki",
  sourceUrl: "https://example.test", sourcePageId: 1, sourceRevisionId: 2,
  sourceRevisionAt: "2026-01-01", verification: "eql-wiki",
};

describe("quest lookup", () => {
  it("returns every quest for a giver or explicit alias", () => {
    const rows = [base, { ...base, id: "q2", name: "Other" }];
    expect(questsForGiver("Holwin", "", rows)).toHaveLength(2);
    expect(questsForGiver("old tester", "", rows)).toHaveLength(2);
    expect(questsForGiver("Nobody", "", rows)).toEqual([]);
  });

  it("searches requirements, rewards, class, and zone", () => {
    const row = { ...base, requirements: [{ itemName: "Wind Rune Caza", itemId: null, quantity: 1, choiceGroup: null }] };
    expect(searchQuests("rune caza", {}, [row])).toEqual([row]);
    expect(searchQuests("", { className: "Wizard" }, [row])).toEqual([]);
  });
});

describe("inventory matching", () => {
  const snapshot: InventorySnapshot = {
    sourcePath: "x", sourceModifiedMs: 1, importedAtMs: 2, rowCount: 3, skippedRows: 0,
    items: [
      { itemId: 100, name: "Wind Rune Caza +3", names: ["Wind Rune Caza +3"], quantity: 2, locations: ["Bank1"] },
      { itemId: 200, name: "Tear of Quellious (Exaltation)", names: [], quantity: 1, locations: ["General1"] },
    ],
  };

  it("normalizes Legends augment suffixes", () => {
    expect(normalizeInventoryItem("Wind Rune Caza +3")).toBe("wind rune caza");
    expect(normalizeInventoryItem("Tear of Quellious (Exaltation)")).toBe("tear of quellious");
  });

  it("prefers IDs and falls back to normalized names with quantities", () => {
    const rows = matchQuestRequirements([
      { itemName: "Different display", itemId: 100, quantity: 2, choiceGroup: null },
      { itemName: "Tear of Quellious", itemId: null, quantity: 2, choiceGroup: null },
    ], snapshot);
    expect(rows[0]).toMatchObject({ owned: 2, satisfied: true, matchedBy: "id", locations: ["Bank1"] });
    expect(rows[1]).toMatchObject({ owned: 1, satisfied: false, matchedBy: "name" });
  });
});

describe("catalog completeness", () => {
  it("ships all 16 Plane of Sky class groups with an audited quest count", async () => {
    const questCatalog = await loadQuestCatalog();
    expect(questCatalog.skyAudit.classes).toHaveLength(16);
    expect(questCatalog.skyAudit.questCount).toBe(94);
    expect(questCatalog.sourcePageCount).toBeGreaterThan(900);
    const monkQuests = questsForGiver("Holwin", "Plane of Sky", questCatalog.quests);
    expect(monkQuests).toHaveLength(6);
    expect(monkQuests.every((quest) => quest.classes.includes("Monk"))).toBe(true);
  });
});
