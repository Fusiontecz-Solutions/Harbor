/**
 * Suppression — the gate every outbound message passes through.
 *
 * Four independent reasons a number may be unreachable, unified behind one
 * check so no send path can accidentally consult only some of them:
 *
 *   STOP_KEYWORD      the contact texted STOP/UNSUBSCRIBE/etc.
 *   MANUAL_BLOCK      an agent blocked the contact in the UI
 *   DNC_LIST          a Do-Not-Call lookup came back "listed"
 *   CARRIER_VIOLATION / BOUNCE   provider-reported hard failures
 *
 * The check sits in the hot path of a 50k-recipient blast, so results are
 * cached in Redis. Writes invalidate the key immediately — an agent blocking a
 * contact must take effect on the very next message, not after a TTL.
 */
import prisma from '../../config/prismaClient';
import { cacheDel, cacheGet, cacheKeys, cacheSet } from './cache.service';
import { normalizePhoneNumber } from './phone';

export type SuppressionReason =
  | 'STOP_KEYWORD'
  | 'MANUAL_BLOCK'
  | 'DNC_LIST'
  | 'CARRIER_VIOLATION'
  | 'BOUNCE';

export interface SuppressionVerdict {
  suppressed: boolean;
  reason: SuppressionReason | null;
  source: string | null;
}

const NOT_SUPPRESSED: SuppressionVerdict = { suppressed: false, reason: null, source: null };

/** Cached for 10 minutes; every write path invalidates explicitly. */
const SUPPRESSION_TTL_SECONDS = 600;

/**
 * Opt-out keywords. Matched against the whole trimmed body, not a substring —
 * "stop by the office tomorrow" must not opt a merchant out.
 *
 * Infobip performs its own opt-out handling for some number types; we keep our
 * own list so behaviour is identical regardless of how a number is provisioned.
 */
const STOP_KEYWORDS = new Set([
  'stop',
  'stopall',
  'unsubscribe',
  'cancel',
  'end',
  'quit',
  'stop all',
  'opt out',
  'optout',
  'remove me',
]);

/** Keywords that re-enable messaging after a STOP. */
const START_KEYWORDS = new Set(['start', 'unstop', 'yes', 'subscribe', 'opt in', 'optin']);

export function isStopKeyword(body: string | null | undefined): boolean {
  const normalized = String(body ?? '')
    .trim()
    .toLowerCase()
    .replace(/[.!?,]+$/g, '')
    .replace(/\s+/g, ' ');
  return normalized.length > 0 && STOP_KEYWORDS.has(normalized);
}

export function isStartKeyword(body: string | null | undefined): boolean {
  const normalized = String(body ?? '')
    .trim()
    .toLowerCase()
    .replace(/[.!?,]+$/g, '')
    .replace(/\s+/g, ' ');
  return normalized.length > 0 && START_KEYWORDS.has(normalized);
}

/**
 * Is this number blocked for any reason?
 *
 * Fails **closed** on an unexpected database error: if we cannot prove a number
 * is safe to message, we do not message it. That is the opposite of the cache
 * layer's fail-open stance, and deliberately so — the cost of a wrongly-skipped
 * message is a retry, the cost of texting someone who opted out is a TCPA
 * complaint.
 */
export async function checkSuppression(phoneNumber: string): Promise<SuppressionVerdict> {
  const normalized = normalizePhoneNumber(phoneNumber);
  if (!normalized) {
    return { suppressed: true, reason: 'CARRIER_VIOLATION', source: 'unparseable phone number' };
  }

  const cacheKey = cacheKeys.suppression(normalized);
  const cached = await cacheGet<SuppressionVerdict>(cacheKey);
  if (cached) return cached;

  try {
    const [suppression, contact] = await Promise.all([
      prisma.messagingSuppression.findFirst({
        where: { phoneNumber: normalized, active: true },
        select: { reason: true, source: true },
      }),
      prisma.messagingContact.findFirst({
        where: { phoneNumber: normalized, status: 'BLOCKED' },
        select: { id: true },
      }),
    ]);

    let verdict: SuppressionVerdict = NOT_SUPPRESSED;

    if (suppression) {
      verdict = {
        suppressed: true,
        reason: suppression.reason as SuppressionReason,
        source: suppression.source ?? null,
      };
    } else if (contact) {
      // A contact row flagged BLOCKED without a suppression row — keep them in
      // sync on read so the two representations cannot drift apart silently.
      verdict = { suppressed: true, reason: 'MANUAL_BLOCK', source: 'contact status' };
    }

    await cacheSet(cacheKey, verdict, SUPPRESSION_TTL_SECONDS);
    return verdict;
  } catch (err) {
    console.error('[messaging:suppression] check failed, failing closed:', normalized, (err as Error)?.message);
    return { suppressed: true, reason: null, source: 'suppression lookup failed' };
  }
}

/**
 * Bulk variant for broadcast preflight — one query for the whole recipient
 * list instead of N cache round-trips. Returns the set of suppressed numbers.
 */
