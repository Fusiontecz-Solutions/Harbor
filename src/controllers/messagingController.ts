/**
 * Inbox HTTP surface: conversation list, thread history, sending, read state.
 *
 * Responses follow Harbor's existing `{ success, data | message }` envelope so
 * the frontend's axios interceptors behave the same as everywhere else.
 */
import type { Request, Response } from 'express';
import prisma from '../config/prismaClient';
import {
  emitConversationUpdate,
  emitUnreadCountUpdate,
} from '../socket/messagingEvents';
import {
  CONVERSATION_PAGE_SIZE,
  MESSAGE_PAGE_SIZE,
  ensureConversation,
  getTotalUnread,
  listConversations,
  listMessages,
  markConversationRead,
  markConversationUnread,
} from '../services/messaging/conversation.service';
import {
  getPushPublicKey,
  parseSubscription,
  removeSubscription,
  saveSubscription,
  sendTestPush,
} from '../services/messaging/push.service';
import {
  findClientById,
  upsertContactFromClient,
} from '../services/messaging/clientRecipients.service';
import { getDefaultSender, isInfobipConfigured } from '../services/messaging/infobip.service';
import {
  isPrivilegedMessagingRole,
  resolveSenderDetailForUser,
  resolveSenderForActor,
  visibleSendersForUser,
} from '../services/messaging/sender.service';
import { messagingPerformance } from '../services/messaging/performance.service';
import { normalizePhoneNumber } from '../services/messaging/phone';
import { analyzeSmsText } from '../services/messaging/smsSegments';
import { dispatchOutboundMessage } from '../services/messaging/sms.service';

const actorId = (req: Request): string | null => req.user?.id ?? null;

const errorStatus = (err: unknown, fallback: number): number =>
  Number((err as { statusCode?: number })?.statusCode) || fallback;

/**
 * The conversation when it is in the caller's inbox scope, else null.
 * Every by-id route goes through this: scoping the list alone would still
 * leave another user's thread readable, archivable or deletable by id.
 */
async function findVisibleConversation(req: Request, conversationId: string) {
  const conversation = await prisma.messagingConversation.findUnique({
    where: { id: conversationId },
    select: { id: true, businessNumber: true, unreadCount: true },
  });
  if (!conversation) return null;
  const allowed = await visibleSendersForUser(actorId(req), req.user?.role);
  if (allowed && !allowed.includes(conversation.businessNumber)) return null;
  return conversation;
}

class MessagingController {
  /** GET /messaging/conversations?page=&search=&filter= */
  async getConversations(req: Request, res: Response): Promise<void> {
    try {
      const userId = actorId(req);
      if (!userId) {
        res.status(401).json({ success: false, message: 'Authentication required' });
        return;
      }

      const result = await listConversations({
        userId,
        page: Number(req.query.page) || 1,
        search: String(req.query.search ?? ''),
        filter: String(req.query.filter ?? 'regular'),
        senderNumbers: await visibleSendersForUser(userId, req.user?.role),
      });

      res.json({
        success: true,
        data: result.items,
        pagination: { page: result.page, pageSize: CONVERSATION_PAGE_SIZE, hasMore: result.hasMore },
      });
    } catch (err) {
      console.error('[messaging] getConversations failed:', err);
      res.status(500).json({ success: false, message: (err as Error)?.message || 'Failed to load conversations' });
    }
  }

  /** GET /messaging/conversations/:id/messages?page= */
  async getMessages(req: Request, res: Response): Promise<void> {
    try {
      const conversationId = String(req.params.id);
      if (!(await findVisibleConversation(req, conversationId))) {
        res.status(404).json({ success: false, message: 'Conversation not found' });
        return;
      }

      const result = await listMessages(conversationId, Number(req.query.page) || 1);

      res.json({
        success: true,
        data: result.items,
        pagination: { page: result.page, pageSize: MESSAGE_PAGE_SIZE, hasMore: result.hasMore },
      });
    } catch (err) {
      console.error('[messaging] getMessages failed:', err);
      res.status(500).json({ success: false, message: (err as Error)?.message || 'Failed to load messages' });
    }
  }

