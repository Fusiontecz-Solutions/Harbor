/**
 * Single-flight guard for broadcast chunk workers.
 *
 * BullMQ concurrency can process many jobs at once; without this lock, every
 * chunk of the same campaign could run in parallel and hammer Postgres while
 * still sharing one per-campaign token bucket. DMS avoids that with an
 * in-flight marker per broadcast id — this is the Harbor equivalent.
 *
 * Different broadcast ids may hold locks simultaneously; only one chunk per id.
 */
import { randomBytes } from 'crypto';
import { getRedisClient } from '../../config/redis';

const LOCK_KEY_PREFIX = 'harbor:msg:bcast:chunk:inflight:';

const envInt = (name: string, fallback: number): number => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
};

/** How long a chunk may hold the lock before Redis expires it (crash safety). */
const LOCK_TTL_SEC = envInt('BROADCAST_CHUNK_LOCK_TTL_SEC', 900);

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

/**
 * Try to become the sole chunk processor for this broadcast.
 * Returns an opaque token to pass to {@link releaseBroadcastChunkLock}.
 */
export async function acquireBroadcastChunkLock(broadcastId: string): Promise<string | null> {
  const redis = getRedisClient();
  if (!redis) return null;

  const token = `${process.pid}:${Date.now()}:${randomBytes(8).toString('hex')}`;
  const key = `${LOCK_KEY_PREFIX}${broadcastId}`;
  const ok = await redis.set(key, token, 'EX', LOCK_TTL_SEC, 'NX');
  return ok === 'OK' ? token : null;
}

/** Release the lock only if we still own it. */
export async function releaseBroadcastChunkLock(broadcastId: string, token: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;

  const key = `${LOCK_KEY_PREFIX}${broadcastId}`;
  try {
    await redis.eval(RELEASE_SCRIPT, 1, key, token);
  } catch (err) {
    console.warn(
      '[messaging:broadcastInflightLock] release failed:',
      broadcastId,
      (err as Error)?.message,
    );
  }
}

/** When another chunk holds the lock, delay the job briefly instead of failing. */
export function broadcastChunkLockRetryDelayMs(): number {
  const base = envInt('BROADCAST_CHUNK_LOCK_RETRY_MS', 750);
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
}
