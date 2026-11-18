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
import { contactDisplayName } from './contactName';
import prisma from '../../config/prismaClient';
import {
  cacheBumpGeneration,
  cacheGeneration,
  cacheGet,
  cacheKeys,
  cacheSet,
} from './cache.service';
import { normalizePhoneNumber, normalizeSender } from './phone';
import { isStartKeyword, isStopKeyword } from './suppression.service';
import { normalizeInboxTab, tabSkipsBroadcastVisibility } from './inboxTabs';
import { deductPrepaidAfterInbound } from '../tenantControl/prepaid';
import { scheduleBroadcastRecompute } from './broadcastCounters';

/** Short TTL: the inbox is realtime via sockets, the cache only absorbs bursts. */
const CONVERSATION_LIST_TTL_SECONDS = 15;
const MESSAGE_PAGE_TTL_SECONDS = 10;
/** Generation names for O(1) cache invalidation (see cacheBumpGeneration). */
const LIST_GENERATION = 'conv:list';
const messagesGeneration = (conversationId: string): string => `conv:msgs:${conversationId}`;

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
  /** Un-delete a soft-deleted thread (an agent deliberately opening / writing to it). */
  restore?: boolean;
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
    update: {
      ...(contact?.id ? { contactId: contact.id } : {}),
      ...(input.restore ? { deletedAt: null } : {}),
    },
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
  /** Segments as counted by the provider. */
  segmentCount?: number | null;
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
    // Report isStop on redeliveries too: if applying the opt-out failed the
    // first time, the provider's retry is the only chance to apply it.
    return {
      conversationId: existing.conversationId,
      messageId: existing.id,
      duplicate: true,
      isStop: isStopKeyword(input.body),
    };
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
        segmentCount: input.segmentCount ?? null,
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
        // …and un-deletes it: a deleted thread the contact writes to again
        // comes back with its full history.
        deletedAt: null,
        ...(isStop ? { isOptedOut: true } : {}),
        ...(isStart ? { isOptedOut: false } : {}),
        ...(input.broadcastId ? { hasBroadcastMessage: true } : {}),
        hasInboundReply: true,
      },
    });

    return { conversationId: conversation.id, messageId: message.id };
  });

  await invalidateConversationCaches(result.conversationId);

  // The campaign's replied / opt-out counters are recounted from rows (distinct
  // non-STOP repliers, distinct STOP senders) — never incremented here.
  if (input.broadcastId) scheduleBroadcastRecompute(input.broadcastId);

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

  // maxWait: under load the pool can be busy for a few seconds; Prisma's 2s
  // default turned a short wait into "Unable to start a transaction" and a
  // message the provider had accepted was recorded as failed.
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
  ], { maxWait: 20_000, timeout: 30_000 });

  await invalidateConversationCaches(input.conversationId);
}

