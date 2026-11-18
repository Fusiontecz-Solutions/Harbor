/**
 * Broadcast audience drill-down.
 *
 * Mirrors Fivra's `StatusDetailModal` / `broadcast-stats` behaviour: every stat
 * tile on a campaign is clickable and resolves to the actual list of people
 * behind that number — including *why* a message failed, not just that it did.
 *
 * Two of the buckets are not stored on the recipient row and have to be derived
 * from the message table:
 *
 *   replied    — contacts with a non-STOP inbound attributed to this campaign
 *   opted-out  — contacts whose inbound matched a stop keyword
 *
 * Deriving them keeps the recipient row as a pure record of *our* send attempt,
 * so a reply arriving days later can never race a counter update.
 */
import type { Prisma } from '@prisma/client';
import { contactDisplayName } from './contactName';
import prisma from '../../config/prismaClient';

export type AudienceBucket =
  | 'all'
  | 'queued'
  | 'sending'
  | 'sent'
  | 'pending'
  | 'delivered'
  | 'failed'
  | 'undeliverable'
  | 'suppressed'
  | 'replied'
  | 'opted-out';

export interface AudienceRow {
  phoneNumber: string;
  contactName: string | null;
  company: string | null;
  city: string | null;
  state: string | null;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  suppressedReason: string | null;
  sentAt: Date | null;
  /** Populated for the replied bucket. */
  replyText?: string | null;
  replyAt?: Date | null;
}

