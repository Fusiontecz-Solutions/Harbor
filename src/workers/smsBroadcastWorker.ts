import { DelayedError, Worker, type ConnectionOptions } from 'bullmq';
import Redis from 'ioredis';
import prisma from '../config/prismaClient';
import {
  SMS_BROADCAST_QUEUE_NAME,
  enqueueBroadcastChunks,
  enqueueBroadcastRetry,
  isSmsBroadcastQueueEnabled,
  type SmsBroadcastJobData,
} from '../queues/smsBroadcastQueue';
import {
  completeBroadcastIfDrained,
  flushBroadcastCounters,
  recordBroadcastCounter,
} from '../services/messaging/broadcast.service';
import { dispatchOutboundMessage, renderTemplate } from '../services/messaging/sms.service';
import {
  acquireBroadcastChunkLock,
  broadcastChunkLockRetryDelayMs,
  releaseBroadcastChunkLock,
} from '../services/messaging/broadcastInflightLock';
import { LIMIT_REACHED_CODE, SENDING_DISABLED_CODE } from '../services/tenantControl/counting';

/* ============================================================================
 * SMS Broadcast Worker
 * ----------------------------------------------------------------------------
 * Runs inside the API process, alongside the application-approval worker.
 *
 * Concurrency is how many chunk jobs may run at once across *different*
 * campaigns. A Redis lock ensures at most one chunk per broadcastId is active
 * (same single-flight model as DMS). Send rate is still governed by the token
 * buckets, not by this concurrency number.
 * ==========================================================================*/

let workerInstance: Worker<SmsBroadcastJobData> | null = null;

const createRedisConnection = (): ConnectionOptions =>
  new Redis(String(process.env.REDIS_URL || '').trim(), {
    maxRetriesPerRequest: null,
    retryStrategy(times) {
      return Math.min(times * 200, 2_000);
    },
  }) as ConnectionOptions;

const resolveConcurrency = (): number => {
  const raw = Number(process.env.BROADCAST_WORKER_CONCURRENCY);
  if (!Number.isFinite(raw) || raw <= 0) return 10;
  return Math.min(100, Math.max(1, Math.floor(raw)));
};

/**
 * Small randomized pause between sends within a chunk.
 *
 * Carriers treat perfectly uniform inter-message timing as a bot signature, and
 * Fivra found jittering the gap materially improved deliverability. Set both to
 * 0 to disable.
 */
const sendGapMs = (): number => {
  const min = Number(process.env.SMS_SEND_GAP_MIN_MS ?? '60');
  const max = Number(process.env.SMS_SEND_GAP_MAX_MS ?? '250');
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= 0) return 0;
  const low = Math.max(0, Math.min(min, max));
  const high = Math.max(low, max);
  return low + Math.floor(Math.random() * (high - low + 1));
};

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/** Statuses that mean "stop sending this campaign right now". */
const HALTED_STATUSES = new Set(['PAUSED', 'CANCELLED', 'COMPLETED', 'FAILED']);

/**
 * Sends in flight at once inside one chunk. The token buckets still set the
 * actual rate; this only stops per-message database and provider latency from
 * capping a campaign at 1/latency messages per second.
 */
const resolveChunkParallelism = (): number => {
  const raw = Number(process.env.BROADCAST_CHUNK_PARALLELISM);
  if (!Number.isFinite(raw) || raw <= 0) return 3;
  return Math.min(50, Math.max(1, Math.floor(raw)));
};

/**
 * Sends in flight across the whole process, whatever the number of campaigns.
 * Each send holds a database connection for several queries; with 8 campaigns
 * × 5 lanes the 10-connection pool starved and sends failed with "Unable to
 * start a transaction". Kept at half the pool so the API stays responsive.
 */
const MAX_CONCURRENT_SENDS = (() => {
  const raw = Number(process.env.BROADCAST_MAX_CONCURRENT_SENDS);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  const pool = Number(process.env.DB_POOL_MAX ?? '10');
  return Math.max(2, Math.floor((Number.isFinite(pool) ? pool : 10) / 2));
})();

