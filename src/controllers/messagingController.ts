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
} from '../services/messaging/conversation.service';
import { getDefaultSender, isInfobipConfigured } from '../services/messaging/infobip.service';
import { normalizePhoneNumber } from '../services/messaging/phone';
import { dispatchOutboundMessage } from '../services/messaging/sms.service';

const actorId = (req: Request): string | null => req.user?.id ?? null;

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
        filter: String(req.query.filter ?? 'all'),
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
      const conversation = await prisma.messagingConversation.findUnique({
        where: { id: conversationId },
        select: { id: true },
      });

      if (!conversation) {
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

      const businessNumber = String(req.body?.fromNumber ?? '').trim() || getDefaultSender();
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
      res.status(500).json({ success: false, message: (err as Error)?.message || 'Failed to open conversation' });
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

      const toNumber = normalizePhoneNumber(req.body?.toNumber);
      if (!toNumber) {
        res.status(400).json({ success: false, message: 'A valid toNumber is required' });
        return;
      }

      const mediaUrls = Array.isArray(req.body?.mediaUrls)
        ? req.body.mediaUrls.map((url: unknown) => String(url)).filter(Boolean)
        : undefined;

      const result = await dispatchOutboundMessage({
        toNumber,
        fromNumber: req.body?.fromNumber,
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

      res.status(201).json({ success: true, data: result });
    } catch (err) {
      console.error('[messaging] sendMessage failed:', err);
      res.status(500).json({ success: false, message: (err as Error)?.message || 'Failed to send message' });
    }
  }

  /** PATCH /messaging/conversations/:id/read */
  async markRead(req: Request, res: Response): Promise<void> {
    try {
      const conversationId = String(req.params.id);
      await markConversationRead(conversationId);

      emitConversationUpdate({ id: conversationId, unreadCount: 0 });
      emitUnreadCountUpdate(await getTotalUnread());

      res.json({ success: true, data: { id: conversationId, unreadCount: 0 } });
    } catch (err) {
      console.error('[messaging] markRead failed:', err);
      res.status(500).json({ success: false, message: (err as Error)?.message || 'Failed to mark conversation read' });
    }
  }

  /** PATCH /messaging/conversations/:id/archive */
  async setArchived(req: Request, res: Response): Promise<void> {
    try {
      const conversationId = String(req.params.id);
      const isArchived = Boolean(req.body?.isArchived ?? true);

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

  /** GET /messaging/unread-count */
  async getUnreadCount(_req: Request, res: Response): Promise<void> {
    try {
      res.json({ success: true, data: { unreadCount: await getTotalUnread() } });
    } catch (err) {
      console.error('[messaging] getUnreadCount failed:', err);
      res.status(500).json({ success: false, message: 'Failed to load unread count' });
    }
  }

  /** GET /messaging/config — what the FE needs to render the composer. */
  async getConfig(_req: Request, res: Response): Promise<void> {
    res.json({
      success: true,
      data: {
        provider: 'infobip',
        configured: isInfobipConfigured(),
        defaultSender: getDefaultSender() || null,
        voiceEnabled: Boolean(String(process.env.INFOBIP_APPLICATION_ID || '').trim()),
      },
    });
  }
}

export default new MessagingController();
