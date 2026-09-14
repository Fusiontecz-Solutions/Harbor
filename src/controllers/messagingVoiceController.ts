/**
 * Two-way calling via Infobip Voice / WebRTC.
 *
 * The browser never holds Infobip credentials. It asks this endpoint for a
 * short-lived WebRTC token scoped to the signed-in agent, then uses the Infobip
 * RTC SDK to place and receive calls directly. Server-initiated PSTN calls go
 * through {@link MessagingVoiceController.call} so they are logged the same way
 * browser calls are.
 */
import type { Request, Response } from 'express';
import prisma from '../config/prismaClient';
import {
  createOutboundCall,
  createWebRtcToken,
  getDefaultSender,
  toInfobipError,
} from '../services/messaging/infobip.service';
import { normalizePhoneNumber } from '../services/messaging/phone';
import { checkSuppression } from '../services/messaging/suppression.service';

class MessagingVoiceController {
  /**
   * POST /messaging/voice/token
   *
   * Identity is the Harbor user id — stable across sessions, so inbound calls
   * can be routed to whichever browser that agent currently has open.
   */
  async token(req: Request, res: Response): Promise<void> {
    try {
      const user = req.user;
      if (!user?.id) {
        res.status(401).json({ success: false, message: 'Authentication required' });
        return;
      }

      if (!String(process.env.INFOBIP_APPLICATION_ID || '').trim()) {
        res.status(503).json({
          success: false,
          message: 'Voice is not configured. Set INFOBIP_APPLICATION_ID to enable calling.',
        });
        return;
      }

      const token = await createWebRtcToken(user.id, user.name || user.email);
      res.json({ success: true, data: token });
    } catch (err) {
      const error = toInfobipError(err);
      console.error('[messaging:voice] token mint failed:', error.message);
      res.status(502).json({ success: false, message: error.message });
    }
  }

  /**
   * POST /messaging/voice/call  { toNumber, fromNumber? }
   *
   * Suppression is enforced for calls as well as messages — a contact who
   * opted out of contact has opted out of being phoned, not just texted.
   */
  async call(req: Request, res: Response): Promise<void> {
    try {
      const toNumber = normalizePhoneNumber(req.body?.toNumber);
      if (!toNumber) {
        res.status(400).json({ success: false, message: 'A valid toNumber is required' });
        return;
      }

      const verdict = await checkSuppression(toNumber);
      if (verdict.suppressed) {
        res.status(409).json({
          success: false,
          message: `Cannot call this number — ${verdict.reason ?? 'suppressed'}`,
        });
        return;
      }

      const fromNumber = String(req.body?.fromNumber ?? '').trim() || getDefaultSender();
      const result = await createOutboundCall({ to: toNumber, from: fromNumber });

      const call = await prisma.messagingCall.create({
        data: {
          providerCallId: result.providerCallId,
          fromNumber,
          toNumber,
          direction: 'OUTBOUND',
          status: result.status,
          userId: req.user?.id ?? null,
          startedAt: new Date(),
        },
      });

      res.status(201).json({ success: true, data: call });
    } catch (err) {
      const error = toInfobipError(err);
      console.error('[messaging:voice] outbound call failed:', error.message);
      res.status(502).json({ success: false, message: error.message });
    }
  }

  /** GET /messaging/voice/history?page= */
  async history(req: Request, res: Response): Promise<void> {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 50));

      const where = req.query.phoneNumber
        ? {
            OR: [
              { toNumber: normalizePhoneNumber(req.query.phoneNumber) ?? '' },
              { fromNumber: normalizePhoneNumber(req.query.phoneNumber) ?? '' },
            ],
          }
        : {};

      const [items, total] = await Promise.all([
        prisma.messagingCall.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.messagingCall.count({ where }),
      ]);

      res.json({ success: true, data: items, pagination: { page, pageSize, total, hasMore: page * pageSize < total } });
    } catch (err) {
      console.error('[messaging:voice] history failed:', err);
      res.status(500).json({ success: false, message: 'Failed to load call history' });
    }
  }

  /**
   * POST /messaging/voice/log
   * Browser-side WebRTC calls are established by the SDK without touching our
   * server, so the client reports the outcome here to keep one call log.
   */
  async log(req: Request, res: Response): Promise<void> {
    try {
      const toNumber = normalizePhoneNumber(req.body?.toNumber);
      const fromNumber = String(req.body?.fromNumber ?? '').trim() || getDefaultSender();
      if (!toNumber) {
        res.status(400).json({ success: false, message: 'A valid toNumber is required' });
        return;
      }

      const providerCallId = req.body?.providerCallId ? String(req.body.providerCallId) : null;
      const duration = Number(req.body?.durationSeconds);

      const data = {
        fromNumber,
        toNumber,
        direction: (String(req.body?.direction ?? 'OUTBOUND').toUpperCase() === 'INBOUND'
          ? 'INBOUND'
          : 'OUTBOUND') as 'INBOUND' | 'OUTBOUND',
        status: String(req.body?.status ?? 'completed'),
        durationSeconds: Number.isFinite(duration) ? Math.round(duration) : null,
        userId: req.user?.id ?? null,
        startedAt: req.body?.startedAt ? new Date(req.body.startedAt) : null,
        endedAt: new Date(),
      };

      // Upsert on the provider call id so the SDK and the webhook converge on
      // one row instead of logging the same call twice.
      const call = providerCallId
        ? await prisma.messagingCall.upsert({
            where: { providerCallId },
            create: { ...data, providerCallId },
            update: data,
          })
        : await prisma.messagingCall.create({ data });

      res.status(201).json({ success: true, data: call });
    } catch (err) {
      console.error('[messaging:voice] log failed:', err);
      res.status(400).json({ success: false, message: (err as Error)?.message || 'Failed to log call' });
    }
  }
}

export default new MessagingVoiceController();