export async function checkSuppressionBulk(phoneNumbers: string[]): Promise<Map<string, SuppressionVerdict>> {
  const verdicts = new Map<string, SuppressionVerdict>();

  const normalized = phoneNumbers
    .map((phone) => normalizePhoneNumber(phone))
    .filter((phone): phone is string => Boolean(phone));

  if (normalized.length === 0) return verdicts;

  const unique = [...new Set(normalized)];

  const [suppressions, blockedContacts] = await Promise.all([
    prisma.messagingSuppression.findMany({
      where: { phoneNumber: { in: unique }, active: true },
      select: { phoneNumber: true, reason: true, source: true },
    }),
    prisma.messagingContact.findMany({
      where: { phoneNumber: { in: unique }, status: 'BLOCKED' },
      select: { phoneNumber: true },
    }),
  ]);

  for (const row of suppressions) {
    verdicts.set(row.phoneNumber, {
      suppressed: true,
      reason: row.reason as SuppressionReason,
      source: row.source ?? null,
    });
  }

  for (const row of blockedContacts) {
    if (!verdicts.has(row.phoneNumber)) {
      verdicts.set(row.phoneNumber, { suppressed: true, reason: 'MANUAL_BLOCK', source: 'contact status' });
    }
  }

  return verdicts;
}

/** Add (or reactivate) a suppression and invalidate the cached verdict. */
export async function addSuppression(input: {
  phoneNumber: string;
  reason: SuppressionReason;
  source?: string;
  createdById?: string | null;
}): Promise<void> {
  const normalized = normalizePhoneNumber(input.phoneNumber);
  if (!normalized) return;

  await prisma.messagingSuppression.upsert({
    where: { phoneNumber_reason: { phoneNumber: normalized, reason: input.reason } },
    create: {
      phoneNumber: normalized,
      reason: input.reason,
      source: input.source ?? null,
      createdById: input.createdById ?? null,
      active: true,
    },
    update: {
      active: true,
      source: input.source ?? undefined,
    },
  });

  await cacheDel(cacheKeys.suppression(normalized));
}

/** Lift one reason. Other active reasons keep the number suppressed. */
export async function removeSuppression(phoneNumber: string, reason: SuppressionReason): Promise<void> {
  const normalized = normalizePhoneNumber(phoneNumber);
  if (!normalized) return;

  await prisma.messagingSuppression.updateMany({
    where: { phoneNumber: normalized, reason },
    data: { active: false },
  });

  await cacheDel(cacheKeys.suppression(normalized));
}

/**
 * Block a contact from the UI: flips the contact row AND writes a suppression,
 * so the block holds even for numbers that have no contact record yet.
 */
export async function blockContact(phoneNumber: string, createdById?: string | null): Promise<void> {
  const normalized = normalizePhoneNumber(phoneNumber);
  if (!normalized) throw new Error('Invalid phone number');

  await prisma.$transaction([
    prisma.messagingContact.updateMany({
      where: { phoneNumber: normalized },
      data: { status: 'BLOCKED' },
    }),
    prisma.messagingSuppression.upsert({
      where: { phoneNumber_reason: { phoneNumber: normalized, reason: 'MANUAL_BLOCK' } },
      create: {
        phoneNumber: normalized,
        reason: 'MANUAL_BLOCK',
        source: 'blocked in app',
        createdById: createdById ?? null,
        active: true,
      },
      update: { active: true },
    }),
  ]);

  await cacheDel(cacheKeys.suppression(normalized));
}

export async function unblockContact(phoneNumber: string): Promise<void> {
  const normalized = normalizePhoneNumber(phoneNumber);
  if (!normalized) throw new Error('Invalid phone number');

  await prisma.$transaction([
    prisma.messagingContact.updateMany({
      where: { phoneNumber: normalized },
      data: { status: 'ACTIVE' },
    }),
    prisma.messagingSuppression.updateMany({
      where: { phoneNumber: normalized, reason: 'MANUAL_BLOCK' },
      data: { active: false },
    }),
  ]);

  await cacheDel(cacheKeys.suppression(normalized));
}

/**
 * Record an inbound STOP. Also flips the conversation's `isOptedOut` so the
 * composer can be disabled in the UI rather than failing at send time.
 */
export async function applyStopKeyword(phoneNumber: string, conversationId?: string): Promise<void> {
  await addSuppression({
    phoneNumber,
    reason: 'STOP_KEYWORD',
    source: 'inbound STOP message',
  });

  if (conversationId) {
    await prisma.messagingConversation.update({
      where: { id: conversationId },
      data: { isOptedOut: true },
    });
  }
}

export async function applyStartKeyword(phoneNumber: string, conversationId?: string): Promise<void> {
  await removeSuppression(phoneNumber, 'STOP_KEYWORD');

  if (conversationId) {
    await prisma.messagingConversation.update({
      where: { id: conversationId },
      data: { isOptedOut: false },
    });
  }
}
