// Item wishlist (drop alerts): localStorage-backed store shared by the Drops
// tab (star buttons) and the Fights tab (drop alerts + wishlist card).
//
// Cross-view sync mirrors the overlayState pattern: writes dispatch a
// same-window custom event, and other windows hear the browser "storage"
// event; onWishlistChanged subscribes to both (via the shared localStore
// scaffold).

import { createLocalStore } from "./localStore";

/** localStorage key — exported so views can filter "storage" events. */
export const WISHLIST_KEY = "eqlogs.wishlist.v1";

/** Same-window change event dispatched by toggleWishlist. */
export const WISHLIST_EVENT = "eqlogs-wishlist-changed";

export interface WishlistEntry {
  name: string;
}

/** Tolerant of corrupt/legacy payloads (bad JSON, non-array values, entries
 *  without a name). Case-insensitive unique by name. */
const store = createLocalStore<WishlistEntry[]>(
  WISHLIST_KEY,
  WISHLIST_EVENT,
  (raw) => {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: WishlistEntry[] = [];
    for (const e of raw) {
      if (typeof e !== "object" || e === null) continue;
      const name = String((e as { name?: unknown }).name ?? "").trim();
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      out.push({ name });
    }
    return out;
  },
);

/** Stored wishlist ([] when unavailable/corrupt). */
export function loadWishlist(): WishlistEntry[] {
  return store.load();
}

function saveWishlist(entries: WishlistEntry[]): void {
  store.save(entries);
}

/** Whether `name` (case-insensitive) is on the wishlist. */
export function isWishlisted(name: string): boolean {
  const key = name.trim().toLowerCase();
  if (!key) return false;
  return loadWishlist().some((e) => e.name.toLowerCase() === key);
}

/** Add or remove `name` (case-insensitive match, original casing kept on
 *  add). Returns the new state: true = now wishlisted. */
export function toggleWishlist(name: string): boolean {
  const trimmed = name.trim();
  const key = trimmed.toLowerCase();
  if (!key) return false;
  const entries = loadWishlist();
  const without = entries.filter((e) => e.name.toLowerCase() !== key);
  if (without.length < entries.length) {
    saveWishlist(without);
    return false;
  }
  saveWishlist([...entries, { name: trimmed }]);
  return true;
}

/** Subscribe to wishlist changes (same-window toggles AND other windows via
 *  the browser "storage" event). Returns an unsubscribe function. */
export function onWishlistChanged(cb: () => void): () => void {
  return store.subscribe(cb);
}
