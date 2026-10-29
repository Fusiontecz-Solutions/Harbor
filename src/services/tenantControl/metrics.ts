import { Prisma } from '@prisma/client';
import {
  SQL_IS_DELIVERED,
  SQL_IS_FAILED,
  SQL_IS_PENDING,
  SQL_IS_SENT,
  SQL_IS_UNDELIVERABLE,
  SQL_MESSAGE_COST,
} from '../messaging/smsMetrics';
import { COUNTED_SQL, INBOUND_COUNTED_SQL, SEGMENTS_SQL } from './counting';

/**
 * The `metrics` block Tenant Control serves next to the legacy counts (the
 * `metrics` capability). Same definitions as every Harbor screen — see
 * ../messaging/smsMetrics.ts — so the console bills what Harbor reports:
 *
 *   accepted       provider accepted (providerMessageId, SENT/DELIVERED/UNDELIVERABLE)
 *                  = delivered + undeliverable + pending
 *   failedNotSent  FAILED (rejected / never accepted). Never billed by the provider.
 *   segments       billable segments of accepted messages (unknown count = 1)
 *   costAccount    Σ message cost in the account currency (price × segments)
 *   costUsd        Σ costUsd; `costUsdMissing` accepted messages carry none
 *   inboundTotal   all inbound (STOP included) — what legacy `replied` counts
 *   replies        non-STOP inbound;  repliers = distinct numbers sending one
 *   optOuts        distinct numbers that sent STOP
 *
 * Every outbound filter also carries COUNTED_SQL, so console refusals
 * (`blocked`) are never in any of these.
 */
export interface Metrics {
  accepted: number;
  delivered: number;
  undeliverable: number;
  pending: number;
  failedNotSent: number;
  segments: number;
  /** Null when no accepted message is priced, or when they span currencies. */
  costAccount: number | null;
  currency: string | null;
  costUsd: number;
  costUsdMissing: number;
  inboundTotal: number;
  replies: number;
  repliers: number;
  optOuts: number;
}

/** Outbound-only metrics, for reps (inbound is not attributed to a user). */
export type OutboundMetrics = Omit<Metrics, 'inboundTotal' | 'replies' | 'repliers' | 'optOuts'>;

const SENT = Prisma.sql`(${COUNTED_SQL} AND ${SQL_IS_SENT})`;
const PRICED = Prisma.sql`(${SENT} AND ${SQL_MESSAGE_COST} IS NOT NULL)`;
const REPLY = Prisma.sql`(${INBOUND_COUNTED_SQL} AND NOT "isStopKeyword")`;
const STOP = Prisma.sql`(${INBOUND_COUNTED_SQL} AND "isStopKeyword")`;

/** Aggregate columns (prefixed m_) for the outbound metrics. Money comes back as exact numeric text. */
export const OUTBOUND_METRICS_SQL = Prisma.sql`
  count(*) FILTER (WHERE ${SENT}) AS m_accepted,
  count(*) FILTER (WHERE ${COUNTED_SQL} AND ${SQL_IS_DELIVERED}) AS m_delivered,
  count(*) FILTER (WHERE ${COUNTED_SQL} AND ${SQL_IS_UNDELIVERABLE}) AS m_undeliverable,
  count(*) FILTER (WHERE ${COUNTED_SQL} AND ${SQL_IS_PENDING}) AS m_pending,
  count(*) FILTER (WHERE ${COUNTED_SQL} AND ${SQL_IS_FAILED}) AS m_failed,
  COALESCE(SUM(${SEGMENTS_SQL}) FILTER (WHERE ${SENT}), 0)::bigint AS m_segments,
  COALESCE(SUM(${SQL_MESSAGE_COST}) FILTER (WHERE ${PRICED}), 0)::text AS m_cost,
  count(*) FILTER (WHERE ${PRICED}) AS m_priced,
  count(DISTINCT "priceCurrency") FILTER (WHERE ${PRICED}) AS m_currencies,
  min("priceCurrency") FILTER (WHERE ${PRICED}) AS m_currency,
  COALESCE(SUM("costUsd") FILTER (WHERE ${SENT}), 0)::text AS m_cost_usd,
  count(*) FILTER (WHERE ${SENT} AND "costUsd" IS NULL) AS m_cost_usd_missing`;

/** Inbound aggregate columns. Distinct counts, so they are only additive across messages, not days. */
export const INBOUND_METRICS_SQL = Prisma.sql`
  count(*) FILTER (WHERE ${INBOUND_COUNTED_SQL}) AS m_inbound,
  count(*) FILTER (WHERE ${REPLY}) AS m_replies,
  count(DISTINCT "fromNumber") FILTER (WHERE ${REPLY}) AS m_repliers,
  count(DISTINCT "fromNumber") FILTER (WHERE ${STOP}) AS m_opt_outs`;

