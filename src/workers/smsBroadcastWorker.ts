import { Worker, type ConnectionOptions } from 'bullmq';
import Redis from 'ioredis';
import prisma from '../config/prismaClient';
import {
  SMS_BROADCAST_QUEUE_NAME,
  isSmsBroadcastQueueEnabled,
  type SmsBroadcastJobData,
} from '../queues/smsBroadcastQueue';
import {
  completeBroadcastIfDrained,
  flushBroadcastCounters,
  recordBroadcastCounter,
} from '../services/messaging/broadcast.service';
import { dispatchOutboundMessage, renderTemplate } from '../services/messaging/sms.service';

/* ============================================================================
 * SMS Broadcast Worker
 * ----------------------------------------------------------------------------
 * Runs inside the API process, alongside the application-approval worker.
 *
 * Concurrency here is the number of chunks in flight, NOT the send rate — the
 * send rate is governed entirely by the Redis token buckets. Raising
 * concurrency lets more campaigns progress simultaneously; it does not make
 * Harbor exceed the provider limit, because every send still has to take a
 * token from the shared account bucket.
 *
 * Because these are I/O-bound HTTPS calls that spend most of their time parked
 * on a bucket or awaiting Infobip, concurrency well above the core count is
 * appropriate.
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

async function processChunk(data: SmsBroadcastJobData): Promise<void> {
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
    },
  });

  if (!broadcast) {
    console.warn('[smsBroadcastWorker] broadcast no longer exists, dropping chunk:', data.broadcastId);
    return;
  }

  if (HALTED_STATUSES.has(broadcast.status)) {
    return;
  }

  const recipients = await prisma.smsBroadcastRecipient.findMany({
    where: { id: { in: data.recipientIds }, status: 'QUEUED' },
    select: { id: true, phoneNumber: true, mergeData: true },
  });

  if (recipients.length === 0) return;

  // Claim the rows so a duplicate delivery of this job cannot re-send them.
  await prisma.smsBroadcastRecipient.updateMany({
    where: { id: { in: recipients.map((r) => r.id) }, status: 'QUEUED' },
    data: { status: 'SENDING' },
  });

  for (const recipient of recipients) {
    // Re-read status between sends so pause/cancel takes effect inside a chunk
    // rather than only at chunk boundaries.
    const current = await prisma.smsBroadcast.findUnique({
      where: { id: broadcast.id },
      select: { status: true },
    });

    if (!current || HALTED_STATUSES.has(current.status)) {
      // Hand the remainder back to QUEUED so a resume picks them up.
      await prisma.smsBroadcastRecipient.updateMany({
        where: { id: recipient.id, status: 'SENDING' },
        data: { status: 'QUEUED' },
      });
      continue;
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
      bulkId: broadcast.campaignKey,
      broadcastThrottlePerSecond: broadcast.throttlePerSecond,
      rateLimitWaitMs: 60_000,
    });

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
        break;

      case 'failed':
      default:
        if (result.retryable) {
          await prisma.smsBroadcastRecipient.update({
            where: { id: recipient.id },
            data: { status: 'QUEUED', errorMessage: result.reason },
          });
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
      async (job) => {
        await processChunk(job.data);
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
