/**
 * Broadcast HTTP surface.
 *
 * Creation and starting are deliberately separate calls: creating runs the
 * suppression preflight and returns the true reachable audience, so an operator
 * confirms "42,180 of 50,000 will receive this" before anything is sent.
 */
import type { Request, Response } from 'express';
import prisma from '../config/prismaClient';
import {
  cancelBroadcast,
  createBroadcast,
  getBroadcastStats,
  pauseBroadcast,
  startBroadcast,
} from '../services/messaging/broadcast.service';
import { parseContactSheet } from '../services/messaging/contact.service';
import { normalizePhoneNumber } from '../services/messaging/phone';
import {
  exportAudienceCsv,
  getBroadcastAudience,
  getErrorBreakdown,
  type AudienceBucket,
} from '../services/messaging/broadcastAudience.service';
import { resolveClientsAsRecipients } from '../services/messaging/clientRecipients.service';
import { cleanupUploadedTempFiles, readUploadedFile } from '../utils/readUploadedFile';

/** Buckets the drill-down understands; anything else falls back to 'all'. */
const AUDIENCE_BUCKETS = new Set<AudienceBucket>([
  'all',
  'queued',
  'sending',
  'sent',
  'delivered',
  'failed',
  'undeliverable',
  'suppressed',
  'replied',
  'opted-out',
]);

const parseBucket = (raw: unknown): AudienceBucket => {
  const value = String(raw ?? 'all').toLowerCase() as AudienceBucket;
  return AUDIENCE_BUCKETS.has(value) ? value : 'all';
};

const actorId = (req: Request): string | null => req.user?.id ?? null;

