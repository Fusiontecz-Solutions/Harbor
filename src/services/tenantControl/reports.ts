import { Prisma, type SmsBroadcastStatus } from '@prisma/client';
import prisma from '../../config/prismaClient';
import { COUNTED_SQL, DAY_MS, dayKey, FAILED_SQL, REFUSED_SQL, resolveRange, SEGMENTS_SQL } from './counting';

export const CONTRACT = 'tenant-control/v2' as const;

type Query = Record<string, unknown>;

interface UsageDay {
  date: string;
  sent: number;
  delivered: number;
  failed: number;
  segments: number;
  blocked: number;
}

// ── GET /usage ──────────────────────────────────────────────────────────────

export async function collectUsage(query: Query, now = new Date()) {
  const { from, to, start, end } = resolveRange(query, now);
  const rows = await prisma.$queryRaw<
    { day: string; sent: bigint; delivered: bigint; failed: bigint; segments: bigint; blocked: bigint }[]
  >`
    SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS day,
           count(*) FILTER (WHERE ${COUNTED_SQL}) AS sent,
           count(*) FILTER (WHERE ${COUNTED_SQL} AND "status"::text = 'DELIVERED') AS delivered,
           count(*) FILTER (WHERE ${COUNTED_SQL} AND ${FAILED_SQL}) AS failed,
           COALESCE(SUM(${SEGMENTS_SQL}) FILTER (WHERE ${COUNTED_SQL}), 0)::bigint AS segments,
           count(*) FILTER (WHERE ${REFUSED_SQL}) AS blocked
      FROM "MessagingMessage"
     WHERE "direction"::text = 'OUTBOUND' AND "createdAt" >= ${start} AND "createdAt" < ${end}
     GROUP BY 1`;

  const byDay = new Map(rows.map((r) => [r.day, r]));
  const daily: UsageDay[] = [];
  for (let ms = start.getTime(); ms < end.getTime(); ms += DAY_MS) {
    const date = dayKey(ms);
    const r = byDay.get(date);
    daily.push({
      date,
      sent: Number(r?.sent ?? 0),
      delivered: Number(r?.delivered ?? 0),
      failed: Number(r?.failed ?? 0),
      segments: Number(r?.segments ?? 0),
      blocked: Number(r?.blocked ?? 0),
    });
  }
  const sum = (key: Exclude<keyof UsageDay, 'date'>) => daily.reduce((a, d) => a + d[key], 0);

  return {
    contract: CONTRACT,
    from,
    to,
    totals: { sent: sum('sent'), delivered: sum('delivered'), failed: sum('failed'), segments: sum('segments'), blocked: sum('blocked') },
    daily,
    generatedAt: now.toISOString(),
  };
}

// ── GET /broadcasts ─────────────────────────────────────────────────────────

export type BroadcastStatus = 'draft' | 'scheduled' | 'sending' | 'paused' | 'completed' | 'failed' | 'cancelled';
export const BROADCAST_STATUSES: readonly BroadcastStatus[] = [
  'draft',
  'scheduled',
  'sending',
  'paused',
  'completed',
  'failed',
  'cancelled',
];

/** QUEUED means "waiting for its start time" until that time passes, then the scheduler picks it up. */
export function toBroadcastStatus(status: SmsBroadcastStatus, scheduledAt: Date | null, now = new Date()): BroadcastStatus {
  switch (status) {
    case 'DRAFT':
    case 'PENDING_APPROVAL':
      return 'draft';
    case 'QUEUED':
      return scheduledAt && scheduledAt > now ? 'scheduled' : 'sending';
    case 'RUNNING':
      return 'sending';
    case 'PAUSED':
      return 'paused';
    case 'COMPLETED':
      return 'completed';
    case 'FAILED':
      return 'failed';
    case 'CANCELLED':
      return 'cancelled';
  }
}

function statusWhere(status: BroadcastStatus, now: Date): Prisma.SmsBroadcastWhereInput {
  switch (status) {
    case 'draft':
      return { status: { in: ['DRAFT', 'PENDING_APPROVAL'] } };
    case 'scheduled':
      return { status: 'QUEUED', scheduledAt: { gt: now } };
    case 'sending':
      return {
        OR: [
          { status: 'RUNNING' },
          { status: 'QUEUED', OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }] },
        ],
      };
    case 'paused':
      return { status: 'PAUSED' };
    case 'completed':
      return { status: 'COMPLETED' };
    case 'failed':
      return { status: 'FAILED' };
    case 'cancelled':
      return { status: 'CANCELLED' };
  }
}

