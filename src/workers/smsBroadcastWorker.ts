import { DelayedError, Worker, type ConnectionOptions } from 'bullmq';
import Redis from 'ioredis';
import prisma from '../config/prismaClient';
import {
  SMS_BROADCAST_QUEUE_NAME,
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
  if (!Number.isFinite(raw) || raw <= 0) return 5;
  return Math.min(50, Math.max(1, Math.floor(raw)));
};

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
 * chunk is orphaned. If the provider accepted the message (the outbound row has
 * a provider id) the recipient is marked SENT; otherwise it never left and goes
 * back to QUEUED. Without this the campaign could never complete.
 */
async function recoverOrphanedRows(broadcastId: string, recipientIds: string[]): Promise<void> {
  const orphaned = await prisma.smsBroadcastRecipient.findMany({
    where: { id: { in: recipientIds }, status: 'SENDING' },
    select: { id: true, phoneNumber: true },
  });
  if (orphaned.length === 0) return;

  const submitted = await prisma.messagingMessage.findMany({
    where: {
      broadcastId,
      direction: 'OUTBOUND',
      toNumber: { in: orphaned.map((row) => row.phoneNumber) },
      providerMessageId: { not: null },
    },
    select: { toNumber: true, providerMessageId: true },
  });
  const submittedByNumber = new Map(submitted.map((m) => [m.toNumber, m.providerMessageId]));

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
    } else {
      await prisma.smsBroadcastRecipient.updateMany({
        where: { id: row.id, status: 'SENDING' },
        data: { status: 'QUEUED' },
      });
    }
  }
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
        await sendOne(recipient);
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
