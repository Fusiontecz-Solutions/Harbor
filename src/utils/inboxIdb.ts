/**
 * Layer 2 of the inbox cache: IndexedDB.
 *
 * Ported from Fivra's `inbox-idb.ts`. This is what makes the inbox open
 * instantly on a hard refresh — conversations and open threads render from disk
 * while the network request is still in flight, then reconcile.
 *
 * Design notes carried over:
 *   - Every read and write is wrapped: a browser in private mode, with storage
 *     disabled, or over quota must degrade to a cache miss, never throw into a
 *     render.
 *   - Entries are LRU-capped. IndexedDB has no TTL of its own, so an inbox
 *     browsed for months would otherwise accumulate unbounded message history.
 *   - Cache keys embed the signed-in user. Two agents sharing a browser profile
 *     must never see each other's conversations out of the cache.
 */
import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'harbor-inbox';
const DB_VERSION = 1;
const STORE_CONVERSATIONS = 'conversations';
const STORE_MESSAGES = 'messages';

/** Keep the most recent N cached list pages / threads. */
const MAX_CONVERSATION_KEYS = 10;
const MAX_MESSAGE_THREADS = 50;

/** Stale entries are still served (instantly) but trigger a refetch. */
export const IDB_STALE_AFTER_MS = 5 * 60 * 1000;

export interface IdbEntry<T> {
  key: string;
  data: T;
  updatedAt: number;
}

const isBrowser = typeof window !== 'undefined' && typeof indexedDB !== 'undefined';

let dbPromise: Promise<IDBPDatabase | null> | null = null;

function getDb(): Promise<IDBPDatabase | null> {
  if (!isBrowser) return Promise.resolve(null);

  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_CONVERSATIONS)) {
          db.createObjectStore(STORE_CONVERSATIONS, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
          db.createObjectStore(STORE_MESSAGES, { keyPath: 'key' });
        }
      },
    }).catch((error) => {
      // Private browsing, blocked storage, or a corrupt database. Disable the
      // layer for this session rather than retrying on every read.
      console.warn('[inbox-idb] unavailable, continuing without persistence:', error);
      return null;
    });
  }

  return dbPromise;
}

function scopeKey(userScope: string | null | undefined, key: string): string {
  return `${userScope?.trim() || 'anon'}::${key}`;
}

async function readEntry<T>(store: string, key: string): Promise<IdbEntry<T> | null> {
  try {
    const db = await getDb();
    if (!db) return null;
    const entry = (await db.get(store, key)) as IdbEntry<T> | undefined;
    return entry ?? null;
  } catch (error) {
    console.warn('[inbox-idb] read failed:', key, error);
    return null;
  }
}

async function writeEntry<T>(store: string, key: string, data: T, maxEntries: number): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;

    await db.put(store, { key, data, updatedAt: Date.now() } satisfies IdbEntry<T>);
    await evictOldest(db, store, maxEntries);
  } catch (error) {
    console.warn('[inbox-idb] write failed:', key, error);
  }
}

/** Trim the store to `maxEntries`, dropping least-recently-updated first. */
async function evictOldest(db: IDBPDatabase, store: string, maxEntries: number): Promise<void> {
  try {
    const all = (await db.getAll(store)) as Array<IdbEntry<unknown>>;
    if (all.length <= maxEntries) return;

    const excess = all.sort((a, b) => a.updatedAt - b.updatedAt).slice(0, all.length - maxEntries);
    await Promise.all(excess.map((entry) => db.delete(store, entry.key)));
  } catch (error) {
    console.warn('[inbox-idb] eviction failed:', error);
  }
}

/* ------------------------------------------------------------------ */
/* Conversation list pages                                             */
/* ------------------------------------------------------------------ */

export function conversationCacheKey(
  userScope: string | null | undefined,
  page: number,
  search: string,
  filter: string,
): string {
  return scopeKey(userScope, `conv:${page}:${search || '-'}:${filter || '-'}`);
}

export async function readCachedConversations<T>(key: string): Promise<{ data: T; isStale: boolean } | null> {
  const entry = await readEntry<T>(STORE_CONVERSATIONS, key);
  if (!entry) return null;
  return { data: entry.data, isStale: Date.now() - entry.updatedAt > IDB_STALE_AFTER_MS };
}

export async function writeCachedConversations<T>(key: string, data: T): Promise<void> {
  await writeEntry(STORE_CONVERSATIONS, key, data, MAX_CONVERSATION_KEYS);
}

/* ------------------------------------------------------------------ */
/* Thread messages                                                     */
/* ------------------------------------------------------------------ */

export function messagesCacheKey(userScope: string | null | undefined, conversationId: string): string {
  return scopeKey(userScope, `msgs:${conversationId}`);
}

export async function readCachedMessages<T>(key: string): Promise<{ data: T; isStale: boolean } | null> {
  const entry = await readEntry<T>(STORE_MESSAGES, key);
  if (!entry) return null;
  return { data: entry.data, isStale: Date.now() - entry.updatedAt > IDB_STALE_AFTER_MS };
}

export async function writeCachedMessages<T>(key: string, data: T): Promise<void> {
  await writeEntry(STORE_MESSAGES, key, data, MAX_MESSAGE_THREADS);
}

/**
 * Wipe everything. Call on logout — cached conversations are merchant PII and
 * must not survive into the next person's session on a shared machine.
 */
export async function clearInboxCache(): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await Promise.all([db.clear(STORE_CONVERSATIONS), db.clear(STORE_MESSAGES)]);
  } catch (error) {
    console.warn('[inbox-idb] clear failed:', error);
  }
}
