/**
 * Conversation / inbox service.
 *
 * The inbox list reads ONLY `MessagingConversation`, never the message table.
 * That denormalization (Fivra's `ConversationSummary`) is the single biggest
 * reason their inbox stays responsive with millions of messages: listing
 * threads becomes one indexed scan of a narrow table instead of a correlated
 * "latest message per pair" aggregate.
 *
 * The cost is that every write has to maintain the summary. All of those writes
 * live in this file, inside transactions, so the summary cannot drift.
 */
import type { Prisma } from '@prisma/client';
import prisma from '../../config/prismaClient';
import {
  cacheDelPattern,
  cacheGet,
  cacheKeys,
  cacheSet,
} from './cache.service';
import { normalizePhoneNumber, normalizeSender } from './phone';
import { isStartKeyword, isStopKeyword } from './suppression.service';
import { normalizeInboxTab, tabSkipsBroadcastVisibility } from './inboxTabs';
import { deductPrepaidAfterInbound } from '../tenantControl/prepaid';

/** Short TTL: the inbox is realtime via sockets, the cache only absorbs bursts. */
const CONVERSATION_LIST_TTL_SECONDS = 15;
const MESSAGE_PAGE_TTL_SECONDS = 10;

export const CONVERSATION_PAGE_SIZE = 30;
export const MESSAGE_PAGE_SIZE = 50;

/** Broadcast threads stay out of the inbox until the contact has replied (incl. STOP). */
function inboxVisibilityWhere(): Prisma.MessagingConversationWhereInput {
  return {
    OR: [{ hasBroadcastMessage: false }, { hasInboundReply: true }],
  };
}

export interface ConversationListParams {
  userId: string;
  page?: number;
  search?: string;
  /** all | unread | broadcast | opted-out */
  filter?: string;
  /**
   * Senders whose threads this caller may see. `null` means no restriction
   * (admins and super admins); an array scopes the inbox to those numbers, so
   * a rep sees only conversations on the sender assigned to them.
   */
  senderNumbers?: string[] | null;
}

/**
 * Find or create the thread for a (business number, contact number) pair.
 *
 * Uses an upsert on the composite unique key so two inbound webhooks arriving
 * concurrently for a brand-new contact cannot create duplicate threads.
 */
export async function ensureConversation(input: {
  businessNumber: string;
  contactNumber: string;
  ownerUserId?: string | null;
  tx?: Prisma.TransactionClient;
}): Promise<{ id: string; isOptedOut: boolean }> {
  const businessNumber = normalizeSender(input.businessNumber);
  const contactNumber = normalizePhoneNumber(input.contactNumber);
  if (!contactNumber) throw new Error(`Cannot open a conversation with an unparseable number: ${input.contactNumber}`);

  const db = input.tx ?? prisma;

  // Link an existing contact record when one exists, so the thread shows a name.
  const contact = await db.messagingContact.findFirst({
    where: { phoneNumber: contactNumber },
    select: { id: true },
  });

  const conversation = await db.messagingConversation.upsert({
    where: { businessNumber_contactNumber: { businessNumber, contactNumber } },
    create: {
      businessNumber,
      contactNumber,
      contactId: contact?.id ?? null,
      ownerUserId: input.ownerUserId ?? null,
    },
    // Only backfill the contact link; never clobber ownership or counters here.
    update: contact?.id ? { contactId: contact.id } : {},
    select: { id: true, isOptedOut: true },
  });

  return conversation;
}

/**
 * Persist an inbound message and roll the conversation summary forward.
 *
 * Idempotent on `providerMessageId`: Infobip retries callbacks it considers
 * unacknowledged, and a duplicated inbound would otherwise double the unread
 * count and re-notify the agent.
 */
