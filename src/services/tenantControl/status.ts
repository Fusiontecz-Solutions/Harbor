import prisma from '../../config/prismaClient';
import { getAccountBalance, isInfobipConfigured, toInfobipError } from '../messaging/infobip.service';
import { COUNTED_SQL, countedWhere, DAY_MS, FAILED_SQL, INBOUND_COUNTED_SQL, REFUSED_CODES, SEGMENTS_SQL } from './counting';
import { getLimitState, type LimitState } from './quota';
import { getPrepaidState, type PrepaidState } from './prepaid';
import { getSendingState, type SendingState } from './state';

/**
 * `metrics`: /usage, /broadcasts and /reps carry a `metrics` block with the shared
 * SMS definitions (../messaging/smsMetrics.ts) and accept a `tz` query param.
 */
export const CAPABILITIES = ['usage', 'broadcasts', 'reps', 'limit', 'prepaid', 'metrics'] as const;

/** Shape of GET /api/tenant-control/v1/status (Tenant Control API v2, a superset of v1). */
export interface TenantStatus {
  contract: 'tenant-control/v2';
  platform: 'harbor';
  appVersion: string | null;
  sending: SendingState;
  messages: {
    total: number;
    segmentsTotal: number;
    last24h: number;
    last7d: number;
    last30d: number;
    delivered30d: number;
    failed30d: number;
    segments30d: number;
    blocked30d: number;
    daily: { date: string; sent: number; failed: number }[];
    inbound: {
      total: number;
      segmentsTotal: number;
      last24h: number;
      last7d: number;
      last30d: number;
      segments30d: number;
    };
  };
  balance:
    | { available: true; amount: number; currency: string; monthlyLimit: number | null; monthlyBalance: number | null }
    | { available: false; error: string };
  generatedAt: string;
  capabilities: (typeof CAPABILITIES)[number][];
  limit: LimitState | null;
  /** Console-managed prepaid balance; null when not priced by the console. */
  prepaid: PrepaidState | null;
}

const BALANCE_CACHE_MS = 60_000;
let balanceCache: { value: TenantStatus['balance']; at: number } | null = null;

async function readBalance(): Promise<TenantStatus['balance']> {
  if (balanceCache && Date.now() - balanceCache.at < BALANCE_CACHE_MS) return balanceCache.value;
  let value: TenantStatus['balance'];
  if (!isInfobipConfigured()) {
    value = { available: false, error: 'Infobip is not configured on this server' };
  } else {
    try {
      value = { available: true, ...(await getAccountBalance()) };
    } catch (err) {
      const e = toInfobipError(err);
      value = {
        available: false,
        error:
          e.statusCode === 401 || e.statusCode === 403
            ? 'The Infobip API key cannot read the balance (needs the account-management:manage scope)'
            : e.message,
      };
    }
  }
  balanceCache = { value, at: Date.now() };
  return value;
}

export async function collectStatus(now = new Date()): Promise<TenantStatus> {
  const d1 = new Date(now.getTime() - DAY_MS);
  const d7 = new Date(now.getTime() - 7 * DAY_MS);
  const d30 = new Date(now.getTime() - 30 * DAY_MS);
  const seriesStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 29 * DAY_MS);

  const [sending, balance, limit, prepaid, totals, inboundTotals, inbound24h, inbound7d, inbound30, last24h, last7d, window30, blocked30d, dailyRows] = await Promise.all([
    getSendingState({ fresh: true }),
    readBalance(),
    getLimitState(now),
    getPrepaidState({ fresh: true }),
    prisma.$queryRaw<{ total: bigint; segments: bigint }[]>`
      SELECT count(*) AS total, COALESCE(SUM(${SEGMENTS_SQL}), 0)::bigint AS segments
        FROM "MessagingMessage" WHERE ${COUNTED_SQL}`,
    prisma.$queryRaw<{ total: bigint; segments: bigint }[]>`
      SELECT count(*) AS total, COALESCE(SUM(${SEGMENTS_SQL}), 0)::bigint AS segments
        FROM "MessagingMessage" WHERE ${INBOUND_COUNTED_SQL}`,
    prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "MessagingMessage" WHERE ${INBOUND_COUNTED_SQL} AND "createdAt" >= ${d1}`,
    prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "MessagingMessage" WHERE ${INBOUND_COUNTED_SQL} AND "createdAt" >= ${d7}`,
    prisma.$queryRaw<{ total: bigint; segments: bigint }[]>`
      SELECT count(*) AS total, COALESCE(SUM(${SEGMENTS_SQL}), 0)::bigint AS segments
        FROM "MessagingMessage" WHERE ${INBOUND_COUNTED_SQL} AND "createdAt" >= ${d30}`,
    prisma.messagingMessage.count({ where: countedWhere({ gte: d1 }) }),
    prisma.messagingMessage.count({ where: countedWhere({ gte: d7 }) }),
    prisma.$queryRaw<{ total: bigint; delivered: bigint; failed: bigint; segments: bigint }[]>`
      SELECT count(*) AS total,
             count(*) FILTER (WHERE "status"::text = 'DELIVERED') AS delivered,
             count(*) FILTER (WHERE ${FAILED_SQL}) AS failed,
             COALESCE(SUM(${SEGMENTS_SQL}), 0)::bigint AS segments
        FROM "MessagingMessage" WHERE ${COUNTED_SQL} AND "createdAt" >= ${d30}`,
    prisma.messagingMessage.count({
      where: { direction: 'OUTBOUND', errorCode: { in: REFUSED_CODES }, createdAt: { gte: d30 } },
    }),
    prisma.$queryRaw<{ day: string; sent: bigint; failed: bigint }[]>`
      SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS day,
             count(*) FILTER (WHERE NOT (${FAILED_SQL})) AS sent,
             count(*) FILTER (WHERE ${FAILED_SQL}) AS failed
        FROM "MessagingMessage"
       WHERE ${COUNTED_SQL} AND "createdAt" >= ${seriesStart}
       GROUP BY 1`,
  ]);

  const byDay = new Map(dailyRows.map((r) => [r.day, r]));
  const daily = Array.from({ length: 30 }, (_, i) => {
    const date = new Date(seriesStart.getTime() + i * DAY_MS).toISOString().slice(0, 10);
    const row = byDay.get(date);
    return { date, sent: Number(row?.sent ?? 0), failed: Number(row?.failed ?? 0) };
  });
  const w = window30[0];

  return {
    contract: 'tenant-control/v2',
    platform: 'harbor',
    appVersion: process.env.APP_VERSION?.trim() || null,
    sending,
    messages: {
      total: Number(totals[0]?.total ?? 0),
      segmentsTotal: Number(totals[0]?.segments ?? 0),
      last24h,
      last7d,
      last30d: Number(w?.total ?? 0),
      delivered30d: Number(w?.delivered ?? 0),
      failed30d: Number(w?.failed ?? 0),
      segments30d: Number(w?.segments ?? 0),
      blocked30d,
      daily,
      inbound: {
        total: Number(inboundTotals[0]?.total ?? 0),
        segmentsTotal: Number(inboundTotals[0]?.segments ?? 0),
        last24h: Number(inbound24h[0]?.n ?? 0),
        last7d: Number(inbound7d[0]?.n ?? 0),
        last30d: Number(inbound30[0]?.total ?? 0),
        segments30d: Number(inbound30[0]?.segments ?? 0),
      },
    },
    balance,
    generatedAt: now.toISOString(),
    capabilities: [...CAPABILITIES],
    limit,
    prepaid,
  };
}