/**
 * Broadcast lifecycle: create → preflight → enqueue → run → report.
 *
 * Two ideas carried over from Fivra, both load-bearing at volume:
 *
 * 1. **Recipients are pre-stored as QUEUED before a single message is sent.**
 *    The funnel is therefore always complete and resumable: if the process dies
 *    mid-blast, whatever is still QUEUED is exactly what remains to send. The
 *    alternative — deriving progress from messages that exist — cannot
 *    distinguish "not sent yet" from "lost".
 *
 * 2. **Counters are flushed on a debounce, not per message.** A 50k-recipient
 *    campaign generates 50k sends and 50k delivery receipts; writing a counter
 *    UPDATE for each would serialize the whole campaign behind row locks on one
 *    `SmsBroadcast` row. Increments accumulate in memory and flush every couple
 *    of seconds, or when a batch threshold is hit.
 */
import prisma from '../../config/prismaClient';
import { emitBroadcastProgress } from '../../socket/messagingEvents';
import {
  BROADCAST_CHUNK_SIZE,
  enqueueBroadcastChunks,
  isSmsBroadcastQueueEnabled,
  removeBroadcastJobs,
} from '../../queues/smsBroadcastQueue';
import { cacheDel, cacheKeys } from './cache.service';
import { getDefaultSender } from './infobip.service';
import { resolveSenderForUser } from './sender.service';
import { normalizePhoneNumber, normalizeSender } from './phone';
import { checkSuppressionBulk } from './suppression.service';

export interface BroadcastRecipientInput {
  phoneNumber: string;
  /** Merge fields for {{token}} substitution in the body. */
  mergeData?: Record<string, unknown>;
}

export interface CreateBroadcastInput {
  name: string;
  body: string;
  fromNumber?: string;
  mediaUrls?: string[];
  recipients: BroadcastRecipientInput[];
  throttlePerSecond?: number | null;
  scheduledAt?: Date | null;
  createdById?: string | null;
}

/** Recipients inserted per statement. Large enough to be fast, small enough to not blow the parameter limit. */
const RECIPIENT_INSERT_BATCH = 1_000;

/**
 * Create a broadcast and pre-store its recipients.
 *
 * Suppression is evaluated up front in one bulk query rather than per send:
 * a blocked number is recorded as suppressed immediately, so the operator sees
 * the true reachable audience before the blast starts instead of watching the
 * failure count climb.
 */
export async function createBroadcast(input: CreateBroadcastInput): Promise<{
  id: string;
  campaignKey: string;
  totalRecipients: number;
  queuedCount: number;
  suppressedCount: number;
  duplicatesDropped: number;
  invalidDropped: number;
}> {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('Broadcast name is required');

  const body = String(input.body || '').trim();
  if (!body) throw new Error('Broadcast message body is required');

  // A campaign goes out as whoever created it, so recipients replying land in
  // that user's inbox rather than a shared one.
  const fromNumber = normalizeSender(
    input.fromNumber?.trim() || (await resolveSenderForUser(input.createdById)) || getDefaultSender(),
  );
  if (!fromNumber) throw new Error('No sender configured — set INFOBIP_SENDER or pass fromNumber');

  if (!Array.isArray(input.recipients) || input.recipients.length === 0) {
    throw new Error('At least one recipient is required');
  }

  // Normalize, drop unparseable, dedupe. Last write wins on merge data so a
  // spreadsheet with a repeated number keeps its most recent row.
  const byNumber = new Map<string, BroadcastRecipientInput>();
  let invalidDropped = 0;

  for (const recipient of input.recipients) {
    const phoneNumber = normalizePhoneNumber(recipient?.phoneNumber);
    if (!phoneNumber) {
      invalidDropped += 1;
      continue;
    }
    byNumber.set(phoneNumber, { ...recipient, phoneNumber });
  }

  const duplicatesDropped = input.recipients.length - byNumber.size - invalidDropped;
  const uniqueNumbers = [...byNumber.keys()];

  if (uniqueNumbers.length === 0) {
    throw new Error('No valid recipients after normalization');
  }

  const suppressed = await checkSuppressionBulk(uniqueNumbers);

  // Attach existing contact records so the broadcast shows names and so replies
  // land on an already-identified thread.
  const contacts = await prisma.messagingContact.findMany({
    where: { phoneNumber: { in: uniqueNumbers } },
    select: { id: true, phoneNumber: true },
  });
  const contactByNumber = new Map(contacts.map((c) => [c.phoneNumber, c.id]));

  const campaignKey = buildCampaignKey(name);

  const broadcast = await prisma.smsBroadcast.create({
    data: {
      campaignKey,
      name,
      body,
      fromNumber,
      mediaUrls: input.mediaUrls ?? [],
      status: input.scheduledAt ? 'QUEUED' : 'DRAFT',
      totalRecipients: uniqueNumbers.length,
      queuedCount: uniqueNumbers.length - suppressed.size,
      suppressedCount: suppressed.size,
      throttlePerSecond: input.throttlePerSecond ?? null,
      scheduledAt: input.scheduledAt ?? null,
      createdById: input.createdById ?? null,
    },
    select: { id: true, campaignKey: true },
  });

  // Pre-store recipients in batches. skipDuplicates guards the composite unique
  // key if the same payload is submitted twice.
  for (let i = 0; i < uniqueNumbers.length; i += RECIPIENT_INSERT_BATCH) {
    const slice = uniqueNumbers.slice(i, i + RECIPIENT_INSERT_BATCH);
    await prisma.smsBroadcastRecipient.createMany({
      data: slice.map((phoneNumber) => {
        const verdict = suppressed.get(phoneNumber);
        return {
          broadcastId: broadcast.id,
          phoneNumber,
          contactId: contactByNumber.get(phoneNumber) ?? null,
          mergeData: (byNumber.get(phoneNumber)?.mergeData ?? null) as never,
          status: verdict ? ('FAILED' as const) : ('QUEUED' as const),
          suppressedReason: verdict?.reason ?? null,
          errorMessage: verdict ? `Suppressed: ${verdict.reason ?? 'unknown'}` : null,
        };
      }),
      skipDuplicates: true,
    });
  }

  return {
    id: broadcast.id,
    campaignKey: broadcast.campaignKey,
    totalRecipients: uniqueNumbers.length,
    queuedCount: uniqueNumbers.length - suppressed.size,
    suppressedCount: suppressed.size,
    duplicatesDropped: Math.max(0, duplicatesDropped),
    invalidDropped,
  };
}