export async function recordInboundMessage(input: {
  providerMessageId: string;
  fromNumber: string;
  toNumber: string;
  body: string;
  mediaUrls?: string[];
  receivedAt?: Date;
  /** Set when the reply is to a broadcast — surfaces the campaign in chat. */
  broadcastId?: string | null;
}): Promise<{ conversationId: string; messageId: string; duplicate: boolean; isStop: boolean } | null> {
  const contactNumber = normalizePhoneNumber(input.fromNumber);
  const businessNumber = normalizeSender(input.toNumber);
  if (!contactNumber) {
    console.warn('[messaging:conversation] dropping inbound from unparseable number:', input.fromNumber);
    return null;
  }

  const existing = await prisma.messagingMessage.findUnique({
    where: { providerMessageId: input.providerMessageId },
    select: { id: true, conversationId: true },
  });
  if (existing) {
    return { conversationId: existing.conversationId, messageId: existing.id, duplicate: true, isStop: false };
  }

  const isStop = isStopKeyword(input.body);
  const isStart = isStartKeyword(input.body);
  const receivedAt = input.receivedAt ?? new Date();
  const hasMedia = Boolean(input.mediaUrls?.length);

  const result = await prisma.$transaction(async (tx) => {
    const conversation = await ensureConversation({
      businessNumber,
      contactNumber,
      tx,
    });

    const message = await tx.messagingMessage.create({
      data: {
        conversationId: conversation.id,
        providerMessageId: input.providerMessageId,
        direction: 'INBOUND',
        fromNumber: contactNumber,
        toNumber: businessNumber,
        body: input.body,
        mediaUrls: input.mediaUrls ?? [],
        status: 'RECEIVED',
        broadcastId: input.broadcastId ?? null,
        isStopKeyword: isStop,
        sentAt: receivedAt,
        createdAt: receivedAt,
      },
      select: { id: true },
    });

    await tx.messagingConversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageId: message.id,
        lastMessageText: input.body?.slice(0, 500) ?? null,
        lastMessageAt: receivedAt,
        lastMessageDirection: 'INBOUND',
        lastMessageHasMedia: hasMedia,
        messageCount: { increment: 1 },
        unreadCount: { increment: 1 },
        // An inbound reply un-archives the thread — it needs attention again.
        isArchived: false,
        ...(isStop ? { isOptedOut: true } : {}),
        ...(isStart ? { isOptedOut: false } : {}),
        ...(input.broadcastId ? { hasBroadcastMessage: true } : {}),
        hasInboundReply: true,
      },
    });

    // Count the reply against the campaign that prompted it.
    if (input.broadcastId) {
      await tx.smsBroadcast.update({
        where: { id: input.broadcastId },
        data: {
          repliedCount: { increment: 1 },
          ...(isStop ? { optOutCount: { increment: 1 } } : {}),
        },
      });
    }

    return { conversationId: conversation.id, messageId: message.id };
  });

  await invalidateConversationCaches(result.conversationId);

  void deductPrepaidAfterInbound(1);

  return { ...result, duplicate: false, isStop };
}

/**
 * Persist an outbound message in QUEUED state before it is handed to Infobip.
 *
 * Writing the row first means a crash between "provider accepted" and "we
 * recorded it" leaves an auditable QUEUED row rather than an invisible send.
 * The row's own id is used as Infobip's `messageId`, so the delivery report
 * joins straight back to it.
 */
export async function recordOutboundMessage(input: {
  conversationId: string;
  fromNumber: string;
  toNumber: string;
  body: string;
  mediaUrls?: string[];
  sentById?: string | null;
  broadcastId?: string | null;
}): Promise<{ id: string }> {
  const message = await prisma.messagingMessage.create({
    data: {
      conversationId: input.conversationId,
      direction: 'OUTBOUND',
      fromNumber: normalizeSender(input.fromNumber),
      toNumber: normalizePhoneNumber(input.toNumber) ?? input.toNumber,
      body: input.body,
      mediaUrls: input.mediaUrls ?? [],
      status: 'QUEUED',
      sentById: input.sentById ?? null,
      broadcastId: input.broadcastId ?? null,
    },
    select: { id: true },
  });

  return message;
}

/** Roll the summary forward once the provider has accepted an outbound message. */
export async function markOutboundSubmitted(input: {
  messageId: string;
  conversationId: string;
  providerMessageId: string | null;
  providerBulkId: string | null;
  status: 'SENT' | 'FAILED' | 'UNDELIVERABLE' | 'QUEUED';
  errorCode?: string | null;
  errorMessage?: string | null;
  segmentCount?: number | null;
  body: string;
  hasMedia: boolean;
}): Promise<void> {
  const sentAt = new Date();

  await prisma.$transaction([
    prisma.messagingMessage.update({
      where: { id: input.messageId },
      data: {
        providerMessageId: input.providerMessageId,
        providerBulkId: input.providerBulkId,
        status: input.status,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
        segmentCount: input.segmentCount ?? null,
        sentAt,
      },
    }),
    prisma.messagingConversation.update({
      where: { id: input.conversationId },
      data: {
        lastMessageId: input.messageId,
        lastMessageText: input.body?.slice(0, 500) ?? null,
        lastMessageAt: sentAt,
        lastMessageDirection: 'OUTBOUND',
        lastMessageHasMedia: input.hasMedia,
        messageCount: { increment: 1 },
      },
    }),
  ]);

  await invalidateConversationCaches(input.conversationId);
}

/**
 * Apply a delivery report.
 *
 * Guards against out-of-order callbacks: Infobip can deliver a `DELIVERED`
 * receipt before the `SENT` one, and letting a late SENT overwrite DELIVERED
 * would make the funnel counts drift backwards.
 */
