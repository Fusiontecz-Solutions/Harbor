/**
 * Infobip callbacks — inbound SMS, delivery reports, and call events.
 *
 * These are the only unauthenticated messaging endpoints, so two rules apply:
 *
 * 1. **Verify the shared secret** before doing any work.
 * 2. **Always answer 200 once accepted.** Infobip retries any non-2xx, and a
 *    bug in our own persistence would otherwise turn into an infinite retry
 *    storm. Failures are logged and swallowed; the 200 acknowledges receipt of
 *    the callback, not success of our processing.
 *
 * Reference: https://www.infobip.com/docs/api/channels/sms/inbound-sms/receive-inbound-sms-messages
 */
import type { Request, Response } from 'express';
import { notifyInboundMessage } from '../services/messaging/push.service';
import prisma from '../config/prismaClient';
import {
  parseDeliveryReportPayload,
  parseInboundPayload,
  verifyWebhookSecret,
} from '../services/messaging/infobip.service';
import {
  applyDeliveryReport,
  getTotalUnread,
  recordInboundMessage,
} from '../services/messaging/conversation.service';
import { recordBroadcastCounter } from '../services/messaging/broadcast.service';
import { normalizePhoneNumber, normalizeSender } from '../services/messaging/phone';
import { applyStartKeyword, applyStopKeyword, isStartKeyword } from '../services/messaging/suppression.service';
import {
  emitConversationUpdate,
  emitMessageStatusUpdate,
  emitNewMessage,
  emitUnreadCountUpdate,
} from '../socket/messagingEvents';

/**
 * The secret may arrive as a header or as a query parameter, because Infobip's
 * callback configuration exposes different options per channel.
 */
function extractSecret(req: Request): string | undefined {
  const header = req.headers['x-infobip-secret'] ?? req.headers['x-webhook-secret'];
  if (typeof header === 'string') return header;
  if (typeof req.query.secret === 'string') return req.query.secret;
  return undefined;
}

function rejectUnauthorized(req: Request, res: Response): boolean {
  if (verifyWebhookSecret(extractSecret(req))) return false;

  console.warn('[messaging:webhook] rejected callback with bad or missing secret from', req.ip);
  res.status(401).json({ success: false, message: 'Unauthorized' });
  return true;
}

class MessagingWebhookController {
  /**
   * POST /messaging/webhooks/infobip/inbound
   *
   * A merchant replying to a broadcast lands here, and the reply is attached to
   * the campaign via `callbackData` — which is what makes broadcast replies
   * appear in the normal chat inbox rather than a separate campaign silo.
   */
  async inbound(req: Request, res: Response): Promise<void> {
    if (rejectUnauthorized(req, res)) return;

    const messages = parseInboundPayload(req.body);
    if (messages.length === 0) {
      res.status(200).json({ success: true, processed: 0 });
      return;
    }

    let processed = 0;
    /** An opt-out we could not apply — ask Infobip to redeliver the batch. */
    let stopFailed = false;

    for (const message of messages) {
      try {
        // Prefer the campaign echoed back by the provider; otherwise attribute
        // the reply to the most recent broadcast message we sent this number.
        const broadcastId = message.campaignReference ?? (await inferBroadcastId(message.from, message.to));

        const result = await recordInboundMessage({
          providerMessageId: message.providerMessageId,
          fromNumber: message.from,
          toNumber: message.to,
          body: message.text,
          mediaUrls: message.mediaUrls,
          receivedAt: message.receivedAt,
          broadcastId,
        });

        if (!result) continue;

        // A lost opt-out is a compliance problem, so on failure we answer
        // non-2xx and Infobip redelivers. The message row already exists by
        // then, so the retry arrives as a duplicate — which is why STOP is
        // re-applied for duplicates too (it is idempotent). START is not, since
        // an old START redelivered after a newer STOP must not undo it.
        if (result.isStop) {
          try {
            await applyStopKeyword(message.from, result.conversationId);
          } catch (err) {
            stopFailed = true;
            console.error('[messaging:webhook] could not apply STOP, requesting redelivery:', message.from, err);
            continue;
          }
        }

        if (result.duplicate) continue;
        processed += 1;

        // The campaign's replied/optOut counters were already incremented inside
        // recordInboundMessage; STOP's suppression was applied above.
        if (!result.isStop && isStartKeyword(message.text)) {
          await applyStartKeyword(message.from, result.conversationId);
        }

        emitNewMessage(result.conversationId, {
          id: result.messageId,
          conversationId: result.conversationId,
          direction: 'INBOUND',
          fromNumber: message.from,
          toNumber: message.to,
          body: message.text,
          mediaUrls: message.mediaUrls,
          status: 'RECEIVED',
          isStopKeyword: result.isStop,
          broadcastId,
          createdAt: message.receivedAt.toISOString(),
        });

        // Push to everyone who can see this thread — even with Harbor closed.
        void notifyInboundMessage({
          conversationId: result.conversationId,
          businessNumber: message.to,
          contactNumber: message.from,
          text: message.text,
          isStop: result.isStop,
          hasMedia: Boolean(message.mediaUrls?.length),
        });

        emitConversationUpdate({
          id: result.conversationId,
          lastMessageText: message.text,
          lastMessageAt: message.receivedAt.toISOString(),
          lastMessageDirection: 'INBOUND',
          ...(result.isStop ? { isOptedOut: true } : {}),
        });
      } catch (err) {
        // Swallow per-message so one bad row cannot force Infobip to redeliver
        // the whole batch.
        console.error('[messaging:webhook] inbound processing failed:', message.providerMessageId, err);
      }
    }

    try {
      emitUnreadCountUpdate(await getTotalUnread());
    } catch {
      /* non-critical */
    }

    if (stopFailed) {
      res.status(500).json({ success: false, processed, message: 'Opt-out could not be recorded; please redeliver' });
      return;
    }

    res.status(200).json({ success: true, processed });
  }

