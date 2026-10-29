import { Prisma, type SmsBroadcastStatus } from '@prisma/client';
import prisma from '../../config/prismaClient';
import {
  COUNTED_SQL,
  daysBetween,
  DEFAULT_TZ,
  FAILED_SQL,
  isValidTimeZone,
  INBOUND_COUNTED_SQL,
  REFUSED_SQL,
  resolveRange,
  SEGMENTS_SQL,
} from './counting';
import {
  accFromRow,
  addAcc,
  emptyAcc,
  INBOUND_METRICS_SQL,
  OUTBOUND_METRICS_SQL,
  toMetrics,
  toOutboundMetrics,
  type Metrics,
  type MetricsRow,
  type OutboundMetrics,
} from './metrics';

export const CONTRACT = 'tenant-control/v2' as const;

type Query = Record<string, unknown>;

/**
 * `tz` (IANA) — the zone `from`/`to` and every day bucket are read in. Absent
 * means UTC, which is what the contract always did, so a console that does not
 * send it sees no change. Invalid zones are a 400 rather than a silent UTC.
 */
export function parseTz(query: Query): string {
  const raw = query.tz;
  if (raw === undefined || raw === '') return DEFAULT_TZ;
  if (typeof raw !== 'string' || !isValidTimeZone(raw)) throw new BadRequest('tz must be an IANA time zone, e.g. America/New_York');
  return raw;
}

/** Calendar day of "createdAt" (a UTC timestamp without zone) in `tz`. */
const daySql = (tz: string) => Prisma.sql`to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}, 'YYYY-MM-DD')`;

interface UsageDay {
  date: string;
  sent: number;
  delivered: number;
  failed: number;
  segments: number;
  blocked: number;
  /**
   * ALL inbound (MO) messages received that day — not only replies attributed
   * to a campaign — and how many of those were an opt-out. Both are inbound,
   * so neither is part of `sent`; they are reported alongside it so the console
   * can show inbound and opt-out rates without a second round trip.
   *
   * The field is named `replied` because that is what the contract shipped as;
   * the console surfaces it as "Messages Received".
   */
  replied: number;
  /** Segments of the inbound messages counted in `replied` (a message with no count is 1). */
  inboundSegments: number;
  optOut: number;
  /**
   * The shared SMS definitions (capability `metrics`). The fields above keep
   * their original meaning: `failed` there still includes UNDELIVERABLE and
   * `replied` still counts STOP. Prefer these.
   */
  metrics: Metrics;
}

// ── GET /usage ──────────────────────────────────────────────────────────────

