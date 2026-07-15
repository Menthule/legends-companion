import type { QuestRecord } from "./quests";
import { normalizeInventoryItem } from "./quests";

export interface InventorySnapshotMeta {
  id: number;
  sourcePath: string;
  sourceModifiedMs: number;
  importedAtMs: number;
  fingerprint: string;
  rowCount: number;
  skippedRows: number;
  sections: string[];
}

export interface InventoryEntryRow {
  ordinal: number;
  location: string;
  storage: string;
  itemId: number | null;
  name: string;
  normalizedName: string;
  quantity: number;
  slots: number;
  keyring: boolean;
  exaltation: boolean;
}

export interface InventoryCurrency {
  name: string;
  quantity: number;
  updatedAtMs: number;
}

export type QuestProgressStatus = "unknown" | "in-progress" | "completed" | "ignored";

export interface InventoryQuestProgress {
  questId: string;
  status: QuestProgressStatus;
  updatedAtMs: number;
}

export interface InventoryDatabase {
  current: InventorySnapshotMeta | null;
  entries: InventoryEntryRow[];
  previousEntries: InventoryEntryRow[];
  history: InventorySnapshotMeta[];
  currencies: InventoryCurrency[];
  keepKeys: string[];
  questProgress: InventoryQuestProgress[];
}

export interface InventoryRow {
  key: string;
  itemId: number | null;
  name: string;
  normalizedName: string;
  quantity: number;
  locations: string[];
  storages: string[];
  entries: InventoryEntryRow[];
  exaltation: boolean;
}

export interface ItemQuestUse {
  quest: QuestRecord;
  required: number;
  status: QuestProgressStatus;
}

export function inventoryItemKey(entry: Pick<InventoryEntryRow, "itemId" | "name">): string {
  return `${entry.itemId == null ? "name" : `id:${entry.itemId}`}:${entry.name.trim().toLowerCase()}`;
}

export function aggregateInventory(entries: InventoryEntryRow[]): InventoryRow[] {
  const rows = new Map<string, InventoryRow>();
  for (const entry of entries) {
    const key = inventoryItemKey(entry);
    const existing = rows.get(key) ?? {
      key,
      itemId: entry.itemId,
      name: entry.name,
      normalizedName: entry.normalizedName,
      quantity: 0,
      locations: [],
      storages: [],
      entries: [],
      exaltation: entry.exaltation,
    };
    existing.quantity += entry.quantity;
    existing.entries.push(entry);
    if (!existing.locations.includes(entry.location)) existing.locations.push(entry.location);
    if (!existing.storages.includes(entry.storage)) existing.storages.push(entry.storage);
    rows.set(key, existing);
  }
  return [...rows.values()].map((row) => ({
    ...row,
    locations: row.locations.sort(naturalCompare),
    storages: row.storages.sort(),
  }));
}

function naturalCompare(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

export function questUsesForItem(
  row: InventoryRow,
  quests: QuestRecord[],
  progress: InventoryQuestProgress[],
): ItemQuestUse[] {
  const status = new Map(progress.map((value) => [value.questId, value.status]));
  return quests.flatMap((quest) => {
    const required = quest.requirements
      .filter((requirement) => (
        (row.itemId != null && requirement.itemId === row.itemId)
        || normalizeInventoryItem(requirement.itemName) === row.normalizedName
      ))
      .reduce((sum, requirement) => sum + requirement.quantity, 0);
    return required > 0
      ? [{ quest, required, status: status.get(quest.id) ?? "unknown" }]
      : [];
  });
}

export type InventoryEvidence =
  | "Keep"
  | "Equipped"
  | "Watched"
  | "Needed"
  | "Extra quantity"
  | "Recipe component"
  | "Completed quests only"
  | "No known use";

export function classifyInventoryItem(args: {
  row: InventoryRow;
  questUses: ItemQuestUse[];
  recipeUses: number;
  keep: boolean;
  watched: boolean;
}): InventoryEvidence {
  const { row, questUses, recipeUses, keep, watched } = args;
  if (keep) return "Keep";
  if (row.storages.some((storage) => storage === "equipped" || storage.startsWith("keyring-"))) {
    return "Equipped";
  }
  if (watched) return "Watched";
  const active = questUses.filter((use) => use.status !== "completed" && use.status !== "ignored");
  const required = active.reduce((sum, use) => sum + use.required, 0);
  if (required > 0 && row.quantity <= required) return "Needed";
  if (required > 0 && row.quantity > required) return "Extra quantity";
  if (recipeUses > 0) return "Recipe component";
  if (questUses.length > 0) return "Completed quests only";
  return "No known use";
}

export function inventoryDelta(current: InventoryEntryRow[], previous: InventoryEntryRow[]) {
  const count = (entries: InventoryEntryRow[]) => new Map(
    aggregateInventory(entries).map((row) => [row.key, row.quantity]),
  );
  const now = count(current);
  const before = count(previous);
  let added = 0;
  let removed = 0;
  for (const key of new Set([...now.keys(), ...before.keys()])) {
    const difference = (now.get(key) ?? 0) - (before.get(key) ?? 0);
    if (difference > 0) added += difference;
    if (difference < 0) removed -= difference;
  }
  return { added, removed };
}
