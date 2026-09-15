/**
 * Pull-side backstop for delivery status.
 *
 * Infobip reports a message's final outcome by POSTing a delivery receipt once.
 * If that callback was never registered, was unreachable, or simply got lost,
 * the outcome never reaches us and the message stays on whatever status the
 * submit response gave it — usually PENDING, which we store as SENT.
 *
 * That is not a cosmetic problem. A message Infobip REJECTED seconds after
 * accepting it (`REJECTED_NETWORK`, say, for a destination the account is not
 * provisioned for) renders in the inbox with a delivered-looking tick, and the
 * agent believes the merchant was contacted when they were not.
 *
 * So we also pull: any outbound message still non-terminal after a grace period
 * is looked up in Infobip's own logs and reconciled through exactly the same
 * `applyDeliveryReport` path the webhook uses. Whichever arrives first wins;
 * `applyDeliveryReport` ignores a status that would move a message backwards,
 * so the two paths cannot fight.
 */
import prisma from '../../config/prismaClient';
import { applyDeliveryReport } from './conversation.service';
import { fetchMessageLogs, isInfobipConfigured } from './infobip.service';
import { emitMessageStatusUpdate } from '../../socket/messagingEvents';

/** How long to let the webhook win before pulling. */
const GRACE_MS = Number(process.env.MESSAGING_RECONCILE_GRACE_MS ?? '120000');
/** Stop chasing messages this old — Infobip expires its own logs. */
const MAX_AGE_MS = Number(process.env.MESSAGING_RECONCILE_MAX_AGE_MS ?? String(48 * 60 * 60 * 1000));
/** Messages per pass. Infobip caps `messageId` repetition, so keep it modest. */
const BATCH_SIZE = Number(process.env.MESSAGING_RECONCILE_BATCH ?? '50');
const INTERVAL_MS = Number(process.env.MESSAGING_RECONCILE_INTERVAL_MS ?? '60000');

/**
 * Reconcile one batch of stuck messages. Returns how many changed status, so
 * the caller (and tests) can assert progress rather than just "it ran".
 */
export async function reconcileDeliveryStatuses(): Promise<number> {
  if (!isInfobipConfigured()) return 0;

  const now = Date.now();

  const stuck = await prisma.messagingMessage.findMany({
    where: {
      direction: 'OUTBOUND',
      status: { in: ['QUEUED', 'SENT'] },
      providerMessageId: { not: null },
      createdAt: { lt: new Date(now - GRACE_MS), gt: new Date(now - MAX_AGE_MS) },
    },
    orderBy: { createdAt: 'asc' },
    take: BATCH_SIZE,
    select: { id: true, providerMessageId: true, conversationId: true },
  });

  const byProviderId = new Map(stuck.map((row) => [row.providerMessageId, row] as const));

  if (stuck.length === 0) return 0;

  const reports = await fetchMessageLogs(
    stuck.map((row) => row.providerMessageId).filter((id): id is string => Boolean(id)),
  );

  let updated = 0;

  for (const report of reports) {
    // Nothing to do while the provider also still considers it in flight.
    if (report.status === 'SENT') continue;

    const applied = await applyDeliveryReport({
      providerMessageId: report.providerMessageId,
      status: report.status as 'SENT' | 'DELIVERED' | 'FAILED' | 'UNDELIVERABLE',
      errorCode: report.errorCode,
      errorMessage: report.errorMessage,
      doneAt: report.doneAt,
      segmentCount: report.segmentCount,
      priceAmount: report.priceAmount,
      priceCurrency: report.priceCurrency,
    });

    if (!applied) continue;
    updated += 1;

    emitMessageStatusUpdate(applied.conversationId, {
      messageId: byProviderId.get(report.providerMessageId)?.id ?? report.providerMessageId,
      providerMessageId: report.providerMessageId,
      status: report.status,
      errorMessage: report.errorMessage,
    });
  }

  if (updated > 0) {
    console.log(`[messaging:reconcile] updated ${updated} of ${stuck.length} pending message(s) from Infobip logs`);
  }

  return updated;
}

/**
 * Run the reconciler on a timer. Started from index.ts alongside the workers.
 * Errors are logged and swallowed: a provider outage must not take the process
 * down, and the next tick retries the same rows anyway.
 */
export function startDeliveryReconciler(): void {
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

  console.log(`[messaging:reconcile] delivery reconciler started (every ${Math.round(INTERVAL_MS / 1000)}s)`);
}
