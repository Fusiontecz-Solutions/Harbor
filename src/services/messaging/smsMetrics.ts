/**
 * One set of SMS count definitions, used by every surface that reports them —
 * broadcast counters, the campaign list and detail, the Reports dashboard, the
 * PDF / Excel exports and Messaging Performance.
 *
 * Before this module each screen wrote its own filter, and they disagreed:
 * "sent" sometimes meant "any outbound row" (rejected ones included), "failed"
 * lumped carrier non-delivery together with provider rejections, and "replies"
 * counted STOP. These are the definitions now, everywhere:
 *
 *   sent          accepted by the provider: has a providerMessageId and is
 *                 SENT, DELIVERED or UNDELIVERABLE (Infobip EXPIRED is stored
 *                 as UNDELIVERABLE). = delivered + undeliverable + pending
 *   delivered     DELIVERED
 *   undeliverable UNDELIVERABLE (incl. expired) — accepted, carrier did not deliver
 *   pending       SENT with no final delivery report yet
 *   unknown       pending rows older than the reconcile window; we stopped
 *                 asking and never invent a final status for them
 *   failed        FAILED (Infobip REJECTED, or never accepted) — never "sent"
 *   replies       inbound messages that are not STOP
 *   repliers      distinct contacts with at least one non-STOP inbound
 *   optOuts       inbound STOP messages (distinct contacts on campaign counters)
 *
 * Everything here is pure so it can be unit tested without a database.
 */
import { Prisma } from '@prisma/client';

export type OutboundStatus = 'QUEUED' | 'SENDING' | 'SENT' | 'DELIVERED' | 'FAILED' | 'UNDELIVERABLE' | 'RECEIVED';

/** Statuses a provider-accepted message can be in. */
export const SENT_STATUSES = ['SENT', 'DELIVERED', 'UNDELIVERABLE'] as const;
export const FAILED_STATUSES = ['FAILED'] as const;

export type OutboundBucket = 'queued' | 'suppressed' | 'failed' | 'pending' | 'delivered' | 'undeliverable';

/** Which reporting bucket one outbound message / recipient falls in. */
export function outboundBucket(input: {
  status: string | null | undefined;
  hasProviderId: boolean;
  suppressed?: boolean;
}): OutboundBucket {
  if (input.suppressed) return 'suppressed';
  switch (input.status) {
    case 'DELIVERED':
      return input.hasProviderId ? 'delivered' : 'failed';
    case 'UNDELIVERABLE':
      return input.hasProviderId ? 'undeliverable' : 'failed';
    case 'SENT':
      return input.hasProviderId ? 'pending' : 'failed';
    case 'FAILED':
      return 'failed';
    default:
      return 'queued';
  }
}

export const isSentBucket = (b: OutboundBucket): boolean => b === 'delivered' || b === 'undeliverable' || b === 'pending';

/* ----------------------------------------------------------------------------
 * Status transitions
 * --------------------------------------------------------------------------*/

/**
 * Lifecycle rank. A report may only move a message forward. FAILED and
 * UNDELIVERABLE share a rank so the first final outcome wins between them;
 * DELIVERED outranks both because a handset receipt is the ground truth even
 * when a carrier first reported a failure.
 */
export const STATUS_RANK: Record<string, number> = {
  QUEUED: 0,
  SENDING: 1,
  SENT: 2,
  FAILED: 3,
  UNDELIVERABLE: 3,
  DELIVERED: 4,
  RECEIVED: 4,
};

export interface StatusTransition {
  changed: boolean;
  from: string;
  to: string;
}

/** Decide whether an incoming status replaces the stored one. */
export function decideTransition(current: string, incoming: string): StatusTransition {
  const currentRank = STATUS_RANK[current] ?? 0;
  const incomingRank = STATUS_RANK[incoming] ?? 0;
  // Equal rank never re-applies: a duplicate DLR, or FAILED after UNDELIVERABLE.
  const changed = incoming !== current && incomingRank > currentRank;
  return { changed, from: current, to: changed ? incoming : current };
}

/**
 * Counter deltas for a transition — what an incremental counter would do.
 * Broadcast counters are recomputed from rows (see broadcastCounters.ts), but
 * this is the contract they must agree with: a real transition moves exactly
 * one unit out of the old bucket and into the new one, a no-op moves nothing.
 */
