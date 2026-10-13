/**
 * Harbor Reports — on-screen summary and the Excel export behind it.
 *
 * Four sections, each selectable on its own:
 *   - broadcasts    one row per campaign, every recipient, every reply (with text)
 *   - inbox         conversations and messages
 *   - agents        per-user lead and messaging performance
 *   - applications  the CRM deal pipeline
 *
 * Everything is scoped to a [from, to) date range. Owner SSN and date of birth
 * are deliberately never exported.
 */
import * as XLSX from 'xlsx';
import prisma from '../../config/prismaClient';
import { collectBroadcastDetails, type BroadcastDetail } from './broadcastDetail.service';
import { renderReportPdf } from './harborReportPdf.service';

export const REPORT_SECTIONS = ['broadcasts', 'inbox', 'agents', 'applications'] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

export interface ReportRange {
  from: Date;
  to: Date;
}

/** Excel tops out at 1,048,576 rows; stay well clear and say so when cut. */
const MAX_SHEET_ROWS = 200_000;
/** Rows fetched per query when paging large tables. */
const PAGE = 5_000;

type Row = Record<string, string | number | boolean | Date | null>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** `from` / `to` are YYYY-MM-DD (inclusive). Defaults to the last 30 days. */
export function parseReportRange(fromRaw: unknown, toRaw: unknown): ReportRange {
  const parse = (v: unknown): Date | null => {
    const s = String(v ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const d = new Date(`${s}T00:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const toDay = parse(toRaw) ?? new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
  const from = parse(fromRaw) ?? new Date(toDay.getTime() - 29 * DAY_MS);
  // Inclusive end date → exclusive bound at the start of the next day.
  const to = new Date(toDay.getTime() + DAY_MS);
  if (from >= to) throw Object.assign(new Error('"from" must be on or before "to"'), { statusCode: 400 });
  return { from, to };
}

export function parseSections(raw: unknown): ReportSection[] {
  const wanted = String(raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (wanted.length === 0) return [...REPORT_SECTIONS];
  const valid = wanted.filter((s): s is ReportSection => (REPORT_SECTIONS as readonly string[]).includes(s));
  if (valid.length === 0) throw Object.assign(new Error('No valid report sections requested'), { statusCode: 400 });
  return [...new Set(valid)];
}

const inRange = (range: ReportRange) => ({ gte: range.from, lt: range.to });
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const pct = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

export async function userNames(): Promise<Map<string, string>> {
  const users = await prisma.user.findMany({ select: { id: true, firstName: true, lastName: true, email: true } });
  return new Map(users.map((u) => [u.id, `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email]));
}

/** Page through a table by id so very large exports never load in one query. */
async function pageAll<T extends { id: string }>(fetch: (cursor: string | null) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await fetch(cursor);
    out.push(...page);
    if (page.length < PAGE || out.length >= MAX_SHEET_ROWS) break;
    cursor = page[page.length - 1].id;
  }
  return out.slice(0, MAX_SHEET_ROWS);
}

const cursorArgs = (cursor: string | null) => ({
  take: PAGE,
  orderBy: { id: 'asc' as const },
  ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
});

/* ============================================================================
 * Summary (on-screen cards)
 * ==========================================================================*/

