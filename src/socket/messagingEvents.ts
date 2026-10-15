/**
 * Realtime fan-out for the messaging module.
 *
 * Event names are kept identical to Fivra's (`new_message`,
 * `message_status_update`, `conversation_update`, `unread_count_update`) so the
 * ported frontend hook works unchanged, and so anyone who knows one codebase
 * can read the other.
 *
 * Rooms mirror the inbox list's visibility rule (visibleSendersForUser):
 *   `messaging:all`               privileged roles — every thread
 *   `messaging:sender:<number>`   reps — only threads on their own number
 *   `messaging:conv:<id>`         sockets viewing one thread (joined only after
 *                                 the same visibility check the REST route does)
 *
 * Every list-level event is emitted to `messaging:all` plus the thread's sender
 * room, never to a room every socket is in — a rep must not receive another
 * rep's message bodies over the socket any more than over the API.
 *
 * Every emit is best-effort. Sockets are an optimization on top of the REST +
 * cache path; the frontend revalidates on reconnect and keeps a slow poll, so a
 * failed emit must never fail the write that triggered it.
 */
import prisma from '../config/prismaClient';
import { getTotalUnread } from '../services/messaging/conversation.service';
import { getSocketIO } from './index';

export const MESSAGING_ALL_ROOM = 'messaging:all';

/** Every authenticated messaging socket — carries aggregate campaign counters only, never message content. */
export const MESSAGING_BROADCASTS_ROOM = 'messaging:broadcasts';

export const senderRoom = (businessNumber: string): string => `messaging:sender:${businessNumber}`;

export const conversationRoom = (conversationId: string): string => `messaging:conv:${conversationId}`;

/**
 * conversationId → businessNumber. A conversation's business number never
 * changes, so entries never go stale; the map is only bounded.
 */
const businessNumberCache = new Map<string, string>();
const BUSINESS_NUMBER_CACHE_MAX = 5_000;

function rememberBusinessNumber(conversationId: string, businessNumber: string): void {
  if (!conversationId || !businessNumber) return;
  if (businessNumberCache.size >= BUSINESS_NUMBER_CACHE_MAX) {
    const oldest = businessNumberCache.keys().next().value;
    if (oldest !== undefined) businessNumberCache.delete(oldest);
  }
  businessNumberCache.set(conversationId, businessNumber);
}

async function businessNumberFor(conversationId: string): Promise<string | null> {
  const cached = businessNumberCache.get(conversationId);
  if (cached) return cached;
  const row = await prisma.messagingConversation.findUnique({
    where: { id: conversationId },
    select: { businessNumber: true },
  });
  if (!row?.businessNumber) return null;
  rememberBusinessNumber(conversationId, row.businessNumber);
  return row.businessNumber;
}

/** Rooms allowed to see list-level events for this conversation. */
async function listRoomsFor(conversationId: string, knownBusinessNumber?: string | null): Promise<string[]> {
  if (knownBusinessNumber) rememberBusinessNumber(conversationId, knownBusinessNumber);
  const businessNumber = knownBusinessNumber || (await businessNumberFor(conversationId));
  return businessNumber ? [MESSAGING_ALL_ROOM, senderRoom(businessNumber)] : [MESSAGING_ALL_ROOM];
}

function emit(rooms: string[], event: string, payload: unknown): void {
  const io = getSocketIO();
  if (!io || rooms.length === 0) return;

  try {
    // One emit to several rooms: socket.io de-duplicates a socket in more than
    // one of them, so nobody gets the event twice.
    io.to(rooms).emit(event, payload);
  } catch (err) {
    console.error('[messaging:socket] emit failed:', { rooms, event, error: (err as Error)?.message });
  }
}

/** Run an async emit without ever surfacing its failure to the caller. */
function fireAndForget(label: string, work: () => Promise<void>): void {
  if (!getSocketIO()) return;
  work().catch((err) => console.error(`[messaging:socket] ${label} failed:`, (err as Error)?.message));
}

/** A message arrived or was sent on a thread. */
export function emitNewMessage(conversationId: string, message: unknown): void {
  fireAndForget('new_message', async () => {
    const payload = { type: 'new_message', conversationId, message, timestamp: new Date().toISOString() };
    // Thread viewers are already visibility-checked on join; list rooms are
    // scoped by sender. Socket.io de-duplicates across the union.
    const rooms = await listRoomsFor(conversationId);
    emit([...rooms, conversationRoom(conversationId)], 'new_message', payload);
  });
}

/** A delivery report moved a message between statuses. */
export function emitMessageStatusUpdate(
  conversationId: string,
  update: { messageId: string; providerMessageId: string | null; status: string; errorMessage?: string | null },
): void {
  fireAndForget('message_status_update', async () => {
    const rooms = await listRoomsFor(conversationId);
    emit([...rooms, conversationRoom(conversationId)], 'message_status_update', {
      type: 'message_status_update',
      conversationId,
      ...update,
      timestamp: new Date().toISOString(),
    });
  });
}

/**
 * Summary fields changed (unread cleared, opted out, blocked, archived,
 * deleted). Pass `businessNumber` when the row may no longer exist.
 */
export function emitConversationUpdate(
  conversation: { id: string; businessNumber?: string | null } & Record<string, unknown>,
): void {
  fireAndForget('conversation_update', async () => {
    const rooms = await listRoomsFor(conversation.id, conversation.businessNumber ?? null);
    emit(rooms, 'conversation_update', {
      type: 'conversation_update',
      conversation,
      timestamp: new Date().toISOString(),
    });
  });
}

/**
 * Unread badge totals after a change to `conversationId`. Each audience gets
 * its own total: privileged viewers the whole inbox, the sender's room only
 * that number's threads — the same scoping as the list.
 */
export function emitUnreadCountUpdate(conversationId: string, knownBusinessNumber?: string | null): void {
  fireAndForget('unread_count_update', async () => {
    if (knownBusinessNumber) rememberBusinessNumber(conversationId, knownBusinessNumber);
    const businessNumber = knownBusinessNumber || (await businessNumberFor(conversationId));
    const timestamp = new Date().toISOString();

    emit([MESSAGING_ALL_ROOM], 'unread_count_update', {
      type: 'unread_count_update',
      unreadCount: await getTotalUnread(),
      timestamp,
    });
    if (businessNumber) {
      emit([senderRoom(businessNumber)], 'unread_count_update', {
        type: 'unread_count_update',
        unreadCount: await getTotalUnread([businessNumber]),
        timestamp,
      });
    }
  });
}

/**
 * Broadcast progress. Emitted on the debounced stats flush rather than per
 * message, so a 50k-recipient blast produces a readable trickle of updates
 * instead of 50k socket frames. The payload is aggregate counters only (no
 * bodies or numbers), matching what GET /messaging/broadcasts shows any user.
 */
export function emitBroadcastProgress(broadcastId: string, stats: Record<string, unknown>): void {
  emit([MESSAGING_BROADCASTS_ROOM], 'broadcast_progress', {
    type: 'broadcast_progress',
    broadcastId,
    stats,
    timestamp: new Date().toISOString(),
  });
}