/** URL-safe, collision-resistant campaign key derived from the name. */
function buildCampaignKey(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'broadcast';
  return `${slug}-${Date.now().toString(36)}`;
}

/**
 * Hand a broadcast's queued recipients to the worker.
 *
 * Only rows still in QUEUED are enqueued, which makes this safe to call again
 * after a partial run — it resumes rather than restarts.
 */
export async function startBroadcast(broadcastId: string): Promise<{ chunks: number; recipients: number }> {
  if (!isSmsBroadcastQueueEnabled()) {
    throw new Error('Cannot start a broadcast: REDIS_URL is not configured, so the queue is unavailable');
  }

  const broadcast = await prisma.smsBroadcast.findUnique({
    where: { id: broadcastId },
    select: { id: true, status: true },
  });
  if (!broadcast) throw new Error('Broadcast not found');
  if (broadcast.status === 'RUNNING') throw new Error('Broadcast is already running');
  if (broadcast.status === 'COMPLETED') throw new Error('Broadcast has already completed');

  const pending = await prisma.smsBroadcastRecipient.findMany({
    where: { broadcastId, status: 'QUEUED' },
    select: { id: true },
  });

  if (pending.length === 0) {
    await prisma.smsBroadcast.update({
      where: { id: broadcastId },
      data: { status: 'COMPLETED', finishedAt: new Date() },
    });
    return { chunks: 0, recipients: 0 };
  }

  await prisma.smsBroadcast.update({
    where: { id: broadcastId },
    data: { status: 'RUNNING', startedAt: new Date() },
  });

  const chunks = await enqueueBroadcastChunks(
    broadcastId,
    pending.map((row) => row.id),
  );

  return { chunks, recipients: pending.length };
}

/**
 * Pause: drop pending jobs. In-flight chunks stop at their next recipient
 * because the worker re-reads the broadcast status between sends.
 */
export async function pauseBroadcast(broadcastId: string): Promise<void> {
  await prisma.smsBroadcast.update({ where: { id: broadcastId }, data: { status: 'PAUSED' } });
  await removeBroadcastJobs(broadcastId);
}

export async function cancelBroadcast(broadcastId: string): Promise<void> {
  await prisma.smsBroadcast.update({
    where: { id: broadcastId },
    data: { status: 'CANCELLED', finishedAt: new Date() },
  });
  await removeBroadcastJobs(broadcastId);
}

/* ============================================================================
 * Debounced counter flushing
 * ==========================================================================*/

type CounterField =
  | 'sentCount'
  | 'deliveredCount'
  | 'failedCount'
  | 'undeliverableCount'
  | 'suppressedCount'
  | 'queuedCount';

interface PendingCounters {
  increments: Partial<Record<CounterField, number>>;
  timer: NodeJS.Timeout | null;
  eventsSinceFlush: number;
}

const pendingByBroadcast = new Map<string, PendingCounters>();