export async function buildReportSummary(range: ReportRange) {
  const [broadcastAgg, broadcastCount, inbound, outbound, optOuts, conversations, applications, leads] =
    await Promise.all([
      prisma.smsBroadcast.aggregate({
        where: { createdAt: inRange(range) },
        _sum: {
          totalRecipients: true,
          sentCount: true,
          deliveredCount: true,
          failedCount: true,
          undeliverableCount: true,
          repliedCount: true,
          optOutCount: true,
          suppressedCount: true,
        },
      }),
      prisma.smsBroadcast.count({ where: { createdAt: inRange(range) } }),
      prisma.messagingMessage.count({ where: { direction: 'INBOUND', createdAt: inRange(range) } }),
      prisma.messagingMessage.count({ where: { direction: 'OUTBOUND', createdAt: inRange(range) } }),
      prisma.messagingMessage.count({ where: { direction: 'INBOUND', isStopKeyword: true, createdAt: inRange(range) } }),
      prisma.messagingConversation.count({ where: { lastMessageAt: inRange(range) } }),
      prisma.application.groupBy({
        by: ['currentQueue'],
        where: { createdAt: inRange(range), deletedAt: null },
        _count: { _all: true },
      }),
      prisma.messagingContact.count({ where: { createdAt: inRange(range) } }),
    ]);

  const s = broadcastAgg._sum;
  const sent = s.sentCount ?? 0;
  return {
    range: { from: range.from.toISOString(), to: new Date(range.to.getTime() - 1).toISOString() },
    broadcasts: {
      campaigns: broadcastCount,
      recipients: s.totalRecipients ?? 0,
      sent,
      delivered: s.deliveredCount ?? 0,
      failed: (s.failedCount ?? 0) + (s.undeliverableCount ?? 0),
      suppressed: s.suppressedCount ?? 0,
      replied: s.repliedCount ?? 0,
      optedOut: s.optOutCount ?? 0,
      deliveryRate: pct(s.deliveredCount ?? 0, sent),
      replyRate: pct(s.repliedCount ?? 0, sent),
    },
    inbox: { activeConversations: conversations, messagesSent: outbound, messagesReceived: inbound, optOuts },
    leads: { imported: leads },
    applications: {
      total: applications.reduce((n, g) => n + g._count._all, 0),
      byQueue: applications
        .map((g) => ({ queue: g.currentQueue, count: g._count._all }))
        .sort((a, b) => b.count - a.count),
    },
  };
}

/* ============================================================================
 * Sheets
 * ==========================================================================*/

