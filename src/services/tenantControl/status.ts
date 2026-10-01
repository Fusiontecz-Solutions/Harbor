import { Prisma } from '@prisma/client';
import prisma from '../../config/prismaClient';
import { getAccountBalance, isInfobipConfigured, toInfobipError } from '../messaging/infobip.service';
import { getSendingState, SENDING_DISABLED_CODE, type SendingState } from './state';

/** Shape of GET /api/tenant-control/v1/status (Tenant Control API v1). */
export interface TenantStatusV1 {
  contract: 'tenant-control/v1';
  platform: 'harbor';
  appVersion: string | null;
  sending: SendingState;
  messages: {
    total: number;
    last24h: number;
    last7d: number;
    last30d: number;
    delivered30d: number;
    failed30d: number;
    segments30d: number;
    blocked30d: number;
    daily: { date: string; sent: number; failed: number }[];
  };
  balance:
    | { available: true; amount: number; currency: string; monthlyLimit: number | null; monthlyBalance: number | null }
    | { available: false; error: string };
  generatedAt: string;
}

const DAY_MS = 86_400_000;
const BALANCE_CACHE_MS = 60_000;
let balanceCache: { value: TenantStatusV1['balance']; at: number } | null = null;

async function readBalance(): Promise<TenantStatusV1['balance']> {
  if (balanceCache && Date.now() - balanceCache.at < BALANCE_CACHE_MS) return balanceCache.value;
  let value: TenantStatusV1['balance'];
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

/** Outbound messages handed to Infobip, excluding sends refused while paused. */
const counted = (since?: Date): Prisma.MessagingMessageWhereInput => ({
  direction: 'OUTBOUND',
  status: { notIn: ['QUEUED', 'SENDING'] },
  OR: [{ errorCode: null }, { errorCode: { not: SENDING_DISABLED_CODE } }],
  ...(since ? { createdAt: { gte: since } } : {}),
});

export async function collectStatus(now = new Date()): Promise<TenantStatusV1> {
  const d1 = new Date(now.getTime() - DAY_MS);
  const d7 = new Date(now.getTime() - 7 * DAY_MS);
  const d30 = new Date(now.getTime() - 30 * DAY_MS);
  const seriesStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 29 * DAY_MS);

  const [sending, balance, total, last24h, last7d, last30d, delivered30d, failed30d, segmentAgg, nullSegments, blocked30d, dailyRows] =
    await Promise.all([
      getSendingState({ fresh: true }),
      readBalance(),
      prisma.messagingMessage.count({ where: counted() }),
      prisma.messagingMessage.count({ where: counted(d1) }),
      prisma.messagingMessage.count({ where: counted(d7) }),
      prisma.messagingMessage.count({ where: counted(d30) }),
      prisma.messagingMessage.count({ where: { ...counted(d30), status: 'DELIVERED' } }),
      prisma.messagingMessage.count({ where: { ...counted(d30), status: { in: ['FAILED', 'UNDELIVERABLE'] } } }),
      prisma.messagingMessage.aggregate({ where: counted(d30), _sum: { segmentCount: true } }),
      // Messages without a provider segment count still cost at least one segment.
      prisma.messagingMessage.count({ where: { ...counted(d30), segmentCount: null } }),
      prisma.messagingMessage.count({
        where: { direction: 'OUTBOUND', errorCode: SENDING_DISABLED_CODE, createdAt: { gte: d30 } },
      }),
      prisma.$queryRaw<{ day: string; sent: bigint; failed: bigint }[]>`
        SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS day,
               count(*) FILTER (WHERE "status"::text NOT IN ('FAILED', 'UNDELIVERABLE')) AS sent,
               count(*) FILTER (WHERE "status"::text IN ('FAILED', 'UNDELIVERABLE')) AS failed
        FROM "MessagingMessage"
        WHERE "direction"::text = 'OUTBOUND'
          AND "status"::text NOT IN ('QUEUED', 'SENDING')
          AND ("errorCode" IS NULL OR "errorCode" <> ${SENDING_DISABLED_CODE})
          AND "createdAt" >= ${seriesStart}
        GROUP BY 1`,
    ]);

  const byDay = new Map(dailyRows.map((r) => [r.day, r]));
  const daily = Array.from({ length: 30 }, (_, i) => {
    const date = new Date(seriesStart.getTime() + i * DAY_MS).toISOString().slice(0, 10);
    const row = byDay.get(date);
    return { date, sent: Number(row?.sent ?? 0), failed: Number(row?.failed ?? 0) };
  });

  return {
    contract: 'tenant-control/v1',
    platform: 'harbor',
    appVersion: process.env.APP_VERSION?.trim() || null,
    sending,
    messages: {
      total,
      last24h,
      last7d,
      last30d,
      delivered30d,
      failed30d,
      segments30d: (segmentAgg._sum.segmentCount ?? 0) + nullSegments,
      blocked30d,
      daily,
    },
    balance,
    generatedAt: now.toISOString(),
  };
}
