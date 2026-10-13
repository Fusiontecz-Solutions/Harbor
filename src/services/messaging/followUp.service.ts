/**
 * Lead-batch audiences, follow-up campaigns, and the approval gate.
 *
 * Three things that all turn on the same question — *who is still worth
 * messaging* — so they live together rather than being scattered through the
 * broadcast service.
 *
 * The rule that matters most is the follow-up audience. A follow-up chases
 * people who never answered, and "never answered" has to be read from the
 * message table rather than the recipient row: a reply arriving days after the
 * campaign finished still means don't chase them. On top of that, an agent who
 * has marked a lead Interested or Not Interested has already handled it by
 * hand, and a second automated nudge would either undo their work or annoy
 * someone who already said no.
 */
import type { MessagingMessageStatus } from '@prisma/client';
import prisma from '../../config/prismaClient';
import { createBroadcast, type BroadcastRecipientInput } from './broadcast.service';
import { analyzeSmsTemplate, estimatedCampaignCredits } from './smsSegments';

/**
 * Minimum gap between a campaign and the follow-up that chases it.
 *
 * Merchants do not reply instantly, and a follow-up sent minutes later reads
 * as a malfunction rather than a nudge — it is also the quickest way to have a
 * number flagged by a carrier.
 */
export const MIN_FOLLOW_UP_GAP_MS = Number(
  process.env.BROADCAST_FOLLOW_UP_MIN_GAP_MS ?? String(60 * 60 * 1000),
);

export type FollowUpAudience = 'unreplied' | 'failed' | 'all';

export function parseFollowUpAudience(value: unknown): FollowUpAudience {
  if (value === 'unreplied' || value === 'failed' || value === 'all') return value;
  return 'all';
}

const FOLLOW_UP_UNREPLIED: MessagingMessageStatus[] = ['SENT', 'DELIVERED'];
const FOLLOW_UP_FAILED: MessagingMessageStatus[] = ['FAILED'];
const FOLLOW_UP_ALL: MessagingMessageStatus[] = ['SENT', 'DELIVERED', 'FAILED'];

function statusesForAudience(audience: FollowUpAudience): MessagingMessageStatus[] {
  switch (audience) {
    case 'unreplied':
      return FOLLOW_UP_UNREPLIED;
    case 'failed':
      return FOLLOW_UP_FAILED;
    case 'all':
      return FOLLOW_UP_ALL;
  }
}

/** Contacts an agent has already judged are out of every automated audience. */
const UNHANDLED_ONLY = { disposition: 'NEW' as const };

/** Leads left out of a batch audience, and why — so the audience shrinks honestly. */
export interface BatchExclusions {
  /** Every lead in the caller's share of the batch, before anything is left out. */
  total: number;
  blocked: number;
  /** Marked Interested or Not Interested (the sum of the two below). */
  disposed: number;
  interested: number;
  notInterested: number;
}

export interface BatchAudience {
  recipients: BroadcastRecipientInput[];
  excluded: BatchExclusions;
}

const toRecipient = (contact: {
  phoneNumber: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  city: string | null;
  state: string | null;
}): BroadcastRecipientInput => ({
  phoneNumber: contact.phoneNumber,
  mergeData: {
    firstName: contact.firstName,
    lastName: contact.lastName,
    company: contact.company,
    city: contact.city,
    state: contact.state,
  },
});

/**
 * The messageable leads in one upload batch.
 *
 * `ownerUserIds` is what makes an agent's batch their own slice of it: passed
 * their id, they get the leads dealt to them and nobody else's. Passing null
 * (an admin) resolves the whole batch.
 */
export async function resolveBatchAudience(
  batchId: string,
  ownerUserIds: string[] | null,
): Promise<BatchAudience> {
  const scope: Record<string, unknown> = { batchId };
  if (Array.isArray(ownerUserIds)) scope.ownerUserId = { in: ownerUserIds };

  const select = {
    phoneNumber: true,
    firstName: true,
    lastName: true,
    company: true,
    city: true,
    state: true,
  } as const;

  const eligible = await prisma.messagingContact.findMany({
    where: { ...scope, status: 'ACTIVE', ...UNHANDLED_ONLY } as never,
    select,
  });

  // Counted rather than inferred from the difference, so the two reasons stay
  // distinguishable in the UI.
  const [total, blocked, interested, notInterested] = await Promise.all([
    prisma.messagingContact.count({ where: scope as never }),
    prisma.messagingContact.count({ where: { ...scope, status: 'BLOCKED' } as never }),
    prisma.messagingContact.count({ where: { ...scope, status: 'ACTIVE', disposition: 'INTERESTED' } as never }),
    prisma.messagingContact.count({ where: { ...scope, status: 'ACTIVE', disposition: 'NOT_INTERESTED' } as never }),
  ]);

  return {
    recipients: eligible.map(toRecipient),
    excluded: { total, blocked, disposed: interested + notInterested, interested, notInterested },
  };
}