/** Flush at least this often while a campaign is active. */
const FLUSH_DEBOUNCE_MS = Number(process.env.BROADCAST_STATS_DEBOUNCE_MS ?? '2000');
/** …or immediately once this many increments have piled up. */
const FLUSH_BATCH_SIZE = Number(process.env.BROADCAST_STATS_BATCH_SIZE ?? '50');

/**
 * Record a counter change. Cheap and synchronous — the database write happens
 * later, on the debounce.
 *
 * Each broadcast gets its own timer, so concurrent campaigns flush
 * independently instead of queueing behind one shared timer.
 */
export function recordBroadcastCounter(broadcastId: string, field: CounterField, delta = 1): void {
  let pending = pendingByBroadcast.get(broadcastId);
  if (!pending) {
    pending = { increments: {}, timer: null, eventsSinceFlush: 0 };
    pendingByBroadcast.set(broadcastId, pending);
  }

  pending.increments[field] = (pending.increments[field] ?? 0) + delta;
  pending.eventsSinceFlush += 1;

  if (pending.eventsSinceFlush >= FLUSH_BATCH_SIZE) {
    void flushBroadcastCounters(broadcastId);
    return;
  }

  if (!pending.timer) {
    pending.timer = setTimeout(() => {
      void flushBroadcastCounters(broadcastId);
    }, FLUSH_DEBOUNCE_MS);
    // Never hold the process open just for a stats flush.
    pending.timer.unref?.();
  }
}

/**
 * Write accumulated increments and notify the UI.
 *
 * Increments are taken out of the map *before* the await so counts recorded
 * while the update is in flight are not lost or double-counted.
 */
export async function flushBroadcastCounters(broadcastId: string): Promise<void> {
  const pending = pendingByBroadcast.get(broadcastId);
  if (!pending) return;

  if (pending.timer) {
    clearTimeout(pending.timer);
    pending.timer = null;
  }

  const increments = pending.increments;
  pending.increments = {};
  pending.eventsSinceFlush = 0;

  const fields = Object.entries(increments).filter(([, value]) => value && value !== 0);
  if (fields.length === 0) return;

  try {
    const data: Record<string, { increment: number } | { decrement: number }> = {};
    for (const [field, value] of fields) {
      // queuedCount only ever goes down as recipients leave the queue.
      data[field] = field === 'queuedCount' ? { decrement: Math.abs(value as number) } : { increment: value as number };
    }

    const updated = await prisma.smsBroadcast.update({
      where: { id: broadcastId },
      data,
      select: {
        id: true,
        status: true,
        totalRecipients: true,
        queuedCount: true,
        sentCount: true,
        deliveredCount: true,
        failedCount: true,
        undeliverableCount: true,
        suppressedCount: true,
        repliedCount: true,
        optOutCount: true,
      },
    });

    await cacheDel(cacheKeys.broadcastStats(broadcastId));
    emitBroadcastProgress(broadcastId, updated);

    // A campaign with nothing left queued is finished.
    if (updated.status === 'RUNNING' && updated.queuedCount <= 0) {
      await completeBroadcastIfDrained(broadcastId);
    }
  } catch (err) {
    // Put the increments back so they are retried on the next flush rather
    // than silently lost.
    for (const [field, value] of fields) {
      pending.increments[field as CounterField] = (pending.increments[field as CounterField] ?? 0) + (value as number);
    }
    console.error('[messaging:broadcast] counter flush failed:', broadcastId, (err as Error)?.message);
  }
}

/** Mark a campaign complete once no recipient rows remain in QUEUED. */
export async function completeBroadcastIfDrained(broadcastId: string): Promise<void> {
  const remaining = await prisma.smsBroadcastRecipient.count({
    where: { broadcastId, status: { in: ['QUEUED', 'SENDING'] } },
  });
  if (remaining > 0) return;

  await prisma.smsBroadcast.updateMany({
    where: { id: broadcastId, status: 'RUNNING' },
    data: { status: 'COMPLETED', finishedAt: new Date() },
  });

  pendingByBroadcast.delete(broadcastId);
}

export async function getBroadcastStats(broadcastId: string) {
  return prisma.smsBroadcast.findUnique({
    where: { id: broadcastId },
    select: {
      id: true,
      campaignKey: true,
      name: true,
      status: true,
      totalRecipients: true,
      queuedCount: true,
      sentCount: true,
      deliveredCount: true,
      failedCount: true,
      undeliverableCount: true,
      suppressedCount: true,
      repliedCount: true,
      optOutCount: true,
      startedAt: true,
      finishedAt: true,
      createdAt: true,
    },
  });
}

export { BROADCAST_CHUNK_SIZE };