  /**
   * POST /messaging/conversations
   * Open (or reuse) a thread with a number, so the UI can start a chat before
   * the first message exists.
   */
  async openConversation(req: Request, res: Response): Promise<void> {
    try {
      const contactNumber = normalizePhoneNumber(req.body?.phoneNumber);
      if (!contactNumber) {
        res.status(400).json({ success: false, message: 'A valid phoneNumber is required' });
        return;
      }

      // The acting user's assigned sender, falling back to INFOBIP_SENDER.
      const businessNumber = await resolveSenderForActor(actorId(req), req.user?.role, req.body?.fromNumber);
      if (!businessNumber) {
        res.status(400).json({ success: false, message: 'No sender configured — set INFOBIP_SENDER' });
        return;
      }

      const conversation = await ensureConversation({
        businessNumber,
        contactNumber,
        ownerUserId: actorId(req),
      });

      res.status(201).json({ success: true, data: conversation });
    } catch (err) {
      console.error('[messaging] openConversation failed:', err);
      res.status(errorStatus(err, 500)).json({ success: false, message: (err as Error)?.message || 'Failed to open conversation' });
    }
  }

  /**
   * POST /messaging/send
   * One-to-one send. Suppression, rate limiting and persistence all happen in
   * dispatchOutboundMessage — this only translates the result to HTTP.
   */
  async sendMessage(req: Request, res: Response): Promise<void> {
    try {
      if (!isInfobipConfigured()) {
        res.status(503).json({
          success: false,
          message: 'Messaging is not configured. Set INFOBIP_BASE_URL, INFOBIP_API_KEY and INFOBIP_SENDER.',
        });
        return;
      }

      const body = String(req.body?.body ?? '').trim();
      if (!body) {
        res.status(400).json({ success: false, message: 'Message body is required' });
        return;
      }
      const sms = analyzeSmsText(body);

      const toNumber = normalizePhoneNumber(req.body?.toNumber);
      if (!toNumber) {
        res.status(400).json({ success: false, message: 'A valid toNumber is required' });
        return;
      }

      const mediaUrls = Array.isArray(req.body?.mediaUrls)
        ? req.body.mediaUrls.map((url: unknown) => String(url)).filter(Boolean)
        : undefined;

      // Chat started from the CRM client picker: mirror the client into a
      // MessagingContact BEFORE dispatching, because ensureConversation links
      // whatever contact exists at that moment. Done here rather than when the
      // agent picks the client so nothing is written for a chat they abandon.
      const clientId = String(req.body?.clientId ?? '').trim();
      if (clientId && isPrivilegedMessagingRole(req.user?.role)) {
        const client = await findClientById(clientId);
        if (client) {
          await upsertContactFromClient(client, toNumber, actorId(req));
        }
      }

      const fromNumber = await resolveSenderForActor(actorId(req), req.user?.role, req.body?.fromNumber);

      const result = await dispatchOutboundMessage({
        toNumber,
        fromNumber,
        body,
        mediaUrls,
        sentById: actorId(req),
      });

      if (result.status === 'suppressed') {
        res.status(409).json({ success: false, message: `Cannot message this number — ${result.reason}`, data: result });
        return;
      }

      if (result.status === 'failed' || result.status === 'rate_limited') {
        res.status(502).json({ success: false, message: result.reason || 'Send failed', data: result });
        return;
      }

      res.status(201).json({ success: true, data: { ...result, sms } });
    } catch (err) {
      console.error('[messaging] sendMessage failed:', err);
      res.status(errorStatus(err, 500)).json({ success: false, message: (err as Error)?.message || 'Failed to send message' });
    }
  }

