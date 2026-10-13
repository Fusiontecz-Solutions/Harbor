/**
 * Everything known about each broadcast in a period, computed once and shared
 * by the PDF and Excel reports so both always show the same numbers.
 *
 * Counters on SmsBroadcast are kept for comparison, but every breakdown here is
 * derived from the recipient and message rows themselves.
 */
import prisma from '../../config/prismaClient';
import { analyzeSmsText } from '../messaging/smsSegments';
import type { ReportRange } from './harborReport.service';

/** Send windows default to New York; hourly charts use the same clock. */
export const REPORT_TIMEZONE = 'America/New_York';

export interface RecipientDetail {
  phone: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  email: string | null;
  city: string | null;
  state: string | null;
  leadOwner: string | null;
  disposition: string | null;
  recipientStatus: string;
  messageStatus: string | null;
  sentAt: Date | null;
  deliveredAt: Date | null;
  deliverySeconds: number | null;
  segments: number | null;
  price: number | null;
  errorCode: string | null;
  error: string | null;
  suppressedReason: string | null;
  replies: number;
  firstReplyAt: Date | null;
  replySeconds: number | null;
  optedOut: boolean;
}

export interface ReplyDetail {
  from: string;
  contactName: string | null;
  company: string | null;
  leadOwner: string | null;
  text: string | null;
  media: string | null;
  isStop: boolean;
  receivedAt: Date;
  minutesAfterSend: number | null;
}

export interface Breakdown {
  label: string;
  recipients: number;
  delivered: number;
  failed: number;
  replied: number;
  optedOut: number;
  interested: number;
}

export interface BroadcastDetail {
  index: number;
  id: string;
  name: string;
  campaignKey: string;
  status: string;
  body: string;
  media: string[];
  fromNumber: string;
  leadBatch: string | null;
  followUpOf: string | null;
  followUps: string[];
  createdBy: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  throttlePerSecond: number | null;
  createdAt: Date;
  scheduledAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  message: {
    encoding: string;
    characters: number;
    segmentsPerMessage: number;
    mergeFields: string[];
    unicodeTriggers: string[];
  };
  counters: Record<string, number>;
  funnel: {
    recipients: number;
    suppressed: number;
    attempted: number;
    sent: number;
    delivered: number;
    failed: number;
    pending: number;
    stillQueued: number;
    replied: number;
    totalReplies: number;
    optedOut: number;
    interested: number;
    notInterested: number;
  };
  rates: {
    delivery: number | null;
    failure: number | null;
    reply: number | null;
    replyOfDelivered: number | null;
    optOut: number | null;
    interested: number | null;
  };
  cost: {
    segments: number;
    total: number | null;
    currency: string | null;
    perSent: number | null;
    perDelivered: number | null;
    perReply: number | null;
  };
  timing: {
    durationSeconds: number | null;
    firstSentAt: Date | null;
    lastSentAt: Date | null;
    throughputPerMinute: number | null;
    deliveryMedianSeconds: number | null;
    deliveryP90Seconds: number | null;
    replyMedianMinutes: number | null;
    firstReplyAt: Date | null;
    lastReplyAt: Date | null;
  };
  statusBreakdown: Array<{ label: string; count: number }>;
  failureReasons: Array<{ label: string; count: number }>;
  suppressionReasons: Array<{ label: string; count: number }>;
  sendsByHour: number[];
  repliesByHour: number[];
  repliesByDay: Array<{ label: string; count: number }>;
  byOwner: Breakdown[];
  byState: Breakdown[];
  replies: ReplyDetail[];
  recipients: RecipientDetail[];
}

const pct = (part: number, whole: number): number | null =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;

function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
}

const hourFormatter = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: REPORT_TIMEZONE });
const dayFormatter = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: REPORT_TIMEZONE });
const hourOf = (d: Date) => Number(hourFormatter.format(d)) % 24;

