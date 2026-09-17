/**
 * Which number a user sends from.
 *
 * Senders used to come from INFOBIP_SENDER alone, so every user shared one
 * number. An admin now curates a registry of senders and assigns one per user,
 * which lets separate desks run their own number. The env value remains the
 * fallback, so an unassigned user keeps working exactly as before and the
 * change cannot strand anyone mid-rollout.
 *
 * Every send path resolves through here rather than reading the env directly,
 * so there is one answer to "who is this going out as".
 */
import prisma from '../../config/prismaClient';
import { getDefaultSender } from './infobip.service';
import { normalizePhoneNumber, normalizeSender } from './phone';

/** Roles that see the whole inbox rather than just their own sender's threads. */
const PRIVILEGED_ROLES = new Set(['ADMIN', 'SUPER_ADMIN']);

export function isPrivilegedMessagingRole(role: unknown): boolean {
  return PRIVILEGED_ROLES.has(String(role || '').toUpperCase().replace(/-/g, '_'));
}

/**
 * The sender assigned to a user, or the env default when they have none.
 *
 * An inactive sender is ignored: deactivating a number should stop it being
 * used without having to unassign every user first.
 */
export async function resolveSenderForUser(userId: string | null | undefined): Promise<string> {
  const fallback = normalizeSender(getDefaultSender());
  if (!userId) return fallback;

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { messagingSender: { select: { phoneNumber: true, isActive: true } } },
    });
    const assigned = user?.messagingSender;
    if (assigned?.isActive && assigned.phoneNumber) {
      return normalizeSender(assigned.phoneNumber);
    }
  } catch (err) {
    // A lookup failure must not block a send — fall back to the shared number.
    console.warn('[messaging:sender] resolve failed, using default:', (err as Error)?.message);
  }

  return fallback;
}

/**
 * Senders whose conversations a user may see.
 *
 * Returns null for privileged roles, meaning "no restriction". For everyone
 * else it is their own sender, so a rep's inbox contains only the threads on
 * their number.
 */
export async function visibleSendersForUser(
  userId: string | null | undefined,
  role: unknown,
): Promise<string[] | null> {
  if (isPrivilegedMessagingRole(role)) return null;
  const sender = await resolveSenderForUser(userId);
  return sender ? [sender] : [];
}

/**
 * The sender a user will send as, with its label when one is assigned.
 *
 * Used by the config endpoint so the UI can show people which number they are
 * sending from — with per-user senders, that is no longer something they can
 * assume.
 */
export async function resolveSenderDetailForUser(
  userId: string | null | undefined,
): Promise<{ phoneNumber: string; label: string | null; assigned: boolean }> {
  const fallback = normalizeSender(getDefaultSender());
  if (!userId) return { phoneNumber: fallback, label: null, assigned: false };

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { messagingSender: { select: { phoneNumber: true, label: true, isActive: true } } },
    });
    const assigned = user?.messagingSender;
    if (assigned?.isActive && assigned.phoneNumber) {
      return {
        phoneNumber: normalizeSender(assigned.phoneNumber),
        label: assigned.label ?? null,
        assigned: true,
      };
    }
  } catch (err) {
    console.warn('[messaging:sender] detail lookup failed:', (err as Error)?.message);
  }

  return { phoneNumber: fallback, label: null, assigned: false };
}

export interface SenderInput {
  phoneNumber: string;
  label?: string | null;
  isActive?: boolean;
}

/** Create or update a sender, normalizing the number so it matches inbound `to`. */
export async function upsertSender(input: SenderInput & { id?: string }) {
  const phoneNumber = normalizePhoneNumber(input.phoneNumber);
  if (!phoneNumber) {
    throw new Error(`"${input.phoneNumber}" is not a valid phone number`);
  }

  const data = {
    phoneNumber,
    label: input.label?.trim() || null,
    isActive: input.isActive ?? true,
  };

  if (input.id) {
    return prisma.messagingSender.update({ where: { id: input.id }, data });
  }
  return prisma.messagingSender.upsert({
    where: { phoneNumber },
    create: data,
    update: { label: data.label, isActive: data.isActive },
  });
}

export async function listSenders() {
  return prisma.messagingSender.findMany({
    orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
    include: { _count: { select: { users: true } } },
  });
}

/** Assign a sender to a user, or clear it with a null senderId. */
export async function assignSenderToUser(userId: string, senderId: string | null) {
  if (senderId) {
    const sender = await prisma.messagingSender.findUnique({ where: { id: senderId } });
    if (!sender) throw new Error('Sender not found');
  }
  return prisma.user.update({
    where: { id: userId },
    data: { messagingSenderId: senderId },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      role: true,
      messagingSender: { select: { id: true, phoneNumber: true, label: true, isActive: true } },
    },
  });
}

/** Users and their assigned sender, for the admin assignment table. */
export async function listUsersWithSenders() {
  return prisma.user.findMany({
    where: { isActive: true },
    orderBy: [{ firstName: 'asc' }, { email: 'asc' }],
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      role: true,
      messagingSender: { select: { id: true, phoneNumber: true, label: true, isActive: true } },
    },
  });
}

/**
 * Delete a sender. Assignments null out via the FK's ON DELETE SET NULL, so
 * affected users fall back to the env default rather than losing the ability
 * to send.
 */
export async function deleteSender(id: string) {
  return prisma.messagingSender.delete({ where: { id } });
}
