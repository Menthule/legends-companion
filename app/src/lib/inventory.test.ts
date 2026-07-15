import { describe, expect, it } from "vitest";
import { aggregateInventory, classifyInventoryItem, inventoryDelta, type InventoryEntryRow } from "./inventory";

function entry(name: string, quantity: number, storage = "bank"): InventoryEntryRow {
  return {
    ordinal: 0, location: "Bank1", storage, itemId: 42, name,
    normalizedName: "sky gem", quantity, slots: 10, keyring: false, exaltation: false,
  };
}

describe("inventory analysis", () => {
  it("keeps ranked variants separate and totals exact duplicates", () => {
    const rows = aggregateInventory([entry("Sky Gem +1", 1), entry("Sky Gem +2", 1), entry("Sky Gem +1", 2)]);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.name === "Sky Gem +1")?.quantity).toBe(3);
  });

  it("never labels an active quest item as unused", () => {
    const row = aggregateInventory([entry("Sky Gem", 1)])[0];
    expect(classifyInventoryItem({
      row, keep: false, watched: false, recipeUses: 0,
      questUses: [{ quest: { id: "q" } as never, required: 2, status: "in-progress" }],
    })).toBe("Needed");
  });

  it("reports quantity changes between snapshots", () => {
    expect(inventoryDelta([entry("Sky Gem", 4)], [entry("Sky Gem", 1)])).toEqual({ added: 3, removed: 0 });
  });
});
