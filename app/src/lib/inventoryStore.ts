// Quest-inventory persistence (Quests tab): the remembered /output inventory
// export path and the last parsed snapshot, both keyed by lowercased
// character name. Built on the shared localStore scaffold so edits sync
// across windows like the wishlist does.

import { createLocalStore } from "./localStore";
import type { InventorySnapshot } from "./quests";

export const INVENTORY_PATH_KEY = "eqlogs.inventory.path.v1";
export const INVENTORY_SNAPSHOT_KEY = "eqlogs.inventory.snapshot.v1";
/** Same-window change event dispatched by remember* writes. */
export const INVENTORY_EVENT = "eqlogs-inventory-changed";

function decodeRecord<V>(raw: unknown): Record<string, V> {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, V>)
    : {};
}

const pathStore = createLocalStore<Record<string, string>>(
  INVENTORY_PATH_KEY,
  INVENTORY_EVENT,
  decodeRecord,
);

const snapshotStore = createLocalStore<Record<string, InventorySnapshot>>(
  INVENTORY_SNAPSHOT_KEY,
  INVENTORY_EVENT,
  decodeRecord,
);

export function savedInventoryPath(character: string): string {
  return pathStore.load()[character.toLowerCase()] ?? "";
}

export function rememberInventoryPath(character: string, path: string): void {
  const rows = pathStore.load();
  rows[character.toLowerCase()] = path;
  pathStore.save(rows);
}

export function savedInventorySnapshot(
  character: string,
): InventorySnapshot | null {
  return snapshotStore.load()[character.toLowerCase()] ?? null;
}

export function rememberInventorySnapshot(
  character: string,
  snapshot: InventorySnapshot,
): void {
  const rows = snapshotStore.load();
  rows[character.toLowerCase()] = snapshot;
  snapshotStore.save(rows);
}

/** Subscribe to inventory changes (`remote` = another window). */
export function onInventoryChanged(
  cb: (remote: boolean) => void,
): () => void {
  return snapshotStore.subscribe(cb);
}
