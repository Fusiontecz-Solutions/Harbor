/**
 * Per-user messaging performance.
 *
 * Answers "who sent what, and what came back" over a date range: messages out,
 * delivered, failed, campaigns run, replies received and opt-outs.
 *
 * Attribution is the whole difficulty here, and the two directions work
 * differently:
 *
 *   Outbound — `MessagingMessage.sentById`, falling back to the campaign's
 *   creator for broadcast messages. The worker now stamps `sentById` directly,
 *   but rows written before that change have it null, so the fallback keeps
 *   historical campaigns attributed rather than silently dropping them.
 *
 *   Inbound — a reply carries no user at all, so it is attributed through the
 *   number it arrived on: conversation.businessNumber → the user assigned that
 *   sender. That is the same rule the inbox scoping uses, so a reply counted
 *   for someone is exactly a reply they can see. Replies to the shared env
 *   default belong to nobody and are reported separately rather than being
 *   spread across users, which would invent numbers.
 *
 * Raw SQL rather than Prisma groupBy: the outbound fallback needs a COALESCE
 * across a join, and inbound needs to group by a field on the related
 * conversation. Neither is expressible in groupBy.
 */
import prisma from '../../config/prismaClient';
import { addDays, REPORT_TIMEZONE, zonedDay, zonedMidnight } from '../reports/reportTime';
import { SQL_IS_DELIVERED, SQL_IS_FAILED, SQL_IS_SENT, SQL_IS_UNDELIVERABLE } from './smsMetrics';

export interface PerformanceRow {
  userId: string | null;
  name: string | null;
  email: string | null;
  role: string | null;
  /** The number their inbound traffic is attributed through. */
  senderNumber: string | null;
  /** Accepted by the provider (smsMetrics). */
  messagesSent: number;
  delivered: number;
  /** Accepted, carrier did not deliver (incl. expired). */
  undeliverable: number;
  /** Rejected / never accepted — not part of messagesSent. */
  failed: number;
  campaigns: number;
  /** Non-STOP inbound. */
  replies: number;
  optOuts: number;
}

export interface PerformanceDayRow {
  day: string;
  userId: string | null;
  messagesSent: number;
  replies: number;
  optOuts: number;
}

export interface PerformanceResult {
  from: string;
  to: string;
  totals: {
    messagesSent: number;
    delivered: number;
    undeliverable: number;
    failed: number;
    campaigns: number;
    replies: number;
    optOuts: number;
  };
  users: PerformanceRow[];
  /** Per-user per-day series, for charting. */
  daily: PerformanceDayRow[];
  /**
   * Inbound traffic on numbers no user is assigned to — usually the shared env
   * default. Surfaced rather than hidden, so the per-user replies adding up to
   * less than the total is explained instead of looking like a bug.
   */
  unattributedReplies: number;
  unattributedOptOuts: number;
}

/**
 * Inclusive US Eastern days → [start, end) instants; defaults to the last 30
 * days. YYYY-MM-DD is read as an Eastern day (it used to be the server's local
 * day, i.e. UTC in production).
 */
function resolveRange(from?: string, to?: string): { start: Date; end: Date } {
  const isDay = (v?: string) => Boolean(v && /^\d{4}-\d{2}-\d{2}$/.test(v));
  const dayOf = (v: string | undefined, fallback: string): string => {
    if (!v) return fallback;
    if (isDay(v)) return v;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new Error('Invalid date range');
    return zonedDay(d);
  };
  const toDay = dayOf(to, zonedDay(new Date()));
  const fromDay = dayOf(from, addDays(toDay, -30));
  const start = zonedMidnight(fromDay);
  const end = zonedMidnight(addDays(toDay, 1));
  if (start >= end) throw new Error('Invalid date range');
  return { start, end };
}

const toInt = (value: unknown): number => Number(value ?? 0) || 0;

