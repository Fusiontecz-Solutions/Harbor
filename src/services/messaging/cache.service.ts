/**
 * Redis cache for the messaging module.
 *
 * Ported from the Fivra `CacheService` with its two load-bearing properties
 * kept intact:
 *
 *   1. **Fail-open.** Every operation swallows its error and behaves as a cache
 *      miss. A Redis outage must degrade latency, never correctness — the
 *      caller always has a database path behind it.
 *   2. **SCAN, never KEYS.** Pattern invalidation walks the keyspace in cursor
 *      batches. `KEYS` blocks the single Redis thread for the whole scan, which
 *      on a production keyspace stalls every other consumer (including BullMQ).
 *
 * Harbor already owns a shared ioredis client (`config/redis.ts`), so this
 * layers on top of it rather than opening a second connection.
 */
import type Redis from 'ioredis';
import { getRedisClient } from '../../config/redis';

/** Namespace so messaging keys never collide with BullMQ or other consumers. */
const KEY_PREFIX = 'harbor:msg:';

const DEFAULT_TTL_SECONDS = Number(process.env.MESSAGING_CACHE_TTL_SECONDS ?? '300');

/** Keys are grouped so a write to one entity can invalidate exactly its slice. */
export const cacheKeys = {
  conversationList: (userId: string, page: number, search: string, filter: string): string =>
    `${KEY_PREFIX}conv:list:${userId}:${page}:${search || '-'}:${filter || '-'}`,
  conversationListPattern: (userId: string): string => `${KEY_PREFIX}conv:list:${userId}:*`,
  /** Every user's conversation list — used when a write could affect any viewer. */
  conversationListAllPattern: (): string => `${KEY_PREFIX}conv:list:*`,
  conversationMessages: (conversationId: string, page: number): string =>
    `${KEY_PREFIX}conv:msgs:${conversationId}:${page}`,
  conversationMessagesPattern: (conversationId: string): string =>
    `${KEY_PREFIX}conv:msgs:${conversationId}:*`,
  unreadCount: (userId: string): string => `${KEY_PREFIX}unread:${userId}`,
  suppression: (phoneNumber: string): string => `${KEY_PREFIX}supp:${phoneNumber}`,
  dncResult: (phoneNumber: string): string => `${KEY_PREFIX}dnc:${phoneNumber}`,
  broadcastStats: (broadcastId: string): string => `${KEY_PREFIX}bcast:stats:${broadcastId}`,
  broadcastStatsPattern: (): string => `${KEY_PREFIX}bcast:stats:*`,
};

function client(): Redis | null {
  return getRedisClient();
}

/** Returns the cached value, or null on miss, malformed JSON, or any Redis error. */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const redis = client();
  if (!redis) return null;

  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch (err) {
    console.warn('[messaging:cache] get failed, treating as miss:', key, (err as Error)?.message);
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<void> {
  const redis = client();
  if (!redis) return;

  try {
    await redis.setex(key, Math.max(1, Math.floor(ttlSeconds)), JSON.stringify(value));
  } catch (err) {
    console.warn('[messaging:cache] set failed, continuing uncached:', key, (err as Error)?.message);
  }
}

export async function cacheDel(...keys: string[]): Promise<void> {
  const redis = client();
  if (!redis || keys.length === 0) return;

  try {
    await redis.del(...keys);
  } catch (err) {
    console.warn('[messaging:cache] del failed:', keys.join(','), (err as Error)?.message);
  }
}

/**
 * Delete every key matching a glob, walking the keyspace with SCAN.
 *
 * Deletes are issued in batches as the cursor advances rather than collecting
 * the full key list first, so invalidating a large slice never balloons memory
 * in this process.
 */
export async function cacheDelPattern(pattern: string): Promise<void> {
  const redis = client();
  if (!redis) return;

  const BATCH_SIZE = 100;

  try {
    const stream = redis.scanStream({ match: pattern, count: BATCH_SIZE });
    let pending: string[] = [];

    await new Promise<void>((resolve, reject) => {
      stream.on('data', (keys: string[]) => {
        if (!keys.length) return;
        pending.push(...keys);

        if (pending.length >= BATCH_SIZE) {
          const batch = pending;
          pending = [];
          // Pause while the delete is in flight so the stream cannot outrun us.
          stream.pause();
          redis
            .del(...batch)
            .catch((err) => console.warn('[messaging:cache] batch delete failed:', err?.message))
            .finally(() => stream.resume());
        }
      });

      stream.on('end', () => {
        if (pending.length === 0) return resolve();
        redis
          .del(...pending)
          .catch((err) => console.warn('[messaging:cache] final delete failed:', err?.message))
          .finally(() => resolve());
      });

      stream.on('error', reject);
    });
  } catch (err) {
    console.warn('[messaging:cache] delPattern failed:', pattern, (err as Error)?.message);
  }
}

/**
 * Read-through helper: return the cached value, otherwise run `loader`, cache
 * its result and return it. A loader throwing propagates — only cache failures
 * are swallowed.
 */
export async function cacheWrap<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
): Promise<T> {
  const hit = await cacheGet<T>(key);
  if (hit !== null) return hit;

  const value = await loader();
  // `undefined` is not representable in JSON — skip rather than cache "null".
  if (value !== undefined) {
    await cacheSet(key, value, ttlSeconds);
  }
  return value;
}
