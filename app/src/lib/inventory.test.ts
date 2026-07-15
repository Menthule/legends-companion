import { describe, expect, it } from "vitest";
import {
  aggregateInventory,
  classifyInventoryItem,
  currencyRate,
  inventoryCapacity,
  inventoryChanges,
  inventoryDelta,
  type InventoryEntryRow,
} from "./inventory";

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

  it("does not reserve materials for an unplanned quest", () => {
    const row = aggregateInventory([entry("Sky Gem", 1)])[0];
    expect(classifyInventoryItem({
      row, keep: false, watched: false, recipeUses: 0,
      questUses: [{ quest: { id: "q" } as never, required: 2, status: "unknown" }],
    })).toBe("Possible quest use");
  });

  it("reports quantity changes between snapshots", () => {
    expect(inventoryDelta([entry("Sky Gem", 4)], [entry("Sky Gem", 1)])).toEqual({ added: 3, removed: 0 });
  });

  it("reports added, removed, moved, and quantity changes", () => {
    const moved = { ...entry("Moved", 2), name: "Moved", location: "General1" };
    const beforeMoved = { ...moved, quantity: 1, location: "Bank1" };
    const changes = inventoryChanges(
      [moved, { ...entry("Added", 1), name: "Added" }],
      [beforeMoved, { ...entry("Removed", 1), name: "Removed" }],
    );
    expect(changes.find((change) => change.name === "Added")?.kinds).toEqual(["Added"]);
    expect(changes.find((change) => change.name === "Removed")?.kinds).toEqual(["Removed"]);
    expect(changes.find((change) => change.name === "Moved")?.kinds).toEqual(["Quantity changed", "Moved"]);
  });

  it("counts container slots without counting enhancement slots", () => {
    const slots = [
      { ordinal: 0, location: "General1", storage: "carried", empty: false },
      { ordinal: 1, location: "General1-Slot1", storage: "carried", empty: false },
      { ordinal: 2, location: "General1-Slot2", storage: "carried", empty: true },
      { ordinal: 3, location: "General2", storage: "carried", empty: false },
      { ordinal: 4, location: "General2-Slot7", storage: "carried", empty: true },
      { ordinal: 5, location: "Hoard1", storage: "hoard", empty: true },
    ];
    expect(inventoryCapacity(slots)).toEqual([
      { storage: "carried", total: 3, occupied: 2, free: 1 },
      { storage: "hoard", total: 1, occupied: 0, free: 1 },
    ]);
  });

  it("calculates currency gain rates between measurements", () => {
    expect(currencyRate([
      { id: 2, name: "Motes", quantity: 8, measuredAtMs: 7_200_000 },
      { id: 1, name: "Motes", quantity: 2, measuredAtMs: 3_600_000 },
    ])).toEqual({ gained: 6, hours: 1, perHour: 6 });
  });
});
