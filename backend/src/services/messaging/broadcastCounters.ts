/**
 * Broadcast counters, derived from rows.
 *
 * The counters on `SmsBroadcast` used to be running increments: the worker
 * bumped sentCount, the webhook bumped deliveredCount/failedCount, inbound
 * bumped repliedCount. Increments drift — a duplicate or late delivery report
 * counted twice, UNDELIVERABLE→DELIVERED landed in both buckets, the pull-side
 * reconciler never touched them at all, and STOP was counted as a reply.
 *
 * Now every counter is recomputed from the recipient and message rows (two
 * indexed GROUP BY-free aggregates per broadcast) and written as absolute
 * values. Callers only say "this broadcast changed"; recomputes are coalesced
 * per broadcast on a short debounce so a 50k-recipient blast still produces a
 * handful of writes a second, not one per receipt. Because the values are
 * absolute, a lost or repeated recompute can never make them wrong — only
 * briefly stale.
 *
 * Definitions are in smsMetrics.ts.
 */
import prisma from '../../config/prismaClient';
import { emitBroadcastProgress } from '../../socket/messagingEvents';
import { cacheDel, cacheKeys } from './cache.service';

export type CounterField =
  | 'sentCount'
  | 'deliveredCount'
  | 'failedCount'
  | 'undeliverableCount'
  | 'suppressedCount'
  | 'queuedCount';

export interface BroadcastCounters {
  queuedCount: number;
  sentCount: number;
  deliveredCount: number;
  undeliverableCount: number;
  failedCount: number;
  suppressedCount: number;
  repliedCount: number;
  optOutCount: number;
  /** Derived, not stored: accepted and still waiting for a final receipt. */
  pendingCount: number;
}

interface CounterRow {
  queued: number;
  suppressed: number;
  sent: number;
  delivered: number;
  undeliverable: number;
  pending: number;
  failed: number;
}

/** Pure: recipient-row bucket counts + reply counts → stored counter values. */
export function countersFromRows(r: CounterRow, replies: { repliers: number; optOuts: number }): BroadcastCounters {
  return {
    queuedCount: r.queued,
    sentCount: r.sent,
    deliveredCount: r.delivered,
    undeliverableCount: r.undeliverable,
    failedCount: r.failed,
    suppressedCount: r.suppressed,
    repliedCount: replies.repliers,
    optOutCount: replies.optOuts,
    pendingCount: r.pending,
  };
}

/**
 * Count one broadcast's funnel from its rows. Recipient rows (one per number,
 * index broadcastId+status) carry the delivery outcome; inbound messages
 * (index broadcastId+direction) carry replies. repliedCount is distinct
 * contacts with a non-STOP reply; optOutCount distinct contacts who sent STOP.
 */
export async function computeBroadcastCounters(broadcastId: string): Promise<BroadcastCounters> {
  const [rows, replies] = await Promise.all([
    prisma.$queryRaw<Array<Record<keyof CounterRow, number>>>`
      SELECT
        COUNT(*) FILTER (WHERE "suppressedReason" IS NULL AND status IN ('QUEUED','SENDING'))::int AS queued,
        COUNT(*) FILTER (WHERE "suppressedReason" IS NOT NULL)::int AS suppressed,
        COUNT(*) FILTER (WHERE "suppressedReason" IS NULL AND "providerMessageId" IS NOT NULL AND status IN ('SENT','DELIVERED','UNDELIVERABLE'))::int AS sent,
        COUNT(*) FILTER (WHERE "suppressedReason" IS NULL AND "providerMessageId" IS NOT NULL AND status = 'DELIVERED')::int AS delivered,
        COUNT(*) FILTER (WHERE "suppressedReason" IS NULL AND "providerMessageId" IS NOT NULL AND status = 'UNDELIVERABLE')::int AS undeliverable,
        COUNT(*) FILTER (WHERE "suppressedReason" IS NULL AND "providerMessageId" IS NOT NULL AND status = 'SENT')::int AS pending,
        COUNT(*) FILTER (WHERE "suppressedReason" IS NULL AND (status = 'FAILED'
                          OR ("providerMessageId" IS NULL AND status IN ('SENT','DELIVERED','UNDELIVERABLE'))))::int AS failed
        FROM "SmsBroadcastRecipient"
       WHERE "broadcastId" = ${broadcastId}::uuid`,
    prisma.$queryRaw<Array<{ repliers: number; optouts: number }>>`
      SELECT COUNT(DISTINCT "fromNumber") FILTER (WHERE NOT "isStopKeyword")::int AS repliers,
             COUNT(DISTINCT "fromNumber") FILTER (WHERE "isStopKeyword")::int AS optouts
        FROM "MessagingMessage"
       WHERE "broadcastId" = ${broadcastId}::uuid AND direction = 'INBOUND'`,
  ]);
  const r = rows[0] ?? { queued: 0, suppressed: 0, sent: 0, delivered: 0, undeliverable: 0, pending: 0, failed: 0 };
  return countersFromRows(
    {
      queued: Number(r.queued),
      suppressed: Number(r.suppressed),
      sent: Number(r.sent),
      delivered: Number(r.delivered),
      undeliverable: Number(r.undeliverable),
      pending: Number(r.pending),
      failed: Number(r.failed),
    },
    { repliers: Number(replies[0]?.repliers ?? 0), optOuts: Number(replies[0]?.optouts ?? 0) },
  );
}