/*
 * Delivery reports are applied by deliveryStatus.service.ts (applyProviderStatus),
 * shared by the webhook, the reconciler and the backfill.
 */

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
  const generation = await cacheGeneration(LIST_GENERATION);
  const cacheKey = cacheKeys.conversationList(params.userId, page, search, `${tab}:${scopeKey}:g${generation}`);
  const cached = await cacheGet<{ items: ConversationListItem[]; page: number; hasMore: boolean }>(cacheKey);
  if (cached) return cached;

  const where: Prisma.MessagingConversationWhereInput = { isArchived: false, deletedAt: null };

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
        select: { ownerName: true, firstName: true, lastName: true, company: true, status: true, disposition: true },
      },
    },
  });

  const hasMore = rows.length > CONVERSATION_PAGE_SIZE;
  const items: ConversationListItem[] = rows.slice(0, CONVERSATION_PAGE_SIZE).map((row) => ({
    id: row.id,
    businessNumber: row.businessNumber,
    contactNumber: row.contactNumber,
    contactName:
      contactDisplayName(row.contact) ||
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
  const generation = await cacheGeneration(messagesGeneration(conversationId));
  const cacheKey = `${cacheKeys.conversationMessages(conversationId, safePage)}:g${generation}`;
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

/**
 * Flag a conversation as unread again (an agent's "come back to this").
 * Keeps an existing count; otherwise sets it to 1 so the badge shows.
 */
export async function markConversationUnread(conversationId: string): Promise<number> {
  const current = await prisma.messagingConversation.findUnique({
    where: { id: conversationId },
    select: { unreadCount: true },
  });
  const unreadCount = Math.max(1, current?.unreadCount ?? 0);
  await prisma.messagingConversation.update({ where: { id: conversationId }, data: { unreadCount } });
  await invalidateConversationCaches(conversationId);
  return unreadCount;
}

export async function getTotalUnread(senderNumbers?: string[] | null): Promise<number> {
  const result = await prisma.messagingConversation.aggregate({
    _sum: { unreadCount: true },
    where: {
      isArchived: false,
      deletedAt: null,
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
 * looking at a thread, so every list is invalidated at once by bumping a shared
 * generation. This runs on every outbound broadcast message, so it must stay
 * O(1) — never a keyspace SCAN.
 */
export async function invalidateConversationCaches(conversationId: string): Promise<void> {
  await cacheBumpGeneration(messagesGeneration(conversationId), LIST_GENERATION);
}

/**
 * Soft-delete a thread: hidden from the inbox, search, unread badge and push,
 * but every message is kept, so campaign and report counts never drop. A new
 * inbound message on the same pair clears `deletedAt` (recordInboundMessage).
 */
export async function softDeleteConversation(conversationId: string): Promise<void> {
  await prisma.messagingConversation.update({
    where: { id: conversationId },
    data: { deletedAt: new Date(), unreadCount: 0 },
  });
  await invalidateConversationCaches(conversationId);
}

/* ============================================================================
 * Batch variants for the broadcast sender.
 *
 * A broadcast batch of N messages used to cost ~11 sequential database round
 * trips per message (contact lookup, conversation upsert, message insert, a
 * 4-statement summary transaction, recipient update…). These do the same
 * writes for the whole batch in 3 statements, with the same semantics as the
 * single-message functions above.
 * ==========================================================================*/

/**
 * Bulk {@link ensureConversation} for broadcast sends (restore: false):
 * creates missing threads with the contact link and owner, and on an existing
 * thread only backfills the contact link — never ownership, counters or
 * deletedAt. One INSERT … ON CONFLICT for the whole batch.
 */
export async function ensureBroadcastConversations(input: {
  businessNumber: string;
  contactNumbers: string[];
  ownerUserId?: string | null;
}): Promise<Map<string, string>> {
  const businessNumber = normalizeSender(input.businessNumber);
  const numbers = [
    ...new Set(input.contactNumbers.map((n) => normalizePhoneNumber(n)).filter((n): n is string => Boolean(n))),
  ];
  const byNumber = new Map<string, string>();
  if (numbers.length === 0) return byNumber;

  const rows = await prisma.$queryRaw<Array<{ id: string; contactNumber: string }>>`
    INSERT INTO "MessagingConversation"
           ("id", "businessNumber", "contactNumber", "contactId", "ownerUserId", "createdAt", "updatedAt")
    SELECT gen_random_uuid(), ${businessNumber}, t.n,
           (SELECT c."id" FROM "MessagingContact" c WHERE c."phoneNumber" = t.n LIMIT 1),
           ${input.ownerUserId ?? null}::uuid, NOW(), NOW()
      FROM unnest(${numbers}::text[]) AS t(n)
    ON CONFLICT ("businessNumber", "contactNumber") DO UPDATE
       SET "contactId" = COALESCE(EXCLUDED."contactId", "MessagingConversation"."contactId")
    RETURNING "id", "contactNumber"`;

  for (const row of rows) byNumber.set(row.contactNumber, row.id);
  return byNumber;
}

/** Bulk {@link recordOutboundMessage}: QUEUED rows with caller-chosen ids (the provider messageId). */
export async function recordOutboundMessagesBulk(
  rows: Array<{
    id: string;
    conversationId: string;
    fromNumber: string;
    toNumber: string;
    body: string;
    sentById?: string | null;
    broadcastId?: string | null;
  }>,
): Promise<void> {
  if (rows.length === 0) return;
  await prisma.messagingMessage.createMany({
    data: rows.map((r) => ({
      id: r.id,
      conversationId: r.conversationId,
      direction: 'OUTBOUND' as const,
      fromNumber: normalizeSender(r.fromNumber),
      toNumber: normalizePhoneNumber(r.toNumber) ?? r.toNumber,
      body: r.body,
      mediaUrls: [],
      status: 'QUEUED' as const,
      sentById: r.sentById ?? null,
      broadcastId: r.broadcastId ?? null,
    })),
  });
}

export interface BroadcastSubmitOutcome {
  messageId: string;
  conversationId: string;
  recipientId: string;
  providerMessageId: string | null;
  status: 'SENT' | 'FAILED' | 'UNDELIVERABLE';
  errorCode: string | null;
  errorMessage: string | null;
  segmentCount: number | null;
  body: string;
}

/**
 * Bulk {@link markOutboundSubmitted} + the recipient-row update, in ONE
 * statement (data-modifying CTEs run atomically): message rows get the
 * provider outcome, conversation summaries roll forward, and recipient rows
 * still in SENDING move to SENT/FAILED. Returns how many recipient rows moved.
 */
export async function markBroadcastBatchSubmitted(input: {
  providerBulkId: string | null;
  outcomes: BroadcastSubmitOutcome[];
}): Promise<number> {
  const o = input.outcomes;
  if (o.length === 0) return 0;
  const now = new Date();

  const moved = await prisma.$executeRaw`
    WITH v AS (
      SELECT * FROM unnest(
        ${o.map((x) => x.messageId)}::uuid[],
        ${o.map((x) => x.conversationId)}::uuid[],
        ${o.map((x) => x.recipientId)}::uuid[],
        ${o.map((x) => x.providerMessageId)}::text[],
        ${o.map((x) => x.status)}::text[],
        ${o.map((x) => x.errorCode)}::text[],
        ${o.map((x) => x.errorMessage)}::text[],
        ${o.map((x) => x.segmentCount)}::int[],
        ${o.map((x) => x.body.slice(0, 500))}::text[]
      ) AS t(message_id, conversation_id, recipient_id, provider_id, status, error_code, error_message, segments, body)
    ), m AS (
      UPDATE "MessagingMessage" mm
         SET "providerMessageId" = v.provider_id,
             "providerBulkId"    = ${input.providerBulkId},
             "status"            = v.status::"MessagingMessageStatus",
             "errorCode"         = v.error_code,
             "errorMessage"      = v.error_message,
             "segmentCount"      = v.segments,
             "sentAt"            = ${now},
             "updatedAt"         = ${now}
        FROM v
       WHERE mm."id" = v.message_id
      RETURNING mm."id"
    ), c AS (
      UPDATE "MessagingConversation" mc
         SET "lastMessageId"        = v.message_id,
             "lastMessageText"      = v.body,
             "lastMessageAt"        = ${now},
             "lastMessageDirection" = 'OUTBOUND',
             "lastMessageHasMedia"  = false,
             "messageCount"         = mc."messageCount" + 1,
             "updatedAt"            = ${now}
        FROM v
       WHERE mc."id" = v.conversation_id
      RETURNING mc."id"
    )
    UPDATE "SmsBroadcastRecipient" r
       SET "status"            = (CASE WHEN v.status = 'SENT' THEN 'SENT' ELSE 'FAILED' END)::"MessagingMessageStatus",
           "providerMessageId" = v.provider_id,
           "sentAt"            = ${now},
           "errorCode"         = CASE WHEN v.status = 'SENT' THEN NULL ELSE v.error_code END,
           "errorMessage"      = CASE WHEN v.status = 'SENT' THEN NULL ELSE v.error_message END,
           "updatedAt"         = ${now}
      FROM v
     WHERE r."id" = v.recipient_id
       AND r."status" = 'SENDING'`;

  await invalidateConversationCachesMany(o.map((x) => x.conversationId));
  return Number(moved) || 0;
}

/** One Redis pipeline for a whole batch of touched threads. */
export async function invalidateConversationCachesMany(conversationIds: string[]): Promise<void> {
  const unique = [...new Set(conversationIds)];
  if (unique.length === 0) return;
  await cacheBumpGeneration(...unique.map(messagesGeneration), LIST_GENERATION);
}