  /** POST /messaging/webhooks/infobip/delivery — delivery receipts. */
  async delivery(req: Request, res: Response): Promise<void> {
    if (rejectUnauthorized(req, res)) return;

    const reports = parseDeliveryReportPayload(req.body);
    if (reports.length === 0) {
      res.status(200).json({ success: true, processed: 0 });
      return;
    }

    let processed = 0;

    for (const report of reports) {
      try {
        const applied = await applyDeliveryReport({
          providerMessageId: report.providerMessageId,
          status: report.status as 'SENT' | 'DELIVERED' | 'FAILED' | 'UNDELIVERABLE',
          errorCode: report.errorCode,
          errorMessage: report.errorMessage,
          doneAt: report.doneAt,
          segmentCount: report.segmentCount,
          priceAmount: report.priceAmount,
          priceCurrency: report.priceCurrency,
        });

        if (!applied) continue;
        processed += 1;

        // Mirror the outcome onto the broadcast recipient row and counters.
        const broadcastId = applied.broadcastId ?? report.callbackData;
        if (broadcastId) {
          await prisma.smsBroadcastRecipient.updateMany({
            where: { broadcastId, providerMessageId: report.providerMessageId },
            data: {
              status: report.status as never,
              errorCode: report.errorCode,
              errorMessage: report.errorMessage,
            },
          });

          if (report.status === 'DELIVERED') recordBroadcastCounter(broadcastId, 'deliveredCount');
          if (report.status === 'FAILED') recordBroadcastCounter(broadcastId, 'failedCount');
          if (report.status === 'UNDELIVERABLE') recordBroadcastCounter(broadcastId, 'undeliverableCount');
        }

        emitMessageStatusUpdate(applied.conversationId, {
          messageId: report.providerMessageId,
          providerMessageId: report.providerMessageId,
          status: report.status,
          errorMessage: report.errorMessage,
        });
      } catch (err) {
        console.error('[messaging:webhook] delivery report failed:', report.providerMessageId, err);
      }
    }

    res.status(200).json({ success: true, processed });
  }

  /** POST /messaging/webhooks/infobip/calls — Infobip Voice call state changes. */
  async calls(req: Request, res: Response): Promise<void> {
    if (rejectUnauthorized(req, res)) return;

    try {
      const body = req.body as Record<string, any>;
      const providerCallId = String(body?.callId ?? body?.call?.id ?? '').trim();

      if (providerCallId) {
        const state = String(body?.state ?? body?.call?.state ?? '').toLowerCase();
        const duration = Number(body?.duration ?? body?.call?.duration);
        const isTerminal = ['finished', 'completed', 'failed', 'no-answer', 'busy'].includes(state);

        await prisma.messagingCall.updateMany({
          where: { providerCallId },
          data: {
            status: state || undefined,
            durationSeconds: Number.isFinite(duration) ? Math.round(duration) : undefined,
            recordingUrl: body?.recordingUrl ? String(body.recordingUrl) : undefined,
            endedAt: isTerminal ? new Date() : undefined,
          },
        });
      }
    } catch (err) {
      console.error('[messaging:webhook] call event failed:', err);
    }

    res.status(200).json({ success: true });
  }
}

/**
 * Attribute a reply to a campaign when the provider did not echo one back.
 *
 * Looks for the most recent outbound broadcast message this number received in
 * the last 30 days. Older than that and a reply is far more likely to be a new
 * conversation than a late campaign response.
 *
 * Both numbers are normalized first. Infobip reports MO numbers as bare digits
 * ("19176151235") while every number we store went through
 * normalizePhoneNumber ("+19176151235"), so matching the raw callback values
 * against stored columns never found a row: every reply was recorded with a
 * null broadcastId, campaign reply counts sat at zero however many people
 * answered, and follow-ups could not tell a responder from a silent lead.
 */
async function inferBroadcastId(rawFrom: string, rawTo: string): Promise<string | null> {
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  const contactNumber = normalizePhoneNumber(rawFrom);
  const businessNumber = normalizeSender(rawTo);
  if (!contactNumber || !businessNumber) return null;

  const lastBroadcastMessage = await prisma.messagingMessage.findFirst({
    where: {
      direction: 'OUTBOUND',
      broadcastId: { not: null },
      // Scoped to the number the reply arrived on, so two campaigns running
      // from different senders cannot steal each other's replies.
      toNumber: contactNumber,
      fromNumber: businessNumber,
      createdAt: { gte: new Date(Date.now() - THIRTY_DAYS_MS) },
    },
    orderBy: { createdAt: 'desc' },
    select: { broadcastId: true },
  });

  return lastBroadcastMessage?.broadcastId ?? null;
}

export default new MessagingWebhookController();