let activeSends = 0;
const sendWaiters: Array<() => void> = [];

async function withSendSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeSends >= MAX_CONCURRENT_SENDS) {
    await new Promise<void>((resolve) => sendWaiters.push(resolve));
  }
  activeSends += 1;
  try {
    return await fn();
  } finally {
    activeSends -= 1;
    sendWaiters.shift()?.();
  }
}

/** Give up on a recipient after this many requeue passes. */
const MAX_RETRY_PASSES = (() => {
  const raw = Number(process.env.BROADCAST_MAX_RETRY_PASSES);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 5;
})();

/** Backoff before a retry pass: 5s, 10s, 20s… capped at 2 minutes. */
const retryDelayMs = (pass: number): number => Math.min(120_000, 5_000 * 2 ** Math.max(0, pass - 1));

/** How stale the cached broadcast status may be before it is re-read. */
const STATUS_RECHECK_MS = 1_000;

/**
 * Platform-level refusals: every remaining recipient would fail the same way,
 * so the campaign is paused instead of burning through its list as FAILED.
 */
const PLATFORM_BLOCK_CODES = new Set([SENDING_DISABLED_CODE, LIMIT_REACHED_CODE]);

/**
 * Rows left in SENDING by a worker that died mid-chunk. The chunk lock means no
 * other chunk of this campaign is sending right now, so any SENDING row in this
 * chunk is orphaned. Three cases:
 *   - the outbound message has a provider id: it was accepted → SENT
 *   - an outbound message row exists without one: it may or may not have
 *     reached the provider → FAILED as "delivery unknown", never resent, since
 *     a duplicate SMS is worse than a missed one
 *   - no outbound row at all: it never left → back to QUEUED to be sent
 */
async function recoverOrphanedRows(broadcastId: string, recipientIds: string[]): Promise<void> {
  const orphaned = await prisma.smsBroadcastRecipient.findMany({
    where: { id: { in: recipientIds }, status: 'SENDING' },
    select: { id: true, phoneNumber: true },
  });
  if (orphaned.length === 0) return;

  const attempts = await prisma.messagingMessage.findMany({
    where: {
      broadcastId,
      direction: 'OUTBOUND',
      toNumber: { in: orphaned.map((row) => row.phoneNumber) },
    },
    select: { toNumber: true, providerMessageId: true },
  });
  const submittedByNumber = new Map(
    attempts.filter((m) => m.providerMessageId).map((m) => [m.toNumber, m.providerMessageId]),
  );
  const attemptedNumbers = new Set(attempts.map((m) => m.toNumber));

  for (const row of orphaned) {
    const providerMessageId = submittedByNumber.get(row.phoneNumber);
    if (providerMessageId) {
      const updated = await prisma.smsBroadcastRecipient.updateMany({
        where: { id: row.id, status: 'SENDING' },
        data: { status: 'SENT', providerMessageId, sentAt: new Date() },
      });
      if (updated.count > 0) {
        recordBroadcastCounter(broadcastId, 'sentCount');
        recordBroadcastCounter(broadcastId, 'queuedCount');
      }
    } else if (attemptedNumbers.has(row.phoneNumber)) {
      const updated = await prisma.smsBroadcastRecipient.updateMany({
        where: { id: row.id, status: 'SENDING' },
        data: {
          status: 'FAILED',
          sentAt: new Date(),
          errorMessage: 'Interrupted mid-send; delivery unknown. Not retried to avoid a duplicate message.',
        },
      });
      if (updated.count > 0) {
        recordBroadcastCounter(broadcastId, 'failedCount');
        recordBroadcastCounter(broadcastId, 'queuedCount');
      }
    } else {
      await prisma.smsBroadcastRecipient.updateMany({
        where: { id: row.id, status: 'SENDING' },
        data: { status: 'QUEUED' },
      });
    }
  }
}