export async function messagingPerformance(params: {
  from?: string;
  to?: string;
}): Promise<PerformanceResult> {
  const { start, end } = resolveRange(params.from, params.to);

  const [outbound, inbound, campaigns, users] = await Promise.all([
    prisma.$queryRaw<
      Array<{ userId: string | null; day: string; sent: bigint; delivered: bigint; undeliverable: bigint; failed: bigint }>
    >`
      SELECT COALESCE(m."sentById", b."createdById") AS "userId",
             to_char((m."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${REPORT_TIMEZONE}, 'YYYY-MM-DD') AS day,
             COUNT(*) FILTER (WHERE ${SQL_IS_SENT}) AS sent,
             COUNT(*) FILTER (WHERE ${SQL_IS_DELIVERED}) AS delivered,
             COUNT(*) FILTER (WHERE ${SQL_IS_UNDELIVERABLE}) AS undeliverable,
             COUNT(*) FILTER (WHERE ${SQL_IS_FAILED}) AS failed
      FROM "MessagingMessage" m
      LEFT JOIN "SmsBroadcast" b ON b."id" = m."broadcastId"
      WHERE m."direction" = 'OUTBOUND'
        AND m."createdAt" >= ${start}
        AND m."createdAt" < ${end}
      GROUP BY 1, 2
    `,

    prisma.$queryRaw<
      Array<{ userId: string | null; day: string; replies: bigint; optouts: bigint }>
    >`
      SELECT u."id" AS "userId",
             to_char((m."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${REPORT_TIMEZONE}, 'YYYY-MM-DD') AS day,
             COUNT(*) FILTER (WHERE NOT m."isStopKeyword") AS replies,
             COUNT(*) FILTER (WHERE m."isStopKeyword") AS optouts
      FROM "MessagingMessage" m
      JOIN "MessagingConversation" c ON c."id" = m."conversationId"
      LEFT JOIN "MessagingSender" s ON s."phoneNumber" = c."businessNumber"
      LEFT JOIN "User" u ON u."messagingSenderId" = s."id"
      WHERE m."direction" = 'INBOUND'
        AND m."createdAt" >= ${start}
        AND m."createdAt" < ${end}
      GROUP BY 1, 2
    `,

    prisma.smsBroadcast.groupBy({
      by: ['createdById'],
      // A campaign counts once it actually went out; drafts, rejected and
      // still-awaiting-approval ones never reached anyone.
      where: { startedAt: { gte: start, lt: end } },
      _count: { _all: true },
    }),

    prisma.user.findMany({
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        role: true,
        messagingSender: { select: { phoneNumber: true } },
      },
    }),
  ]);

  const byUser = new Map<string, PerformanceRow>();
  const userById = new Map(users.map((u) => [u.id, u]));

  const rowFor = (userId: string): PerformanceRow => {
    const existing = byUser.get(userId);
    if (existing) return existing;

    const user = userById.get(userId);
    const name = user ? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() : '';
    const row: PerformanceRow = {
      userId,
      name: name || user?.email || null,
      email: user?.email ?? null,
      role: user?.role ?? null,
      senderNumber: user?.messagingSender?.phoneNumber ?? null,
      messagesSent: 0,
      delivered: 0,
      undeliverable: 0,
      failed: 0,
      campaigns: 0,
      replies: 0,
      optOuts: 0,
    };
    byUser.set(userId, row);
    return row;
  };

  const daily: PerformanceDayRow[] = [];
  const dayKey = (day: string) => day;
  const dailyIndex = new Map<string, PerformanceDayRow>();

  const dailyFor = (userId: string | null, day: string): PerformanceDayRow => {
    const key = `${userId ?? 'none'}:${dayKey(day)}`;
    const existing = dailyIndex.get(key);
    if (existing) return existing;
    const row: PerformanceDayRow = {
      day: dayKey(day),
      userId,
      messagesSent: 0,
      replies: 0,
      optOuts: 0,
    };
    dailyIndex.set(key, row);
    daily.push(row);
    return row;
  };

  let unattributedReplies = 0;
  let unattributedOptOuts = 0;

  for (const row of outbound) {
    const day = dailyFor(row.userId, row.day);
    day.messagesSent += toInt(row.sent);
    if (!row.userId) continue;
    const user = rowFor(row.userId);
    user.messagesSent += toInt(row.sent);
    user.delivered += toInt(row.delivered);
    user.undeliverable += toInt(row.undeliverable);
    user.failed += toInt(row.failed);
  }

  for (const row of inbound) {
    const day = dailyFor(row.userId, row.day);
    day.replies += toInt(row.replies);
    day.optOuts += toInt(row.optouts);

    if (!row.userId) {
      unattributedReplies += toInt(row.replies);
      unattributedOptOuts += toInt(row.optouts);
      continue;
    }
    const user = rowFor(row.userId);
    user.replies += toInt(row.replies);
    user.optOuts += toInt(row.optouts);
  }

  for (const row of campaigns) {
    if (!row.createdById) continue;
    rowFor(row.createdById).campaigns += row._count._all;
  }

  const userRows = [...byUser.values()].sort((a, b) => b.messagesSent - a.messagesSent);
  daily.sort((a, b) => a.day.localeCompare(b.day));

  return {
    from: start.toISOString(),
    to: end.toISOString(),
    totals: {
      messagesSent: userRows.reduce((sum, r) => sum + r.messagesSent, 0),
      delivered: userRows.reduce((sum, r) => sum + r.delivered, 0),
      undeliverable: userRows.reduce((sum, r) => sum + r.undeliverable, 0),
      failed: userRows.reduce((sum, r) => sum + r.failed, 0),
      campaigns: userRows.reduce((sum, r) => sum + r.campaigns, 0),
      replies: userRows.reduce((sum, r) => sum + r.replies, 0),
      optOuts: userRows.reduce((sum, r) => sum + r.optOuts, 0),
    },
    users: userRows,
    daily,
    unattributedReplies,
    unattributedOptOuts,
  };
}
