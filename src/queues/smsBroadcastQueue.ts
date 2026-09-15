import { Queue, type ConnectionOptions } from 'bullmq';
import Redis from 'ioredis';
import { isRedisAvailable } from '../config/redis';

/* ============================================================================
 * SMS Broadcast Queue
 * ----------------------------------------------------------------------------
 * Replaces Fivra's Kafka `broadcast.recipients` topic.
 *
 * In Fivra, the number of Kafka partitions was the hard ceiling on how many
 * campaigns could run at once — 2 partitions meant 2 concurrent campaigns no
 * matter how much hardware you threw at it, which is why their orchestrator
 * forces the topic to 96 partitions on boot.
 *
 * BullMQ has no such coupling. Jobs from different broadcasts interleave freely
 * across the worker's concurrency slots, so N campaigns genuinely run in
 * parallel. Fairness between them is enforced by the per-broadcast Redis token
 * buckets (see services/messaging/tokenBucket.ts), not by the transport.
 *
 * Jobs carry a CHUNK of recipients rather than a single one. At 50k recipients,
 * per-recipient jobs mean 50k Redis round-trips of queue bookkeeping; chunks of
 * ~100 cut that by two orders of magnitude while the token bucket still paces
 * individual sends inside the chunk.
 * ==========================================================================*/

export const SMS_BROADCAST_QUEUE_NAME = 'sms-broadcast';

export type SmsBroadcastJobName = 'send-chunk';

export interface SmsBroadcastJobData {
  broadcastId: string;
  /** Recipient row ids for this chunk — bodies are resolved in the worker. */
  recipientIds: string[];
  /** Chunk index, for log correlation only. */
  chunkIndex: number;
}

/** Recipients per job. Override with BROADCAST_CHUNK_SIZE. */
export const BROADCAST_CHUNK_SIZE = (() => {
  const raw = Number(process.env.BROADCAST_CHUNK_SIZE);
  if (!Number.isFinite(raw) || raw <= 0) return 100;
  return Math.min(1_000, Math.max(1, Math.floor(raw)));
})();

let queueInstance: Queue<SmsBroadcastJobData> | null = null;

const redisUrl = (): string => String(process.env.REDIS_URL || '').trim();

/** BullMQ bundles its own ioredis types; cast avoids duplicate-package TS errors. */
const createRedisConnection = (): ConnectionOptions =>
  new Redis(redisUrl(), {
    maxRetriesPerRequest: null,
    retryStrategy(times) {
      return Math.min(times * 200, 2_000);
    },
  }) as ConnectionOptions;

export const isSmsBroadcastQueueEnabled = (): boolean => Boolean(redisUrl()) && isRedisAvailable();

export const getSmsBroadcastQueue = (): Queue<SmsBroadcastJobData> | null => {
  if (!isSmsBroadcastQueueEnabled()) return null;

  if (!queueInstance) {
    queueInstance = new Queue<SmsBroadcastJobData>(SMS_BROADCAST_QUEUE_NAME, {
      connection: createRedisConnection(),
      defaultJobOptions: {
        removeOnComplete: 1_000,
        /** Keep failures long enough to diagnose a bad campaign. */
        removeOnFail: 5_000,
        attempts: 3,
        backoff: { type: 'exponential', delay: 10_000 },
      },
    }) as Queue<SmsBroadcastJobData>;
  }

  return queueInstance;
};

/**
 * Enqueue every chunk for a broadcast.
 *
 * Job ids are deterministic (`bcast:<id>:<chunkIndex>`) so re-running the
 * enqueue after a partial failure cannot double-send: BullMQ rejects a
 * duplicate job id while the original is still known to the queue.
 */
export const enqueueBroadcastChunks = async (
  broadcastId: string,
  recipientIds: string[],
): Promise<number> => {
  const queue = getSmsBroadcastQueue();
  if (!queue) {
    throw new Error('Broadcast queue unavailable: REDIS_URL is not configured');
  }

  const jobs: Array<{
    name: SmsBroadcastJobName;
    data: SmsBroadcastJobData;
    opts: { jobId: string };
  }> = [];

  for (let i = 0; i < recipientIds.length; i += BROADCAST_CHUNK_SIZE) {
    const chunkIndex = Math.floor(i / BROADCAST_CHUNK_SIZE);
    jobs.push({
      name: 'send-chunk',
      data: {
        broadcastId,
        recipientIds: recipientIds.slice(i, i + BROADCAST_CHUNK_SIZE),
        chunkIndex,
      },
      opts: { jobId: `bcast:${broadcastId}:${chunkIndex}` },
    });
  }

  // addBulk in slices so a huge campaign does not build one enormous pipeline.
  const ADD_BATCH = 500;
  for (let i = 0; i < jobs.length; i += ADD_BATCH) {
    await queue.addBulk(jobs.slice(i, i + ADD_BATCH));
  }

  return jobs.length;
};

/**
 * Drop every pending job for a broadcast. Jobs already in flight finish their
 * chunk — the worker re-checks broadcast status before each send, so a
 * cancelled campaign stops within one chunk rather than mid-blast.
 */
export const removeBroadcastJobs = async (broadcastId: string): Promise<number> => {
  const queue = getSmsBroadcastQueue();
  if (!queue) return 0;

  const jobs = await queue.getJobs(['waiting', 'delayed', 'paused']);
  let removed = 0;

  for (const job of jobs) {
    if (job?.data?.broadcastId === broadcastId) {
      await job.remove().catch(() => undefined);
      removed += 1;
    }
  }

  return removed;
};
