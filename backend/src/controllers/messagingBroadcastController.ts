/**
 * Broadcast HTTP surface.
 *
 * Creation and starting are deliberately separate calls: creating runs the
 * suppression preflight and returns the true reachable audience, so an operator
 * confirms "42,180 of 50,000 will receive this" before anything is sent.
 */
import type { Request, Response } from 'express';
import { contactDisplayName } from '../services/messaging/contactName';
import { Prisma } from '@prisma/client';
import prisma from '../config/prismaClient';
import { parsePagination } from '../utils/pagination';
import {
  cancelBroadcast,
  createBroadcast,
  getBroadcastStats,
  pauseBroadcast,
  startBroadcast,
} from '../services/messaging/broadcast.service';
import { parseContactSheet } from '../services/messaging/contact.service';
import { buildMergeDataFromSheetRow } from '../services/messaging/mergeTemplate';
import { analyzeSmsTemplate, estimatedCampaignCredits } from '../services/messaging/smsSegments';
import { firstPhoneNumberIn, normalizePhoneNumber } from '../services/messaging/phone';
import { checkSuppressionBulk } from '../services/messaging/suppression.service';
import {
  exportAudienceCsv,
  getBroadcastAudience,
  getErrorBreakdown,
  type AudienceBucket,
} from '../services/messaging/broadcastAudience.service';
import { resolveClientsAsRecipients } from '../services/messaging/clientRecipients.service';
import {
  approveBroadcast,
  createFollowUpBroadcast,
  parseFollowUpAudience,
  previewFollowUpAudience,
  rejectBroadcast,
  resolveBatchAudience,
  type BatchExclusions,
} from '../services/messaging/followUp.service';
import { isPrivilegedMessagingRole, resolveSenderForActor } from '../services/messaging/sender.service';
import {
  deleteSendWindow,
  listSendWindows,
  listUpcomingSendWindows,
  resolveWindowToInstant,
  upsertSendWindow,
} from '../services/messaging/sendWindow.service';
import { cleanupUploadedTempFiles, readUploadedFile } from '../utils/readUploadedFile';