  /** PATCH /messaging/conversations/:id/read */
  async markRead(req: Request, res: Response): Promise<void> {
    try {
      const conversationId = String(req.params.id);
      if (!(await findVisibleConversation(req, conversationId))) {
        res.status(404).json({ success: false, message: 'Conversation not found' });
        return;
      }
      await markConversationRead(conversationId);

      emitConversationUpdate({ id: conversationId, unreadCount: 0 });
      emitUnreadCountUpdate(conversationId);

      res.json({ success: true, data: { id: conversationId, unreadCount: 0 } });
    } catch (err) {
      console.error('[messaging] markRead failed:', err);
      res.status(500).json({ success: false, message: (err as Error)?.message || 'Failed to mark conversation read' });
    }
  }

  /** PATCH /messaging/conversations/:id/unread — "keep this for later". */
  async markUnread(req: Request, res: Response): Promise<void> {
    try {
      const conversationId = String(req.params.id);
      if (!(await findVisibleConversation(req, conversationId))) {
        res.status(404).json({ success: false, message: 'Conversation not found' });
        return;
      }
      const unreadCount = await markConversationUnread(conversationId);

      emitConversationUpdate({ id: conversationId, unreadCount });
      emitUnreadCountUpdate(conversationId);

      res.json({ success: true, data: { id: conversationId, unreadCount } });
    } catch (err) {
      console.error('[messaging] markUnread failed:', err);
      res.status(500).json({ success: false, message: (err as Error)?.message || 'Failed to mark conversation unread' });
    }
  }

  /** GET /messaging/push/config — the VAPID public key a browser subscribes with. */
  async pushConfig(_req: Request, res: Response): Promise<void> {
    const publicKey = getPushPublicKey();
    res.json({ success: true, data: { enabled: Boolean(publicKey), publicKey } });
  }

  /** POST /messaging/push/subscribe — body: the browser PushSubscription JSON. */
  async pushSubscribe(req: Request, res: Response): Promise<void> {
    try {
      const userId = actorId(req);
      const sub = parseSubscription(req.body?.subscription ?? req.body);
      if (!userId || !sub) {
        res.status(400).json({ success: false, message: 'A valid push subscription is required' });
        return;
      }
      await saveSubscription(userId, sub, String(req.headers['user-agent'] ?? '').slice(0, 300) || null);
      res.json({ success: true });
    } catch (err) {
      console.error('[messaging] push subscribe failed:', err);
      res.status(500).json({ success: false, message: 'Failed to save push subscription' });
    }
  }

  /** POST /messaging/push/unsubscribe — body: { endpoint } */
  async pushUnsubscribe(req: Request, res: Response): Promise<void> {
    try {
      const endpoint = String(req.body?.endpoint ?? '').trim();
      if (endpoint) await removeSubscription(endpoint, actorId(req) ?? undefined);
      res.json({ success: true });
    } catch (err) {
      console.error('[messaging] push unsubscribe failed:', err);
      res.status(500).json({ success: false, message: 'Failed to remove push subscription' });
    }
  }

  /** POST /messaging/push/test — send a test notification to the caller's devices. */
  async pushTest(req: Request, res: Response): Promise<void> {
    try {
      const userId = actorId(req);
      if (!userId) {
        res.status(401).json({ success: false, message: 'Authentication required' });
        return;
      }
      res.json({ success: true, data: { delivered: await sendTestPush(userId) } });
    } catch (err) {
      console.error('[messaging] push test failed:', err);
      res.status(500).json({ success: false, message: 'Failed to send test notification' });
    }
  }

  /** PATCH /messaging/conversations/:id/archive */
  async setArchived(req: Request, res: Response): Promise<void> {
    try {
      const conversationId = String(req.params.id);
      const isArchived = Boolean(req.body?.isArchived ?? true);
      if (!(await findVisibleConversation(req, conversationId))) {
        res.status(404).json({ success: false, message: 'Conversation not found' });
        return;
      }

      const conversation = await prisma.messagingConversation.update({
        where: { id: conversationId },
        data: { isArchived },
        select: { id: true, isArchived: true },
      });

      emitConversationUpdate(conversation);
      res.json({ success: true, data: conversation });
    } catch (err) {
      console.error('[messaging] setArchived failed:', err);
      res.status(500).json({ success: false, message: (err as Error)?.message || 'Failed to update conversation' });
    }
  }