export interface AudiencePage {
  rows: AudienceRow[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/** Recipient-row statuses that map 1:1 onto a bucket. */
const DIRECT_STATUS: Partial<Record<AudienceBucket, string>> = {
  queued: 'QUEUED',
  sending: 'SENDING',
  pending: 'SENT',
  delivered: 'DELIVERED',
  failed: 'FAILED',
  undeliverable: 'UNDELIVERABLE',
};

function buildRecipientWhere(broadcastId: string, bucket: AudienceBucket): Prisma.SmsBroadcastRecipientWhereInput {
  const where: Prisma.SmsBroadcastRecipientWhereInput = { broadcastId };

  const direct = DIRECT_STATUS[bucket];
  if (direct) {
    where.status = direct as never;
    // A suppressed row is stored as FAILED; keep the two buckets distinct so
    // "failed" means "the carrier rejected it", not "we never tried".
    if (bucket === 'failed') where.suppressedReason = null;
    return where;
  }

  if (bucket === 'suppressed') {
    where.suppressedReason = { not: null };
  }

  // "Sent" = accepted by the provider, whatever the outcome since (smsMetrics).
  if (bucket === 'sent') {
    where.providerMessageId = { not: null };
    where.status = { in: ['SENT', 'DELIVERED', 'UNDELIVERABLE'] };
    where.suppressedReason = null;
  }

  return where;
}

/**
 * Numbers that replied to this campaign, with their first reply.
 * One query, then grouped in memory — a campaign's reply count is orders of
 * magnitude smaller than its recipient count.
 */
async function loadReplies(
  broadcastId: string,
): Promise<Map<string, { text: string | null; at: Date; isStop: boolean; hasReply: boolean }>> {
  const replies = await prisma.messagingMessage.findMany({
    where: { broadcastId, direction: 'INBOUND' },
    orderBy: { createdAt: 'asc' },
    select: { fromNumber: true, body: true, createdAt: true, isStopKeyword: true },
  });

  const byNumber = new Map<string, { text: string | null; at: Date; isStop: boolean; hasReply: boolean }>();
  for (const reply of replies) {
    const existing = byNumber.get(reply.fromNumber);
    // Keep the earliest reply, but let a later STOP win the opt-out flag.
    if (!existing) {
      byNumber.set(reply.fromNumber, {
        text: reply.body,
        at: reply.createdAt,
        isStop: reply.isStopKeyword,
        hasReply: !reply.isStopKeyword,
      });
    } else {
      if (reply.isStopKeyword) existing.isStop = true;
      if (!reply.isStopKeyword) existing.hasReply = true;
    }
  }

  return byNumber;
}

export async function getBroadcastAudience(
  broadcastId: string,
  bucket: AudienceBucket,
  page = 1,
  pageSize = 100,
): Promise<AudiencePage> {
  const safePage = Math.max(1, page);
  const safeSize = Math.min(500, Math.max(1, pageSize));

  /* ---- Derived buckets: driven by the message table, not the recipient row ---- */
  if (bucket === 'replied' || bucket === 'opted-out') {
    const replies = await loadReplies(broadcastId);
    const wanted = [...replies.entries()].filter(([, r]) => (bucket === 'opted-out' ? r.isStop : r.hasReply));

    const total = wanted.length;
    const slice = wanted.slice((safePage - 1) * safeSize, safePage * safeSize);
    const numbers = slice.map(([phone]) => phone);

    // Enrich with whatever contact detail we hold for those numbers.
    const contacts = await prisma.messagingContact.findMany({
      where: { phoneNumber: { in: numbers } },
      select: { phoneNumber: true, ownerName: true, firstName: true, lastName: true, company: true, city: true, state: true },
    });
    const contactByPhone = new Map(contacts.map((c) => [c.phoneNumber, c]));

    const recipients = await prisma.smsBroadcastRecipient.findMany({
      where: { broadcastId, phoneNumber: { in: numbers } },
      select: { phoneNumber: true, status: true, sentAt: true },
    });
    const recipientByPhone = new Map(recipients.map((r) => [r.phoneNumber, r]));

    return {
      rows: slice.map(([phone, reply]) => {
        const contact = contactByPhone.get(phone);
        const recipient = recipientByPhone.get(phone);
        return {
          phoneNumber: phone,
          contactName: contactDisplayName(contact),
          company: contact?.company ?? null,
          city: contact?.city ?? null,
          state: contact?.state ?? null,
          status: recipient?.status ?? 'SENT',
          errorCode: null,
          errorMessage: null,
          suppressedReason: reply.isStop ? 'STOP_KEYWORD' : null,
          sentAt: recipient?.sentAt ?? null,
          replyText: reply.text,
          replyAt: reply.at,
        };
      }),
      total,
      page: safePage,
      pageSize: safeSize,
      hasMore: safePage * safeSize < total,
    };
  }

  /* ---- Recipient-row buckets ---- */
  const where = buildRecipientWhere(broadcastId, bucket);

  const [rows, total] = await Promise.all([
    prisma.smsBroadcastRecipient.findMany({
      where,
      orderBy: [{ sentAt: 'desc' }, { createdAt: 'asc' }],
      skip: (safePage - 1) * safeSize,
      take: safeSize,
      select: {
        phoneNumber: true,
        status: true,
        errorCode: true,
        errorMessage: true,
        suppressedReason: true,
        sentAt: true,
        contact: { select: { ownerName: true, firstName: true, lastName: true, company: true, city: true, state: true } },
        mergeData: true,
      },
    }),
    prisma.smsBroadcastRecipient.count({ where }),
  ]);

  return {
    rows: rows.map((row) => {
      const merge = (row.mergeData as Record<string, unknown> | null) ?? {};
      const mergedName = String(merge.ownerName ?? '').trim() || [merge.firstName, merge.lastName].filter(Boolean).join(' ').trim();
      return {
        phoneNumber: row.phoneNumber,
        contactName:
          contactDisplayName(row.contact) || mergedName || null,
        company: row.contact?.company ?? (merge.company ? String(merge.company) : null),
        city: row.contact?.city ?? (merge.city ? String(merge.city) : null),
        state: row.contact?.state ?? (merge.state ? String(merge.state) : null),
        status: row.status,
        errorCode: row.errorCode,
        errorMessage: row.errorMessage,
        suppressedReason: row.suppressedReason,
        sentAt: row.sentAt,
      };
    }),
    total,
    page: safePage,
    pageSize: safeSize,
    hasMore: safePage * safeSize < total,
  };
}

/**
 * Failure reasons grouped by code, so an operator sees "1,204 of these were
 * 'Absent Subscriber'" instead of scrolling a list of identical rows. This is
 * the single most useful view when a campaign underperforms.
 */
export async function getErrorBreakdown(broadcastId: string): Promise<
  Array<{ errorCode: string | null; errorMessage: string | null; count: number }>
> {
  const grouped = await prisma.smsBroadcastRecipient.groupBy({
    by: ['errorCode', 'errorMessage'],
    where: {
      broadcastId,
      status: { in: ['FAILED', 'UNDELIVERABLE'] },
    },
    _count: { _all: true },
  });

  return grouped
    .map((row) => ({
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      count: row._count._all,
    }))
    .sort((a, b) => b.count - a.count);
}

/** CSV export of a bucket. Paged internally so a large campaign cannot blow memory. */
export async function exportAudienceCsv(broadcastId: string, bucket: AudienceBucket): Promise<string> {
  const header = [
    'Phone Number',
    'Contact Name',
    'Company',
    'City',
    'State',
    'Status',
    'Error Code',
    'Error Message',
    'Suppressed Reason',
    'Sent At',
    'Reply',
  ];

  const lines: string[] = [header.join(',')];
  const PAGE = 500;
  let page = 1;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await getBroadcastAudience(broadcastId, bucket, page, PAGE);
    for (const row of result.rows) {
      lines.push(
        [
          row.phoneNumber,
          row.contactName ?? '',
          row.company ?? '',
          row.city ?? '',
          row.state ?? '',
          row.status,
          row.errorCode ?? '',
          row.errorMessage ?? '',
          row.suppressedReason ?? '',
          row.sentAt ? row.sentAt.toISOString() : '',
          row.replyText ?? '',
        ]
          .map(csvCell)
          .join(','),
      );
    }

    if (!result.hasMore) break;
    page += 1;
  }

  return lines.join('\n');
}

/**
 * Quote a CSV cell. A leading =, +, - or @ is prefixed with a single quote:
 * spreadsheet software treats those as formulas, so an error message beginning
 * with "-" would otherwise execute on open.
 */
function csvCell(value: string): string {
  const str = String(value ?? '');
  const guarded = /^[=+\-@]/.test(str) ? `'${str}` : str;
  return `"${guarded.replace(/"/g, '""')}"`;
}