async function broadcastSheets(range: ReportRange, names: Map<string, string>): Promise<Array<[string, Row[]]>> {
  const broadcasts = await prisma.smsBroadcast.findMany({
    where: { createdAt: inRange(range) },
    orderBy: { createdAt: 'desc' },
  });
  const ids = broadcasts.map((b) => b.id);
  const byId = new Map(broadcasts.map((b) => [b.id, b]));
  const batches = await prisma.messagingLeadBatch.findMany({
    where: { id: { in: broadcasts.map((b) => b.leadBatchId).filter((v): v is string => Boolean(v)) } },
    select: { id: true, name: true },
  });
  const batchName = new Map(batches.map((b) => [b.id, b.name]));

  const summary: Row[] = broadcasts.map((b) => ({
    'Campaign': b.name,
    'Campaign Key': b.campaignKey,
    'Status': b.status,
    'Message': b.body,
    'Media URLs': b.mediaUrls.join(', ') || null,
    'From Number': b.fromNumber,
    'Lead Batch': b.leadBatchId ? batchName.get(b.leadBatchId) ?? b.leadBatchId : null,
    'Follow-up Of': b.parentBroadcastId ? byId.get(b.parentBroadcastId)?.name ?? b.parentBroadcastId : null,
    'Created By': b.createdById ? names.get(b.createdById) ?? b.createdById : null,
    'Approved By': b.approvedById ? names.get(b.approvedById) ?? b.approvedById : null,
    'Approved At': b.approvedAt,
    'Throttle / sec': b.throttlePerSecond,
    'Scheduled At': b.scheduledAt,
    'Started At': b.startedAt,
    'Finished At': b.finishedAt,
    'Created At': b.createdAt,
    'Total Recipients': b.totalRecipients,
    'Queued': b.queuedCount,
    'Sent': b.sentCount,
    'Delivered': b.deliveredCount,
    'Failed': b.failedCount,
    'Undeliverable': b.undeliverableCount,
    'Suppressed': b.suppressedCount,
    'Replied': b.repliedCount,
    'Opted Out': b.optOutCount,
    'Delivery Rate %': pct(b.deliveredCount, b.sentCount),
    'Reply Rate %': pct(b.repliedCount, b.sentCount),
    'Opt-out Rate %': pct(b.optOutCount, b.sentCount),
  }));

  if (ids.length === 0) return [['Broadcasts', summary], ['Broadcast Recipients', []], ['Broadcast Replies', []]];

  // Replies: every inbound message attributed to these campaigns, with text.
  const replies = await pageAll((cursor) =>
    prisma.messagingMessage.findMany({
      where: { broadcastId: { in: ids }, direction: 'INBOUND' },
      select: { id: true, broadcastId: true, fromNumber: true, toNumber: true, body: true, mediaUrls: true, isStopKeyword: true, createdAt: true },
      ...cursorArgs(cursor),
    }),
  );
  const repliedKey = new Set(replies.map((r) => `${r.broadcastId}|${r.fromNumber}`));
  const optedKey = new Set(replies.filter((r) => r.isStopKeyword).map((r) => `${r.broadcastId}|${r.fromNumber}`));
  const firstReplyAt = new Map<string, Date>();
  for (const r of replies) {
    const k = `${r.broadcastId}|${r.fromNumber}`;
    const prev = firstReplyAt.get(k);
    if (!prev || r.createdAt < prev) firstReplyAt.set(k, r.createdAt);
  }

  // Delivery outcome per recipient comes from the outbound message row.
  const outbound = await pageAll((cursor) =>
    prisma.messagingMessage.findMany({
      where: { broadcastId: { in: ids }, direction: 'OUTBOUND' },
      select: { id: true, broadcastId: true, toNumber: true, status: true, deliveredAt: true, segmentCount: true, priceAmount: true, priceCurrency: true, errorMessage: true },
      ...cursorArgs(cursor),
    }),
  );
  const outboundByKey = new Map(outbound.map((m) => [`${m.broadcastId}|${m.toNumber}`, m]));

  const recipients = await pageAll((cursor) =>
    prisma.smsBroadcastRecipient.findMany({
      where: { broadcastId: { in: ids } },
      include: { contact: { select: { firstName: true, lastName: true, company: true, emailAddress: true, city: true, state: true, ownerUserId: true, disposition: true } } },
      ...cursorArgs(cursor),
    }),
  );

  const recipientRows: Row[] = recipients.map((r) => {
    const key = `${r.broadcastId}|${r.phoneNumber}`;
    const msg = outboundByKey.get(key);
    const c = r.contact;
    return {
      'Campaign': byId.get(r.broadcastId)?.name ?? r.broadcastId,
      'Phone': r.phoneNumber,
      'First Name': c?.firstName ?? null,
      'Last Name': c?.lastName ?? null,
      'Company': c?.company ?? null,
      'Email': c?.emailAddress ?? null,
      'City': c?.city ?? null,
      'State': c?.state ?? null,
      'Lead Owner': c?.ownerUserId ? names.get(c.ownerUserId) ?? c.ownerUserId : null,
      'Disposition': c?.disposition ?? null,
      'Recipient Status': r.status,
      'Message Status': msg?.status ?? null,
      'Sent At': r.sentAt,
      'Delivered At': msg?.deliveredAt ?? null,
      'Segments': msg?.segmentCount ?? null,
      'Price': num(msg?.priceAmount),
      'Currency': msg?.priceCurrency ?? null,
      'Error Code': r.errorCode,
      'Error': r.errorMessage ?? msg?.errorMessage ?? null,
      'Suppressed Reason': r.suppressedReason,
      'Replied': repliedKey.has(key),
      'First Reply At': firstReplyAt.get(key) ?? null,
      'Opted Out': optedKey.has(key),
      'Provider Message Id': r.providerMessageId,
    };
  });

  const replyRows: Row[] = replies
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((r) => ({
      'Campaign': r.broadcastId ? byId.get(r.broadcastId)?.name ?? r.broadcastId : null,
      'From (Contact)': r.fromNumber,
      'To (Our Number)': r.toNumber,
      'Reply Text': r.body,
      'Media URLs': r.mediaUrls.join(', ') || null,
      'Is STOP': r.isStopKeyword,
      'Received At': r.createdAt,
    }));

  return [
    ['Broadcasts', summary],
    ['Broadcast Recipients', recipientRows],
    ['Broadcast Replies', replyRows],
  ];
}

