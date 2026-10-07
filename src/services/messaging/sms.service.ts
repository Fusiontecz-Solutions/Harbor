/**
 * Outbound send path — shared by 1:1 chat and the broadcast worker.
 *
 * Every outbound message in Harbor goes through {@link dispatchOutboundMessage}
 * so the safety checks cannot be bypassed by adding a new caller. The order of
 * operations matters:
 *
 *   1. suppression   — never message a blocked/opted-out number
 *   2. persist       — write the QUEUED row, its id becomes the provider's messageId
 *   3. rate limit    — wait on the account (and broadcast) token bucket
 *   4. send          — hand to Infobip
 *   5. reconcile     — record the outcome, update the summary, notify sockets
 *
 * Steps 1–2 before 3 is deliberate: a message waiting on a full bucket is
 * already durable, so a crash during the wait loses nothing.
 */
import prisma from '../../config/prismaClient';
import {
  emitConversationUpdate,
  emitNewMessage,
} from '../../socket/messagingEvents';
import {
  ensureConversation,
  markOutboundSubmitted,
  recordOutboundMessage,
} from './conversation.service';
import {
  getDefaultSender,
  isInfobipConfigured,
  sendSms,
  toInfobipError,
} from './infobip.service';
import { normalizePhoneNumber } from './phone';
import { resolveSenderForUser } from './sender.service';
import { checkSuppression } from './suppression.service';
import { getAccountBucket, getBroadcastBucket } from './tokenBucket';

export interface DispatchResult {
  status: 'sent' | 'suppressed' | 'failed' | 'rate_limited';
  messageId: string | null;
  conversationId: string | null;
  providerMessageId: string | null;
  reason: string | null;
  /** True when the caller should requeue rather than treat this as terminal. */
  retryable: boolean;
}

export interface DispatchInput {
  toNumber: string;
  fromNumber?: string;
  body: string;
  mediaUrls?: string[];
  sentById?: string | null;
  /** Present for broadcast sends — enables the per-campaign bucket and stats. */
  broadcastId?: string | null;
  /** Groups a campaign's provider-side messages. */
  bulkId?: string | null;
  broadcastThrottlePerSecond?: number | null;
  /** Max time to wait on the rate limiter before giving up and requeueing. */
  rateLimitWaitMs?: number;
}

export { renderTemplate } from './mergeTemplate';

export async function dispatchOutboundMessage(input: DispatchInput): Promise<DispatchResult> {
  const toNumber = normalizePhoneNumber(input.toNumber);
  if (!toNumber) {
    return {
      status: 'failed',
      messageId: null,
      conversationId: null,
      providerMessageId: null,
      reason: `Unparseable destination number: ${input.toNumber}`,
      retryable: false,
    };
  }

  if (!isInfobipConfigured()) {
    return {
      status: 'failed',
      messageId: null,
      conversationId: null,
      providerMessageId: null,
      reason: 'Infobip is not configured (INFOBIP_BASE_URL / INFOBIP_API_KEY)',
      retryable: false,
    };
  }

  // Falls back through the sender assigned to whoever is sending, then the
  // env default. Broadcasts pass fromNumber explicitly and skip both.
  const fromNumber =
    input.fromNumber?.trim() || (await resolveSenderForUser(input.sentById)) || getDefaultSender();
  if (!fromNumber) {
    return {
      status: 'failed',
      messageId: null,
      conversationId: null,
      providerMessageId: null,
      reason: 'No sender configured (INFOBIP_SENDER)',
      retryable: false,
    };
  }

  // 1. Suppression — before anything is persisted or a token is spent.
  const verdict = await checkSuppression(toNumber);
  if (verdict.suppressed) {
    return {
      status: 'suppressed',
      messageId: null,
      conversationId: null,
      providerMessageId: null,
      reason: verdict.reason ? `${verdict.reason}${verdict.source ? ` (${verdict.source})` : ''}` : 'suppressed',
      retryable: false,
    };
  }

  // 2. Persist as QUEUED. The row id is the provider-side messageId.
  const conversation = await ensureConversation({
    businessNumber: fromNumber,
    contactNumber: toNumber,
    ownerUserId: input.sentById ?? null,
  });

  const message = await recordOutboundMessage({
    conversationId: conversation.id,
    fromNumber,
    toNumber,
    body: input.body,
    mediaUrls: input.mediaUrls,
    sentById: input.sentById ?? null,
    broadcastId: input.broadcastId ?? null,
  });

  // 3. Rate limit. Both buckets must grant, account first (the scarcer resource).
  const waitMs = input.rateLimitWaitMs ?? 30_000;
  const accountGranted = await getAccountBucket().waitForToken(1, waitMs);
  if (!accountGranted) {
    return {
      status: 'rate_limited',
      messageId: message.id,
      conversationId: conversation.id,
      providerMessageId: null,
      reason: 'Account rate limit: no token available within the wait window',
      retryable: true,
    };
  }

  if (input.broadcastId) {
    const campaignGranted = await getBroadcastBucket(
      input.broadcastId,
      input.broadcastThrottlePerSecond,
    ).waitForToken(1, waitMs);

    if (!campaignGranted) {
      return {
        status: 'rate_limited',
        messageId: message.id,
        conversationId: conversation.id,
        providerMessageId: null,
        reason: 'Broadcast rate limit: no token available within the wait window',
        retryable: true,
      };
    }
  }

  // 4. Send.
  try {
    const result = await sendSms({
      to: toNumber,
      from: fromNumber,
      text: input.body,
      mediaUrls: input.mediaUrls,
      messageId: message.id,
      bulkId: input.bulkId ?? undefined,
      callbackData: input.broadcastId ?? undefined,
    });

    const terminalFailure = result.status === 'FAILED' || result.status === 'UNDELIVERABLE';

    // 5. Reconcile.
    await markOutboundSubmitted({
      messageId: message.id,
      conversationId: conversation.id,
      providerMessageId: result.providerMessageId,
      providerBulkId: result.providerBulkId,
      status: terminalFailure ? (result.status as 'FAILED' | 'UNDELIVERABLE') : 'SENT',
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      segmentCount: result.segmentCount,
      body: input.body,
      hasMedia: Boolean(input.mediaUrls?.length),
    });

    // 1:1 messages update the UI immediately. Broadcast messages do not emit
    // per-message — the debounced progress event covers them.
    if (!input.broadcastId) {
      emitNewMessage(conversation.id, {
        id: message.id,
        conversationId: conversation.id,
        direction: 'OUTBOUND',
        fromNumber,
        toNumber,
        body: input.body,
        mediaUrls: input.mediaUrls ?? [],
        status: terminalFailure ? result.status : 'SENT',
        createdAt: new Date().toISOString(),
      });
      emitConversationUpdate({ id: conversation.id, lastMessageText: input.body, lastMessageAt: new Date().toISOString() });
    }

    return {
      status: terminalFailure ? 'failed' : 'sent',
      messageId: message.id,
      conversationId: conversation.id,
      providerMessageId: result.providerMessageId,
      reason: result.errorMessage,
      retryable: false,
    };
  } catch (err) {
    const error = toInfobipError(err);

    await prisma.messagingMessage.update({
      where: { id: message.id },
      data: {
        status: error.retryable ? 'QUEUED' : 'FAILED',
        errorCode: error.providerCode,
        errorMessage: error.message,
      },
    });

    return {
      status: 'failed',
      messageId: message.id,
      conversationId: conversation.id,
      providerMessageId: null,
      reason: error.message,
      retryable: error.retryable,
    };
  }
}
