import { describe, expect, it } from "vitest";
import type { InventoryItemMetadata } from "../types";
import type { InventoryRow } from "./inventory";
import {
  filterInventoryRows,
  type AnalyzedInventoryRow,
  type InventoryFilters,
} from "./inventoryFilters";

const row: InventoryRow = {
  key: "id:1:test item", itemId: 1, name: "Test Item", normalizedName: "test item",
  quantity: 3, locations: ["General 1-Slot1"], storages: ["general"], entries: [],
  exaltation: false,
};
const metadata: InventoryItemMetadata = {
  key: row.key, itemId: 1, itemtype: 10, slots: 131072, classes: 1 << 6,
  races: 1 << 12, reqlevel: 46, magic: 1, noDrop: 1, noRent: 0, loregroup: 1,
};
const analyzed: AnalyzedInventoryRow = {
  row, metadata, recipeUses: 0, status: "Needed",
  questUses: [{ quest: { id: "quest", name: "Quest" } as never, required: 1, status: "in-progress" }],
};
const defaults: InventoryFilters = {
  storage: "all", status: "all", classMask: 0, raceBit: 0, itemtype: null,
  slotMask: 0, minLevel: 0, maxLevel: 0, minQuantity: 1, quest: "all", property: "all",
};

describe("filterInventoryRows", () => {
  it("combines class, race, type, slot, level, quantity, quest, and property filters", () => {
    const result = filterInventoryRows([analyzed], {
      ...defaults, classMask: 1 << 6, raceBit: 1 << 12, itemtype: 10,
      slotMask: 131072, minLevel: 40, maxLevel: 50, minQuantity: 2,
      quest: "active", property: "no-drop",
    });
    expect(result).toEqual([analyzed]);
  });

  it("excludes unknown reference rows only when a metadata filter is active", () => {
    const unknown = { ...analyzed, metadata: null };
    expect(filterInventoryRows([unknown], defaults)).toHaveLength(1);
    expect(filterInventoryRows([unknown], { ...defaults, classMask: 1 })).toHaveLength(0);
  });

  it("supports completed-quest and missing-reference audits", () => {
    const completed = { ...analyzed, questUses: [{ ...analyzed.questUses[0], status: "completed" as const }] };
    expect(filterInventoryRows([completed], { ...defaults, quest: "completed" })).toHaveLength(1);
    expect(filterInventoryRows([{ ...completed, metadata: null }], { ...defaults, property: "missing-reference" })).toHaveLength(1);
  });
});
