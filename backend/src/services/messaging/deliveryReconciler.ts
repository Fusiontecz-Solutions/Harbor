/**
 * Pull-side backstop for delivery status.
 *
 * Infobip reports a message's final outcome by POSTing a delivery receipt once.
 * If that callback was never registered (INFOBIP_CALLBACK_BASE_URL unset), was
 * unreachable, or simply got lost, the outcome never reaches us and the message
 * stays on whatever status the submit response gave it — usually PENDING,
 * which we store as SENT.
 *
 * So we also pull: any outbound message still non-terminal after a grace period
 * is looked up in Infobip's logs and applied through exactly the same
 * `applyProviderStatus` path the webhook uses (status, recipient mirror,
 * counter recompute). Whichever arrives first wins; a status that would move a
 * message backwards or sideways is a no-op, so the two paths cannot fight.
 *
 * Scheduling: each row carries `nextStatusCheckAt`. A pass takes the rows that
 * are due, oldest-due first, so a row the provider still reports as pending is
 * pushed to the back (with backoff) instead of blocking the head of the queue
 * forever. After RECONCILE_MAX_AGE_MS (default 7 days) a row is no longer
 * checked; it stays SENT — we never invent a final status — and reports count
 * it as "unknown".
 */
import prisma from '../../config/prismaClient';
import { applyProviderStatus, type ProviderStatus } from './deliveryStatus.service';
import { fetchMessageLogs, isInfobipConfigured, warnIfCallbackUrlMissing } from './infobip.service';
import { emitMessageStatusUpdate } from '../../socket/messagingEvents';
import { RECONCILE_MAX_AGE_MS } from './smsMetrics';

/** How long to let the webhook win before pulling. */
const GRACE_MS = Number(process.env.MESSAGING_RECONCILE_GRACE_MS ?? '120000');
/** Messages per pass; the logs call is split into INFOBIP_LOGS_IDS_PER_REQUEST chunks. */
const BATCH_SIZE = Math.max(1, Number(process.env.MESSAGING_RECONCILE_BATCH ?? '500'));
const INTERVAL_MS = Number(process.env.MESSAGING_RECONCILE_INTERVAL_MS ?? '60000');
/** Backoff for rows the provider still reports pending (or does not know). */
const BACKOFF_BASE_MS = Number(process.env.MESSAGING_RECONCILE_BACKOFF_BASE_MS ?? '120000');
const BACKOFF_MAX_MS = Number(process.env.MESSAGING_RECONCILE_BACKOFF_MAX_MS ?? String(6 * 60 * 60 * 1000));

/** Delay before the next check after `attempts` pending answers. Pure, tested. */
export function nextCheckDelayMs(attempts: number, base = BACKOFF_BASE_MS, max = BACKOFF_MAX_MS): number {
  const n = Math.max(0, attempts);
  return Math.min(max, base * 2 ** Math.min(n, 20));
}

let running = false;

/**
 * Reconcile one batch of due messages. Returns how many changed status, so
 * the caller (and tests) can assert progress rather than just "it ran".
 */
export async function reconcileDeliveryStatuses(): Promise<number> {
  if (!isInfobipConfigured()) return 0;
  if (running) return 0; // a slow pass must not overlap the next tick
  running = true;
  try {
    return await reconcileOnce();
  } finally {
    running = false;
  }
}

