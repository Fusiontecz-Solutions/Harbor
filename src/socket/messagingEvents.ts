/**
 * Realtime fan-out for the messaging module.
 *
 * Event names are kept identical to Fivra's (`new_message`,
 * `message_status_update`, `conversation_update`, `unread_count_update`) so the
 * ported frontend hook works unchanged, and so anyone who knows one codebase
 * can read the other.
 *
 * Two rooms:
 *   `messaging:inbox`          every agent with the inbox open — list updates
 *   `messaging:conv:<id>`      agents viewing one thread — message updates
 *
 * Every emit is best-effort. Sockets are an optimization on top of the REST +
 * cache path; the frontend falls back to polling when the connection drops, so
 * a failed emit must never fail the write that triggered it.
 */
import { getSocketIO } from './index';

export const MESSAGING_INBOX_ROOM = 'messaging:inbox';

export const conversationRoom = (conversationId: string): string => `messaging:conv:${conversationId}`;

function emit(room: string, event: string, payload: unknown): void {
  const io = getSocketIO();
  if (!io) return;

  try {
    io.to(room).emit(event, payload);
  } catch (err) {
    console.error('[messaging:socket] emit failed:', { room, event, error: (err as Error)?.message });
  }
}

/** A message arrived or was sent on a thread. */
export function emitNewMessage(conversationId: string, message: unknown): void {
  const payload = { type: 'new_message', conversationId, message, timestamp: new Date().toISOString() };
  emit(conversationRoom(conversationId), 'new_message', payload);
  // The inbox list also needs it — the thread jumps to the top.
  emit(MESSAGING_INBOX_ROOM, 'new_message', payload);
}

/** A delivery report moved a message between statuses. */
export function emitMessageStatusUpdate(
  conversationId: string,
  update: { messageId: string; providerMessageId: string | null; status: string; errorMessage?: string | null },
): void {
  emit(conversationRoom(conversationId), 'message_status_update', {
    type: 'message_status_update',
    conversationId,
    ...update,
    timestamp: new Date().toISOString(),
  });
}

/** Summary fields changed (unread cleared, opted out, blocked, archived). */
export function emitConversationUpdate(conversation: { id: string } & Record<string, unknown>): void {
  emit(MESSAGING_INBOX_ROOM, 'conversation_update', {
    type: 'conversation_update',
    conversation,
    timestamp: new Date().toISOString(),
  });
}

export function emitUnreadCountUpdate(unreadCount: number): void {
  emit(MESSAGING_INBOX_ROOM, 'unread_count_update', {
    type: 'unread_count_update',
    unreadCount,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Broadcast progress. Emitted on the debounced stats flush rather than per
 * message, so a 50k-recipient blast produces a readable trickle of updates
 * instead of 50k socket frames.
 */
export function emitBroadcastProgress(broadcastId: string, stats: Record<string, unknown>): void {
  emit(MESSAGING_INBOX_ROOM, 'broadcast_progress', {
    type: 'broadcast_progress',
    broadcastId,
    stats,
    timestamp: new Date().toISOString(),
  });
}
