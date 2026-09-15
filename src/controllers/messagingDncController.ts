/**
 * DNC lookup endpoints.
 *
 * A "listed" verdict writes a DNC_LIST suppression as a side effect, so
 * checking a number is also how you protect it — there is no separate
 * "apply the result" step to forget.
 */
import type { Request, Response } from 'express';
import prisma from '../config/prismaClient';
import { checkDnc, checkDncBulk } from '../services/messaging/dnc.service';
import { normalizePhoneNumber } from '../services/messaging/phone';

const actorId = (req: Request): string | null => req.user?.id ?? null;

class MessagingDncController {
  /** GET /messaging/dnc/check?phoneNumber=&force= */
  async check(req: Request, res: Response): Promise<void> {
    try {
      const phoneNumber = normalizePhoneNumber(req.query.phoneNumber);
      if (!phoneNumber) {
        res.status(400).json({ success: false, message: 'A valid phoneNumber is required' });
        return;
      }

      const result = await checkDnc(phoneNumber, {
        force: String(req.query.force ?? '') === 'true',
        userId: actorId(req),
      });

      res.json({ success: true, data: result });
    } catch (err) {
      console.error('[messaging:dnc] check failed:', err);
      res.status(500).json({ success: false, message: (err as Error)?.message || 'DNC lookup failed' });
    }
  }

  /**
   * POST /messaging/dnc/check-bulk  { phoneNumbers: string[] }
   * Capped so one request cannot run up an unbounded vendor bill.
   */
  async checkBulk(req: Request, res: Response): Promise<void> {
    try {
      const raw = Array.isArray(req.body?.phoneNumbers) ? req.body.phoneNumbers : [];
      const numbers = raw
        .map((value: unknown) => normalizePhoneNumber(value))
        .filter((value: string | null): value is string => Boolean(value));

      if (numbers.length === 0) {
        res.status(400).json({ success: false, message: 'phoneNumbers must contain at least one valid number' });
        return;
      }

      const MAX_PER_REQUEST = Number(process.env.DNC_MAX_BULK ?? '1000');
      if (numbers.length > MAX_PER_REQUEST) {
        res.status(400).json({
          success: false,
          message: `Too many numbers in one request (${numbers.length}). Maximum is ${MAX_PER_REQUEST}.`,
        });
        return;
      }

      const results = await checkDncBulk(numbers, { userId: actorId(req) });

      res.json({
        success: true,
        data: results,
        summary: {
          checked: results.length,
          listed: results.filter((r) => r.status === 'listed').length,
          clear: results.filter((r) => r.status === 'clear').length,
          unknown: results.filter((r) => r.status === 'unknown').length,
        },
      });
    } catch (err) {
      console.error('[messaging:dnc] bulk check failed:', err);
      res.status(500).json({ success: false, message: (err as Error)?.message || 'Bulk DNC lookup failed' });
    }
  }

  /** GET /messaging/dnc/history?page= — previously checked numbers. */
  async history(req: Request, res: Response): Promise<void> {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 50));

      const [items, total] = await Promise.all([
        prisma.messagingDncCheck.findMany({
          orderBy: { checkedAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: { id: true, phoneNumber: true, status: true, carrier: true, numberType: true, checkedAt: true },
        }),
        prisma.messagingDncCheck.count(),
      ]);

      res.json({ success: true, data: items, pagination: { page, pageSize, total, hasMore: page * pageSize < total } });
    } catch (err) {
      console.error('[messaging:dnc] history failed:', err);
      res.status(500).json({ success: false, message: 'Failed to load DNC history' });
    }
  }
}

export default new MessagingDncController();