export async function collectUsage(query: Query, now = new Date()) {
  const tz = parseTz(query);
  const { from, to, start, end } = resolveRange(query, now, tz);
  // Inbound is read in the same pass, so the direction filter widens to both.
  // Every outbound aggregate still carries its own COUNTED/REFUSED filter, so
  // adding inbound rows to the scan cannot change them. GROUPING SETS adds a
  // period row (day = NULL) for the distinct counts, which do not sum by day.
  const rows = await prisma.$queryRaw<
    ({
      day: string | null;
      sent: bigint;
      delivered: bigint;
      failed: bigint;
      segments: bigint;
      blocked: bigint;
      replied: bigint;
      inboundSegments: bigint;
      optOut: bigint;
    } & MetricsRow)[]
  >`
    SELECT day,
           count(*) FILTER (WHERE ${COUNTED_SQL}) AS sent,
           count(*) FILTER (WHERE ${COUNTED_SQL} AND "status"::text = 'DELIVERED') AS delivered,
           count(*) FILTER (WHERE ${COUNTED_SQL} AND ${FAILED_SQL}) AS failed,
           COALESCE(SUM(${SEGMENTS_SQL}) FILTER (WHERE ${COUNTED_SQL}), 0)::bigint AS segments,
           count(*) FILTER (WHERE ${REFUSED_SQL}) AS blocked,
           count(*) FILTER (WHERE ${INBOUND_COUNTED_SQL}) AS replied,
           COALESCE(SUM(${SEGMENTS_SQL}) FILTER (WHERE ${INBOUND_COUNTED_SQL}), 0)::bigint AS "inboundSegments",
           count(*) FILTER (WHERE ${INBOUND_COUNTED_SQL} AND "isStopKeyword") AS "optOut",
           ${OUTBOUND_METRICS_SQL},
           ${INBOUND_METRICS_SQL}
      FROM (SELECT *, ${daySql(tz)} AS day
              FROM "MessagingMessage"
             WHERE "direction"::text IN ('OUTBOUND', 'INBOUND')
               AND "createdAt" >= ${start} AND "createdAt" < ${end}) m
     GROUP BY GROUPING SETS ((day), ())`;

  const byDay = new Map(rows.filter((r) => r.day !== null).map((r) => [r.day as string, r]));
  const period = rows.find((r) => r.day === null);
  const totalAcc = emptyAcc();
  const daily: UsageDay[] = daysBetween(from, to).map((date) => {
    const r = byDay.get(date);
    const acc = accFromRow(r);
    addAcc(totalAcc, acc);
    return {
      date,
      sent: Number(r?.sent ?? 0),
      delivered: Number(r?.delivered ?? 0),
      failed: Number(r?.failed ?? 0),
      segments: Number(r?.segments ?? 0),
      blocked: Number(r?.blocked ?? 0),
      replied: Number(r?.replied ?? 0),
      inboundSegments: Number(r?.inboundSegments ?? 0),
      optOut: Number(r?.optOut ?? 0),
      metrics: toMetrics(acc),
    };
  });
  // Additive totals are the exact sum of the days; distinct ones are over the period.
  totalAcc.repliers = Number(period?.m_repliers ?? 0);
  totalAcc.optOuts = Number(period?.m_opt_outs ?? 0);
  const sum = (key: Exclude<keyof UsageDay, 'date' | 'metrics'>) => daily.reduce((a, d) => a + d[key], 0);

  return {
    contract: CONTRACT,
    from,
    to,
    tz,
    totals: {
      sent: sum('sent'),
      delivered: sum('delivered'),
      failed: sum('failed'),
      segments: sum('segments'),
      blocked: sum('blocked'),
      replied: sum('replied'),
      inboundSegments: sum('inboundSegments'),
      optOut: sum('optOut'),
      metrics: toMetrics(totalAcc),
    },
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
  const { start, end } = resolveRange(query, now, parseTz(query));
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
  // Inbound carries the broadcastId of the campaign it replies to, so replies
  // and opt-outs are attributed in the same pass.
  const counts = ids.length
    ? await prisma.$queryRaw<({ id: string; sent: bigint; delivered: bigint; failed: bigint; segments: bigint } & MetricsRow)[]>`
        SELECT "broadcastId"::text AS id,
               count(*) FILTER (WHERE ${COUNTED_SQL}) AS sent,
               count(*) FILTER (WHERE ${COUNTED_SQL} AND "status"::text = 'DELIVERED') AS delivered,
               count(*) FILTER (WHERE ${COUNTED_SQL} AND ${FAILED_SQL}) AS failed,
               COALESCE(SUM(${SEGMENTS_SQL}) FILTER (WHERE ${COUNTED_SQL}), 0)::bigint AS segments,
               ${OUTBOUND_METRICS_SQL},
               ${INBOUND_METRICS_SQL}
          FROM "MessagingMessage"
         WHERE "broadcastId" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
           AND (${COUNTED_SQL} OR ${INBOUND_COUNTED_SQL})
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
        metrics: toMetrics(accFromRow(c)),
      };
    }),
    nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    generatedAt: now.toISOString(),
  };
}

// ── GET /reps ───────────────────────────────────────────────────────────────

/** Every Harbor user can send SMS, so every user is a rep. */
export async function collectReps(query: Query, now = new Date()) {
  const tz = parseTz(query);
  const { from, to, start, end } = resolveRange(query, now, tz);
  const [users, sends, broadcasts] = await Promise.all([
    prisma.user.findMany({ select: { id: true, firstName: true, lastName: true, email: true, isActive: true } }),
    prisma.$queryRaw<
      ({ id: string; sent: bigint; delivered: bigint; failed: bigint; segments: bigint; last: Date } & MetricsRow)[]
    >`
      SELECT "sentById"::text AS id,
             count(*) AS sent,
             count(*) FILTER (WHERE "status"::text = 'DELIVERED') AS delivered,
             count(*) FILTER (WHERE ${FAILED_SQL}) AS failed,
             COALESCE(SUM(${SEGMENTS_SQL}), 0)::bigint AS segments,
             max("createdAt") AS last,
             ${OUTBOUND_METRICS_SQL}
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
        /** Outbound only: inbound is not attributed to a user. */
        metrics: toOutboundMetrics(accFromRow(s)) as OutboundMetrics,
      };
    })
    .sort((a, b) => b.sent - a.sent || a.name.localeCompare(b.name));

  return { contract: CONTRACT, from, to, tz, reps, generatedAt: now.toISOString() };
}

export class BadRequest extends Error {}
