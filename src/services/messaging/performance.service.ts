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

export interface PerformanceRow {
  userId: string | null;
  name: string | null;
  email: string | null;
  role: string | null;
  /** The number their inbound traffic is attributed through. */
  senderNumber: string | null;
  messagesSent: number;
  delivered: number;
  failed: number;
  campaigns: number;
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

/** Inclusive-start, exclusive-end day window; defaults to the last 30 days. */
function resolveRange(from?: string, to?: string): { start: Date; end: Date } {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error('Invalid date range');
  }

  // Normalize to whole days so a range never half-includes one.
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);
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
      Array<{ userId: string | null; day: Date; sent: bigint; delivered: bigint; failed: bigint }>
    >`
      SELECT COALESCE(m."sentById", b."createdById") AS "userId",
             date_trunc('day', m."createdAt") AS day,
             COUNT(*) AS sent,
             COUNT(*) FILTER (WHERE m."status" = 'DELIVERED') AS delivered,
             COUNT(*) FILTER (WHERE m."status" IN ('FAILED', 'UNDELIVERABLE')) AS failed
      FROM "MessagingMessage" m
      LEFT JOIN "SmsBroadcast" b ON b."id" = m."broadcastId"
      WHERE m."direction" = 'OUTBOUND'
        AND m."createdAt" >= ${start}
        AND m."createdAt" <= ${end}
      GROUP BY 1, 2
    `,

    prisma.$queryRaw<
      Array<{ userId: string | null; day: Date; replies: bigint; optouts: bigint }>
    >`
      SELECT u."id" AS "userId",
             date_trunc('day', m."createdAt") AS day,
             COUNT(*) FILTER (WHERE NOT m."isStopKeyword") AS replies,
             COUNT(*) FILTER (WHERE m."isStopKeyword") AS optouts
      FROM "MessagingMessage" m
      JOIN "MessagingConversation" c ON c."id" = m."conversationId"
      LEFT JOIN "MessagingSender" s ON s."phoneNumber" = c."businessNumber"
      LEFT JOIN "User" u ON u."messagingSenderId" = s."id"
      WHERE m."direction" = 'INBOUND'
        AND m."createdAt" >= ${start}
        AND m."createdAt" <= ${end}
      GROUP BY 1, 2
    `,

    prisma.smsBroadcast.groupBy({
      by: ['createdById'],
      // A campaign counts once it actually went out; drafts, rejected and
      // still-awaiting-approval ones never reached anyone.
      where: { startedAt: { gte: start, lte: end } },
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
      failed: 0,
      campaigns: 0,
      replies: 0,
      optOuts: 0,
    };
    byUser.set(userId, row);
    return row;
  };

  const daily: PerformanceDayRow[] = [];
  const dayKey = (day: Date) => day.toISOString().slice(0, 10);
  const dailyIndex = new Map<string, PerformanceDayRow>();

  const dailyFor = (userId: string | null, day: Date): PerformanceDayRow => {
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
