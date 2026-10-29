/**
 * Data for the on-screen Reports dashboard: headline KPIs with change against
 * the previous period, a daily trend, per-campaign performance, an agent
 * leaderboard, lead pipeline health, spend, and applications.
 *
 * The PDF / Excel exports have their own builders; this is sized for a page.
 */
import prisma from '../../config/prismaClient';
import { agentSheet, type ReportRange } from './harborReport.service';
import { REPORT_TIMEZONE } from './reportTime';
import { zonedDay } from './reportTime';
import {
  RECONCILE_MAX_AGE_MS,
  SQL_IS_DELIVERED,
  SQL_IS_FAILED,
  SQL_IS_PENDING,
  SQL_IS_SENT,
  SQL_IS_UNDELIVERABLE,
} from '../messaging/smsMetrics';

const DAY_MS = 86_400_000;
const pct = (part: number, whole: number): number | null =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;

/** Definitions: smsMetrics.ts. */
interface Kpis {
  campaigns: number;
  recipients: number;
  /** Accepted by the provider (delivered + undeliverable + pending). */
  sent: number;
  delivered: number;
  /** Accepted, carrier did not deliver (incl. expired). */
  undeliverable: number;
  /** Accepted, no final receipt yet. */
  pending: number;
  /** Pending older than the reconcile window — outcome unknown, never guessed. */
  unknown: number;
  /** Rejected / never accepted — not part of sent. */
  failed: number;
  /** Non-STOP inbound messages. */
  replies: number;
  repliers: number;
  optOuts: number;
  directSent: number;
  leadsImported: number;
  applications: number;
  /** Outbound SMS cost in USD (rows with a known USD cost). */
  spend: number;
  /** Sent messages with no USD cost recorded yet. */
  unpriced: number;
}

async function kpisFor(range: ReportRange): Promise<Kpis> {
  const within = { gte: range.from, lt: range.to };
  const unknownBefore = new Date(Date.now() - RECONCILE_MAX_AGE_MS);
  const [broadcasts, outbound, inbound, leads, applications] = await Promise.all([
    prisma.smsBroadcast.aggregate({ where: { createdAt: within }, _count: { _all: true }, _sum: { totalRecipients: true } }),
    prisma.$queryRaw<
      Array<{ sent: bigint; delivered: bigint; undeliverable: bigint; pending: bigint; unknown: bigint; failed: bigint; direct: bigint; spend: string | null; unpriced: bigint }>
    >`
      SELECT COUNT(*) FILTER (WHERE ${SQL_IS_SENT})::bigint AS sent,
             COUNT(*) FILTER (WHERE ${SQL_IS_DELIVERED})::bigint AS delivered,
             COUNT(*) FILTER (WHERE ${SQL_IS_UNDELIVERABLE})::bigint AS undeliverable,
             COUNT(*) FILTER (WHERE ${SQL_IS_PENDING})::bigint AS pending,
             COUNT(*) FILTER (WHERE ${SQL_IS_PENDING} AND "createdAt" < ${unknownBefore})::bigint AS unknown,
             COUNT(*) FILTER (WHERE ${SQL_IS_FAILED})::bigint AS failed,
             COUNT(*) FILTER (WHERE ${SQL_IS_SENT} AND "broadcastId" IS NULL)::bigint AS direct,
             SUM("costUsd")::text AS spend,
             COUNT(*) FILTER (WHERE ${SQL_IS_SENT} AND "costUsd" IS NULL)::bigint AS unpriced
        FROM "MessagingMessage"
       WHERE direction = 'OUTBOUND' AND "createdAt" >= ${range.from} AND "createdAt" < ${range.to}`,
    prisma.$queryRaw<Array<{ replies: bigint; repliers: bigint; optouts: bigint }>>`
      SELECT COUNT(*) FILTER (WHERE NOT "isStopKeyword")::bigint AS replies,
             COUNT(DISTINCT "fromNumber") FILTER (WHERE NOT "isStopKeyword")::bigint AS repliers,
             COUNT(*) FILTER (WHERE "isStopKeyword")::bigint AS optouts
        FROM "MessagingMessage"
       WHERE direction = 'INBOUND' AND "createdAt" >= ${range.from} AND "createdAt" < ${range.to}`,
    prisma.messagingContact.count({ where: { createdAt: within } }),
    prisma.application.count({ where: { createdAt: within, deletedAt: null } }),
  ]);
  const o = outbound[0];
  const i = inbound[0];
  return {
    campaigns: broadcasts._count._all,
    recipients: broadcasts._sum.totalRecipients ?? 0,
    sent: Number(o?.sent ?? 0),
    delivered: Number(o?.delivered ?? 0),
    undeliverable: Number(o?.undeliverable ?? 0),
    pending: Number(o?.pending ?? 0),
    unknown: Number(o?.unknown ?? 0),
    failed: Number(o?.failed ?? 0),
    directSent: Number(o?.direct ?? 0),
    replies: Number(i?.replies ?? 0),
    repliers: Number(i?.repliers ?? 0),
    optOuts: Number(i?.optouts ?? 0),
    leadsImported: leads,
    applications,
    spend: Math.round(Number(o?.spend ?? 0) * 100) / 100,
    unpriced: Number(o?.unpriced ?? 0),
  };
}

