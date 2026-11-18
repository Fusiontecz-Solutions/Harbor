/**
 * Layer 1 of the inbox cache: in-memory, TTL'd, process-local.
 *
 * The inbox reads through three layers, fastest first:
 *
 *   1. this module        — 0ms, survives navigation, dies on refresh
 *   2. IndexedDB          — ~5ms, survives refresh and offline
 *   3. the API            — 200-500ms
 *
 * Layer 1 exists because React remounts constantly: switching tabs, opening a
 * thread and coming back, a parent re-render. Without it, every one of those is
 * an IndexedDB round-trip at minimum. TTLs are deliberately short (seconds) —
 * this absorbs render churn, it is not a substitute for the socket updates that
 * keep the data actually fresh.
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/** Conversations change often; 5s matches Fivra's tuning. */
export const CONVERSATIONS_TTL_MS = 5_000;
/** Messages in an open thread are socket-driven, so an even shorter TTL. */
export const MESSAGES_TTL_MS = 2_000;

/**
 * Bounded so a long session browsing hundreds of threads cannot grow the heap
 * without limit. Eviction is least-recently-inserted, which is adequate because
 * entries expire in seconds anyway.
 */
const MAX_ENTRIES = 200;

const store = new Map<string, CacheEntry<unknown>>();

export function memoryGet<T>(key: string): T | null {
  const entry = store.get(key);
  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }

  return entry.value as T;
}

export function memorySet<T>(key: string, value: T, ttlMs: number): void {
  if (store.size >= MAX_ENTRIES) {
    // Map preserves insertion order, so the first key is the oldest.
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }

  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/** Drop every key starting with `prefix`. Used on writes that invalidate a slice. */
export function memoryInvalidate(prefix: string): void {
  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

export function memoryClear(): void {
  store.clear();
}

/** Key builders — kept here so the IndexedDB layer can mirror them exactly. */
export const memoryKeys = {
  conversations: (page: number, search: string, filter: string): string =>
    `conv:list:${page}:${search || '-'}:${filter || '-'}`,
  conversationsPrefix: 'conv:list:',
  messages: (conversationId: string, page: number): string => `conv:msgs:${conversationId}:${page}`,
  messagesPrefix: (conversationId: string): string => `conv:msgs:${conversationId}:`,
};
