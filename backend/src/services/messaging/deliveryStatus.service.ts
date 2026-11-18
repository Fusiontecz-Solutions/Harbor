/**
 * The single path a provider delivery outcome takes into Harbor.
 *
 * The DLR webhook, the pull-side reconciler and the backfill script all call
 * `applyProviderStatus`. It
 *   1. moves the message forward only (smsMetrics.decideTransition) — duplicate
 *      and late receipts are a no-op and report `changed: false`;
 *   2. records price / segments / total cost when the provider sent them;
 *   3. mirrors the outcome onto the broadcast recipient row;
 *   4. asks for that broadcast's counters to be recomputed from rows.
 *
 * Previously only the webhook did 3–4, and did 4 by incrementing, so reconciled
 * messages never reached the campaign counters and repeated receipts were
 * counted twice.
 */
import type { Prisma } from '@prisma/client';
import prisma from '../../config/prismaClient';
import { scheduleBroadcastRecompute } from './broadcastCounters';
import { invalidateConversationCaches } from './conversation.service';
import { decideTransition, messageCost, STATUS_RANK, type StatusTransition } from './smsMetrics';

export type ProviderStatus = 'SENT' | 'DELIVERED' | 'FAILED' | 'UNDELIVERABLE';

export interface ProviderStatusReport {
  providerMessageId: string;
  status: ProviderStatus;
  errorCode?: string | null;
  errorMessage?: string | null;
  doneAt?: Date | null;
  segmentCount?: number | null;
  /** Infobip price.pricePerMessage — per segment, in priceCurrency. */
  priceAmount?: number | null;
  priceCurrency?: string | null;
  /** Exact USD cost when known (the portal export's "Total Cost"). */
  costUsd?: number | null;
  /** Broadcast id echoed back by the provider, used when the row has none. */
  callbackData?: string | null;
  /**
   * When DELIVERED arrives without doneAt, stamp "now" (live receipts). The
   * backfill passes false: an old message must not look delivered today.
   */
  doneAtFallbackNow?: boolean;
}

export interface StoredMessageForStatus {
  id: string;
  conversationId: string;
  broadcastId: string | null;
  status: string;
  segmentCount: number | null;
  priceAmount: Prisma.Decimal | number | null;
  priceCurrency: string | null;
  costAmount: Prisma.Decimal | number | null;
  costUsd: Prisma.Decimal | number | null;
}

export interface StatusPlan {
  transition: StatusTransition;
  /** Fields to write on the message row; empty when nothing changes. */
  data: Prisma.MessagingMessageUpdateManyMutationInput;
  /** Categories touched, for logs and the backfill summary. */
  categories: string[];
}

const toNum = (v: Prisma.Decimal | number | null | undefined): number | null => (v == null ? null : Number(v));

/**
 * Pure: what applying `report` to `message` would change. Price fields are
 * filled when missing (or when the status moves), never overwritten with null.
 */
export function planStatusUpdate(
  message: StoredMessageForStatus,
  report: ProviderStatusReport,
  env: NodeJS.ProcessEnv = process.env,
): StatusPlan {
  const transition = decideTransition(message.status, report.status);
  const data: Prisma.MessagingMessageUpdateManyMutationInput = {};
  const categories: string[] = [];

  if (transition.changed) {
    data.status = report.status;
    data.errorCode = report.errorCode ?? null;
    data.errorMessage = report.errorMessage ?? null;
    data.deliveredAt =
      report.status === 'DELIVERED' ? report.doneAt ?? (report.doneAtFallbackNow === false ? null : new Date()) : null;
    categories.push(`status:${transition.from}->${transition.to}`);
  }

  const segments = report.segmentCount ?? message.segmentCount;
  if (report.segmentCount != null && message.segmentCount == null) {
    data.segmentCount = report.segmentCount;
    categories.push('segments:filled');
  }

  const price = report.priceAmount ?? toNum(message.priceAmount);
  const currency = report.priceCurrency ?? message.priceCurrency;
  if (report.priceAmount != null && message.priceAmount == null) {
    data.priceAmount = report.priceAmount;
    data.priceCurrency = report.priceCurrency ?? null;
    categories.push('price:filled');
  }

  const cost = messageCost({ pricePerSegment: price, currency, segments, env });
  if (message.costAmount == null && cost.costAmount != null) {
    data.costAmount = cost.costAmount;
    categories.push('costAmount:filled');
  }
  const usd = report.costUsd ?? cost.costUsd;
  if (usd != null && (message.costUsd == null || (report.costUsd != null && toNum(message.costUsd) !== report.costUsd))) {
    data.costUsd = usd;
    categories.push(report.costUsd != null ? 'costUsd:exact' : 'costUsd:converted');
  }

  return { transition, data, categories };
}