function tally(values: Array<string | null | undefined>, fallback = 'Unknown'): Array<{ label: string; count: number }> {
  const map = new Map<string, number>();
  for (const v of values) {
    const key = (v ?? '').trim() || fallback;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}

const FAILED_STATUSES = new Set(['FAILED', 'UNDELIVERABLE', 'REJECTED', 'EXPIRED']);

function breakdown(recipients: RecipientDetail[], keyOf: (r: RecipientDetail) => string): Breakdown[] {
  const map = new Map<string, Breakdown>();
  for (const r of recipients) {
    const label = keyOf(r);
    const row = map.get(label) ?? { label, recipients: 0, delivered: 0, failed: 0, replied: 0, optedOut: 0, interested: 0 };
    row.recipients += 1;
    if (r.messageStatus === 'DELIVERED') row.delivered += 1;
    if (FAILED_STATUSES.has(r.messageStatus ?? '') || r.recipientStatus === 'FAILED') row.failed += 1;
    if (r.replies > 0) row.replied += 1;
    if (r.optedOut) row.optedOut += 1;
    if (r.disposition === 'INTERESTED') row.interested += 1;
    map.set(label, row);
  }
  return [...map.values()].sort((a, b) => b.recipients - a.recipients);
}

export async function collectBroadcastDetails(
  range: ReportRange,
  names: Map<string, string>,
): Promise<BroadcastDetail[]> {
  const broadcasts = await prisma.smsBroadcast.findMany({
    where: { createdAt: { gte: range.from, lt: range.to } },
    orderBy: { createdAt: 'asc' },
  });
  if (broadcasts.length === 0) return [];

  const ids = broadcasts.map((b) => b.id);
  const nameById = new Map(
    (await prisma.smsBroadcast.findMany({ select: { id: true, name: true } })).map((b) => [b.id, b.name]),
  );
  const followUps = await prisma.smsBroadcast.findMany({
    where: { parentBroadcastId: { in: ids } },
    select: { parentBroadcastId: true, name: true },
  });
  const batches = new Map(
    (
      await prisma.messagingLeadBatch.findMany({
        where: { id: { in: broadcasts.map((b) => b.leadBatchId).filter((v): v is string => Boolean(v)) } },
        select: { id: true, name: true },
      })
    ).map((b) => [b.id, b.name]),
  );
  const who = (id: string | null) => (id ? names.get(id) ?? id : null);

  const details: BroadcastDetail[] = [];
  for (const [index, b] of broadcasts.entries()) {
    const [recipientRows, outbound, inbound] = await Promise.all([
      prisma.smsBroadcastRecipient.findMany({
        where: { broadcastId: b.id },
        include: {
          contact: {
            select: { firstName: true, lastName: true, company: true, emailAddress: true, city: true, state: true, ownerUserId: true, disposition: true },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.messagingMessage.findMany({
        where: { broadcastId: b.id, direction: 'OUTBOUND' },
        select: { toNumber: true, status: true, sentAt: true, deliveredAt: true, segmentCount: true, priceAmount: true, priceCurrency: true, errorMessage: true, createdAt: true },
      }),
      prisma.messagingMessage.findMany({
        where: { broadcastId: b.id, direction: 'INBOUND' },
        select: { fromNumber: true, body: true, mediaUrls: true, isStopKeyword: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    // Latest outbound row per number (a retried send can leave older rows).
    const outByNumber = new Map<string, (typeof outbound)[number]>();
    for (const m of outbound) {
      const prev = outByNumber.get(m.toNumber);
      if (!prev || m.createdAt > prev.createdAt) outByNumber.set(m.toNumber, m);
    }
    const repliesByNumber = new Map<string, typeof inbound>();
    for (const r of inbound) {
      const list = repliesByNumber.get(r.fromNumber) ?? [];
      list.push(r);
      repliesByNumber.set(r.fromNumber, list);
    }

    const recipients: RecipientDetail[] = recipientRows.map((r) => {
      const msg = outByNumber.get(r.phoneNumber);
      const replies = repliesByNumber.get(r.phoneNumber) ?? [];
      // The message row's sentAt is when the provider accepted it; the
      // recipient row's is written afterwards (often after delivery), so it
      // would make delivery times negative.
      const sentAt = msg?.sentAt ?? r.sentAt ?? null;
      const deliveredAt = msg?.deliveredAt ?? null;
      const firstReplyAt = replies[0]?.createdAt ?? null;
      const c = r.contact;
      return {
        phone: r.phoneNumber,
        firstName: c?.firstName ?? null,
        lastName: c?.lastName ?? null,
        company: c?.company ?? null,
        email: c?.emailAddress ?? null,
        city: c?.city ?? null,
        state: c?.state ?? null,
        leadOwner: who(c?.ownerUserId ?? null),
        disposition: c?.disposition ?? null,
        recipientStatus: r.status,
        messageStatus: msg?.status ?? null,
        sentAt,
        deliveredAt,
        deliverySeconds: sentAt && deliveredAt ? Math.max(0, Math.round((deliveredAt.getTime() - sentAt.getTime()) / 1000)) : null,
        segments: msg?.segmentCount ?? null,
        price: msg?.priceAmount != null ? Number(msg.priceAmount) : null,
        errorCode: r.errorCode,
        error: r.errorMessage ?? msg?.errorMessage ?? null,
        suppressedReason: r.suppressedReason,
        replies: replies.length,
        firstReplyAt,
        replySeconds: sentAt && firstReplyAt ? Math.max(0, Math.round((firstReplyAt.getTime() - sentAt.getTime()) / 1000)) : null,
        optedOut: replies.some((x) => x.isStopKeyword),
      };
    });
    const recipientByPhone = new Map(recipients.map((r) => [r.phone, r]));

    const sent = recipients.filter((r) => r.sentAt || ['SENT', 'DELIVERED'].includes(r.recipientStatus)).length;
    const delivered = recipients.filter((r) => r.messageStatus === 'DELIVERED').length;
    const failed = recipients.filter((r) => !r.suppressedReason && (FAILED_STATUSES.has(r.messageStatus ?? '') || r.recipientStatus === 'FAILED')).length;
    const suppressed = recipients.filter((r) => r.suppressedReason).length;
    const stillQueued = recipients.filter((r) => ['QUEUED', 'SENDING'].includes(r.recipientStatus)).length;
    const replied = recipients.filter((r) => r.replies > 0).length;
    const optedOut = recipients.filter((r) => r.optedOut).length;
    const interested = recipients.filter((r) => r.disposition === 'INTERESTED').length;
    const notInterested = recipients.filter((r) => r.disposition === 'NOT_INTERESTED').length;
    const pending = Math.max(0, sent - delivered - failed);

    const segments = recipients.reduce((n, r) => n + (r.segments ?? 0), 0);
    const priced = recipients.filter((r) => r.price != null);
    const totalCost = priced.length ? Math.round(priced.reduce((n, r) => n + (r.price ?? 0), 0) * 10_000) / 10_000 : null;
    const perUnit = (n: number) => (totalCost != null && n > 0 ? Math.round((totalCost / n) * 10_000) / 10_000 : null);

    const sentTimes = recipients.map((r) => r.sentAt).filter((d): d is Date => Boolean(d)).sort((a, x) => a.getTime() - x.getTime());
    const firstSentAt = sentTimes[0] ?? null;
    const lastSentAt = sentTimes[sentTimes.length - 1] ?? null;
    const spanStart = b.startedAt ?? firstSentAt;
    const spanEnd = b.finishedAt ?? lastSentAt;
    const durationSeconds = spanStart && spanEnd ? Math.max(0, Math.round((spanEnd.getTime() - spanStart.getTime()) / 1000)) : null;

    const sendsByHour = Array.from({ length: 24 }, () => 0);
    for (const d of sentTimes) sendsByHour[hourOf(d)] += 1;
    const repliesByHour = Array.from({ length: 24 }, () => 0);
    for (const r of inbound) repliesByHour[hourOf(r.createdAt)] += 1;

    const analysis = analyzeSmsText(b.body ?? '');
    const mergeFields = [...new Set([...(b.body ?? '').matchAll(/\{\{?\s*([\w.]+)\s*\}?\}/g)].map((m) => m[1]))];

    details.push({
      index: index + 1,
      id: b.id,
      name: b.name,
      campaignKey: b.campaignKey,
      status: b.status,
      body: b.body,
      media: b.mediaUrls,
      fromNumber: b.fromNumber,
      leadBatch: b.leadBatchId ? batches.get(b.leadBatchId) ?? b.leadBatchId : null,
      followUpOf: b.parentBroadcastId ? nameById.get(b.parentBroadcastId) ?? b.parentBroadcastId : null,
      followUps: followUps.filter((f) => f.parentBroadcastId === b.id).map((f) => f.name),
      createdBy: who(b.createdById),
      approvedBy: who(b.approvedById),
      approvedAt: b.approvedAt,
      throttlePerSecond: b.throttlePerSecond,
      createdAt: b.createdAt,
      scheduledAt: b.scheduledAt,
      startedAt: b.startedAt,
      finishedAt: b.finishedAt,
      message: {
        encoding: analysis.encodingLabel,
        characters: analysis.characters,
        segmentsPerMessage: analysis.segments,
        mergeFields,
        unicodeTriggers: analysis.unicodeTriggers,
      },
      counters: {
        totalRecipients: b.totalRecipients,
        queued: b.queuedCount,
        sent: b.sentCount,
        delivered: b.deliveredCount,
        failed: b.failedCount,
        undeliverable: b.undeliverableCount,
        suppressed: b.suppressedCount,
        replied: b.repliedCount,
        optedOut: b.optOutCount,
      },
      funnel: {
        recipients: recipients.length,
        suppressed,
        attempted: recipients.length - suppressed,
        sent,
        delivered,
        failed,
        pending,
        stillQueued,
        replied,
        totalReplies: inbound.length,
        optedOut,
        interested,
        notInterested,
      },
      rates: {
        delivery: pct(delivered, sent),
        failure: pct(failed, sent),
        reply: pct(replied, sent),
        replyOfDelivered: pct(replied, delivered),
        optOut: pct(optedOut, sent),
        interested: pct(interested, replied),
      },
      cost: {
        segments,
        total: totalCost,
        currency: priced.length ? outbound.find((m) => m.priceCurrency)?.priceCurrency ?? null : null,
        perSent: perUnit(sent),
        perDelivered: perUnit(delivered),
        perReply: perUnit(replied),
      },
      timing: {
        durationSeconds,
        firstSentAt,
        lastSentAt,
        throughputPerMinute: durationSeconds && durationSeconds > 0 ? Math.round((sent / durationSeconds) * 60 * 10) / 10 : null,
        deliveryMedianSeconds: quantile(recipients.map((r) => r.deliverySeconds).filter((v): v is number => v != null), 0.5),
        deliveryP90Seconds: quantile(recipients.map((r) => r.deliverySeconds).filter((v): v is number => v != null), 0.9),
        replyMedianMinutes: (() => {
          const s = quantile(recipients.map((r) => r.replySeconds).filter((v): v is number => v != null), 0.5);
          return s == null ? null : Math.round(s / 60);
        })(),
        firstReplyAt: inbound[0]?.createdAt ?? null,
        lastReplyAt: inbound[inbound.length - 1]?.createdAt ?? null,
      },
      statusBreakdown: tally(recipients.map((r) => (r.suppressedReason ? 'SUPPRESSED' : r.messageStatus ?? r.recipientStatus))),
      failureReasons: tally(
        recipients
          .filter((r) => !r.suppressedReason && (FAILED_STATUSES.has(r.messageStatus ?? '') || r.recipientStatus === 'FAILED'))
          .map((r) => [r.errorCode, r.error].filter(Boolean).join(' — ') || null),
        'No reason recorded',
      ),
      suppressionReasons: tally(recipients.filter((r) => r.suppressedReason).map((r) => r.suppressedReason)),
      sendsByHour,
      repliesByHour,
      repliesByDay: tally(inbound.map((r) => dayFormatter.format(r.createdAt))).sort((a, x) => a.label.localeCompare(x.label)),
      byOwner: breakdown(recipients, (r) => r.leadOwner ?? 'Unassigned'),
      byState: breakdown(recipients, (r) => (r.state ?? '').trim().toUpperCase() || 'Unknown'),
      replies: inbound.map((r) => {
        const rec = recipientByPhone.get(r.fromNumber);
        return {
          from: r.fromNumber,
          contactName: rec ? `${rec.firstName ?? ''} ${rec.lastName ?? ''}`.trim() || null : null,
          company: rec?.company ?? null,
          leadOwner: rec?.leadOwner ?? null,
          text: r.body,
          media: r.mediaUrls.join(', ') || null,
          isStop: r.isStopKeyword,
          receivedAt: r.createdAt,
          minutesAfterSend: rec?.sentAt ? Math.max(0, Math.round((r.createdAt.getTime() - rec.sentAt.getTime()) / 60_000)) : null,
        };
      }),
      recipients,
    });
  }
  return details;
}
