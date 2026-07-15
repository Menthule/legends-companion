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

export interface InventoryStorageSlot {
  ordinal: number;
  location: string;
  storage: string;
  empty: boolean;
}

export interface InventoryCurrency {
  name: string;
  quantity: number;
  updatedAtMs: number;
}

export interface InventoryCurrencyMeasurement {
  id: number;
  name: string;
  quantity: number;
  measuredAtMs: number;
}

export type InventoryDispositionAction = "keep" | "move" | "sell" | "trade" | "review";

export interface InventoryDisposition {
  itemKey: string;
  action: InventoryDispositionAction;
  note: string;
  updatedAtMs: number;
}

export type QuestProgressStatus = "unknown" | "planned" | "in-progress" | "completed" | "ignored";

export interface InventoryQuestProgress {
  questId: string;
  status: QuestProgressStatus;
  updatedAtMs: number;
}

export interface InventoryDatabase {
  current: InventorySnapshotMeta | null;
  entries: InventoryEntryRow[];
  previousEntries: InventoryEntryRow[];
  storageSlots: InventoryStorageSlot[];
  history: InventorySnapshotMeta[];
  currencies: InventoryCurrency[];
  currencyHistory: InventoryCurrencyMeasurement[];
  keepKeys: string[];
  dispositions: InventoryDisposition[];
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
  | "Possible quest use"
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
  const active = questUses.filter((use) => use.status === "planned" || use.status === "in-progress");
  const required = active.reduce((sum, use) => sum + use.required, 0);
  if (required > 0 && row.quantity <= required) return "Needed";
  if (required > 0 && row.quantity > required) return "Extra quantity";
  if (recipeUses > 0) return "Recipe component";
  if (questUses.some((use) => use.status === "unknown")) return "Possible quest use";
  if (questUses.length > 0) return "Completed quests only";
  return "No known use";
}

export interface InventoryCapacityRow {
  storage: string;
  total: number;
  occupied: number;
  free: number;
}

/** Count usable exported storage slots. Container children are counted only
 * when the parent exposes a normal Slot1..N sequence; enhancement slots such
 * as Slot7/8/9 therefore do not inflate capacity. */
export function inventoryCapacity(slots: InventoryStorageSlot[]): InventoryCapacityRow[] {
  const areas = ["carried", "bank", "shared-bank", "hoard", "personal-depot"];
  const roots: Record<string, RegExp> = {
    carried: /^General\d+$/i,
    bank: /^Bank\d+$/i,
    "shared-bank": /^SharedBank\d+$/i,
    hoard: /^Hoard\d+$/i,
    "personal-depot": /^Personal-Depot\d+$/i,
  };
  return areas.flatMap((storage) => {
    const area = slots.filter((slot) => slot.storage === storage);
    const rootRows = area.filter((slot) => roots[storage].test(slot.location));
    const physical = rootRows.flatMap((root) => {
      if (storage === "hoard" || storage === "personal-depot") return [root];
      const escaped = root.location.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const childPattern = new RegExp(`^${escaped}-Slot(\\d+)$`, "i");
      const children = area
        .map((slot) => ({ slot, index: Number(childPattern.exec(slot.location)?.[1] ?? 0) }))
        .filter((value) => value.index > 0)
        .sort((left, right) => left.index - right.index);
      return children.length >= 2 && children[0].index === 1
        ? children.map((value) => value.slot)
        : [root];
    });
    if (physical.length === 0) return [];
    const occupied = physical.filter((slot) => !slot.empty).length;
    return [{ storage, total: physical.length, occupied, free: physical.length - occupied }];
  });
}

export type InventoryChangeKind = "Added" | "Removed" | "Moved" | "Quantity changed";

export interface InventoryChange {
  key: string;
  name: string;
  kinds: InventoryChangeKind[];
  beforeQuantity: number;
  quantity: number;
  difference: number;
  beforeLocations: string[];
  locations: string[];
}

export function inventoryChanges(
  current: InventoryEntryRow[],
  previous: InventoryEntryRow[],
): InventoryChange[] {
  const now = new Map(aggregateInventory(current).map((row) => [row.key, row]));
  const before = new Map(aggregateInventory(previous).map((row) => [row.key, row]));
  const changes: InventoryChange[] = [];
  for (const key of new Set([...now.keys(), ...before.keys()])) {
    const currentRow = now.get(key);
    const previousRow = before.get(key);
    const quantity = currentRow?.quantity ?? 0;
    const beforeQuantity = previousRow?.quantity ?? 0;
    const locations = currentRow?.locations ?? [];
    const beforeLocations = previousRow?.locations ?? [];
    const kinds: InventoryChangeKind[] = [];
    if (!previousRow) kinds.push("Added");
    else if (!currentRow) kinds.push("Removed");
    else {
      if (quantity !== beforeQuantity) kinds.push("Quantity changed");
      if (locations.join("\0") !== beforeLocations.join("\0")) kinds.push("Moved");
    }
    if (kinds.length > 0) changes.push({
      key, name: currentRow?.name ?? previousRow?.name ?? key, kinds,
      beforeQuantity, quantity, difference: quantity - beforeQuantity,
      beforeLocations, locations,
    });
  }
  return changes.sort((left, right) => left.name.localeCompare(right.name));
}

export function currencyRate(measurements: InventoryCurrencyMeasurement[]) {
  if (measurements.length < 2) return null;
  const [latest, previous] = [...measurements].sort((left, right) => right.measuredAtMs - left.measuredAtMs);
  const hours = (latest.measuredAtMs - previous.measuredAtMs) / 3_600_000;
  if (hours <= 0) return null;
  const gained = latest.quantity - previous.quantity;
  return { gained, hours, perHour: gained / hours };
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