async function inboxSheets(range: ReportRange, names: Map<string, string>): Promise<Array<[string, Row[]]>> {
  const conversations = await pageAll((cursor) =>
    prisma.messagingConversation.findMany({
      where: { lastMessageAt: inRange(range) },
      include: { contact: { select: { firstName: true, lastName: true, company: true, status: true, disposition: true } } },
      ...cursorArgs(cursor),
    }),
  );
  const convRows: Row[] = conversations
    .sort((a, b) => (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0))
    .map((c) => ({
      'Contact Number': c.contactNumber,
      'Contact Name': `${c.contact?.firstName ?? ''} ${c.contact?.lastName ?? ''}`.trim() || null,
      'Company': c.contact?.company ?? null,
      'Our Number': c.businessNumber,
      'Owner': c.ownerUserId ? names.get(c.ownerUserId) ?? c.ownerUserId : null,
      'Messages': c.messageCount,
      'Unread': c.unreadCount,
      'Has Broadcast': c.hasBroadcastMessage,
      'Has Reply': c.hasInboundReply,
      'Opted Out': c.isOptedOut,
      'Blocked': c.contact?.status === 'BLOCKED',
      'Disposition': c.contact?.disposition ?? null,
      'Archived': c.isArchived,
      'Last Message': c.lastMessageText,
      'Last Direction': c.lastMessageDirection,
      'Last Message At': c.lastMessageAt,
      'Started At': c.createdAt,
    }));

  const broadcastNames = new Map(
    (await prisma.smsBroadcast.findMany({ select: { id: true, name: true } })).map((b) => [b.id, b.name]),
  );
  const messages = await pageAll((cursor) =>
    prisma.messagingMessage.findMany({
      where: { createdAt: inRange(range) },
      ...cursorArgs(cursor),
    }),
  );
  const messageRows: Row[] = messages
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((m) => ({
      'Created At': m.createdAt,
      'Direction': m.direction,
      'From': m.fromNumber,
      'To': m.toNumber,
      'Text': m.body,
      'Media URLs': m.mediaUrls.join(', ') || null,
      'Status': m.status,
      'Campaign': m.broadcastId ? broadcastNames.get(m.broadcastId) ?? m.broadcastId : null,
      'Sent By': m.sentById ? names.get(m.sentById) ?? m.sentById : null,
      'Is STOP': m.isStopKeyword,
      'Segments': m.segmentCount,
      'Price': num(m.priceAmount),
      'Currency': m.priceCurrency,
      'Sent At': m.sentAt,
      'Delivered At': m.deliveredAt,
      'Error Code': m.errorCode,
      'Error': m.errorMessage,
    }));

  return [
    ['Conversations', convRows],
    ['Messages', messageRows],
  ];
}