export function bucketDelta(t: StatusTransition, hasProviderId: boolean): Partial<Record<OutboundBucket, number>> {
  if (!t.changed) return {};
  const from = outboundBucket({ status: t.from, hasProviderId });
  const to = outboundBucket({ status: t.to, hasProviderId });
  if (from === to) return {};
  return { [from]: -1, [to]: 1 };
}

/** Map an Infobip status group (webhook, logs or the portal export) to ours. */
export function mapProviderStatus(group: string | null | undefined): OutboundStatus | null {
  switch (String(group ?? '').trim().toUpperCase()) {
    case 'DELIVERED':
      return 'DELIVERED';
    case 'UNDELIVERABLE':
    case 'EXPIRED':
      return 'UNDELIVERABLE';
    case 'REJECTED':
      return 'FAILED';
    case 'PENDING':
      return 'SENT';
    default:
      return null;
  }
}

/* ----------------------------------------------------------------------------
 * Cost
 * --------------------------------------------------------------------------*/

/**
 * Units of `currency` per 1 USD, from INFOBIP_<CUR>_PER_USD (e.g.
 * INFOBIP_BDT_PER_USD=74). USD is always 1. Null when unknown.
 */
export function usdRate(currency: string | null | undefined, env: NodeJS.ProcessEnv = process.env): number | null {
  const cur = String(currency ?? '').trim().toUpperCase();
  if (!cur) return null;
  if (cur === 'USD') return 1;
  const raw = Number(env[`INFOBIP_${cur}_PER_USD`]);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

/**
 * Infobip's `price.pricePerMessage` is the price of one segment (verified
 * against the portal export: a 2-segment message's "Total Cost" is exactly
 * 2 × "Purchase Price"). The message's cost is that times the segment count.
 */
export function messageCost(input: {
  pricePerSegment: number | null | undefined;
  currency: string | null | undefined;
  segments: number | null | undefined;
  env?: NodeJS.ProcessEnv;
}): { costAmount: number | null; costUsd: number | null } {
  if (input.pricePerSegment == null || !Number.isFinite(input.pricePerSegment)) return { costAmount: null, costUsd: null };
  const segments = input.segments && input.segments > 0 ? input.segments : 1;
  const costAmount = round6(input.pricePerSegment * segments);
  const rate = usdRate(input.currency, input.env);
  return { costAmount, costUsd: rate ? round6(costAmount / rate) : null };
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/* ----------------------------------------------------------------------------
 * SQL fragments (alias-free, for "MessagingMessage" rows)
 * --------------------------------------------------------------------------*/

/** COUNT(*) FILTER clauses implementing the definitions above. */
export const SQL_IS_SENT = Prisma.sql`("providerMessageId" IS NOT NULL AND status IN ('SENT','DELIVERED','UNDELIVERABLE'))`;
export const SQL_IS_DELIVERED = Prisma.sql`("providerMessageId" IS NOT NULL AND status = 'DELIVERED')`;
export const SQL_IS_UNDELIVERABLE = Prisma.sql`("providerMessageId" IS NOT NULL AND status = 'UNDELIVERABLE')`;
export const SQL_IS_PENDING = Prisma.sql`("providerMessageId" IS NOT NULL AND status = 'SENT')`;
/** Never accepted, or rejected — includes the (theoretical) final row with no provider id. */
export const SQL_IS_FAILED = Prisma.sql`(status = 'FAILED' OR ("providerMessageId" IS NULL AND status IN ('SENT','DELIVERED','UNDELIVERABLE')))`;

/**
 * One message's cost in its account currency (`priceCurrency`). Rows written
 * before `costAmount` existed carry only the per-segment price, so they are
 * extended by their segment count — the same rule as messageCost(). Null when
 * the message was never priced.
 */
export const SQL_MESSAGE_COST = Prisma.sql`COALESCE("costAmount", "priceAmount" * COALESCE(NULLIF("segmentCount", 0), 1))`;

/** Prisma where for "sent" outbound messages. */
export const SENT_MESSAGE_WHERE: Prisma.MessagingMessageWhereInput = {
  direction: 'OUTBOUND',
  providerMessageId: { not: null },
  status: { in: [...SENT_STATUSES] },
};

/** How long the reconciler keeps asking; older pending rows are "unknown". */
export const RECONCILE_MAX_AGE_MS = Number(
  process.env.MESSAGING_RECONCILE_MAX_AGE_MS ?? String(7 * 24 * 60 * 60 * 1000),
);