export interface MetricsRow {
  m_accepted?: bigint | number | null;
  m_delivered?: bigint | number | null;
  m_undeliverable?: bigint | number | null;
  m_pending?: bigint | number | null;
  m_failed?: bigint | number | null;
  m_segments?: bigint | number | null;
  m_cost?: string | null;
  m_priced?: bigint | number | null;
  m_currencies?: bigint | number | null;
  m_currency?: string | null;
  m_cost_usd?: string | null;
  m_cost_usd_missing?: bigint | number | null;
  m_inbound?: bigint | number | null;
  m_replies?: bigint | number | null;
  m_repliers?: bigint | number | null;
  m_opt_outs?: bigint | number | null;
}

const int = (v: bigint | number | null | undefined) => Number(v ?? 0);

/**
 * Money is carried as integer micro-units (1e-6) so that summing days gives
 * exactly the period total. Postgres sums the NUMERIC(12,6) columns exactly,
 * so the text it returns has at most 6 decimals and converts without loss.
 */
export const toMicros = (text: string | null | undefined): number => Math.round(Number(text ?? 0) * 1e6);
const fromMicros = (micros: number) => micros / 1e6;

/** Internal accumulator: money in micros, currency set kept for mixed detection. */
export interface MetricsAcc extends Omit<Metrics, 'costAccount' | 'currency' | 'costUsd'> {
  costMicros: number;
  costUsdMicros: number;
  priced: number;
  currencies: Set<string>;
  mixed: boolean;
}

export const emptyAcc = (): MetricsAcc => ({
  accepted: 0,
  delivered: 0,
  undeliverable: 0,
  pending: 0,
  failedNotSent: 0,
  segments: 0,
  costMicros: 0,
  costUsdMicros: 0,
  costUsdMissing: 0,
  priced: 0,
  currencies: new Set(),
  mixed: false,
  inboundTotal: 0,
  replies: 0,
  repliers: 0,
  optOuts: 0,
});

export function accFromRow(r: MetricsRow | undefined): MetricsAcc {
  const acc = emptyAcc();
  if (!r) return acc;
  acc.accepted = int(r.m_accepted);
  acc.delivered = int(r.m_delivered);
  acc.undeliverable = int(r.m_undeliverable);
  acc.pending = int(r.m_pending);
  acc.failedNotSent = int(r.m_failed);
  acc.segments = int(r.m_segments);
  acc.costMicros = toMicros(r.m_cost);
  acc.priced = int(r.m_priced);
  acc.mixed = int(r.m_currencies) > 1;
  if (r.m_currency) acc.currencies.add(r.m_currency);
  acc.costUsdMicros = toMicros(r.m_cost_usd);
  acc.costUsdMissing = int(r.m_cost_usd_missing);
  acc.inboundTotal = int(r.m_inbound);
  acc.replies = int(r.m_replies);
  acc.repliers = int(r.m_repliers);
  acc.optOuts = int(r.m_opt_outs);
  return acc;
}

/** Adds the additive fields of `b` into `a`. Distinct counts (repliers, optOuts) are NOT summed. */
export function addAcc(a: MetricsAcc, b: MetricsAcc): MetricsAcc {
  a.accepted += b.accepted;
  a.delivered += b.delivered;
  a.undeliverable += b.undeliverable;
  a.pending += b.pending;
  a.failedNotSent += b.failedNotSent;
  a.segments += b.segments;
  a.costMicros += b.costMicros;
  a.costUsdMicros += b.costUsdMicros;
  a.costUsdMissing += b.costUsdMissing;
  a.priced += b.priced;
  a.mixed = a.mixed || b.mixed;
  b.currencies.forEach((c) => a.currencies.add(c));
  a.inboundTotal += b.inboundTotal;
  a.replies += b.replies;
  return a;
}

export function toMetrics(acc: MetricsAcc): Metrics {
  return {
    ...toOutboundMetrics(acc),
    inboundTotal: acc.inboundTotal,
    replies: acc.replies,
    repliers: acc.repliers,
    optOuts: acc.optOuts,
  };
}

export function toOutboundMetrics(acc: MetricsAcc): OutboundMetrics {
  const single = !acc.mixed && acc.currencies.size === 1;
  return {
    accepted: acc.accepted,
    delivered: acc.delivered,
    undeliverable: acc.undeliverable,
    pending: acc.pending,
    failedNotSent: acc.failedNotSent,
    segments: acc.segments,
    costAccount: single ? fromMicros(acc.costMicros) : null,
    currency: single ? [...acc.currencies][0] : acc.mixed || acc.currencies.size > 1 ? 'MIXED' : null,
    costUsd: fromMicros(acc.costUsdMicros),
    costUsdMissing: acc.costUsdMissing,
  };
}