/**
 * Campaigns stuck in RUNNING: every chunk job is gone (it exhausted its
 * retries, or the process died) but recipients are still QUEUED or SENDING,
 * so nothing will ever move them. Called from the scheduler tick.
 *
 * A recent stall resumes on its own. An old one is paused instead of sent:
 * a campaign meant for yesterday afternoon must not go out unannounced the
 * next morning — an admin can resume it.
 */
export async function recoverStalledBroadcasts(now = new Date()): Promise<{ resumed: number; paused: number }> {
  const STALL_MS = Number(process.env.BROADCAST_STALL_MS ?? String(15 * 60_000));
  const AUTO_RESUME_MS = Number(process.env.BROADCAST_AUTO_RESUME_MS ?? String(2 * 60 * 60_000));

  const stalled = await prisma.$queryRaw<Array<{ id: string; name: string; lastActivity: Date }>>`
    SELECT b.id, b.name, MAX(r."updatedAt") AS "lastActivity"
      FROM "SmsBroadcast" b
      JOIN "SmsBroadcastRecipient" r ON r."broadcastId" = b.id
     WHERE b.status = 'RUNNING'
     GROUP BY b.id, b.name
    HAVING COUNT(*) FILTER (WHERE r.status IN ('QUEUED', 'SENDING')) > 0
       AND MAX(r."updatedAt") < ${new Date(now.getTime() - STALL_MS)}`;

  let resumed = 0;
  let paused = 0;
  for (const b of stalled) {
    // A chunk that is genuinely still working holds the lock; leave it alone.
    const lock = await acquireBroadcastChunkLock(b.id);
    if (!lock) continue;
    await releaseBroadcastChunkLock(b.id, lock);

    if (now.getTime() - new Date(b.lastActivity).getTime() > AUTO_RESUME_MS) {
      await prisma.smsBroadcast.updateMany({ where: { id: b.id, status: 'RUNNING' }, data: { status: 'PAUSED' } });
      paused += 1;
      console.warn(`[smsBroadcastWorker] "${b.name}" stalled since ${new Date(b.lastActivity).toISOString()} — paused for an admin to resume`);
      continue;
    }

    const pending = await prisma.smsBroadcastRecipient.findMany({
      where: { broadcastId: b.id, status: { in: ['QUEUED', 'SENDING'] } },
      select: { id: true },
    });
    // The worker settles SENDING rows (recoverOrphanedRows) before sending.
    await enqueueBroadcastChunks(b.id, pending.map((r) => r.id));
    resumed += 1;
    console.warn(`[smsBroadcastWorker] "${b.name}" stalled — re-queued ${pending.length} recipients`);
  }
  return { resumed, paused };
}