const STATUS_RANK: Record<string, number> = {
  QUEUED: 0,
  SENDING: 1,
  SENT: 2,
  DELIVERED: 4,
  RECEIVED: 4,
  FAILED: 3,
  UNDELIVERABLE: 3,
};

export async function applyDeliveryReport(input: {
  providerMessageId: string;
  status: 'SENT' | 'DELIVERED' | 'FAILED' | 'UNDELIVERABLE';
  errorCode?: string | null;
  errorMessage?: string | null;
  doneAt?: Date | null;
  segmentCount?: number | null;
  priceAmount?: number | null;
  priceCurrency?: string | null;
}): Promise<{ conversationId: string; broadcastId: string | null } | null> {
  const message = await prisma.messagingMessage.findUnique({
    where: { providerMessageId: input.providerMessageId },
    select: { id: true, conversationId: true, broadcastId: true, status: true, toNumber: true },
  });

  if (!message) {
    console.warn('[messaging:conversation] delivery report for unknown message:', input.providerMessageId);
    return null;
  }

  const currentRank = STATUS_RANK[message.status] ?? 0;
  const incomingRank = STATUS_RANK[input.status] ?? 0;
  if (incomingRank < currentRank) {
    // Late/duplicate receipt for an already-terminal message — ignore.
    return { conversationId: message.conversationId, broadcastId: message.broadcastId };
  }

  await prisma.messagingMessage.update({
    where: { id: message.id },
    data: {
      status: input.status,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      deliveredAt: input.status === 'DELIVERED' ? input.doneAt ?? new Date() : null,
      segmentCount: input.segmentCount ?? undefined,
      priceAmount: input.priceAmount ?? undefined,
      priceCurrency: input.priceCurrency ?? undefined,
    },
  });

  await invalidateConversationCaches(message.conversationId);

  return { conversationId: message.conversationId, broadcastId: message.broadcastId };
}

export interface ConversationListItem {
  id: string;
  businessNumber: string;
  contactNumber: string;
  contactName: string | null;
  lastMessageText: string | null;
  lastMessageAt: Date | null;
  lastMessageDirection: string | null;
  unreadCount: number;
  hasBroadcastMessage: boolean;
  isOptedOut: boolean;
  isBlocked: boolean;
}

/**
 * Paged inbox list. Cached briefly per (user, page, search, filter) — the same
 * key shape the frontend mirrors into IndexedDB, so both layers invalidate on
 * the same events.
 */
export async function listConversations(params: ConversationListParams): Promise<{
  items: ConversationListItem[];
  page: number;
  hasMore: boolean;
}> {
  const page = Math.max(1, Number(params.page) || 1);
  const search = String(params.search ?? '').trim();
  const tab = normalizeInboxTab(String(params.filter ?? 'regular'));

  const scopeKey = Array.isArray(params.senderNumbers)
    ? params.senderNumbers.slice().sort().join(',')
    : 'all';
  const cacheKey = cacheKeys.conversationList(params.userId, page, search, `${tab}:${scopeKey}`);
  const cached = await cacheGet<{ items: ConversationListItem[]; page: number; hasMore: boolean }>(cacheKey);
  if (cached) return cached;

  const where: Prisma.MessagingConversationWhereInput = { isArchived: false };

  // Scope to the caller's sender(s). An empty array means the user has no
  // usable sender, so they see nothing rather than everything — failing closed
  // matters here, since the alternative leaks another desk's conversations.
  if (Array.isArray(params.senderNumbers)) {
    where.businessNumber = { in: params.senderNumbers };
  }

  const andParts: Prisma.MessagingConversationWhereInput[] = Array.isArray(where.AND)
    ? [...where.AND]
    : [];

  if (!tabSkipsBroadcastVisibility(tab)) {
    andParts.push(inboxVisibilityWhere());
  }

  const dispositionNew: Prisma.MessagingConversationWhereInput = {
    OR: [{ contact: { is: null } }, { contact: { disposition: 'NEW' } }],
  };

  switch (tab) {
    case 'opt-out':
      andParts.push({ isOptedOut: true });
      break;
    case 'interested':
      andParts.push({ isOptedOut: false, contact: { disposition: 'INTERESTED' } });
      break;
    case 'not-interested':
      andParts.push({ isOptedOut: false, contact: { disposition: 'NOT_INTERESTED' } });
      break;
    case 'unreplied':
      andParts.push({
        isOptedOut: false,
        hasInboundReply: false,
        ...dispositionNew,
      });
      break;
    case 'regular':
    default:
      andParts.push({
        isOptedOut: false,
        hasInboundReply: true,
        ...dispositionNew,
      });
      break;
  }

  if (search) {
    const normalizedSearch = normalizePhoneNumber(search);
    andParts.push({
      OR: [
        { contactNumber: { contains: normalizedSearch ?? search } },
        { lastMessageText: { contains: search, mode: 'insensitive' } },
        { contact: { firstName: { contains: search, mode: 'insensitive' } } },
        { contact: { lastName: { contains: search, mode: 'insensitive' } } },
        { contact: { company: { contains: search, mode: 'insensitive' } } },
      ],
    });
  }

  where.AND = andParts;

  // Fetch one extra row to answer hasMore without a second COUNT query.
  const rows = await prisma.messagingConversation.findMany({
    where,
    orderBy: { lastMessageAt: 'desc' },
    skip: (page - 1) * CONVERSATION_PAGE_SIZE,
    take: CONVERSATION_PAGE_SIZE + 1,
    select: {
      id: true,
      businessNumber: true,
      contactNumber: true,
      lastMessageText: true,
      lastMessageAt: true,
      lastMessageDirection: true,
      unreadCount: true,
      hasBroadcastMessage: true,
      isOptedOut: true,
      contact: {
        select: { firstName: true, lastName: true, company: true, status: true, disposition: true },
      },
    },
  });

  const hasMore = rows.length > CONVERSATION_PAGE_SIZE;
  const items: ConversationListItem[] = rows.slice(0, CONVERSATION_PAGE_SIZE).map((row) => ({
    id: row.id,
    businessNumber: row.businessNumber,
    contactNumber: row.contactNumber,
    contactName:
      [row.contact?.firstName, row.contact?.lastName].filter(Boolean).join(' ').trim() ||
      row.contact?.company ||
      null,
    lastMessageText: row.lastMessageText,
    lastMessageAt: row.lastMessageAt,
    lastMessageDirection: row.lastMessageDirection,
    unreadCount: row.unreadCount,
    hasBroadcastMessage: row.hasBroadcastMessage,
    isOptedOut: row.isOptedOut,
    isBlocked: row.contact?.status === 'BLOCKED',
  }));

  const payload = { items, page, hasMore };
  await cacheSet(cacheKey, payload, CONVERSATION_LIST_TTL_SECONDS);
  return payload;
}

