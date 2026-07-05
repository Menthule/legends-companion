// Item wishlist (drop alerts): localStorage-backed store shared by the Drops
// tab (star buttons) and the Fights tab (drop alerts + wishlist card).
//
// Cross-view sync mirrors the overlayState pattern: writes dispatch a
// same-window custom event, and other windows hear the browser "storage"
// event; onWishlistChanged subscribes to both.

/** localStorage key — exported so views can filter "storage" events. */
export const WISHLIST_KEY = "eqlogs.wishlist.v1";

/** Same-window change event dispatched by toggleWishlist. */
export const WISHLIST_EVENT = "eqlogs-wishlist-changed";

export interface WishlistEntry {
  name: string;
}

/** Stored wishlist, tolerant of corrupt/legacy payloads (bad JSON, non-array
 *  values, entries without a name). Case-insensitive unique by name. */
export function loadWishlist(): WishlistEntry[] {
  try {
    const raw = localStorage.getItem(WISHLIST_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: WishlistEntry[] = [];
    for (const e of parsed) {
      if (typeof e !== "object" || e === null) continue;
      const name = String((e as { name?: unknown }).name ?? "").trim();
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      out.push({ name });
    }
    return out;
  } catch {
    return []; // localStorage unavailable / corrupt — behave as empty
  }
}

function saveWishlist(entries: WishlistEntry[]): void {
  try {
    localStorage.setItem(WISHLIST_KEY, JSON.stringify(entries));
  } catch {
    // localStorage unavailable — the wishlist just won't persist.
  }
  window.dispatchEvent(new Event(WISHLIST_EVENT));
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
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === WISHLIST_KEY) cb();
  };
  const onLocal = () => cb();
  window.addEventListener("storage", onStorage);
  window.addEventListener(WISHLIST_EVENT, onLocal);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(WISHLIST_EVENT, onLocal);
  };
}