/**
 * The numbers that replied to a campaign.
 *
 * Read from inbound messages since the campaign started rather than from the
 * campaign's own attribution: a merchant who answers from a different thread,
 * or whose reply arrived after the counters were flushed, has still answered.
 * Chasing them would be the most visible possible failure of this feature.
 */
async function respondedNumbers(
  broadcastId: string,
  since: Date,
  numbers: string[],
  /** The number this campaign sent from; replies arrive back on it. */
  businessNumber: string | null,
): Promise<Set<string>> {
  if (numbers.length === 0) return new Set();

  const replies = await prisma.messagingMessage.findMany({
    where: {
      direction: 'INBOUND',
      fromNumber: { in: numbers },
      OR: [
        // Attributed to this campaign.
        { broadcastId },
        /**
         * Or simply anything they said to us on this campaign's own number
         * since it went out — a reply that arrived before attribution was
         * fixed, or one the provider never echoed a campaign for, still means
         * they answered.
         *
         * Scoped to `toNumber` so two campaigns running from different senders
         * at the same time cannot absorb each other's replies, which would
         * silently drop real leads out of a follow-up.
         */
        {
          createdAt: { gte: since },
          ...(businessNumber ? { toNumber: businessNumber } : {}),
        },
      ],
    },
    select: { fromNumber: true },
  });

  return new Set(replies.map((reply) => reply.fromNumber));
}

export interface FollowUpPreview {
  parentId: string;
  parentName: string;
  audience: FollowUpAudience;
  /** Earliest instant a follow-up may be scheduled for. */
  earliestSendAt: Date;
  eligibleCount: number;
  excluded: { replied: number; disposed: number; notDelivered: number };
}

/**
 * Who a follow-up to this campaign would reach, without creating anything.
 *
 * Separate from creation so an operator can see "of 4,000, 3,100 never
 * replied" before committing to a second send — the same preflight idea the
 * original broadcast already uses.
 */
export async function previewFollowUpAudience(
  parentId: string,
  audience: FollowUpAudience = 'all',
): Promise<FollowUpPreview> {
  const parent = await prisma.smsBroadcast.findUnique({
    where: { id: parentId },
    select: { id: true, name: true, fromNumber: true, startedAt: true, finishedAt: true, createdAt: true },
  });
  if (!parent) throw new Error('Broadcast not found');

  const since = parent.startedAt ?? parent.createdAt;

  const statuses = statusesForAudience(audience);
  const candidates = await prisma.smsBroadcastRecipient.findMany({
    where: { broadcastId: parentId, status: { in: statuses } },
    select: { phoneNumber: true },
  });
  const candidateNumbers = candidates.map((row) => row.phoneNumber);

  const notDelivered = await prisma.smsBroadcastRecipient.count({
    where: { broadcastId: parentId, status: { notIn: statuses } },
  });

  if (candidateNumbers.length === 0) {
    return {
      parentId: parent.id,
      parentName: parent.name,
      audience,
      earliestSendAt: new Date((parent.finishedAt ?? since).getTime() + MIN_FOLLOW_UP_GAP_MS),
      eligibleCount: 0,
      excluded: { replied: 0, disposed: 0, notDelivered },
    };
  }

  const responded = await respondedNumbers(parentId, since, candidateNumbers, parent.fromNumber);
  const silent = candidateNumbers.filter((number) => !responded.has(number));

  const handled = await prisma.messagingContact.findMany({
    where: {
      phoneNumber: { in: silent },
      OR: [{ disposition: { not: 'NEW' } }, { status: 'BLOCKED' }],
    },
    select: { phoneNumber: true },
  });
  const handledNumbers = new Set(handled.map((row) => row.phoneNumber));

  const eligible = silent.filter((number) => !handledNumbers.has(number));

  return {
    parentId: parent.id,
    parentName: parent.name,
    audience,
    earliestSendAt: new Date((parent.finishedAt ?? since).getTime() + MIN_FOLLOW_UP_GAP_MS),
    eligibleCount: eligible.length,
    excluded: {
      replied: candidateNumbers.length - silent.length,
      disposed: handledNumbers.size,
      notDelivered,
    },
  };
}

/**
 * Create a follow-up campaign against a parent's non-responders.
 *
 * The one-hour minimum is enforced here rather than trusted from the caller:
 * the gap exists to protect the sending number's reputation, so it has to hold
 * whether the request came from the UI, the API or a future automation.
 */