/** Every day in the range, in the reporting timezone, as YYYY-MM-DD. */
function daysIn(range: ReportRange): string[] {
  const out = new Set<string>();
  for (let t = range.from.getTime(); t < range.to.getTime(); t += DAY_MS / 2) out.add(zonedDay(new Date(t)));
  return [...out].sort();
}

export async function buildReportDashboard(range: ReportRange) {
  const span = range.to.getTime() - range.from.getTime();
  const previous: ReportRange = { from: new Date(range.from.getTime() - span), to: range.from };

  const [current, prior] = await Promise.all([kpisFor(range), kpisFor(previous)]);

  // Daily trend (Eastern), messages and applications.
  const [dailyMessages, dailyApps] = await Promise.all([
    prisma.$queryRaw<
      Array<{ day: string; sent: bigint; delivered: bigint; undeliverable: bigint; failed: bigint; replies: bigint; optouts: bigint }>
    >`
      SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${REPORT_TIMEZONE}, 'YYYY-MM-DD') AS day,
             COUNT(*) FILTER (WHERE direction = 'OUTBOUND' AND ${SQL_IS_SENT})::bigint AS sent,
             COUNT(*) FILTER (WHERE direction = 'OUTBOUND' AND ${SQL_IS_DELIVERED})::bigint AS delivered,
             COUNT(*) FILTER (WHERE direction = 'OUTBOUND' AND ${SQL_IS_UNDELIVERABLE})::bigint AS undeliverable,
             COUNT(*) FILTER (WHERE direction = 'OUTBOUND' AND ${SQL_IS_FAILED})::bigint AS failed,
             COUNT(*) FILTER (WHERE direction = 'INBOUND' AND NOT "isStopKeyword")::bigint AS replies,
             COUNT(*) FILTER (WHERE direction = 'INBOUND' AND "isStopKeyword")::bigint AS optouts
        FROM "MessagingMessage"
       WHERE "createdAt" >= ${range.from} AND "createdAt" < ${range.to}
       GROUP BY 1`,
    prisma.$queryRaw<Array<{ day: string; n: bigint }>>`
      SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${REPORT_TIMEZONE}, 'YYYY-MM-DD') AS day, COUNT(*)::bigint AS n
        FROM "Application"
       WHERE "deletedAt" IS NULL AND "createdAt" >= ${range.from} AND "createdAt" < ${range.to}
       GROUP BY 1`,
  ]);
  const msgByDay = new Map(dailyMessages.map((r) => [r.day, r]));
  const appsByDay = new Map(dailyApps.map((r) => [r.day, Number(r.n)]));
  const daily = daysIn(range).map((day) => {
    const m = msgByDay.get(day);
    return {
      day,
      sent: Number(m?.sent ?? 0),
      delivered: Number(m?.delivered ?? 0),
      undeliverable: Number(m?.undeliverable ?? 0),
      failed: Number(m?.failed ?? 0),
      replies: Number(m?.replies ?? 0),
      optOuts: Number(m?.optouts ?? 0),
      applications: appsByDay.get(day) ?? 0,
    };
  });

  // Campaign performance, with cost from the message rows.
  const broadcasts = await prisma.smsBroadcast.findMany({
    where: { createdAt: { gte: range.from, lt: range.to } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      status: true,
      createdAt: true,
      totalRecipients: true,
      sentCount: true,
      deliveredCount: true,
      failedCount: true,
      undeliverableCount: true,
      suppressedCount: true,
      repliedCount: true,
      optOutCount: true,
      startedAt: true,
      finishedAt: true,
      createdBy: { select: { firstName: true, lastName: true } },
    },
  });
  const costRows = broadcasts.length
    ? await prisma.messagingMessage.groupBy({
        by: ['broadcastId'],
        where: { broadcastId: { in: broadcasts.map((b) => b.id) }, direction: 'OUTBOUND', providerMessageId: { not: null } },
        _sum: { costUsd: true, segmentCount: true },
      })
    : [];
  const costBy = new Map(costRows.map((r) => [r.broadcastId, r]));
  const campaigns = broadcasts.map((b) => {
    const cost = costBy.get(b.id);
    return {
      id: b.id,
      name: b.name,
      status: b.status,
      createdAt: b.createdAt,
      createdBy: b.createdBy ? `${b.createdBy.firstName ?? ''} ${b.createdBy.lastName ?? ''}`.trim() : null,
      recipients: b.totalRecipients,
      sent: b.sentCount,
      delivered: b.deliveredCount,
      undeliverable: b.undeliverableCount,
      pending: Math.max(0, b.sentCount - b.deliveredCount - b.undeliverableCount),
      failed: b.failedCount,
      suppressed: b.suppressedCount,
      replied: b.repliedCount,
      optOuts: b.optOutCount,
      deliveryRate: pct(b.deliveredCount, b.sentCount),
      replyRate: pct(b.repliedCount, b.deliveredCount),
      optOutRate: pct(b.optOutCount, b.sentCount),
      cost: cost?._sum.costUsd != null ? Math.round(Number(cost._sum.costUsd) * 100) / 100 : null,
      segments: cost?._sum.segmentCount ?? null,
      durationMinutes:
        b.startedAt && b.finishedAt ? Math.max(0, Math.round((b.finishedAt.getTime() - b.startedAt.getTime()) / 60_000)) : null,
    };
  });

  // Agents: reuse the export's per-user rows, keep anyone with activity.
  const agentRows = (await agentSheet(range))[0][1];
  const agents = agentRows
    .map((r) => ({
      name: String(r['User'] ?? ''),
      role: String(r['Role'] ?? ''),
      leadsOwned: Number(r['Leads Owned'] ?? 0),
      interested: Number(r['Leads Interested'] ?? 0),
      notInterested: Number(r['Leads Not Interested'] ?? 0),
      broadcasts: Number(r['Broadcasts Created'] ?? 0),
      broadcastSent: Number(r['Broadcast Messages Sent'] ?? 0),
      directSent: Number(r['Direct Messages Sent'] ?? 0),
      replies: Number(r['Replies Received'] ?? 0),
      replyRate: (r['Reply Rate %'] as number | null) ?? null,
      optOuts: Number(r['Opt-outs'] ?? 0),
      conversations: Number(r['Active Conversations'] ?? 0),
    }))
    .filter((a) => a.leadsOwned + a.broadcastSent + a.directSent + a.replies + a.broadcasts > 0)
    .sort((a, b) => b.replies - a.replies || b.broadcastSent + b.directSent - (a.broadcastSent + a.directSent));

  // Lead pipeline health (all leads, not just this period) and opt-outs on file.
  const [dispositions, blocked, optedOutLeads, totalLeads, batches] = await Promise.all([
    prisma.messagingContact.groupBy({ by: ['disposition'], where: { status: 'ACTIVE' }, _count: { _all: true } }),
    prisma.messagingContact.count({ where: { status: 'BLOCKED' } }),
    prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(DISTINCT c."phoneNumber")::bigint AS n FROM "MessagingContact" c
        JOIN "MessagingSuppression" s ON s."phoneNumber" = c."phoneNumber" AND s.active AND s.reason = 'STOP_KEYWORD'`,
    prisma.messagingContact.count(),
    prisma.messagingLeadBatch.count({ where: { createdAt: { gte: range.from, lt: range.to } } }),
  ]);
  const disp = Object.fromEntries(dispositions.map((d) => [d.disposition, d._count._all]));

  // Applications by queue, and requested amount.
  const [byQueue, requested] = await Promise.all([
    prisma.application.groupBy({
      by: ['currentQueue'],
      where: { createdAt: { gte: range.from, lt: range.to }, deletedAt: null },
      _count: { _all: true },
      _sum: { loanAmount: true },
    }),
    prisma.application.aggregate({
      where: { createdAt: { gte: range.from, lt: range.to }, deletedAt: null },
      _sum: { loanAmount: true },
    }),
  ]);

  // Provider-currency total, shown beside the USD figure for reconciliation.
  const providerTotals = await prisma.messagingMessage.groupBy({
    by: ['priceCurrency'],
    where: { createdAt: { gte: range.from, lt: range.to }, direction: 'OUTBOUND', costAmount: { not: null } },
    _sum: { costAmount: true },
  });

  return {
    range: { from: range.from.toISOString(), to: new Date(range.to.getTime() - 1).toISOString() },
    /** Inclusive US Eastern days — use these for labels, not the ISO instants. */
    days: { from: zonedDay(range.from), to: zonedDay(new Date(range.to.getTime() - 1)), timezone: REPORT_TIMEZONE },
    previousRange: { from: previous.from.toISOString(), to: new Date(previous.to.getTime() - 1).toISOString() },
    kpis: current,
    previous: prior,
    rates: {
      delivery: pct(current.delivered, current.sent),
      undeliverable: pct(current.undeliverable, current.sent),
      reply: pct(current.repliers, current.sent),
      optOut: pct(current.optOuts, current.sent),
      // Failed messages were never sent: rate is of attempted (sent + failed).
      failure: pct(current.failed, current.sent + current.failed),
      previousDelivery: pct(prior.delivered, prior.sent),
      previousReply: pct(prior.repliers, prior.sent),
      previousOptOut: pct(prior.optOuts, prior.sent),
    },
    spend: {
      /** USD. */
      total: current.spend,
      currency: 'USD',
      unpriced: current.unpriced,
      providerTotals: providerTotals.map((t) => ({
        currency: t.priceCurrency,
        total: Math.round(Number(t._sum.costAmount ?? 0) * 100) / 100,
      })),
      perDelivered: current.delivered ? Math.round((current.spend / current.delivered) * 1000) / 1000 : null,
      perReplier: current.repliers ? Math.round((current.spend / current.repliers) * 100) / 100 : null,
    },
    daily,
    campaigns,
    agents,
    leads: {
      total: totalLeads,
      importedInPeriod: current.leadsImported,
      batchesInPeriod: batches,
      new: disp.NEW ?? 0,
      interested: disp.INTERESTED ?? 0,
      notInterested: disp.NOT_INTERESTED ?? 0,
      blocked,
      optedOut: Number(optedOutLeads[0]?.n ?? 0),
    },
    applications: {
      total: current.applications,
      requestedAmount: requested._sum.loanAmount ?? 0,
      byQueue: byQueue
        .map((q) => ({ queue: q.currentQueue, count: q._count._all, requested: q._sum.loanAmount ?? 0 }))
        .sort((a, b) => b.count - a.count),
    },
  };
}
