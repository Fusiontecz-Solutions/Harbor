/**
 * Distributed token bucket (Redis + Lua).
 *
 * Ported from Fivra's `sms-worker/rate/token-bucket.ts`. This is the mechanism
 * that replaces Kafka partition counts as Harbor's concurrency control.
 *
 * Why Lua: read-modify-write on the token count has to be atomic. Doing it with
 * separate GET/SET round-trips lets two workers both observe "1 token left" and
 * both send, which is exactly how you breach a carrier rate limit during a
 * 50k-recipient blast. The script runs inside Redis, so the whole refill-and-
 * take is a single atomic step across every worker in the fleet.
 *
 * Two buckets guard every send:
 *   - an **account** bucket (`rate:infobip:account`) — the provider's ceiling
 *   - a **per-broadcast** bucket (`rate:infobip:bcast:<id>`) — so one large
 *     campaign cannot starve 1:1 replies or another campaign
 *
 * Both must grant a token before a message goes out.
 */
import type Redis from 'ioredis';
import { getRedisClient } from '../../config/redis';

/**
 * Refill is computed from elapsed wall-clock time rather than a background
 * timer, so buckets need no ticker and survive process restarts. The key is
 * given a short TTL: an idle bucket simply disappears and the next `take`
 * starts from a full capacity.
 */
const TAKE_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillPerSec = tonumber(ARGV[2])
local requested = tonumber(ARGV[3])
local now = tonumber(ARGV[4])

local tokens = tonumber(redis.call('HGET', key, 'tokens'))
local ts = tonumber(redis.call('HGET', key, 'ts'))

if tokens == nil then tokens = capacity end
if ts == nil then ts = now end

local elapsed = math.max(0, now - ts) / 1000.0
tokens = math.min(capacity, tokens + elapsed * refillPerSec)

local granted = 0
if tokens >= requested then
  tokens = tokens - requested
  granted = 1
end

redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, 60000)

return granted
`;

export interface TokenBucketOptions {
  /** Burst size — how many messages may go out back-to-back from idle. */
  capacity: number;
  /** Sustained rate in tokens per second. */
  refillPerSecond: number;
}

export class TokenBucket {
  private readonly key: string;
  private readonly capacity: number;
  private readonly refillPerSecond: number;

  constructor(key: string, options: TokenBucketOptions) {
    this.key = key;
    this.capacity = Math.max(1, Math.floor(options.capacity));
    this.refillPerSecond = Math.max(0.1, options.refillPerSecond);
  }

  private redis(): Redis | null {
    return getRedisClient();
  }

  /**
   * Attempt to consume `count` tokens.
   *
   * Returns true when Redis is unavailable: the bucket is a throttle, not an
   * authorization check, and blocking every send because the rate limiter is
   * down would turn a soft dependency into a hard one. The provider enforces
   * its own limits as the real backstop.
   */
  async take(count = 1): Promise<boolean> {
    const redis = this.redis();
    if (!redis) return true;

    try {
      const granted = await redis.eval(
        TAKE_SCRIPT,
        1,
        this.key,
        String(this.capacity),
        String(this.refillPerSecond),
        String(count),
        String(Date.now()),
      );
      return granted === 1;
    } catch (err) {
      console.warn('[messaging:tokenBucket] take failed, allowing send:', this.key, (err as Error)?.message);
      return true;
    }
  }

  /**
   * Block until a token is available or the deadline passes.
   *
   * Sleeps for roughly the time it takes one token to refill instead of busy-
   * spinning, so a worker waiting on a slow bucket costs no CPU. Returns false
   * on timeout — the caller should requeue rather than send.
   */
  async waitForToken(count = 1, timeoutMs = 60_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const sleepMs = Math.min(1_000, Math.max(25, Math.ceil(1000 / this.refillPerSecond)));

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (await this.take(count)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
  }

  /** Current token count, for dashboards and debugging. */
  async available(): Promise<number> {
    const redis = this.redis();
    if (!redis) return this.capacity;

    try {
      const tokens = await redis.hget(this.key, 'tokens');
      return tokens ? Number.parseFloat(tokens) : this.capacity;
    } catch {
      return this.capacity;
    }
  }

  async reset(): Promise<void> {
    const redis = this.redis();
    if (!redis) return;
    try {
      await redis.del(this.key);
    } catch {
      /* fail-open: a stale bucket self-expires within 60s */
    }
  }
}

const envInt = (name: string, fallback: number): number => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

/**
 * Account-wide ceiling shared by every send — 1:1 replies and broadcasts alike.
 * Set `INFOBIP_RATE_PER_SECOND` to whatever the Infobip account is provisioned for.
 */
export function getAccountBucket(): TokenBucket {
  const perSecond = envInt('INFOBIP_RATE_PER_SECOND', 30);
  return new TokenBucket('harbor:msg:rate:infobip:account', {
    capacity: envInt('INFOBIP_RATE_BURST', perSecond * 2),
    refillPerSecond: perSecond,
  });
}

/**
 * Per-broadcast bucket. `throttlePerSecond` comes from the broadcast row, so an
 * operator can slow one campaign down without touching the account ceiling.
 */
export function getBroadcastBucket(broadcastId: string, throttlePerSecond?: number | null): TokenBucket {
  const perSecond = throttlePerSecond && throttlePerSecond > 0
    ? throttlePerSecond
    : envInt('BROADCAST_RATE_PER_SECOND', 10);

  return new TokenBucket(`harbor:msg:rate:infobip:bcast:${broadcastId}`, {
    capacity: Math.max(1, Math.ceil(perSecond)),
    refillPerSecond: perSecond,
  });
}