class MessagingBroadcastController {
  /** GET /messaging/broadcasts?page=&status= */
  async list(req: Request, res: Response): Promise<void> {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
      const status = req.query.status ? String(req.query.status) : undefined;

      const where = status ? { status: status as never } : {};

      const [items, total] = await Promise.all([
        prisma.smsBroadcast.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            campaignKey: true,
            name: true,
            status: true,
            fromNumber: true,
            totalRecipients: true,
            queuedCount: true,
            sentCount: true,
            deliveredCount: true,
            failedCount: true,
            suppressedCount: true,
            repliedCount: true,
            optOutCount: true,
            startedAt: true,
            finishedAt: true,
            createdAt: true,
          },
        }),
        prisma.smsBroadcast.count({ where }),
      ]);

      res.json({
        success: true,
        data: items,
        pagination: { page, pageSize, total, hasMore: page * pageSize < total },
      });
    } catch (err) {
      console.error('[messaging:broadcast] list failed:', err);
      res.status(500).json({ success: false, message: 'Failed to load broadcasts' });
    }
  }

  /**
   * POST /messaging/broadcasts
   * Recipients come either as a JSON array or as an uploaded spreadsheet.
   */
  async create(req: Request, res: Response): Promise<void> {
    try {
      let recipients: Array<{ phoneNumber: string; mergeData?: Record<string, unknown> }> = [];

      const upload = readUploadedFile(req);
      if (upload) {
        const { rows, columnMapping } = parseContactSheet(upload.buffer);
        const phoneHeader = Object.entries(columnMapping).find(([, field]) => field === 'phoneNumber')?.[0];

        if (!phoneHeader) {
          res.status(400).json({
            success: false,
            message: `No phone number column found in the uploaded sheet. Headers seen: ${Object.keys(rows[0] ?? {}).join(', ') || 'none'}`,
          });
          return;
        }

        recipients = rows.flatMap((row) => {
          const phoneNumber = normalizePhoneNumber(row[phoneHeader]);
          if (!phoneNumber) return [];
          // Every other column becomes a merge field, so {{firstName}} in the
          // body resolves from the sheet without extra configuration.
          const mergeData: Record<string, unknown> = {};
          for (const [header, field] of Object.entries(columnMapping)) {
            if (field !== 'phoneNumber') mergeData[field] = row[header];
          }
          return [{ phoneNumber, mergeData }];
        });
      } else if (Array.isArray(req.body?.recipients)) {
        recipients = req.body.recipients;
      }

      // CRM clients as an audience — resolved to numbers + merge data, and
      // reported back so the operator sees who was skipped and why.
      let skippedClients: Array<{ clientId: string; businessName: string; reason: string }> = [];
      if (Array.isArray(req.body?.clientIds) && req.body.clientIds.length > 0) {
        const resolved = await resolveClientsAsRecipients(
          req.body.clientIds.map(String),
          actorId(req),
        );
        recipients = [...recipients, ...resolved.recipients];
        skippedClients = resolved.skipped;
      }

      // Saved messaging contacts, by id.
      if (Array.isArray(req.body?.contactIds) && req.body.contactIds.length > 0) {
        const contacts = await prisma.messagingContact.findMany({
          where: { id: { in: req.body.contactIds.map(String) } },
          select: { phoneNumber: true, firstName: true, lastName: true, company: true, city: true, state: true },
        });
        recipients = [
          ...recipients,
          ...contacts.map((contact) => ({
            phoneNumber: contact.phoneNumber,
            mergeData: {
              firstName: contact.firstName,
              lastName: contact.lastName,
              company: contact.company,
              city: contact.city,
              state: contact.state,
            },
          })),
        ];
      }

      if (recipients.length === 0) {
        res.status(400).json({
          success: false,
          message:
            'No recipients. Upload a spreadsheet in the "file" field, or pass recipients / clientIds / contactIds.',
          skippedClients,
        });
        return;
      }

      const result = await createBroadcast({
        name: String(req.body?.name ?? ''),
        body: String(req.body?.body ?? req.body?.message ?? ''),
        fromNumber: req.body?.fromNumber,
        mediaUrls: Array.isArray(req.body?.mediaUrls) ? req.body.mediaUrls.map(String) : undefined,
        recipients,
        throttlePerSecond: req.body?.throttlePerSecond ? Number(req.body.throttlePerSecond) : null,
        scheduledAt: req.body?.scheduledAt ? new Date(req.body.scheduledAt) : null,
        createdById: actorId(req),
      });

      // Optional one-shot: create and immediately start.
      if (req.body?.startNow === true || String(req.body?.startNow) === 'true') {
        const started = await startBroadcast(result.id);
        res.status(201).json({ success: true, data: { ...result, skippedClients, started } });
        return;
      }

      res.status(201).json({ success: true, data: { ...result, skippedClients } });
    } catch (err) {
      console.error('[messaging:broadcast] create failed:', err);
      res.status(400).json({ success: false, message: (err as Error)?.message || 'Failed to create broadcast' });
    } finally {
      cleanupUploadedTempFiles(req);
    }
  }

  /** POST /messaging/broadcasts/:id/start */
  async start(req: Request, res: Response): Promise<void> {
    try {
      const result = await startBroadcast(String(req.params.id));
      res.json({ success: true, data: result });
    } catch (err) {
      console.error('[messaging:broadcast] start failed:', err);
      res.status(400).json({ success: false, message: (err as Error)?.message || 'Failed to start broadcast' });
    }
  }

  /** POST /messaging/broadcasts/:id/pause */
  async pause(req: Request, res: Response): Promise<void> {
    try {
      await pauseBroadcast(String(req.params.id));
      res.json({ success: true, data: { id: req.params.id, status: 'PAUSED' } });
    } catch (err) {
      console.error('[messaging:broadcast] pause failed:', err);
      res.status(400).json({ success: false, message: (err as Error)?.message || 'Failed to pause broadcast' });
    }
  }

  /** POST /messaging/broadcasts/:id/cancel */
  async cancel(req: Request, res: Response): Promise<void> {
    try {
      await cancelBroadcast(String(req.params.id));
      res.json({ success: true, data: { id: req.params.id, status: 'CANCELLED' } });
    } catch (err) {
      console.error('[messaging:broadcast] cancel failed:', err);
      res.status(400).json({ success: false, message: (err as Error)?.message || 'Failed to cancel broadcast' });
    }
  }

  /** GET /messaging/broadcasts/:id */
  async stats(req: Request, res: Response): Promise<void> {
    try {
      const broadcast = await getBroadcastStats(String(req.params.id));
      if (!broadcast) {
        res.status(404).json({ success: false, message: 'Broadcast not found' });
        return;
      }
      res.json({ success: true, data: broadcast });
    } catch (err) {
      console.error('[messaging:broadcast] stats failed:', err);
      res.status(500).json({ success: false, message: 'Failed to load broadcast' });
    }
  }

  /**
   * GET /messaging/broadcasts/:id/recipients?bucket=&page=
   *
   * `bucket` is one of all | queued | sending | sent | delivered | failed |
   * undeliverable | suppressed | replied | opted-out. This backs the clickable
   * stat tiles on the broadcast detail page.
   */
  async recipients(req: Request, res: Response): Promise<void> {
    try {
      const bucket = parseBucket(req.query.bucket ?? req.query.status);
      const result = await getBroadcastAudience(
        String(req.params.id),
        bucket,
        Number(req.query.page) || 1,
        Number(req.query.pageSize) || 100,
      );

      res.json({
        success: true,
        data: result.rows,
        bucket,
        pagination: {
          page: result.page,
          pageSize: result.pageSize,
          total: result.total,
          hasMore: result.hasMore,
        },
      });
    } catch (err) {
      console.error('[messaging:broadcast] recipients failed:', err);
      res.status(500).json({ success: false, message: 'Failed to load recipients' });
    }
  }

  /** GET /messaging/broadcasts/:id/error-breakdown — failures grouped by reason. */
  async errorBreakdown(req: Request, res: Response): Promise<void> {
    try {
      const data = await getErrorBreakdown(String(req.params.id));
      res.json({ success: true, data });
    } catch (err) {
      console.error('[messaging:broadcast] error breakdown failed:', err);
      res.status(500).json({ success: false, message: 'Failed to load error breakdown' });
    }
  }

  /** GET /messaging/broadcasts/:id/export?bucket= — CSV download of one bucket. */
  async exportRecipients(req: Request, res: Response): Promise<void> {
    try {
      const broadcastId = String(req.params.id);
      const bucket = parseBucket(req.query.bucket);

      const broadcast = await prisma.smsBroadcast.findUnique({
        where: { id: broadcastId },
        select: { campaignKey: true },
      });
      if (!broadcast) {
        res.status(404).json({ success: false, message: 'Broadcast not found' });
        return;
      }

      const csv = await exportAudienceCsv(broadcastId, bucket);
      const filename = `${broadcast.campaignKey}-${bucket}-${new Date().toISOString().slice(0, 10)}.csv`;

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (err) {
      console.error('[messaging:broadcast] export failed:', err);
      res.status(500).json({ success: false, message: 'Failed to export recipients' });
    }
  }
}

export default new MessagingBroadcastController();
