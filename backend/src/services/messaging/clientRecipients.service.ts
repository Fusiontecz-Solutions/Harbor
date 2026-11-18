/**
 * CRM clients as a messaging audience.
 *
 * Harbor already holds every merchant in `Client`, so retyping or re-exporting
 * them into a spreadsheet just to text them is wasted work. This resolves CRM
 * clients into messaging recipients, carrying their fields through as merge
 * data so `{{firstName}}` and `{{company}}` work exactly as they do for an
 * imported sheet.
 *
 * Phone preference is `ownerMobileNumber` before `businessNumber`: the owner's
 * mobile is the number that can actually receive SMS. A business landline
 * silently fails at the carrier, so rows that only have one are flagged
 * `phoneSource: 'business'` and the UI can warn before a blast goes out.
 */
import type { Prisma } from '@prisma/client';
import prisma from '../../config/prismaClient';
import { normalizePhoneNumber } from './phone';
import { checkSuppressionBulk } from './suppression.service';

export interface ClientRecipient {
  clientId: string;
  clientNumber: number;
  businessName: string;
  ownerName: string;
  phoneNumber: string | null;
  /** Which column the number came from — 'owner' is SMS-safe, 'business' may be a landline. */
  phoneSource: 'owner' | 'business' | null;
  email: string | null;
  city: string | null;
  state: string | null;
  status: string;
  /** True when the number is blocked, opted out or on a DNC list. */
  suppressed: boolean;
  suppressionReason: string | null;
}

/**
 * Browse clients for the recipient picker. Only returns clients that have at
 * least one usable phone number — offering an un-textable client in a picker
 * is a bug report waiting to happen.
 */
export async function listClientRecipients(params: {
  search?: string;
  page?: number;
  pageSize?: number;
  /** Omit clients whose number is currently suppressed. */
  excludeSuppressed?: boolean;
}): Promise<{ items: ClientRecipient[]; total: number; page: number; pageSize: number; hasMore: boolean }> {
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(params.pageSize) || 50));
  const search = String(params.search ?? '').trim();

  const where: Prisma.ClientWhereInput = {
    OR: [
      { ownerMobileNumber: { not: null } },
      { businessNumber: { not: null } },
    ],
  };

  if (search) {
    where.AND = [
      {
        OR: [
          { businessName: { contains: search, mode: 'insensitive' } },
          { ownerFirstName: { contains: search, mode: 'insensitive' } },
          { ownerLastName: { contains: search, mode: 'insensitive' } },
          { businessEmail: { contains: search, mode: 'insensitive' } },
          { ownerMobileNumber: { contains: search } },
          { businessNumber: { contains: search } },
        ],
      },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.client.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        clientId: true,
        businessName: true,
        ownerFirstName: true,
        ownerLastName: true,
        ownerMobileNumber: true,
        businessNumber: true,
        businessEmail: true,
        businessCity: true,
        businessState: true,
        status: true,
      },
    }),
    prisma.client.count({ where }),
  ]);

  const mapped = rows.map(toClientRecipient);

  // Annotate with suppression so the picker can grey out unreachable clients.
  const numbers = mapped.map((row) => row.phoneNumber).filter((n): n is string => Boolean(n));
  const verdicts = await checkSuppressionBulk(numbers);

  for (const row of mapped) {
    const verdict = row.phoneNumber ? verdicts.get(row.phoneNumber) : undefined;
    row.suppressed = Boolean(verdict);
    row.suppressionReason = verdict?.reason ?? null;
  }

  const items = params.excludeSuppressed ? mapped.filter((row) => !row.suppressed) : mapped;

  return { items, total, page, pageSize, hasMore: page * pageSize < total };
}

function toClientRecipient(row: {
  id: string;
  clientId: number;
  businessName: string;
  ownerFirstName: string;
  ownerLastName: string;
  ownerMobileNumber: string | null;
  businessNumber: string | null;
  businessEmail: string | null;
  businessCity: string | null;
  businessState: string | null;
  status: string;
}): ClientRecipient {
  const ownerPhone = normalizePhoneNumber(row.ownerMobileNumber);
  const businessPhone = normalizePhoneNumber(row.businessNumber);
  const phoneNumber = ownerPhone ?? businessPhone;

  return {
    clientId: row.id,
    clientNumber: row.clientId,
    businessName: row.businessName,
    ownerName: [row.ownerFirstName, row.ownerLastName].filter(Boolean).join(' ').trim(),
    phoneNumber,
    phoneSource: ownerPhone ? 'owner' : businessPhone ? 'business' : null,
    email: row.businessEmail,
    city: row.businessCity,
    state: row.businessState,
    status: row.status,
    suppressed: false,
    suppressionReason: null,
  };
}

/** The Client columns every messaging path needs. Keep in step with the selects below. */
const CLIENT_PROFILE_SELECT = {
  id: true,
  clientId: true,
  businessName: true,
  ownerFirstName: true,
  ownerLastName: true,
  ownerMobileNumber: true,
  businessNumber: true,
  businessEmail: true,
  businessAddress1: true,
  businessCity: true,
  businessState: true,
  businessZipCode: true,
  status: true,
} as const;

type ClientProfileRow = Prisma.ClientGetPayload<{ select: typeof CLIENT_PROFILE_SELECT }>;

