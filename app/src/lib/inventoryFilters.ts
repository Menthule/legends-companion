import type { InventoryItemMetadata } from "../types";
import type {
  InventoryEvidence,
  InventoryRow,
  ItemQuestUse,
} from "./inventory";

export type InventoryQuestFilter = "all" | "any" | "active" | "completed" | "none";
export type InventoryPropertyFilter =
  | "all"
  | "magic"
  | "lore"
  | "no-drop"
  | "no-rent"
  | "exaltation"
  | "missing-reference";

export interface AnalyzedInventoryRow {
  row: InventoryRow;
  questUses: ItemQuestUse[];
  recipeUses: number;
  status: InventoryEvidence;
  metadata: InventoryItemMetadata | null;
}

export interface InventoryFilters {
  storage: string;
  status: "all" | InventoryEvidence;
  classMask: number;
  raceBit: number;
  itemtype: number | null;
  slotMask: number;
  minLevel: number;
  maxLevel: number;
  minQuantity: number;
  quest: InventoryQuestFilter;
  property: InventoryPropertyFilter;
}

export function filterInventoryRows<T extends AnalyzedInventoryRow>(
  items: T[],
  filters: InventoryFilters,
): T[] {
  return items.filter((item) => {
    const { row, questUses, status, metadata } = item;
    if (filters.storage !== "all" && !row.storages.includes(filters.storage)) return false;
    if (filters.status !== "all" && status !== filters.status) return false;
    if (row.quantity < filters.minQuantity) return false;

    const needsReference = filters.classMask !== 0 || filters.raceBit !== 0
      || filters.itemtype != null || filters.slotMask !== 0
      || filters.minLevel > 0 || filters.maxLevel > 0;
    if (needsReference && metadata == null) return false;
    if (filters.classMask !== 0 && (metadata!.classes & filters.classMask) === 0) return false;
    if (filters.raceBit !== 0 && (metadata!.races & filters.raceBit) === 0) return false;
    if (filters.itemtype != null && metadata!.itemtype !== filters.itemtype) return false;
    if (filters.slotMask !== 0 && (metadata!.slots & filters.slotMask) === 0) return false;
    if (filters.minLevel > 0 && metadata!.reqlevel < filters.minLevel) return false;
    if (filters.maxLevel > 0 && metadata!.reqlevel > filters.maxLevel) return false;

    if (filters.quest === "any" && questUses.length === 0) return false;
    if (filters.quest === "none" && questUses.length !== 0) return false;
    if (filters.quest === "active" && !questUses.some((use) => use.status === "planned" || use.status === "in-progress")) return false;
    if (filters.quest === "completed" && !questUses.some((use) => use.status === "completed")) return false;

    if (filters.property === "magic" && !metadata?.magic) return false;
    if (filters.property === "lore" && !metadata?.loregroup) return false;
    if (filters.property === "no-drop" && !metadata?.noDrop) return false;
    if (filters.property === "no-rent" && !metadata?.noRent) return false;
    if (filters.property === "exaltation" && !row.exaltation) return false;
    if (filters.property === "missing-reference" && metadata != null) return false;
    return true;
  });
}
