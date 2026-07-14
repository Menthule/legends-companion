import { describe, expect, it } from "vitest";
import {
  matchQuestRequirements,
  isQuestReady,
  loadQuestCatalog,
  normalizeInventoryItem,
  questDropSourceSummary,
  questItemDetailLines,
  questsForGiver,
  searchQuests,
  type InventorySnapshot,
  type QuestRecord,
} from "./quests";
import type { DropItemRow, QuestItemReference } from "../types";

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

  it("marks only fully satisfied documented quests ready", () => {
    const ready = {
      ...base,
      requirements: [{ itemName: "Wind Rune Caza", itemId: 100, quantity: 2, choiceGroup: null }],
    };
    const short = {
      ...base,
      requirements: [{ itemName: "Tear of Quellious", itemId: 200, quantity: 2, choiceGroup: null }],
    };
    expect(isQuestReady(ready, snapshot)).toBe(true);
    expect(isQuestReady(short, snapshot)).toBe(false);
    expect(isQuestReady({ ...base, requirements: [] }, snapshot)).toBe(false);
    expect(isQuestReady(ready, null)).toBe(false);
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

describe("quest item references", () => {
  const item = {
    id: 1, name: "Sky Item", itemtype: 0, slots: 0, classes: 0, races: 0,
    ac: 5, hp: 10, mana: 0, astr: 0, asta: 0, aagi: 0, adex: 0,
    awis: 0, aint: 0, acha: 0, damage: 0, delay: 0, magic: 1,
    noDrop: 1, noRent: 0, loregroup: 0, weight: 0, reqlevel: 46,
    haste: 0, procName: null, clickName: null, wornName: null, focusName: null,
    sources: 3, topNpc: "an azarack", topZone: "Plane of Sky",
  } satisfies DropItemRow;
  const reference = {
    queryName: "Sky Item",
    item,
    sources: [
      { npc: "an azarack", level: 52, zone: "airplane", zoneLong: "Plane of Air", era: 0, chance: 12.5, spawns: 2 },
    ],
  } satisfies QuestItemReference;

  it("summarizes bounded drop sources and missing reference data", () => {
    expect(questDropSourceSummary(reference)).toBe("an azarack · Plane of Sky (13%); +2 more");
    expect(questDropSourceSummary(undefined)).toContain("No matching item");
  });

  it("builds compact reward detail lines", () => {
    expect(questItemDetailLines(item)).toEqual(["AC 5 · HP 10", "Required level 46", "NO DROP"]);
    expect(questItemDetailLines(null)).toHaveLength(1);
  });
});