const fullName = (u: { firstName: string; lastName: string; email: string } | null) =>
  u ? `${u.firstName} ${u.lastName}`.trim() || u.email : null;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function collectBroadcasts(query: Query, now = new Date()) {
  const { start, end } = resolveRange(query, now);
  const wanted = typeof query.status === 'string' ? query.status : '';
  if (wanted && !BROADCAST_STATUSES.includes(wanted as BroadcastStatus)) {
    throw new BadRequest(`status must be one of ${BROADCAST_STATUSES.join(', ')}`);
  }
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
  const cursor = typeof query.cursor === 'string' && UUID_RE.test(query.cursor) ? query.cursor : null;

  const rows = await prisma.smsBroadcast.findMany({
    where: {
      createdAt: { gte: start, lt: end },
      ...(wanted ? statusWhere(wanted as BroadcastStatus, now) : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      name: true,
      status: true,
      scheduledAt: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
      totalRecipients: true,
      createdById: true,
      createdBy: { select: { firstName: true, lastName: true, email: true } },
    },
  });
  const page = rows.slice(0, limit);

  const ids = page.map((b) => b.id);
  const counts = ids.length
    ? await prisma.$queryRaw<{ id: string; sent: bigint; delivered: bigint; failed: bigint; segments: bigint }[]>`
        SELECT "broadcastId"::text AS id,
               count(*) AS sent,
               count(*) FILTER (WHERE "status"::text = 'DELIVERED') AS delivered,
               count(*) FILTER (WHERE ${FAILED_SQL}) AS failed,
               COALESCE(SUM(${SEGMENTS_SQL}), 0)::bigint AS segments
          FROM "MessagingMessage"
         WHERE ${COUNTED_SQL} AND "broadcastId" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
         GROUP BY 1`
    : [];
  const byId = new Map(counts.map((c) => [c.id, c]));

  return {
    contract: CONTRACT,
    broadcasts: page.map((b) => {
      const c = byId.get(b.id);
      return {
        id: b.id,
        name: b.name,
        status: toBroadcastStatus(b.status, b.scheduledAt, now),
        createdAt: b.createdAt.toISOString(),
        startedAt: b.startedAt?.toISOString() ?? null,
        completedAt: b.finishedAt?.toISOString() ?? null,
        recipients: b.totalRecipients,
        sent: Number(c?.sent ?? 0),
        delivered: Number(c?.delivered ?? 0),
        failed: Number(c?.failed ?? 0),
        segments: Number(c?.segments ?? 0),
        repId: b.createdById,
        repName: fullName(b.createdBy),
      };
    }),
    nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    generatedAt: now.toISOString(),
  };
}

// ── GET /reps ───────────────────────────────────────────────────────────────

/** Every Harbor user can send SMS, so every user is a rep. */
export async function collectReps(query: Query, now = new Date()) {
  const { from, to, start, end } = resolveRange(query, now);
  const [users, sends, broadcasts] = await Promise.all([
    prisma.user.findMany({ select: { id: true, firstName: true, lastName: true, email: true, isActive: true } }),
    prisma.$queryRaw<{ id: string; sent: bigint; delivered: bigint; failed: bigint; segments: bigint; last: Date }[]>`
      SELECT "sentById"::text AS id,
             count(*) AS sent,
             count(*) FILTER (WHERE "status"::text = 'DELIVERED') AS delivered,
             count(*) FILTER (WHERE ${FAILED_SQL}) AS failed,
             COALESCE(SUM(${SEGMENTS_SQL}), 0)::bigint AS segments,
             max("createdAt") AS last
        FROM "MessagingMessage"
       WHERE ${COUNTED_SQL} AND "sentById" IS NOT NULL AND "createdAt" >= ${start} AND "createdAt" < ${end}
       GROUP BY 1`,
    prisma.smsBroadcast.groupBy({
      by: ['createdById'],
      where: { createdById: { not: null }, createdAt: { gte: start, lt: end } },
      _count: { _all: true },
    }),
  ]);
  const sendsBy = new Map(sends.map((s) => [s.id, s]));
  const broadcastsBy = new Map(broadcasts.map((b) => [b.createdById, b._count._all]));

  const reps = users
    .map((u) => {
      const s = sendsBy.get(u.id);
      return {
        id: u.id,
        name: fullName(u) ?? u.id,
        email: u.email || null,
        active: u.isActive,
        sent: Number(s?.sent ?? 0),
        delivered: Number(s?.delivered ?? 0),
        failed: Number(s?.failed ?? 0),
        segments: Number(s?.segments ?? 0),
        broadcasts: broadcastsBy.get(u.id) ?? 0,
        lastActiveAt: s ? new Date(s.last).toISOString() : null,
      };
    })
    .sort((a, b) => b.sent - a.sent || a.name.localeCompare(b.name));

  return { contract: CONTRACT, from, to, reps, generatedAt: now.toISOString() };
}

export class BadRequest extends Error {}