export async function createFollowUpBroadcast(input: {
  parentId: string;
  name?: string;
  body: string;
  scheduledAt: Date;
  audience?: FollowUpAudience;
  createdById?: string | null;
  requiresApproval?: boolean;
  fromNumber?: string;
}) {
  const parent = await prisma.smsBroadcast.findUnique({
    where: { id: input.parentId },
    select: {
      id: true,
      name: true,
      fromNumber: true,
      leadBatchId: true,
      startedAt: true,
      finishedAt: true,
      createdAt: true,
      status: true,
    },
  });
  if (!parent) throw new Error('Broadcast not found');

  const since = parent.startedAt ?? parent.createdAt;
  const earliest = new Date((parent.finishedAt ?? since).getTime() + MIN_FOLLOW_UP_GAP_MS);

  if (input.scheduledAt.getTime() < earliest.getTime()) {
    const minutes = Math.round(MIN_FOLLOW_UP_GAP_MS / 60000);
    throw new Error(
      `A follow-up must be at least ${minutes} minutes after the original — the earliest is ${earliest.toISOString()}`,
    );
  }

  const audience = parseFollowUpAudience(input.audience);
  const preview = await previewFollowUpAudience(input.parentId, audience);
  if (preview.eligibleCount === 0) {
    throw new Error(
      'Nobody is left to follow up: everyone replied, was marked, or is excluded (undeliverable / suppressed)',
    );
  }

  // Re-resolve the audience rather than trusting the preview's count: minutes
  // may have passed, and a reply that arrived in between must still exclude.
  const statuses = statusesForAudience(audience);
  const candidates = await prisma.smsBroadcastRecipient.findMany({
    where: { broadcastId: input.parentId, status: { in: statuses } },
    select: { phoneNumber: true, mergeData: true },
  });
  const responded = await respondedNumbers(
    input.parentId,
    since,
    candidates.map((row) => row.phoneNumber),
    parent.fromNumber,
  );

  const silent = candidates.filter((row) => !responded.has(row.phoneNumber));
  const handled = await prisma.messagingContact.findMany({
    where: {
      phoneNumber: { in: silent.map((row) => row.phoneNumber) },
      OR: [{ disposition: { not: 'NEW' } }, { status: 'BLOCKED' }],
    },
    select: { phoneNumber: true },
  });
  const handledNumbers = new Set(handled.map((row) => row.phoneNumber));

  const recipients: BroadcastRecipientInput[] = silent
    .filter((row) => !handledNumbers.has(row.phoneNumber))
    .map((row) => ({
      phoneNumber: row.phoneNumber,
      mergeData: (row.mergeData as Record<string, unknown> | null) ?? undefined,
    }));

  if (recipients.length === 0) {
    throw new Error(
      'Nobody is left to follow up: everyone replied, was marked, or is excluded (undeliverable / suppressed)',
    );
  }

  const bodyText = String(input.body ?? '').trim();
  if (!bodyText) throw new Error('Message body is required');

  const mergeSamples = recipients
    .map((row) => row.mergeData)
    .filter((data): data is Record<string, unknown> => Boolean(data && typeof data === 'object'));
  const smsSegment = analyzeSmsTemplate(bodyText, mergeSamples);

  const result = await createBroadcast({
    name: input.name?.trim() || `${parent.name} — follow-up`,
    body: bodyText,
    // Same number as the original, so the thread reads as one conversation
    // rather than a stranger picking up where someone else left off.
    fromNumber: input.fromNumber ?? parent.fromNumber,
    recipients,
    scheduledAt: input.scheduledAt,
    createdById: input.createdById ?? null,
    parentBroadcastId: parent.id,
    leadBatchId: parent.leadBatchId,
    requiresApproval: input.requiresApproval,
  });

  return {
    ...result,
    sms: {
      ...smsSegment,
      estimatedTotalCredits: estimatedCampaignCredits(result.queuedCount, smsSegment.credits),
    },
  };
}

/* ============================================================================
 * Approval
 * ==========================================================================*/

/**
 * Release an agent-built campaign.
 *
 * A scheduled campaign goes to QUEUED, which is what the scheduler picks up;
 * an unscheduled one goes to DRAFT so the approver can start it by hand. Either
 * way the approval is recorded, because "who let this go out" is the first
 * question asked when a campaign causes trouble.
 */
export async function approveBroadcast(broadcastId: string, approverId: string | null) {
  const broadcast = await prisma.smsBroadcast.findUnique({
    where: { id: broadcastId },
    select: { id: true, status: true, scheduledAt: true },
  });
  if (!broadcast) throw new Error('Broadcast not found');
  if (broadcast.status !== 'PENDING_APPROVAL') {
    throw new Error(`Only a campaign awaiting approval can be approved (this one is ${broadcast.status})`);
  }

  return prisma.smsBroadcast.update({
    where: { id: broadcastId },
    data: {
      status: broadcast.scheduledAt ? 'QUEUED' : 'DRAFT',
      approvedById: approverId,
      approvedAt: new Date(),
    },
    select: { id: true, status: true, scheduledAt: true, approvedAt: true },
  });
}

/**
 * Reject an agent-built campaign.
 *
 * CANCELLED rather than deleted: the agent should be able to see that their
 * campaign was turned down instead of finding it vanished.
 */
export async function rejectBroadcast(broadcastId: string) {
  const broadcast = await prisma.smsBroadcast.findUnique({
    where: { id: broadcastId },
    select: { status: true },
  });
  if (!broadcast) throw new Error('Broadcast not found');
  if (broadcast.status !== 'PENDING_APPROVAL') {
    throw new Error(`Only a campaign awaiting approval can be rejected (this one is ${broadcast.status})`);
  }

  return prisma.smsBroadcast.update({
    where: { id: broadcastId },
    data: { status: 'CANCELLED', finishedAt: new Date() },
    select: { id: true, status: true },
  });
}