export async function agentSheet(range: ReportRange): Promise<Array<[string, Row[]]>> {
  const users = await prisma.user.findMany({
    select: { id: true, firstName: true, lastName: true, email: true, role: true, isActive: true },
    orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
  });

  const [leads, dispositions, convs, sent, broadcastSent, received, optOuts, campaigns] = await Promise.all([
    prisma.messagingContact.groupBy({ by: ['ownerUserId'], _count: { _all: true } }),
    prisma.messagingContact.groupBy({ by: ['ownerUserId', 'disposition'], _count: { _all: true } }),
    prisma.messagingConversation.groupBy({ by: ['ownerUserId'], where: { lastMessageAt: inRange(range) }, _count: { _all: true } }),
    prisma.messagingMessage.groupBy({ by: ['sentById'], where: { direction: 'OUTBOUND', broadcastId: null, createdAt: inRange(range) }, _count: { _all: true } }),
    prisma.messagingMessage.groupBy({ by: ['sentById'], where: { direction: 'OUTBOUND', broadcastId: { not: null }, createdAt: inRange(range) }, _count: { _all: true } }),
    prisma.$queryRaw<Array<{ ownerUserId: string | null; n: bigint }>>`
      SELECT c."ownerUserId", COUNT(*)::bigint AS n FROM "MessagingMessage" m
        JOIN "MessagingConversation" c ON c.id = m."conversationId"
       WHERE m.direction = 'INBOUND' AND m."createdAt" >= ${range.from} AND m."createdAt" < ${range.to}
       GROUP BY c."ownerUserId"`,
    prisma.$queryRaw<Array<{ ownerUserId: string | null; n: bigint }>>`
      SELECT c."ownerUserId", COUNT(*)::bigint AS n FROM "MessagingMessage" m
        JOIN "MessagingConversation" c ON c.id = m."conversationId"
       WHERE m.direction = 'INBOUND' AND m."isStopKeyword" = true AND m."createdAt" >= ${range.from} AND m."createdAt" < ${range.to}
       GROUP BY c."ownerUserId"`,
    prisma.smsBroadcast.groupBy({ by: ['createdById'], where: { createdAt: inRange(range) }, _count: { _all: true } }),
  ]);

  const countMap = <K extends string>(rows: Array<Record<K, string | null> & { _count: { _all: number } }>, key: K) =>
    new Map(rows.map((r) => [r[key] ?? '', r._count._all]));
  const leadsBy = countMap(leads, 'ownerUserId');
  const convsBy = countMap(convs, 'ownerUserId');
  const sentBy = countMap(sent, 'sentById');
  const bSentBy = countMap(broadcastSent, 'sentById');
  const campaignsBy = countMap(campaigns, 'createdById');
  const receivedBy = new Map(received.map((r) => [r.ownerUserId ?? '', Number(r.n)]));
  const optOutBy = new Map(optOuts.map((r) => [r.ownerUserId ?? '', Number(r.n)]));
  const disp = new Map<string, number>();
  for (const d of dispositions) disp.set(`${d.ownerUserId ?? ''}|${d.disposition}`, d._count._all);

  const rows: Row[] = users.map((u) => {
    const replies = receivedBy.get(u.id) ?? 0;
    const totalSent = (sentBy.get(u.id) ?? 0) + (bSentBy.get(u.id) ?? 0);
    return {
      'User': `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email,
      'Email': u.email,
      'Role': u.role,
      'Active': u.isActive,
      'Leads Owned': leadsBy.get(u.id) ?? 0,
      'Leads New': disp.get(`${u.id}|NEW`) ?? 0,
      'Leads Interested': disp.get(`${u.id}|INTERESTED`) ?? 0,
      'Leads Not Interested': disp.get(`${u.id}|NOT_INTERESTED`) ?? 0,
      'Broadcasts Created': campaignsBy.get(u.id) ?? 0,
      'Broadcast Messages Sent': bSentBy.get(u.id) ?? 0,
      'Direct Messages Sent': sentBy.get(u.id) ?? 0,
      'Replies Received': replies,
      'Reply Rate %': pct(replies, totalSent),
      'Opt-outs': optOutBy.get(u.id) ?? 0,
      'Active Conversations': convsBy.get(u.id) ?? 0,
    };
  });
  return [['Agent Performance', rows]];
}

export async function applicationSheet(range: ReportRange, names: Map<string, string>): Promise<Array<[string, Row[]]>> {
  const apps = await pageAll((cursor) =>
    prisma.application.findMany({
      where: { createdAt: inRange(range), deletedAt: null },
      select: {
        id: true,
        applicationId: true,
        type: true,
        priority: true,
        currentQueue: true,
        currentState: true,
        status: true,
        category: true,
        loanAmount: true,
        dealDisplayName: true,
        salesRepresentativeId: true,
        createdById: true,
        assignedUnderwriterId: true,
        approvedByUnderwriterId: true,
        approvedAt: true,
        underwriterAction: true,
        scrubberRecommendation: true,
        commissionPercentage: true,
        commissionAmount: true,
        brokerName: true,
        createdAt: true,
        updatedAt: true,
        client: {
          select: {
            businessName: true,
            businessEmail: true,
            businessNumber: true,
            businessState: true,
            ownerFirstName: true,
            ownerLastName: true,
            ownerEmail: true,
            ownerMobileNumber: true,
            ownerFicoScore: true,
          },
        },
        OfferDecision: {
          select: { decision: true, offer: true, rate: true, term: true, frequency: true, position: true, totalRemit: true, declineReason: true },
        },
      },
      ...cursorArgs(cursor),
    }),
  );

  const who = (id: string | null) => (id ? names.get(id) ?? id : null);
  const rows: Row[] = apps
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((a) => ({
      'Application #': a.applicationId,
      'Deal': a.dealDisplayName,
      'Business': a.client?.businessName ?? null,
      'Owner': `${a.client?.ownerFirstName ?? ''} ${a.client?.ownerLastName ?? ''}`.trim() || null,
      'Owner Email': a.client?.ownerEmail ?? null,
      'Owner Phone': a.client?.ownerMobileNumber ?? null,
      'FICO': a.client?.ownerFicoScore ?? null,
      'Business Email': a.client?.businessEmail ?? null,
      'Business Phone': a.client?.businessNumber ?? null,
      'State': a.client?.businessState ?? null,
      'Type': a.type,
      'Priority': a.priority,
      'Queue': a.currentQueue,
      'State (Workflow)': a.currentState,
      'Status': a.status,
      'Category': a.category,
      'Requested Amount': a.loanAmount,
      'Offer Decision': a.OfferDecision?.decision ?? null,
      'Offer Amount': num(a.OfferDecision?.offer),
      'Rate': num(a.OfferDecision?.rate),
      'Term': a.OfferDecision?.term ?? null,
      'Frequency': a.OfferDecision?.frequency ?? null,
      'Position': a.OfferDecision?.position ?? null,
      'Total Remit': num(a.OfferDecision?.totalRemit),
      'Decline Reason': a.OfferDecision?.declineReason ?? null,
      'Scrubber Recommendation': a.scrubberRecommendation,
      'Underwriter Action': a.underwriterAction,
      'Sales Rep': who(a.salesRepresentativeId),
      'Created By': who(a.createdById),
      'Assigned Underwriter': who(a.assignedUnderwriterId),
      'Approved By': who(a.approvedByUnderwriterId),
      'Approved At': a.approvedAt,
      'Commission %': a.commissionPercentage,
      'Commission Amount': a.commissionAmount,
      'Broker': a.brokerName,
      'Created At': a.createdAt,
      'Updated At': a.updatedAt,
    }));
  return [['Applications', rows]];
}

/* ============================================================================
 * One sheet per broadcast
 * ==========================================================================*/

type Cell = string | number | boolean | Date | null;

/** Everything about one campaign, stacked as labelled blocks on its own sheet. */
function broadcastDetailSheet(b: BroadcastDetail): XLSX.WorkSheet {
  const aoa: Cell[][] = [];
  const blank = () => aoa.push([]);
  const title = (t: string) => {
    blank();
    aoa.push([t.toUpperCase()]);
  };
  const kv = (rows: Array<[string, Cell]>) => rows.forEach(([k, v]) => aoa.push([k, v]));
  const grid = (headers: string[], rows: Cell[][]) => {
    aoa.push(headers);
    if (rows.length === 0) aoa.push(['None']);
    else aoa.push(...rows);
  };
  const f = b.funnel;

  aoa.push([`Broadcast ${b.index}: ${b.name}`]);
  aoa.push([`${b.status} · ${b.campaignKey}`]);

  title('Campaign details');
  kv([
    ['Status', b.status],
    ['From number', b.fromNumber],
    ['Created at', b.createdAt],
    ['Created by', b.createdBy],
    ['Approved at', b.approvedAt],
    ['Approved by', b.approvedBy],
    ['Scheduled for', b.scheduledAt],
    ['Started at', b.startedAt],
    ['Finished at', b.finishedAt],
    ['Duration (seconds)', b.timing.durationSeconds],
    ['Throttle (msg/sec)', b.throttlePerSecond],
    ['Achieved throughput (msg/min)', b.timing.throughputPerMinute],
    ['Lead batch', b.leadBatch],
    ['Follow-up of', b.followUpOf],
    ['Follow-ups sent', b.followUps.join(', ') || null],
  ]);

  title('Message');
  kv([
    ['Text', b.body],
    ['Encoding', b.message.encoding],
    ['Characters', b.message.characters],
    ['Segments per message', b.message.segmentsPerMessage],
    ['Merge fields', b.message.mergeFields.join(', ') || null],
    ['Non-GSM characters', b.message.unicodeTriggers.join(' ') || null],
    ['Media', b.media.join(', ') || null],
  ]);

  title('Funnel and rates');
  kv([
    ['Recipients', f.recipients],
    ['Suppressed before send', f.suppressed],
    ['Sent', f.sent],
    ['Delivered', f.delivered],
    ['Failed / undeliverable', f.failed],
    ['Awaiting delivery report', f.pending],
    ['Still queued', f.stillQueued],
    ['Unique repliers', f.replied],
    ['Total replies', f.totalReplies],
    ['Opted out', f.optedOut],
    ['Interested', f.interested],
    ['Not interested', f.notInterested],
    ['Delivery rate %', b.rates.delivery],
    ['Failure rate %', b.rates.failure],
    ['Reply rate % (of sent)', b.rates.reply],
    ['Reply rate % (of delivered)', b.rates.replyOfDelivered],
    ['Opt-out rate %', b.rates.optOut],
    ['Interested % (of repliers)', b.rates.interested],
  ]);

  title('Live campaign counters (for comparison)');
  kv(Object.entries(b.counters).map(([k, v]): [string, Cell] => [k, v]));

  title('Cost');
  kv([
    ['Segments billed', b.cost.segments],
    ['Total cost', b.cost.total],
    ['Currency', b.cost.currency],
    ['Cost per sent', b.cost.perSent],
    ['Cost per delivered', b.cost.perDelivered],
    ['Cost per replier', b.cost.perReply],
  ]);

  title('Timing');
  kv([
    ['First send', b.timing.firstSentAt],
    ['Last send', b.timing.lastSentAt],
    ['Median seconds to deliver', b.timing.deliveryMedianSeconds],
    ['90th percentile seconds to deliver', b.timing.deliveryP90Seconds],
    ['Median minutes to first reply', b.timing.replyMedianMinutes],
    ['First reply', b.timing.firstReplyAt],
    ['Last reply', b.timing.lastReplyAt],
  ]);

  title('Activity by hour (Eastern)');
  grid(['Hour', 'Sent', 'Replies'], b.sendsByHour.map((v, h) => [`${String(h).padStart(2, '0')}:00`, v, b.repliesByHour[h]]));

  title('Status of every recipient');
  grid(['Status', 'Recipients'], b.statusBreakdown.map((x) => [x.label, x.count]));
  title('Failure reasons');
  grid(['Reason', 'Count'], b.failureReasons.map((x) => [x.label, x.count]));
  title('Suppression reasons');
  grid(['Reason', 'Count'], b.suppressionReasons.map((x) => [x.label, x.count]));
  title('Replies by day');
  grid(['Day', 'Replies'], b.repliesByDay.map((x) => [x.label, x.count]));

  const bd = (t: string, rows: typeof b.byOwner) => {
    title(t);
    grid(
      ['', 'Recipients', 'Delivered', 'Failed', 'Replied', 'Opted out', 'Interested'],
      rows.map((r) => [r.label, r.recipients, r.delivered, r.failed, r.replied, r.optedOut, r.interested]),
    );
  };
  bd('By lead owner', b.byOwner);
  bd('By state', b.byState);

  title(`Replies (${b.replies.length})`);
  grid(
    ['Received at', 'From', 'Contact', 'Company', 'Lead owner', 'Reply text', 'Media', 'STOP', 'Minutes after send'],
    b.replies.map((r) => [r.receivedAt, r.from, r.contactName, r.company, r.leadOwner, r.text, r.media, r.isStop, r.minutesAfterSend]),
  );

  title(`All recipients (${b.recipients.length})`);
  grid(
    ['Phone', 'First name', 'Last name', 'Company', 'Email', 'City', 'State', 'Lead owner', 'Disposition', 'Recipient status', 'Message status', 'Sent at', 'Delivered at', 'Seconds to deliver', 'Segments', 'Price', 'Error code', 'Error', 'Suppressed reason', 'Replies', 'First reply at', 'Opted out'],
    b.recipients.map((r) => [
      r.phone, r.firstName, r.lastName, r.company, r.email, r.city, r.state, r.leadOwner, r.disposition,
      r.recipientStatus, r.messageStatus, r.sentAt, r.deliveredAt, r.deliverySeconds, r.segments, r.price,
      r.errorCode, r.error, r.suppressedReason, r.replies, r.firstReplyAt, r.optedOut,
    ]),
  );

  const sheet = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true, dateNF: 'yyyy-mm-dd hh:mm' });
  sheet['!cols'] = [{ wch: 34 }, { wch: 22 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 40 }, ...Array.from({ length: 16 }, () => ({ wch: 16 }))];
  return sheet;
}

/** Excel sheet names: 31 chars max, no []:*?/\ and unique. */
function sheetName(b: BroadcastDetail, used: Set<string>): string {
  const base = `${String(b.index).padStart(2, '0')} ${b.name}`.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31).trim();
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i += 1) name = `${base.slice(0, 27)} (${i})`;
  used.add(name.toLowerCase());
  return name;
}

/* ============================================================================
 * PDF
 * ==========================================================================*/

export async function buildReportPdf(range: ReportRange, sections: ReportSection[]): Promise<Buffer> {
  const names = await userNames();
  const summary = await buildReportSummary(range);
  const lastDay = new Date(range.to.getTime() - DAY_MS).toISOString().slice(0, 10);
  return renderReportPdf({
    periodLabel: `${range.from.toISOString().slice(0, 10)} to ${lastDay}`,
    generatedAt: new Date(),
    summary,
    broadcasts: sections.includes('broadcasts') ? await collectBroadcastDetails(range, names) : [],
    agents: sections.includes('agents') ? (await agentSheet(range))[0][1] : [],
    applications: sections.includes('applications') ? (await applicationSheet(range, names))[0][1] : [],
  });
}

/* ============================================================================
 * Workbook
 * ==========================================================================*/

function toSheet(rows: Row[]): XLSX.WorkSheet {
  if (rows.length === 0) return XLSX.utils.aoa_to_sheet([['No data for this period']]);
  const sheet = XLSX.utils.json_to_sheet(rows, { cellDates: true, dateNF: 'yyyy-mm-dd hh:mm' });
  const headers = Object.keys(rows[0]);
  // Column widths from the header and the first rows, capped so long message
  // text does not produce absurdly wide columns.
  sheet['!cols'] = headers.map((h) => {
    const sample = rows.slice(0, 200).map((r) => {
      const v = r[h];
      return v instanceof Date ? 16 : String(v ?? '').length;
    });
    return { wch: Math.min(60, Math.max(h.length + 2, ...sample)) };
  });
  sheet['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } }) };
  return sheet;
}

export async function buildReportWorkbook(range: ReportRange, sections: ReportSection[]): Promise<Buffer> {
  const names = await userNames();
  const summary = await buildReportSummary(range);

  const sheets: Array<[string, Row[]]> = [];
  const details = sections.includes('broadcasts') ? await collectBroadcastDetails(range, names) : [];
  if (sections.includes('broadcasts')) sheets.push(...(await broadcastSheets(range, names)));
  if (sections.includes('inbox')) sheets.push(...(await inboxSheets(range, names)));
  if (sections.includes('agents')) sheets.push(...(await agentSheet(range)));
  if (sections.includes('applications')) sheets.push(...(await applicationSheet(range, names)));

  const lastDay = new Date(range.to.getTime() - DAY_MS).toISOString().slice(0, 10);
  const b = summary.broadcasts;
  const overview: Array<[string, string | number | null]> = [
    ['Harbor Report', null],
    ['Period', `${range.from.toISOString().slice(0, 10)} to ${lastDay}`],
    ['Generated At', new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'],
    [null as unknown as string, null],
    ['Broadcast campaigns', b.campaigns],
    ['Broadcast recipients', b.recipients],
    ['Broadcast messages sent', b.sent],
    ['Delivered', b.delivered],
    ['Failed / undeliverable', b.failed],
    ['Suppressed', b.suppressed],
    ['Replied', b.replied],
    ['Opted out', b.optedOut],
    ['Delivery rate %', b.deliveryRate],
    ['Reply rate %', b.replyRate],
    [null as unknown as string, null],
    ['Messages sent (all)', summary.inbox.messagesSent],
    ['Messages received', summary.inbox.messagesReceived],
    ['Opt-outs (STOP)', summary.inbox.optOuts],
    ['Active conversations', summary.inbox.activeConversations],
    ['Leads imported', summary.leads.imported],
    ['Applications created', summary.applications.total],
    ...summary.applications.byQueue.map((q): [string, number] => [`  Queue: ${q.queue}`, q.count]),
  ];
  for (const [name, rows] of sheets) {
    if (rows.length >= MAX_SHEET_ROWS) {
      overview.push([`Note: "${name}" truncated to the first ${MAX_SHEET_ROWS.toLocaleString()} rows`, null]);
    }
  }

  const wb = XLSX.utils.book_new();
  const overviewSheet = XLSX.utils.aoa_to_sheet(overview);
  overviewSheet['!cols'] = [{ wch: 48 }, { wch: 28 }];
  XLSX.utils.book_append_sheet(wb, overviewSheet, 'Overview');
  for (const [name, rows] of sheets) XLSX.utils.book_append_sheet(wb, toSheet(rows), name.slice(0, 31));
  // Then every campaign on its own sheet, with every detail about it.
  const used = new Set(wb.SheetNames.map((n) => n.toLowerCase()));
  for (const b of details) XLSX.utils.book_append_sheet(wb, broadcastDetailSheet(b), sheetName(b, used));

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer;
}