/** Recompute and store one broadcast's counters. Returns the new values. */
export async function recomputeBroadcastCounters(broadcastId: string): Promise<BroadcastCounters | null> {
  const counters = await computeBroadcastCounters(broadcastId);
  const { pendingCount, ...stored } = counters;
  const updated = await prisma.smsBroadcast.updateMany({ where: { id: broadcastId }, data: stored });
  if (updated.count === 0) return null;
  return counters;
}

/* ----------------------------------------------------------------------------
 * Coalesced scheduling
 * --------------------------------------------------------------------------*/

interface PendingRecompute {
  timer: NodeJS.Timeout | null;
  inFlight: boolean;
  /** A change arrived while a recompute was running — run once more after. */
  dirty: boolean;
  eventsSinceFlush: number;
}

const pendingByBroadcast = new Map<string, PendingRecompute>();

/** Recompute at least this often while a campaign is changing. */
const FLUSH_DEBOUNCE_MS = Number(process.env.BROADCAST_STATS_DEBOUNCE_MS ?? '2000');
/** …or immediately once this many changes piled up. */
const FLUSH_BATCH_SIZE = Number(process.env.BROADCAST_STATS_BATCH_SIZE ?? '200');

/**
 * Note that a broadcast's rows changed. Cheap and synchronous — the recompute
 * happens on the debounce. The field/delta arguments are kept for the existing
 * call sites but no longer matter: values are recomputed, never incremented.
 */
export function scheduleBroadcastRecompute(broadcastId: string): void {
  let pending = pendingByBroadcast.get(broadcastId);
  if (!pending) {
    pending = { timer: null, inFlight: false, dirty: false, eventsSinceFlush: 0 };
    pendingByBroadcast.set(broadcastId, pending);
  }
  pending.eventsSinceFlush += 1;

  if (pending.eventsSinceFlush >= FLUSH_BATCH_SIZE) {
    void flushBroadcastCounters(broadcastId);
    return;
  }
  if (!pending.timer) {
    pending.timer = setTimeout(() => void flushBroadcastCounters(broadcastId), FLUSH_DEBOUNCE_MS);
    // Never hold the process open just for a stats flush.
    pending.timer.unref?.();
  }
}

/** Back-compat name used by the worker. */
export function recordBroadcastCounter(broadcastId: string, _field?: CounterField, _delta = 1): void {
  scheduleBroadcastRecompute(broadcastId);
}

/** Recompute now (coalescing with any in-flight run), then notify the UI. */
export async function flushBroadcastCounters(broadcastId: string): Promise<void> {
  const pending = pendingByBroadcast.get(broadcastId) ?? { timer: null, inFlight: false, dirty: false, eventsSinceFlush: 0 };
  pendingByBroadcast.set(broadcastId, pending);
  if (pending.timer) {
    clearTimeout(pending.timer);
    pending.timer = null;
  }
  if (pending.inFlight) {
    pending.dirty = true;
    return;
  }
  pending.inFlight = true;
  pending.dirty = false;
  pending.eventsSinceFlush = 0;

  try {
    const counters = await recomputeBroadcastCounters(broadcastId);
    if (counters) {
      const row = await prisma.smsBroadcast.findUnique({
        where: { id: broadcastId },
        select: { id: true, status: true, totalRecipients: true },
      });
      await cacheDel(cacheKeys.broadcastStats(broadcastId));
      if (row) {
        emitBroadcastProgress(broadcastId, { ...row, ...counters });
        // A campaign with nothing left queued is finished.
        if (row.status === 'RUNNING' && counters.queuedCount <= 0) {
          await completeBroadcastIfDrained(broadcastId);
        }
      }
    }
  } catch (err) {
    console.error('[messaging:broadcast] counter recompute failed:', broadcastId, (err as Error)?.message);
    // Retry on the next debounce rather than leave the counters stale.
    pending.dirty = true;
  } finally {
    pending.inFlight = false;
  }

  if (pending.dirty) {
    pending.dirty = false;
    scheduleBroadcastRecompute(broadcastId);
  } else if (!pending.timer) {
    pendingByBroadcast.delete(broadcastId);
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
}