async function processChunk(data: SmsBroadcastJobData): Promise<void> {
  const pass = data.pass ?? 0;
  const broadcast = await prisma.smsBroadcast.findUnique({
    where: { id: data.broadcastId },
    select: {
      id: true,
      campaignKey: true,
      body: true,
      fromNumber: true,
      mediaUrls: true,
      status: true,
      throttlePerSecond: true,
      createdById: true,
    },
  });

  if (!broadcast) {
    console.warn('[smsBroadcastWorker] broadcast no longer exists, dropping chunk:', data.broadcastId);
    return;
  }

  if (HALTED_STATUSES.has(broadcast.status)) {
    return;
  }

  await recoverOrphanedRows(broadcast.id, data.recipientIds);

  const recipients = await prisma.smsBroadcastRecipient.findMany({
    where: { id: { in: data.recipientIds }, status: 'QUEUED' },
    select: { id: true, phoneNumber: true, mergeData: true },
  });

  if (recipients.length === 0) {
    await completeBroadcastIfDrained(broadcast.id);
    return;
  }

  // Claim the rows so a duplicate delivery of this job cannot re-send them.
  await prisma.smsBroadcastRecipient.updateMany({
    where: { id: { in: recipients.map((r) => r.id) }, status: 'QUEUED' },
    data: { status: 'SENDING' },
  });

  // Status is re-read between sends so pause/cancel takes effect inside a
  // chunk, but at most once a second and shared by every lane — one query per
  // message used to be a large share of the per-send latency.
  let statusCheckedAt = Date.now();
  let halted = false;
  const isHalted = async (): Promise<boolean> => {
    if (halted) return true;
    if (Date.now() - statusCheckedAt < STATUS_RECHECK_MS) return false;
    statusCheckedAt = Date.now();
    const current = await prisma.smsBroadcast.findUnique({
      where: { id: broadcast.id },
      select: { status: true },
    });
    if (!current || HALTED_STATUSES.has(current.status)) halted = true;
    return halted;
  };

  /** Recipients to try again on a later pass. */
  const retryIds: string[] = [];

  const sendOne = async (recipient: (typeof recipients)[number]): Promise<void> => {
    if (await isHalted()) {
      // Hand the remainder back to QUEUED so a resume picks them up.
      await prisma.smsBroadcastRecipient.updateMany({
        where: { id: recipient.id, status: 'SENDING' },
        data: { status: 'QUEUED' },
      });
      return;
    }

    const body = renderTemplate(
      broadcast.body,
      (recipient.mergeData as Record<string, unknown> | null) ?? null,
    );

    const result = await dispatchOutboundMessage({
      toNumber: recipient.phoneNumber,
      fromNumber: broadcast.fromNumber,
      body,
      mediaUrls: broadcast.mediaUrls,
      broadcastId: broadcast.id,
      // Attribute campaign messages to whoever created the campaign, so
      // per-user stats count them. Without this every broadcast message is
      // sent by nobody.
      sentById: broadcast.createdById ?? null,
      bulkId: broadcast.campaignKey,
      broadcastThrottlePerSecond: broadcast.throttlePerSecond,
      rateLimitWaitMs: 60_000,
    });

    if (result.status === 'failed' && result.errorCode && PLATFORM_BLOCK_CODES.has(result.errorCode)) {
      // Sending is switched off or the quota is used up: nothing else in this
      // campaign can go out either. Pause it with the recipient still queued so
      // an admin can resume once sending is allowed again.
      halted = true;
      await prisma.smsBroadcastRecipient.update({
        where: { id: recipient.id },
        data: { status: 'QUEUED', errorMessage: result.reason },
      });
      await prisma.smsBroadcast.updateMany({
        where: { id: broadcast.id, status: 'RUNNING' },
        data: { status: 'PAUSED' },
      });
      console.warn('[smsBroadcastWorker] pausing broadcast, platform refused sends:', broadcast.id, result.reason);
      return;
    }

    switch (result.status) {
      case 'sent':
        await prisma.smsBroadcastRecipient.update({
          where: { id: recipient.id },
          data: {
            status: 'SENT',
            providerMessageId: result.providerMessageId,
            sentAt: new Date(),
            errorCode: null,
            errorMessage: null,
          },
        });
        recordBroadcastCounter(broadcast.id, 'sentCount');
        recordBroadcastCounter(broadcast.id, 'queuedCount');
        break;

      case 'suppressed':
        await prisma.smsBroadcastRecipient.update({
          where: { id: recipient.id },
          data: { status: 'FAILED', errorMessage: result.reason, suppressedReason: 'MANUAL_BLOCK' },
        });
        recordBroadcastCounter(broadcast.id, 'suppressedCount');
        recordBroadcastCounter(broadcast.id, 'queuedCount');
        break;

      case 'rate_limited':
        // Not a failure — return it to the queue for the next pass.
        await prisma.smsBroadcastRecipient.update({
          where: { id: recipient.id },
          data: { status: 'QUEUED', errorMessage: result.reason },
        });
        retryIds.push(recipient.id);
        break;

      case 'failed':
      default:
        if (result.retryable) {
          await prisma.smsBroadcastRecipient.update({
            where: { id: recipient.id },
            data: { status: 'QUEUED', errorMessage: result.reason },
          });
          retryIds.push(recipient.id);
        } else {
          await prisma.smsBroadcastRecipient.update({
            where: { id: recipient.id },
            data: { status: 'FAILED', errorMessage: result.reason, sentAt: new Date() },
          });
          recordBroadcastCounter(broadcast.id, 'failedCount');
          recordBroadcastCounter(broadcast.id, 'queuedCount');
        }
        break;
    }

    await sleep(sendGapMs());
  };

  // A fixed pool of lanes pulling from a shared cursor.
  let cursor = 0;
  const lanes = Array.from({ length: Math.min(resolveChunkParallelism(), recipients.length) }, async () => {
    while (cursor < recipients.length) {
      const recipient = recipients[cursor++];
      try {
        await withSendSlot(() => sendOne(recipient));
      } catch (err) {
        // A DB hiccup on one recipient must not strand the rest of the lane;
        // the row stays SENDING and recoverOrphanedRows settles it on retry.
        console.error('[smsBroadcastWorker] send failed:', broadcast.id, recipient.id, (err as Error)?.message);
        retryIds.push(recipient.id);
      }
    }
  });
  await Promise.all(lanes);

  if (retryIds.length > 0 && !halted) {
    if (pass + 1 > MAX_RETRY_PASSES) {
      const gaveUp = await prisma.smsBroadcastRecipient.updateMany({
        where: { id: { in: retryIds }, status: { in: ['QUEUED', 'SENDING'] } },
        data: { status: 'FAILED', sentAt: new Date(), errorMessage: `Gave up after ${MAX_RETRY_PASSES} retries` },
      });
      if (gaveUp.count > 0) {
        recordBroadcastCounter(broadcast.id, 'failedCount', gaveUp.count);
        recordBroadcastCounter(broadcast.id, 'queuedCount', gaveUp.count);
      }
    } else {
      await enqueueBroadcastRetry(broadcast.id, retryIds, data.chunkIndex, pass + 1, retryDelayMs(pass + 1));
    }
  }

  // Push this chunk's counters out promptly so progress is visible per chunk.
  await flushBroadcastCounters(broadcast.id);
  await completeBroadcastIfDrained(broadcast.id);
}

