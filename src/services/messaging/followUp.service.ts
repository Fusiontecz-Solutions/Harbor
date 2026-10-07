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

/** Contacts an agent has already judged are out of every automated audience. */
const UNHANDLED_ONLY = { disposition: 'NEW' as const };

export interface BatchAudience {
  recipients: BroadcastRecipientInput[];
  /** Leads left out, and why — so the operator sees the audience shrink honestly. */
  excluded: { blocked: number; disposed: number };
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
  const [blocked, disposed] = await Promise.all([
    prisma.messagingContact.count({ where: { ...scope, status: 'BLOCKED' } as never }),
    prisma.messagingContact.count({
      where: { ...scope, status: 'ACTIVE', disposition: { not: 'NEW' } } as never,
    }),
  ]);

  return { recipients: eligible.map(toRecipient), excluded: { blocked, disposed } };
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
): Promise<Set<string>> {
  if (numbers.length === 0) return new Set();

  const replies = await prisma.messagingMessage.findMany({
    where: {
      direction: 'INBOUND',
      fromNumber: { in: numbers },
      // Either attributed to this campaign, or simply anything they have said
      // to us since it went out — both mean they answered.
      OR: [{ broadcastId }, { createdAt: { gte: since } }],
    },
    select: { fromNumber: true },
  });

  return new Set(replies.map((reply) => reply.fromNumber));
}

export interface FollowUpPreview {
  parentId: string;
  parentName: string;
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
export async function previewFollowUpAudience(parentId: string): Promise<FollowUpPreview> {
  const parent = await prisma.smsBroadcast.findUnique({
    where: { id: parentId },
    select: { id: true, name: true, startedAt: true, finishedAt: true, createdAt: true },
  });
  if (!parent) throw new Error('Broadcast not found');

  const since = parent.startedAt ?? parent.createdAt;

  /**
   * Only people we actually reached. Chasing a number whose first message was
   * rejected repeats a send that already failed, and if the failure was the
   * number being invalid it will fail again identically.
   */
  const reached = await prisma.smsBroadcastRecipient.findMany({
    where: { broadcastId: parentId, status: { in: ['SENT', 'DELIVERED'] } },
    select: { phoneNumber: true },
  });
  const reachedNumbers = reached.map((row) => row.phoneNumber);

  const notDelivered = await prisma.smsBroadcastRecipient.count({
    where: { broadcastId: parentId, status: { notIn: ['SENT', 'DELIVERED'] } },
  });

  if (reachedNumbers.length === 0) {
    return {
      parentId: parent.id,
      parentName: parent.name,
      earliestSendAt: new Date((parent.finishedAt ?? since).getTime() + MIN_FOLLOW_UP_GAP_MS),
      eligibleCount: 0,
      excluded: { replied: 0, disposed: 0, notDelivered },
    };
  }

  const responded = await respondedNumbers(parentId, since, reachedNumbers);
  const silent = reachedNumbers.filter((number) => !responded.has(number));

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
    earliestSendAt: new Date((parent.finishedAt ?? since).getTime() + MIN_FOLLOW_UP_GAP_MS),
    eligibleCount: eligible.length,
    excluded: {
      replied: reachedNumbers.length - silent.length,
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

  const preview = await previewFollowUpAudience(input.parentId);
  if (preview.eligibleCount === 0) {
    throw new Error('Nobody is left to follow up: everyone replied, was marked, or was never reached');
  }

  // Re-resolve the audience rather than trusting the preview's count: minutes
  // may have passed, and a reply that arrived in between must still exclude.
  const reached = await prisma.smsBroadcastRecipient.findMany({
    where: { broadcastId: input.parentId, status: { in: ['SENT', 'DELIVERED'] } },
    select: { phoneNumber: true, mergeData: true },
  });
  const responded = await respondedNumbers(
    input.parentId,
    since,
    reached.map((row) => row.phoneNumber),
  );

  const silent = reached.filter((row) => !responded.has(row.phoneNumber));
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
    throw new Error('Nobody is left to follow up: everyone replied, was marked, or was never reached');
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