/** Message history for one thread, newest page first. */
export async function listMessages(conversationId: string, page = 1): Promise<{
  items: unknown[];
  page: number;
  hasMore: boolean;
}> {
  const safePage = Math.max(1, Number(page) || 1);
  const cacheKey = cacheKeys.conversationMessages(conversationId, safePage);
  const cached = await cacheGet<{ items: unknown[]; page: number; hasMore: boolean }>(cacheKey);
  if (cached) return cached;

  const rows = await prisma.messagingMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },
    skip: (safePage - 1) * MESSAGE_PAGE_SIZE,
    take: MESSAGE_PAGE_SIZE + 1,
    select: {
      id: true,
      direction: true,
      fromNumber: true,
      toNumber: true,
      body: true,
      mediaUrls: true,
      status: true,
      errorMessage: true,
      broadcastId: true,
      isStopKeyword: true,
      sentAt: true,
      deliveredAt: true,
      createdAt: true,
    },
  });

  const hasMore = rows.length > MESSAGE_PAGE_SIZE;
  // Return oldest-first so the FE can append without reversing.
  const items = rows.slice(0, MESSAGE_PAGE_SIZE).reverse();

  const payload = { items, page: safePage, hasMore };
  await cacheSet(cacheKey, payload, MESSAGE_PAGE_TTL_SECONDS);
  return payload;
}

export async function markConversationRead(conversationId: string): Promise<void> {
  await prisma.messagingConversation.update({
    where: { id: conversationId },
    data: { unreadCount: 0 },
  });
  await invalidateConversationCaches(conversationId);
}

export async function getTotalUnread(senderNumbers?: string[] | null): Promise<number> {
  const result = await prisma.messagingConversation.aggregate({
    _sum: { unreadCount: true },
    where: {
      isArchived: false,
      // Same scoping as the list: the badge must not count threads the user
      // cannot open.
      ...(Array.isArray(senderNumbers) ? { businessNumber: { in: senderNumbers } } : {}),
      AND: [inboxVisibilityWhere()],
    },
  });
  return result._sum.unreadCount ?? 0;
}

/**
 * Invalidate both cache families touched by a write.
 *
 * Conversation lists are keyed per user and we do not know which users are
 * looking at a thread, so the list pattern is cleared wholesale. The TTL is
 * 15s, so this is cheap and correct rather than clever.
 */
async function invalidateConversationCaches(conversationId: string): Promise<void> {
  await Promise.all([
    cacheDelPattern(cacheKeys.conversationMessagesPattern(conversationId)),
    cacheDelPattern(cacheKeys.conversationListAllPattern()),
  ]);
}