  /**
   * DELETE /messaging/conversations/:id
   *
   * Removes the thread and its history. `MessagingMessage.conversationId`
   * cascades, so the single delete takes the messages with it.
   *
   * Deliberately NOT deleted: the MessagingContact record and any suppression
   * entry. Deleting a chat is a housekeeping action on the inbox — it must
   * never un-block a number or erase the fact that someone replied STOP, or
   * the next broadcast would message a contact who opted out.
   */
  async deleteConversation(req: Request, res: Response): Promise<void> {
    try {
      const conversationId = String(req.params.id);

      const existing = await findVisibleConversation(req, conversationId);
      if (!existing) {
        res.status(404).json({ success: false, message: 'Conversation not found' });
        return;
      }

      await prisma.messagingConversation.delete({ where: { id: conversationId } });

      // The FE treats any conversation_update as "refetch page 1", which is
      // what we want here — the row simply stops coming back.
      // The row is gone, so pass its number — the emit cannot look it up.
      emitConversationUpdate({ id: conversationId, deleted: true, businessNumber: existing.businessNumber });
      if (existing.unreadCount > 0) {
        emitUnreadCountUpdate(conversationId, existing.businessNumber);
      }

      res.json({ success: true, data: { id: conversationId } });
    } catch (err) {
      console.error('[messaging] deleteConversation failed:', err);
      res.status(500).json({ success: false, message: (err as Error)?.message || 'Failed to delete conversation' });
    }
  }

  /**
   * GET /messaging/stats/performance?from=&to=
   *
   * Per-user messaging performance for the range. Admin-only: it reports on
   * other people's activity, not the caller's own.
   */
  async performance(req: Request, res: Response): Promise<void> {
    try {
      if (!isPrivilegedMessagingRole(req.user?.role)) {
        res.status(403).json({ success: false, message: 'Forbidden: admins only' });
        return;
      }

      const data = await messagingPerformance({
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
      });

      res.json({ success: true, data });
    } catch (err) {
      console.error('[messaging] performance failed:', err);
      res.status(400).json({ success: false, message: (err as Error)?.message || 'Failed to load performance' });
    }
  }

  /** GET /messaging/unread-count */
  async getUnreadCount(_req: Request, res: Response): Promise<void> {
    try {
      const scope = await visibleSendersForUser(actorId(_req), _req.user?.role);
      res.json({ success: true, data: { unreadCount: await getTotalUnread(scope) } });
    } catch (err) {
      console.error('[messaging] getUnreadCount failed:', err);
      res.status(500).json({ success: false, message: 'Failed to load unread count' });
    }
  }

  /** GET /messaging/config — what the FE needs to render the composer. */
  async getConfig(_req: Request, res: Response): Promise<void> {
    const sender = await resolveSenderDetailForUser(actorId(_req));
    const { getPrepaidState } = await import('../services/tenantControl/prepaid');
    const prepaid = await getPrepaidState();
    res.json({
      success: true,
      data: {
        provider: 'infobip',
        configured: isInfobipConfigured(),
        prepaid,
        // What THIS user will send as, not the global env value.
        defaultSender: sender.phoneNumber || getDefaultSender() || null,
        /** Label of the assigned sender, null when falling back to the env default. */
        defaultSenderLabel: sender.label,
        /** False when nobody has assigned this user a number yet. */
        senderAssigned: sender.assigned,
        voiceEnabled: Boolean(String(process.env.INFOBIP_APPLICATION_ID || '').trim()),
      },
    });
  }
}

export default new MessagingController();