/** Buckets the drill-down understands; anything else falls back to 'all'. */
const AUDIENCE_BUCKETS = new Set<AudienceBucket>([
  'all',
  'queued',
  'sending',
  'sent',
  'pending',
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

const isAdmin = (req: Request): boolean => isPrivilegedMessagingRole(req.user?.role);

/** Owner scope for batch audiences: null for an admin, own id for an agent. */
const ownerScope = (req: Request): string[] | null => (isAdmin(req) ? null : [actorId(req) ?? '']);

/** 403 body shared by every admin-only handler here. */
const adminOnly = (res: Response, what: string): void => {
  res.status(403).json({ success: false, message: `Only admins can ${what}` });
};

/**
 * Gate for every /broadcasts/:id route: an admin may act on any broadcast, an
 * agent only on the ones they created. Anything else answers 404 so ids of
 * other people's campaigns aren't confirmed. Returns false once it has replied.
 */
const ensureBroadcastAccess = async (req: Request, res: Response): Promise<boolean> => {
  const broadcast = await prisma.smsBroadcast.findUnique({
    where: { id: String(req.params.id) },
    select: { createdById: true },
  });
  if (!broadcast || (!isAdmin(req) && broadcast.createdById !== actorId(req))) {
    res.status(404).json({ success: false, message: 'Broadcast not found' });
    return false;
  }
  return true;
};

type CollectedRecipient = { phoneNumber: string; mergeData?: Record<string, unknown> };

interface CollectedAudience {
  recipients: CollectedRecipient[];
  skippedClients: Array<{ clientId: string; businessName: string; reason: string }>;
  batchExcluded: BatchExclusions | null;
  leadBatchId: string | null;
  /** Spreadsheet rows skipped because they have no owner name. */
  sheetMissingOwnerName: number;
}

/**
 * Turn a create (or preview) request into the raw recipient list: uploaded
 * sheet, typed numbers, CRM clients, a lead batch and saved contacts. Shared
 * by create and the audience preview so the preview is exactly what sends.
 */
async function collectAudience(req: Request): Promise<CollectedAudience | { error: { status: number; message: string } }> {
  let recipients: Array<{ phoneNumber: string; mergeData?: Record<string, unknown> }> = [];
  let sheetMissingOwnerName = 0;

  const upload = readUploadedFile(req);
  if (upload) {
    const { rows, columnMapping } = parseContactSheet(upload.buffer);
    const phoneHeader = Object.entries(columnMapping).find(([, field]) => field === 'phoneNumber')?.[0];

    if (!phoneHeader) {
      return {
        error: {
          status: 400,
          message: `No phone number column found in the uploaded sheet. Headers seen: ${Object.keys(rows[0] ?? {}).join(', ') || 'none'}`,
        },
      };
    }

    // A lead without an owner name is never broadcast to.
    const nameHeaders = Object.entries(columnMapping)
      .filter(([, field]) => field === 'ownerName' || field === 'firstName' || field === 'lastName')
      .map(([header]) => header);
    if (nameHeaders.length === 0) {
      return {
        error: {
          status: 400,
          message: `No owner name column found in the uploaded sheet (expected "Owners Name"). Headers seen: ${Object.keys(rows[0] ?? {}).join(', ') || 'none'}`,
        },
      };
    }

    recipients = rows.flatMap((row) => {
      const phoneNumber = firstPhoneNumberIn(row[phoneHeader]);
      if (!phoneNumber) return [];
      if (!nameHeaders.some((h) => String(row[h] ?? '').trim())) {
        sheetMissingOwnerName += 1;
        return [];
      }
      return [
        {
          phoneNumber,
          mergeData: buildMergeDataFromSheetRow(row, columnMapping, phoneHeader),
        },
      ];
    });
  } else if (Array.isArray(req.body?.recipients)) {
    recipients = req.body.recipients;
  }

  // CRM clients as an audience — resolved to numbers + merge data, and
  // reported back so the operator sees who was skipped and why.
  let skippedClients: Array<{ clientId: string; businessName: string; reason: string }> = [];
  if (Array.isArray(req.body?.clientIds) && req.body.clientIds.length > 0) {
    if (!isAdmin(req)) return { error: { status: 403, message: 'Forbidden: only admins can message CRM clients' } };
    const resolved = await resolveClientsAsRecipients(
      req.body.clientIds.map(String),
      actorId(req),
    );
    recipients = [...recipients, ...resolved.recipients];
    skippedClients = resolved.skipped;
  }

  /**
   * A lead upload as the audience.
   *
   * Scoped to the caller: an agent picking "Tuesday's leads" gets the
   * share that was distributed to them, an admin gets the whole upload.
   * Contacts the agent has already marked, and blocked ones, are dropped
   * here rather than being sent and suppressed later.
   */
  let batchExcluded: BatchExclusions | null = null;
  const leadBatchId = req.body?.leadBatchId ? String(req.body.leadBatchId) : null;
  if (leadBatchId) {
    const audience = await resolveBatchAudience(leadBatchId, ownerScope(req));
    recipients = [...recipients, ...audience.recipients];
    batchExcluded = audience.excluded;
  }

  // Saved messaging contacts, by id.
  if (Array.isArray(req.body?.contactIds) && req.body.contactIds.length > 0) {
    const contacts = await prisma.messagingContact.findMany({
      where: {
        id: { in: req.body.contactIds.map(String) },
        ...(isAdmin(req) ? {} : { ownerUserId: actorId(req) }),
      },
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

  return { recipients, skippedClients, batchExcluded, leadBatchId, sheetMissingOwnerName };
}

type BroadcastSort = 'newest' | 'replies' | 'replyRate' | 'delivery' | 'optouts';

/**
 * Ids of one page of campaigns ordered by reply rate (replied / sent) or
 * delivery rate (delivered / sent), applying the same filters as the list.
 */
async function pageIdsByRate(
  sort: 'replyRate' | 'delivery',
  filters: { status?: string; createdById?: string; search: string },
  skip: number,
  take: number,
): Promise<string[]> {
  const conds: Prisma.Sql[] = [];
  if (filters.status) conds.push(Prisma.sql`b."status"::text = ${filters.status}`);
  if (filters.createdById) conds.push(Prisma.sql`b."createdById" = ${filters.createdById}::uuid`);
  if (filters.search) {
    const like = `%${filters.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conds.push(
      Prisma.sql`(b."name" ILIKE ${like} OR b."body" ILIKE ${like} OR u."firstName" ILIKE ${like} OR u."lastName" ILIKE ${like})`,
    );
  }
  const whereSql = conds.length ? Prisma.sql`WHERE ${Prisma.join(conds, ' AND ')}` : Prisma.empty;
  const numerator = sort === 'replyRate' ? Prisma.sql`b."repliedCount"` : Prisma.sql`b."deliveredCount"`;
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT b."id"
    FROM "SmsBroadcast" b
    LEFT JOIN "User" u ON u."id" = b."createdById"
    ${whereSql}
    ORDER BY CASE WHEN b."sentCount" > 0 THEN ${numerator}::float / b."sentCount" END DESC NULLS LAST,
             b."createdAt" DESC
    OFFSET ${skip} LIMIT ${take}`;
  return rows.map((r) => r.id);
}

class MessagingBroadcastController {
  /** GET /messaging/broadcasts?page=&pageSize=&status=&search=&sort= */
  async list(req: Request, res: Response): Promise<void> {
    try {
      const { page, pageSize, skip, take } = parsePagination(req, { defaultPageSize: 25 })!;
      const status = req.query.status ? String(req.query.status) : undefined;
      const search = req.query.search ? String(req.query.search).trim() : '';
      const sort = String(req.query.sort || 'newest') as BroadcastSort;

      const where: Prisma.SmsBroadcastWhereInput = status ? { status: status as never } : {};
      // An agent sees the campaigns they built, including the ones still
      // waiting on approval; an admin sees everyone's.
      if (!isAdmin(req)) where.createdById = actorId(req);
      if (search) {
        const contains = { contains: search, mode: 'insensitive' as const };
        where.OR = [
          { name: contains },
          { body: contains },
          { createdBy: { is: { OR: [{ firstName: contains }, { lastName: contains }] } } },
        ];
      }

      const select = {
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
        // Detail for the campaign list: what was sent, by whom, when.
        body: true,
        scheduledAt: true,
        approvedAt: true,
        throttlePerSecond: true,
        undeliverableCount: true,
        leadBatchId: true,
        parentBroadcastId: true,
        createdBy: { select: { firstName: true, lastName: true } },
        approvedBy: { select: { firstName: true, lastName: true } },
      } satisfies Prisma.SmsBroadcastSelect;

      let items: Prisma.SmsBroadcastGetPayload<{ select: typeof select }>[];
      const total = await prisma.smsBroadcast.count({ where });
      if (sort === 'replyRate' || sort === 'delivery') {
        // A rate is not a column, so Prisma can't order by it: pick this
        // page's ids in SQL (same filters as `where`), then load them.
        // Campaigns with nothing sent yet have no rate and sort last.
        const ids = await pageIdsByRate(sort, { status, createdById: where.createdById as string | undefined, search }, skip, take);
        const rows = ids.length ? await prisma.smsBroadcast.findMany({ where: { id: { in: ids } }, select }) : [];
        const byId = new Map(rows.map((r) => [r.id, r]));
        items = ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => Boolean(r));
      } else {
        const orderBy: Prisma.SmsBroadcastOrderByWithRelationInput[] =
          sort === 'replies'
            ? [{ repliedCount: 'desc' }, { createdAt: 'desc' }]
            : sort === 'optouts'
              ? [{ optOutCount: 'desc' }, { createdAt: 'desc' }]
              : [{ createdAt: 'desc' }];
        items = await prisma.smsBroadcast.findMany({ where, orderBy, skip, take, select });
      }

      // Totals across every campaign this caller can see, not just this page.
      const [sums, byStatus] = await Promise.all([
        prisma.smsBroadcast.aggregate({
          where: isAdmin(req) ? {} : { createdById: actorId(req) },
          _sum: {
            totalRecipients: true,
            sentCount: true,
            deliveredCount: true,
            failedCount: true,
            undeliverableCount: true,
            suppressedCount: true,
            repliedCount: true,
            optOutCount: true,
            queuedCount: true,
          },
          _count: { _all: true },
        }),
        prisma.smsBroadcast.groupBy({
          by: ['status'],
          where: isAdmin(req) ? {} : { createdById: actorId(req) },
          _count: { _all: true },
        }),
      ]);

      const batchIds = [...new Set(items.map((b) => b.leadBatchId).filter((v): v is string => Boolean(v)))];
      const parentIds = [...new Set(items.map((b) => b.parentBroadcastId).filter((v): v is string => Boolean(v)))];
      const [batches, parents] = await Promise.all([
        batchIds.length
          ? prisma.messagingLeadBatch.findMany({ where: { id: { in: batchIds } }, select: { id: true, name: true } })
          : [],
        parentIds.length
          ? prisma.smsBroadcast.findMany({ where: { id: { in: parentIds } }, select: { id: true, name: true } })
          : [],
      ]);
      const batchName = new Map(batches.map((b) => [b.id, b.name]));
      const parentName = new Map(parents.map((b) => [b.id, b.name]));
      const fullName = (u: { firstName: string | null; lastName: string | null } | null) =>
        u ? `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || null : null;

      res.json({
        success: true,
        data: items.map(({ createdBy, approvedBy, ...b }) => ({
          ...b,
          pendingCount: Math.max(0, b.sentCount - b.deliveredCount - b.undeliverableCount),
          createdByName: fullName(createdBy),
          approvedByName: fullName(approvedBy),
          leadBatchName: b.leadBatchId ? batchName.get(b.leadBatchId) ?? null : null,
          parentName: b.parentBroadcastId ? parentName.get(b.parentBroadcastId) ?? null : null,
        })),
        totals: {
          campaigns: sums._count._all,
          byStatus: Object.fromEntries(byStatus.map((g) => [g.status, g._count._all])),
          recipients: sums._sum.totalRecipients ?? 0,
          sent: sums._sum.sentCount ?? 0,
          delivered: sums._sum.deliveredCount ?? 0,
          // Definitions: smsMetrics.ts. Failed (rejected / never accepted) and
          // undeliverable (accepted, carrier did not deliver) are separate.
          failed: sums._sum.failedCount ?? 0,
          undeliverable: sums._sum.undeliverableCount ?? 0,
          pending: Math.max(
            0,
            (sums._sum.sentCount ?? 0) - (sums._sum.deliveredCount ?? 0) - (sums._sum.undeliverableCount ?? 0),
          ),
          suppressed: sums._sum.suppressedCount ?? 0,
          // Distinct contacts with a non-STOP reply.
          replied: sums._sum.repliedCount ?? 0,
          optedOut: sums._sum.optOutCount ?? 0,
          queued: sums._sum.queuedCount ?? 0,
        },
        pagination: { page, pageSize, total, hasMore: page * pageSize < total },
      });
    } catch (err) {
      console.error('[messaging:broadcast] list failed:', err);
      res.status(500).json({ success: false, message: 'Failed to load broadcasts' });
    }
  }

  /**
   * POST /messaging/broadcasts/audience-preview
   *
   * The audience breakdown for step 2 of the create flow, computed exactly as
   * create would (same sources, same normalisation, same suppression check)
   * but without saving anything: how many leads there are, who is left out and
   * why, and how many will actually receive the message. Leads that opted out
   * earlier (STOP) show up as opted out even when they are re-uploaded.
   */
  async audiencePreview(req: Request, res: Response): Promise<void> {
    try {
      const collected = await collectAudience(req);
      if ('error' in collected) {
        res.status(collected.error.status).json({ success: false, message: collected.error.message });
        return;
      }
      const { recipients, skippedClients, batchExcluded, sheetMissingOwnerName } = collected;

      // Same normalise / dedupe rules as createBroadcast.
      const unique = new Map<string, Record<string, unknown> | undefined>();
      let invalid = 0;
      for (const r of recipients) {
        const phone = normalizePhoneNumber(r?.phoneNumber);
        if (!phone) {
          invalid += 1;
          continue;
        }
        unique.set(phone, r.mergeData);
      }
      const duplicates = recipients.length - unique.size - invalid;
      const numbers = [...unique.keys()];

      const verdicts = await checkSuppressionBulk(numbers);
      const byReason = { STOP_KEYWORD: 0, DNC_LIST: 0, MANUAL_BLOCK: 0, OTHER: 0 };
      const optedOutNumbers: string[] = [];
      for (const phone of numbers) {
        const v = verdicts.get(phone);
        if (!v?.suppressed) continue;
        if (v.reason === 'STOP_KEYWORD') {
          byReason.STOP_KEYWORD += 1;
          optedOutNumbers.push(phone);
        } else if (v.reason === 'DNC_LIST') byReason.DNC_LIST += 1;
        else if (v.reason === 'MANUAL_BLOCK') byReason.MANUAL_BLOCK += 1;
        else byReason.OTHER += 1;
      }
      const suppressedTotal = byReason.STOP_KEYWORD + byReason.DNC_LIST + byReason.MANUAL_BLOCK + byReason.OTHER;
      const willSend = numbers.length - suppressedTotal;

      // Who opted out, so the operator can see it is not a mystery number.
      const sample = optedOutNumbers.slice(0, 50);
      const names = await prisma.messagingContact.findMany({
        where: { phoneNumber: { in: sample } },
        select: { phoneNumber: true, ownerName: true, firstName: true, lastName: true, company: true },
      });
      const nameByPhone = new Map(
        names.map((c) => [c.phoneNumber, [contactDisplayName(c), c.company].filter(Boolean).join(' · ') || null]),
      );
      const optedOutAt = await prisma.messagingSuppression.findMany({
        where: { phoneNumber: { in: sample }, reason: 'STOP_KEYWORD', active: true },
        select: { phoneNumber: true, createdAt: true },
      });
      const atByPhone = new Map(optedOutAt.map((r) => [r.phoneNumber, r.createdAt]));

      // Informational: how many of the senders have been messaged by a
      // campaign before, so a re-blast of the same list is obvious.
      const previouslyMessaged = numbers.length
        ? (
            await prisma.messagingMessage.findMany({
              where: { direction: 'OUTBOUND', broadcastId: { not: null }, toNumber: { in: numbers } },
              select: { toNumber: true },
              distinct: ['toNumber'],
            })
          ).length
        : 0;

      const batchTotal = batchExcluded?.total ?? 0;
      const batchEligible = batchExcluded ? batchExcluded.total - batchExcluded.blocked - batchExcluded.disposed : 0;
      const batchEligibleAfterOwner = batchEligible - (batchExcluded?.missingOwnerName ?? 0);
      const totalLeads = batchTotal + (recipients.length - batchEligibleAfterOwner) + sheetMissingOwnerName;

      res.json({
        success: true,
        data: {
          totalLeads,
          excluded: {
            blocked: (batchExcluded?.blocked ?? 0) + byReason.MANUAL_BLOCK,
            interested: batchExcluded?.interested ?? 0,
            notInterested: batchExcluded?.notInterested ?? 0,
            missingOwnerName: (batchExcluded?.missingOwnerName ?? 0) + sheetMissingOwnerName,
            optedOut: byReason.STOP_KEYWORD,
            dnc: byReason.DNC_LIST,
            otherSuppressed: byReason.OTHER,
            invalid,
            duplicates,
          },
          willSend,
          previouslyMessaged,
          optedOut: sample.map((phone) => ({
            phoneNumber: phone,
            name: nameByPhone.get(phone) ?? null,
            optedOutAt: atByPhone.get(phone) ?? null,
          })),
          optedOutMore: Math.max(0, optedOutNumbers.length - sample.length),
          skippedClients,
        },
      });
    } catch (err) {
      console.error('[messaging:broadcast] audience preview failed:', err);
      res.status(Number((err as { statusCode?: number })?.statusCode) || 400).json({
        success: false,
        message: (err as Error)?.message || 'Failed to preview audience',
      });
    } finally {
      cleanupUploadedTempFiles(req);
    }
  }

  /**
   * POST /messaging/broadcasts
   * Recipients come either as a JSON array or as an uploaded spreadsheet.
   */
  async create(req: Request, res: Response): Promise<void> {
    try {
      const collected = await collectAudience(req);
      if ('error' in collected) {
        res.status(collected.error.status).json({ success: false, message: collected.error.message });
        return;
      }
      const { recipients, skippedClients, batchExcluded, leadBatchId, sheetMissingOwnerName } = collected;
      const missingOwnerName = (batchExcluded?.missingOwnerName ?? 0) + sheetMissingOwnerName;

      if (recipients.length === 0) {
        res.status(400).json({
          success: false,
          message: leadBatchId
            ? 'Nobody in that batch is messageable — every lead is blocked, already marked, or has no owner name.'
            : 'No recipients. Upload a spreadsheet in the "file" field, or pass recipients / clientIds / contactIds / leadBatchId.',
          skippedClients,
          batchExcluded,
          missingOwnerName,
        });
        return;
      }

      const bodyText = String(req.body?.body ?? req.body?.message ?? '').trim();
      if (!bodyText) {
        res.status(400).json({ success: false, message: 'Message body is required' });
        return;
      }

      const mergeSamples = recipients
        .map((r) => r.mergeData)
        .filter((data): data is Record<string, unknown> => Boolean(data && typeof data === 'object'));
      const smsSegment = analyzeSmsTemplate(bodyText, mergeSamples);

      /**
       * When to send.
       *
       * `sendWindowId` resolves to the next occurrence of one of the
       * configured daily windows; `scheduledAt` remains for an arbitrary time.
       * The window is preferred when both arrive.
       */
      let scheduledAt: Date | null = null;
      if (req.body?.sendWindowId) {
        scheduledAt = await resolveWindowToInstant(String(req.body.sendWindowId));
      } else if (req.body?.scheduledAt) {
        scheduledAt = new Date(req.body.scheduledAt);
      }

      const fromNumber = await resolveSenderForActor(actorId(req), req.user?.role, req.body?.fromNumber);

      const result = await createBroadcast({
        name: String(req.body?.name ?? ''),
        body: bodyText,
        fromNumber,
        mediaUrls: Array.isArray(req.body?.mediaUrls) ? req.body.mediaUrls.map(String) : undefined,
        recipients,
        throttlePerSecond: req.body?.throttlePerSecond ? Number(req.body.throttlePerSecond) : null,
        scheduledAt,
        createdById: actorId(req),
        leadBatchId,
        // Agents build campaigns against their own leads; a Super Admin
        // decides whether one sends.
        requiresApproval: !isAdmin(req),
      });

      // Optional one-shot: create and immediately start. Not available to an
      // agent — it would be a way straight past the approval gate.
      if ((req.body?.startNow === true || String(req.body?.startNow) === 'true') && isAdmin(req)) {
        const started = await startBroadcast(result.id);
        res.status(201).json({
          success: true,
          data: {
            ...result,
            skippedClients,
            batchExcluded,
            missingOwnerName,
            started,
            sms: {
              ...smsSegment,
              estimatedTotalCredits: estimatedCampaignCredits(result.queuedCount, smsSegment.credits),
            },
          },
        });
        return;
      }

      res.status(201).json({
        success: true,
        data: {
          ...result,
          skippedClients,
          batchExcluded,
          missingOwnerName,
          scheduledAt,
          awaitingApproval: !isAdmin(req),
          sms: {
            ...smsSegment,
            estimatedTotalCredits: estimatedCampaignCredits(result.queuedCount, smsSegment.credits),
          },
        },
      });
    } catch (err) {
      console.error('[messaging:broadcast] create failed:', err);
      res.status(Number((err as { statusCode?: number })?.statusCode) || 400).json({ success: false, message: (err as Error)?.message || 'Failed to create broadcast' });
    } finally {
      cleanupUploadedTempFiles(req);
    }
  }

  /** POST /messaging/broadcasts/:id/start */
  async start(req: Request, res: Response): Promise<void> {
    try {
      // Starting is sending. Agents prepare, admins release.
      if (!isAdmin(req)) return adminOnly(res, 'start a broadcast');
      const result = await startBroadcast(String(req.params.id));
      res.json({ success: true, data: result });
    } catch (err) {
      console.error('[messaging:broadcast] start failed:', err);
      res.status(Number((err as { statusCode?: number })?.statusCode) || 400).json({ success: false, message: (err as Error)?.message || 'Failed to start broadcast' });
    }
  }

  /** POST /messaging/broadcasts/:id/pause */
  async pause(req: Request, res: Response): Promise<void> {
    try {
      if (!(await ensureBroadcastAccess(req, res))) return;
      await pauseBroadcast(String(req.params.id));
      res.json({ success: true, data: { id: req.params.id, status: 'PAUSED' } });
    } catch (err) {
      console.error('[messaging:broadcast] pause failed:', err);
      res.status(Number((err as { statusCode?: number })?.statusCode) || 400).json({ success: false, message: (err as Error)?.message || 'Failed to pause broadcast' });
    }
  }

  /** POST /messaging/broadcasts/:id/cancel */
  async cancel(req: Request, res: Response): Promise<void> {
    try {
      if (!(await ensureBroadcastAccess(req, res))) return;
      await cancelBroadcast(String(req.params.id));
      res.json({ success: true, data: { id: req.params.id, status: 'CANCELLED' } });
    } catch (err) {
      console.error('[messaging:broadcast] cancel failed:', err);
      res.status(Number((err as { statusCode?: number })?.statusCode) || 400).json({ success: false, message: (err as Error)?.message || 'Failed to cancel broadcast' });
    }
  }

  /** POST /messaging/broadcasts/:id/approve — release an agent's campaign. */
  async approve(req: Request, res: Response): Promise<void> {
    try {
      if (!isAdmin(req)) return adminOnly(res, 'approve a broadcast');
      const data = await approveBroadcast(String(req.params.id), actorId(req));

      // An approved campaign with no schedule is a DRAFT the approver may want
      // to send right away; `startNow` saves them a second click.
      if (!data.scheduledAt && (req.body?.startNow === true || String(req.body?.startNow) === 'true')) {
        const started = await startBroadcast(data.id);
        res.json({ success: true, data: { ...data, started } });
        return;
      }

      res.json({ success: true, data });
    } catch (err) {
      console.error('[messaging:broadcast] approve failed:', err);
      res.status(Number((err as { statusCode?: number })?.statusCode) || 400).json({ success: false, message: (err as Error)?.message || 'Failed to approve broadcast' });
    }
  }

  /** POST /messaging/broadcasts/:id/reject */
  async reject(req: Request, res: Response): Promise<void> {
    try {
      if (!isAdmin(req)) return adminOnly(res, 'reject a broadcast');
      res.json({ success: true, data: await rejectBroadcast(String(req.params.id)) });
    } catch (err) {
      console.error('[messaging:broadcast] reject failed:', err);
      res.status(400).json({ success: false, message: (err as Error)?.message || 'Failed to reject broadcast' });
    }
  }

  /**
   * GET /messaging/broadcasts/:id/follow-up — who a follow-up would reach.
   *
   * Read-only preflight, so an operator sees the audience before committing to
   * a second send.
   */
  async followUpPreview(req: Request, res: Response): Promise<void> {
    try {
      if (!(await ensureBroadcastAccess(req, res))) return;
      const audience = parseFollowUpAudience(req.query.audience);
      res.json({ success: true, data: await previewFollowUpAudience(String(req.params.id), audience) });
    } catch (err) {
      console.error('[messaging:broadcast] follow-up preview failed:', err);
      res.status(400).json({ success: false, message: (err as Error)?.message || 'Failed to preview follow-up' });
    }
  }

  /** POST /messaging/broadcasts/:id/follow-up — chase the non-responders. */
  async followUp(req: Request, res: Response): Promise<void> {
    try {
      if (!(await ensureBroadcastAccess(req, res))) return;
      let scheduledAt: Date;
      if (req.body?.sendWindowId) {
        scheduledAt = await resolveWindowToInstant(String(req.body.sendWindowId));
      } else if (req.body?.scheduledAt) {
        scheduledAt = new Date(req.body.scheduledAt);
      } else {
        res.status(400).json({
          success: false,
          message: 'A follow-up needs a send window or a scheduled time — it cannot go out immediately',
        });
        return;
      }

      const data = await createFollowUpBroadcast({
        parentId: String(req.params.id),
        name: req.body?.name ? String(req.body.name) : undefined,
        body: String(req.body?.body ?? req.body?.message ?? ''),
        scheduledAt,
        audience: parseFollowUpAudience(req.body?.audience),
        createdById: actorId(req),
        requiresApproval: !isAdmin(req),
      });

      res.status(201).json({
        success: true,
        data: { ...data, scheduledAt, awaitingApproval: !isAdmin(req) },
      });
    } catch (err) {
      console.error('[messaging:broadcast] follow-up failed:', err);
      res.status(400).json({ success: false, message: (err as Error)?.message || 'Failed to create follow-up' });
    }
  }

  /* ------------------------------------------------------------------------
   * Send windows — the configurable daily times campaigns go out at.
   * ----------------------------------------------------------------------*/

  /** GET /messaging/send-windows — every window, for the settings screen. */
  async sendWindows(_req: Request, res: Response): Promise<void> {
    try {
      res.json({ success: true, data: await listSendWindows() });
    } catch (err) {
      console.error('[messaging:windows] list failed:', err);
      res.status(500).json({ success: false, message: 'Failed to load send windows' });
    }
  }

  /** GET /messaging/send-windows/upcoming — active windows with their next occurrence. */
  async upcomingSendWindows(_req: Request, res: Response): Promise<void> {
    try {
      res.json({ success: true, data: await listUpcomingSendWindows() });
    } catch (err) {
      console.error('[messaging:windows] upcoming failed:', err);
      res.status(500).json({ success: false, message: 'Failed to load send windows' });
    }
  }

  /** POST /messaging/send-windows, PATCH /messaging/send-windows/:id */
  async saveSendWindow(req: Request, res: Response): Promise<void> {
    try {
      if (!isAdmin(req)) return adminOnly(res, 'change send windows');
      const data = await upsertSendWindow({
        id: req.params.id ? String(req.params.id) : undefined,
        label: req.body?.label ?? null,
        timeOfDay: String(req.body?.timeOfDay ?? ''),
        timezone: req.body?.timezone ? String(req.body.timezone) : undefined,
        isActive: req.body?.isActive === undefined ? undefined : Boolean(req.body.isActive),
        sortOrder: req.body?.sortOrder === undefined ? undefined : Number(req.body.sortOrder),
      });
      res.json({ success: true, data });
    } catch (err) {
      console.error('[messaging:windows] save failed:', err);
      res.status(400).json({ success: false, message: (err as Error)?.message || 'Failed to save send window' });
    }
  }

  /** DELETE /messaging/send-windows/:id */
  async removeSendWindow(req: Request, res: Response): Promise<void> {
    try {
      if (!isAdmin(req)) return adminOnly(res, 'change send windows');
      await deleteSendWindow(String(req.params.id));
      res.json({ success: true, data: { id: req.params.id } });
    } catch (err) {
      console.error('[messaging:windows] delete failed:', err);
      res.status(400).json({ success: false, message: (err as Error)?.message || 'Failed to delete send window' });
    }
  }

  /** GET /messaging/broadcasts/:id */
  async stats(req: Request, res: Response): Promise<void> {
    try {
      if (!(await ensureBroadcastAccess(req, res))) return;
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
      if (!(await ensureBroadcastAccess(req, res))) return;
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
      if (!(await ensureBroadcastAccess(req, res))) return;
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
      if (!(await ensureBroadcastAccess(req, res))) return;
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