/** Recipient statuses the message's resulting status may overwrite. */
export function lowerRankedStatuses(status: string): Array<'QUEUED' | 'SENDING' | 'SENT' | 'FAILED' | 'UNDELIVERABLE'> {
  const rank = STATUS_RANK[status] ?? 0;
  return (['QUEUED', 'SENDING', 'SENT', 'FAILED', 'UNDELIVERABLE'] as const).filter((s) => (STATUS_RANK[s] ?? 0) < rank);
}

export interface AppliedStatus extends StatusTransition {
  messageId: string;
  conversationId: string;
  broadcastId: string | null;
  recipientsUpdated: number;
  categories: string[];
}

const MESSAGE_SELECT = {
  id: true,
  conversationId: true,
  broadcastId: true,
  status: true,
  segmentCount: true,
  priceAmount: true,
  priceCurrency: true,
  costAmount: true,
  costUsd: true,
} as const;

/**
 * Apply one provider outcome. Returns null for an unknown message; otherwise
 * `{ changed, from, to, … }` — `changed` is true only on a real status move.
 */
export async function applyProviderStatus(
  report: ProviderStatusReport,
  opts: { message?: StoredMessageForStatus; env?: NodeJS.ProcessEnv } = {},
): Promise<AppliedStatus | null> {
  const message =
    opts.message ??
    (await prisma.messagingMessage.findUnique({
      where: { providerMessageId: report.providerMessageId },
      select: MESSAGE_SELECT,
    }));

  if (!message) {
    console.warn('[messaging:status] provider status for unknown message:', report.providerMessageId);
    return null;
  }

  const plan = planStatusUpdate(message, report, opts.env);
  const transition = plan.transition;

  if (Object.keys(plan.data).length > 0) {
    // Guard on the status we planned from, so two receipts racing for the same
    // row cannot both apply a transition.
    const written = await prisma.messagingMessage.updateMany({
      where: { id: message.id, status: message.status as never },
      data: plan.data,
    });
    if (written.count === 0 && transition.changed) {
      // Lost the race: someone else moved it. Re-read and re-plan once.
      const fresh = await prisma.messagingMessage.findUnique({ where: { id: message.id }, select: MESSAGE_SELECT });
      if (!fresh) return null;
      return applyProviderStatus(report, { message: fresh, env: opts.env });
    }
  }

  const resulting = transition.to;
  const broadcastId = message.broadcastId ?? report.callbackData ?? null;
  let recipientsUpdated = 0;

  // Mirror onto the recipient whenever it is behind the message — this also
  // heals rows the old reconciler left unmirrored, not only fresh transitions.
  if (broadcastId && resulting !== 'QUEUED' && resulting !== 'SENDING') {
    const behind = lowerRankedStatuses(resulting);
    if (behind.length) {
      const res = await prisma.smsBroadcastRecipient.updateMany({
        where: { broadcastId, providerMessageId: report.providerMessageId, status: { in: behind }, suppressedReason: null },
        data: {
          status: resulting as never,
          ...(transition.changed ? { errorCode: report.errorCode ?? null, errorMessage: report.errorMessage ?? null } : {}),
        },
      });
      recipientsUpdated = res.count;
    }
  }

  if (transition.changed || recipientsUpdated > 0) {
    if (broadcastId) scheduleBroadcastRecompute(broadcastId);
    await invalidateConversationCaches(message.conversationId);
  }

  return {
    ...transition,
    messageId: message.id,
    conversationId: message.conversationId,
    broadcastId,
    recipientsUpdated,
    categories: recipientsUpdated > 0 ? [...plan.categories, 'recipient:mirrored'] : plan.categories,
  };
}
