/**
 * IndexedDB-backed cache for Sleeper payloads.
 *
 * Without this the app re-downloads ~11MB on every visit: the player dictionary
 * alone is 2.5MB gzipped, and a full season is 17 weeks x 2 (stats +
 * projections) at ~240KB each. On a phone that is both slow and expensive.
 *
 * Entries carry their own TTL because the payloads age at very different rates:
 * completed weeks never change, the player dictionary changes daily, and the
 * current week changes every few minutes during games.
 */

const DB_NAME = 'sla-cache';
const DB_VERSION = 1;
const STORE = 'payloads';

interface CacheEntry<T> {
  key: string;
  value: T;
  storedAt: number;
  ttl: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    // Private browsing and some embedded webviews block IndexedDB entirely.
    // The app must still work, just without persistence.
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }

    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'key' });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });

  return dbPromise;
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(key);

      request.onsuccess = () => {
        const entry = request.result as CacheEntry<T> | undefined;
        if (!entry) {
          resolve(null);
          return;
        }
        if (entry.ttl > 0 && Date.now() - entry.storedAt > entry.ttl) {
          resolve(null);
          return;
        }
        resolve(entry.value);
      };

      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function cacheSet<T>(key: string, value: T, ttl: number): Promise<void> {
  const db = await openDb();
  if (!db) return;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ key, value, storedAt: Date.now(), ttl } satisfies CacheEntry<T>);
      tx.oncomplete = () => resolve();
      // A write failure (usually a storage quota) must not break the app.
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function cacheClear(): Promise<void> {
  const db = await openDb();
  if (!db) return;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** TTLs, in milliseconds. */
export const TTL = {
  /** Completed weeks are immutable — keep them for a month. */
  FINAL_WEEK: 30 * 24 * 60 * 60 * 1000,
  /** The in-progress week changes constantly during games. */
  LIVE_WEEK: 2 * 60 * 1000,
  /** Player metadata (teams, injuries) turns over daily. */
  PLAYERS: 12 * 60 * 60 * 1000,
  /** League config rarely changes mid-season. */
  LEAGUE: 60 * 60 * 1000,
  /** Rosters change on waivers and trades. */
  ROSTERS: 5 * 60 * 1000,
  /** Preseason totals move with depth charts, injuries and roster changes. */
  SEASON_PROJECTIONS: 6 * 60 * 60 * 1000,
  /** NFL state drives the current week — check often but not every render. */
  STATE: 5 * 60 * 1000,
} as const;

/**
 * Fetches through the cache: returns the cached value when fresh, otherwise
 * fetches, stores and returns.
 */
export async function cached<T>(
  key: string,
  ttl: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const hit = await cacheGet<T>(key);
  if (hit !== null) return hit;

  const value = await fetcher();
  // Fire-and-forget: a slow write shouldn't delay rendering.
  void cacheSet(key, value, ttl);
  return value;
}
