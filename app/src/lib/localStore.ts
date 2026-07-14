// Generic localStorage store scaffold — the load / save / notify / subscribe
// quartet that wishlist, scoreboard, buffConflicts, respawnTiming, timers and
// the Coach/Quests persistence all repeat. Storage keys and event names are
// supplied by each store module and stay exactly as they were.
//
// Import-safe outside a browser (vitest runs in node): every localStorage /
// window touch is guarded, so pure-logic tests can import store modules
// without a DOM.

export interface LocalStore<T> {
  /** localStorage key (exported by store modules so views can filter
   *  "storage" events). */
  key: string;
  /** Parse + validate the stored value; corrupt data and quota errors fall
   *  back to `decode(null)`. */
  load(): T;
  /** Persist (best-effort) and notify same-window listeners via the custom
   *  event, when one is configured. Other windows hear the browser "storage"
   *  event. */
  save(value: T): void;
  /**
   * Subscribe to changes: same-window saves (custom event) AND other windows
   * (browser "storage" event, filtered to this key). `remote` is true for
   * cross-window changes — callers that already hold the state they just
   * wrote can ignore local echoes. Returns an unsubscribe function.
   */
  subscribe(cb: (remote: boolean) => void): () => void;
}

/**
 * `decode` receives the JSON-parsed value, or `null` when the key is missing
 * or unreadable — it must return a usable default in that case. Omitting
 * `eventName` skips the same-window notify (stores whose readers only live
 * in other windows, or that have no subscribers).
 */
export function createLocalStore<T>(
  key: string,
  eventName: string | undefined,
  decode: (raw: unknown) => T,
): LocalStore<T> {
  return {
    key,
    load(): T {
      try {
        const raw = localStorage.getItem(key);
        return decode(raw === null ? null : (JSON.parse(raw) as unknown));
      } catch {
        return decode(null); // unavailable / corrupt — behave as empty
      }
    },
    save(value: T): void {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        // quota / unavailable — the in-memory state still works
      }
      if (eventName) {
        try {
          window.dispatchEvent(new Event(eventName));
        } catch {
          // no window (tests) — fine
        }
      }
    },
    subscribe(cb: (remote: boolean) => void): () => void {
      const onStorage = (e: StorageEvent) => {
        // key === null is localStorage.clear().
        if (e.key === null || e.key === key) cb(true);
      };
      const onLocal = () => cb(false);
      window.addEventListener("storage", onStorage);
      if (eventName) window.addEventListener(eventName, onLocal);
      return () => {
        window.removeEventListener("storage", onStorage);
        if (eventName) window.removeEventListener(eventName, onLocal);
      };
    },
  };
}