async function reconcileOnce(): Promise<number> {
  const now = Date.now();

  const due = await prisma.messagingMessage.findMany({
    where: {
      direction: 'OUTBOUND',
      status: { in: ['QUEUED', 'SENT'] },
      providerMessageId: { not: null },
      createdAt: { lt: new Date(now - GRACE_MS), gt: new Date(now - RECONCILE_MAX_AGE_MS) },
      OR: [{ nextStatusCheckAt: null }, { nextStatusCheckAt: { lte: new Date(now) } }],
    },
    // Never-checked rows first, then whichever has waited longest.
    orderBy: [{ nextStatusCheckAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
    take: BATCH_SIZE,
    select: {
      id: true,
      providerMessageId: true,
      conversationId: true,
      broadcastId: true,
      status: true,
      segmentCount: true,
      priceAmount: true,
      priceCurrency: true,
      costAmount: true,
      costUsd: true,
      statusCheckCount: true,
    },
  });
  if (due.length === 0) return 0;

  const reports = await fetchMessageLogs(due.map((row) => row.providerMessageId as string));
  const reportById = new Map(reports.map((r) => [r.providerMessageId, r]));

  let updated = 0;
  const stillPending: typeof due = [];

  for (const row of due) {
    const report = reportById.get(row.providerMessageId as string);
    try {
      if (report) {
        const applied = await applyProviderStatus(
          {
            providerMessageId: report.providerMessageId,
            status: report.status as ProviderStatus,
            errorCode: report.errorCode,
            errorMessage: report.errorMessage,
            doneAt: report.doneAt,
            segmentCount: report.segmentCount,
            priceAmount: report.priceAmount,
            priceCurrency: report.priceCurrency,
            callbackData: report.callbackData,
          },
          { message: row },
        );
        if (applied?.changed) {
          updated += 1;
          emitMessageStatusUpdate(applied.conversationId, {
            messageId: row.id,
            providerMessageId: report.providerMessageId,
            status: applied.to,
            errorMessage: report.errorMessage,
          });
        }
        if (applied && (applied.to === 'SENT' || applied.to === 'QUEUED')) stillPending.push(row);
      } else {
        // The provider does not know it (yet, or any more): back off too.
        stillPending.push(row);
      }
    } catch (err) {
      console.error('[messaging:reconcile] apply failed:', row.providerMessageId, (err as Error)?.message);
      stillPending.push(row);
    }
  }

  // Push still-pending rows to the back of the queue with exponential backoff.
  // Grouped by attempt count so this is a handful of UPDATEs, not one per row.
  const checkedAt = new Date();
  const byAttempts = new Map<number, string[]>();
  for (const row of stillPending) {
    const list = byAttempts.get(row.statusCheckCount) ?? [];
    list.push(row.id);
    byAttempts.set(row.statusCheckCount, list);
  }
  for (const [attempts, ids] of byAttempts) {
    await prisma.messagingMessage.updateMany({
      where: { id: { in: ids } },
      data: {
        lastStatusCheckAt: checkedAt,
        nextStatusCheckAt: new Date(checkedAt.getTime() + nextCheckDelayMs(attempts)),
        statusCheckCount: { increment: 1 },
      },
    });
  }
  const resolvedIds = due.filter((r) => !stillPending.includes(r)).map((r) => r.id);
  if (resolvedIds.length) {
    await prisma.messagingMessage.updateMany({
      where: { id: { in: resolvedIds } },
      data: { lastStatusCheckAt: checkedAt, nextStatusCheckAt: null, statusCheckCount: { increment: 1 } },
    });
  }

  console.log(
    `[messaging:reconcile] checked ${due.length}, provider returned ${reports.length}, ` +
      `updated ${updated}, still pending ${stillPending.length}`,
  );

  return updated;
}

/**
 * Run the reconciler on a timer. Started from index.ts alongside the workers.
 * Errors are logged and swallowed: a provider outage must not take the process
 * down, and the next tick retries the same rows anyway.
 */
export function startDeliveryReconciler(): void {
  warnIfCallbackUrlMissing();

  if (!isInfobipConfigured()) {
    console.log('[messaging:reconcile] Infobip not configured — delivery reconciler disabled');
    return;
  }

  const tick = () => {
    void reconcileDeliveryStatuses().catch((err) => {
      console.error('[messaging:reconcile] pass failed:', (err as Error)?.message || err);
    });
  };

  const timer = setInterval(tick, INTERVAL_MS);
  // Do not hold the event loop open on shutdown.
  timer.unref?.();

  console.log(
    `[messaging:reconcile] delivery reconciler started (every ${Math.round(INTERVAL_MS / 1000)}s, ` +
      `batch ${BATCH_SIZE}, max age ${Math.round(RECONCILE_MAX_AGE_MS / 3_600_000)}h)`,
  );
}