/**
 * Mirror a CRM client into `MessagingContact`, keyed on the number we will
 * actually text. Shared by the broadcast audience resolver and the one-to-one
 * send path so a chat started from the client picker shows the merchant's name,
 * company and email rather than a bare phone number.
 */
export async function upsertContactFromClient(
  client: Pick<
    ClientProfileRow,
    | 'id'
    | 'ownerFirstName'
    | 'ownerLastName'
    | 'businessEmail'
    | 'businessName'
    | 'businessAddress1'
    | 'businessCity'
    | 'businessState'
    | 'businessZipCode'
  >,
  phoneNumber: string,
  ownerUserId: string | null,
): Promise<{ id: string }> {
  return prisma.messagingContact.upsert({
    where: {
      ownerUserId_phoneNumber: { ownerUserId, phoneNumber } as never,
    },
    create: {
      phoneNumber,
      firstName: client.ownerFirstName,
      lastName: client.ownerLastName,
      emailAddress: client.businessEmail,
      company: client.businessName,
      street: client.businessAddress1,
      city: client.businessCity,
      state: client.businessState,
      zip: client.businessZipCode,
      tags: ['crm-client'],
      source: 'crm-client',
      clientId: client.id,
      ownerUserId,
    },
    // Only re-link and refresh the company: a contact may have been edited by
    // hand in Contacts & DNC, and a send should not silently revert that.
    update: { clientId: client.id, company: client.businessName },
    select: { id: true },
  });
}

/** Load one client with the columns {@link upsertContactFromClient} needs. */
export async function findClientById(id: string): Promise<ClientProfileRow | null> {
  return prisma.client.findUnique({ where: { id }, select: CLIENT_PROFILE_SELECT });
}

/**
 * Find the CRM client that owns a number, matching either the owner mobile or
 * the business line. Used to fill the chat's contact panel for a merchant who
 * has never been imported into `MessagingContact`.
 *
 * Client numbers are stored as typed, not normalized, so compare on the last
 * ten digits rather than on an exact string match.
 */
export async function findClientByPhone(phoneNumber: string): Promise<ClientProfileRow | null> {
  const digits = String(phoneNumber || '').replace(/\D/g, '');
  if (digits.length < 10) return null;
  const national = digits.slice(-10);

  const candidates = await prisma.client.findMany({
    where: {
      OR: [{ ownerMobileNumber: { contains: national } }, { businessNumber: { contains: national } }],
    },
    orderBy: { createdAt: 'desc' },
    take: 25,
    select: CLIENT_PROFILE_SELECT,
  });

  // `contains` can match a longer string, so confirm on the normalized form.
  return (
    candidates.find((row) => {
      const owner = normalizePhoneNumber(row.ownerMobileNumber);
      const business = normalizePhoneNumber(row.businessNumber);
      return owner === phoneNumber || business === phoneNumber;
    }) ?? null
  );
}

/**
 * Turn selected client ids into broadcast recipients.
 *
 * Also upserts a `MessagingContact` per client, linked back via `clientId`, so
 * the resulting conversation shows the merchant's name rather than a bare
 * number — and so a reply threads against the same contact next time.
 */
export async function resolveClientsAsRecipients(
  clientIds: string[],
  ownerUserId?: string | null,
): Promise<{
  recipients: Array<{ phoneNumber: string; mergeData: Record<string, unknown> }>;
  skipped: Array<{ clientId: string; businessName: string; reason: string }>;
}> {
  if (clientIds.length === 0) return { recipients: [], skipped: [] };

  const clients = await prisma.client.findMany({
    where: { id: { in: clientIds } },
    select: {
      id: true,
      clientId: true,
      businessName: true,
      ownerFirstName: true,
      ownerLastName: true,
      ownerMobileNumber: true,
      businessNumber: true,
      businessEmail: true,
      businessAddress1: true,
      businessCity: true,
      businessState: true,
      businessZipCode: true,
      status: true,
    },
  });

  const recipients: Array<{ phoneNumber: string; mergeData: Record<string, unknown> }> = [];
  const skipped: Array<{ clientId: string; businessName: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const client of clients) {
    const mapped = toClientRecipient(client);

    if (!mapped.phoneNumber) {
      skipped.push({ clientId: client.id, businessName: client.businessName, reason: 'No usable phone number' });
      continue;
    }

    if (seen.has(mapped.phoneNumber)) {
      skipped.push({
        clientId: client.id,
        businessName: client.businessName,
        reason: `Duplicate number ${mapped.phoneNumber}`,
      });
      continue;
    }
    seen.add(mapped.phoneNumber);

    // Keep a messaging contact in step with the CRM record.
    await upsertContactFromClient(client, mapped.phoneNumber, ownerUserId ?? null);

    recipients.push({
      phoneNumber: mapped.phoneNumber,
      mergeData: {
        firstName: client.ownerFirstName,
        lastName: client.ownerLastName,
        ownerName: mapped.ownerName,
        company: client.businessName,
        businessName: client.businessName,
        email: client.businessEmail,
        city: client.businessCity,
        state: client.businessState,
        clientNumber: client.clientId,
      },
    });
  }

  // Ids that matched no row at all.
  const foundIds = new Set(clients.map((c) => c.id));
  for (const id of clientIds) {
    if (!foundIds.has(id)) {
      skipped.push({ clientId: id, businessName: '(unknown)', reason: 'Client not found' });
    }
  }

  return { recipients, skipped };
}