export const startSmsBroadcastWorker = (): void => {
  if (!isSmsBroadcastQueueEnabled()) {
    console.warn('[smsBroadcastWorker] disabled: REDIS_URL not configured. SMS broadcasts cannot run.');
    return;
  }

  if (workerInstance) return;

  try {
    workerInstance = new Worker<SmsBroadcastJobData>(
      SMS_BROADCAST_QUEUE_NAME,
      async (job, token) => {
        const lockToken = await acquireBroadcastChunkLock(job.data.broadcastId);
        if (!lockToken) {
          const delayMs = broadcastChunkLockRetryDelayMs();
          await job.moveToDelayed(Date.now() + delayMs, token);
          throw new DelayedError(
            `broadcast ${job.data.broadcastId} chunk already in flight; retry in ${delayMs}ms`,
          );
        }

        try {
          await processChunk(job.data);
        } finally {
          await releaseBroadcastChunkLock(job.data.broadcastId, lockToken);
        }
      },
      {
        connection: createRedisConnection(),
        concurrency: resolveConcurrency(),
      },
    ) as Worker<SmsBroadcastJobData>;

    workerInstance.on('failed', (job, err) => {
      console.error('[smsBroadcastWorker] chunk failed:', {
        jobId: job?.id,
        broadcastId: job?.data?.broadcastId,
        chunkIndex: job?.data?.chunkIndex,
        attemptsMade: job?.attemptsMade,
        error: err?.message,
      });
    });

    workerInstance.on('error', (err) => {
      console.error('[smsBroadcastWorker] worker error:', err);
    });

    console.log(`✅ SMS broadcast worker started (concurrency: ${resolveConcurrency()})`);
  } catch (err) {
    console.error('[smsBroadcastWorker] failed to start:', (err as Error)?.message);
    workerInstance = null;
  }
};

export const stopSmsBroadcastWorker = async (): Promise<void> => {
  if (!workerInstance) return;
  await workerInstance.close();
  workerInstance = null;
};
