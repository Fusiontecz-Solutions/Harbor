/**
 * Messaging contacts + spreadsheet import.
 *
 * Fivra parsed CSVs in the browser and POSTed the rows. That breaks down on
 * large lists: a 50k-row file becomes a multi-megabyte JSON body, and any
 * column the browser parser mishandles is invisible server-side. Harbor already
 * ships `xlsx` and `express-fileupload`, so parsing happens here — one code
 * path for .xlsx and .csv, with the header mapping reported back so the
 * operator can see how their columns were interpreted.
 *
 * Import is idempotent on (owner, phone): re-uploading an updated sheet
 * refreshes the existing contacts instead of duplicating them.
 */
import * as XLSX from 'xlsx';
import prisma from '../../config/prismaClient';
import { normalizePhoneNumber } from './phone';

export interface ImportedRow {
  phoneNumber: string;
  firstName?: string | null;
  lastName?: string | null;
  emailAddress?: string | null;
  company?: string | null;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  tags?: string[];
}

export interface ImportSummary {
  totalRows: number;
  imported: number;
  updated: number;
  skippedInvalid: number;
  skippedDuplicate: number;
  /** Which sheet column fed each contact field, for operator confirmation. */
  columnMapping: Record<string, string>;
  /** First few rejected rows, so a bad file is diagnosable without a re-run. */
  sampleErrors: Array<{ row: number; reason: string }>;
}

/**
 * Header aliases. Matching is case/punctuation-insensitive, so "Phone Number",
 * "phone_number" and "PHONE-NUMBER" all resolve to the same field.
 */
const COLUMN_ALIASES: Record<keyof Omit<ImportedRow, 'tags'> | 'tags', string[]> = {
  phoneNumber: ['phone', 'phonenumber', 'mobile', 'cell', 'cellphone', 'mobilenumber', 'number', 'contactnumber', 'telephone'],
  firstName: ['firstname', 'fname', 'first', 'givenname'],
  lastName: ['lastname', 'lname', 'last', 'surname', 'familyname'],
  emailAddress: ['email', 'emailaddress', 'mail', 'e-mail'],
  company: ['company', 'business', 'businessname', 'organization', 'organisation', 'dba'],
  street: ['street', 'address', 'address1', 'streetaddress', 'addressline1'],
  city: ['city', 'town'],
  state: ['state', 'province', 'region'],
  zip: ['zip', 'zipcode', 'postalcode', 'postcode'],
  tags: ['tags', 'tag', 'labels', 'segment'],
};

const canonicalize = (header: string): string =>
  String(header || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/** Build sheet-header → contact-field mapping for one row's keys. */
function resolveColumnMapping(headers: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};

  for (const header of headers) {
    const canonical = canonicalize(header);
    if (!canonical) continue;

    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (mapping[header]) break;
      if (canonical === canonicalize(field) || aliases.includes(canonical)) {
        mapping[header] = field;
        break;
      }
    }
  }

  return mapping;
}

/**
 * Parse an uploaded .xlsx/.xls/.csv buffer into candidate rows.
 *
 * `raw: false` makes SheetJS hand back formatted strings, which matters for
 * phone numbers: a spreadsheet stores `5551234567` as a float, and the raw
 * value arrives as `5551234567` or worse `5.55123e+9`.
 */
export function parseContactSheet(buffer: Buffer): {
  rows: Array<Record<string, unknown>>;
  columnMapping: Record<string, string>;
} {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return { rows: [], columnMapping: {} };

  const sheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: '',
    raw: false,
  });

  if (rows.length === 0) return { rows: [], columnMapping: {} };

  const columnMapping = resolveColumnMapping(Object.keys(rows[0]));
  return { rows, columnMapping };
}

/** Apply the header mapping to one sheet row. Returns null when unusable. */
function toImportedRow(
  raw: Record<string, unknown>,
  columnMapping: Record<string, string>,
): { row: ImportedRow | null; reason: string | null } {
  const mapped: Record<string, string> = {};

  for (const [header, field] of Object.entries(columnMapping)) {
    const value = String(raw[header] ?? '').trim();
    if (value) mapped[field] = value;
  }

  const phoneNumber = normalizePhoneNumber(mapped.phoneNumber);
  if (!phoneNumber) {
    return {
      row: null,
      reason: mapped.phoneNumber ? `Unparseable phone number "${mapped.phoneNumber}"` : 'No phone number column value',
    };
  }

  return {
    row: {
      phoneNumber,
      firstName: mapped.firstName ?? null,
      lastName: mapped.lastName ?? null,
      emailAddress: mapped.emailAddress ?? null,
      company: mapped.company ?? null,
      street: mapped.street ?? null,
      city: mapped.city ?? null,
      state: mapped.state ?? null,
      zip: mapped.zip ?? null,
      tags: mapped.tags
        ? mapped.tags
            .split(/[,;|]/)
            .map((tag) => tag.trim())
            .filter(Boolean)
        : [],
    },
    reason: null,
  };
}

/**
 * Import a parsed sheet.
 *
 * Upserts run in bounded-size batches inside transactions. A single transaction
 * around 50k upserts would hold locks for minutes and risk a statement timeout;
 * batching keeps each transaction short while still making each batch atomic.
 */
export async function importContacts(input: {
  buffer: Buffer;
  ownerUserId?: string | null;
  defaultTags?: string[];
}): Promise<ImportSummary> {
  const { rows, columnMapping } = parseContactSheet(input.buffer);

  if (rows.length === 0) {
    return {
      totalRows: 0,
      imported: 0,
      updated: 0,
      skippedInvalid: 0,
      skippedDuplicate: 0,
      columnMapping,
      sampleErrors: [],
    };
  }

  if (!Object.values(columnMapping).includes('phoneNumber')) {
    throw new Error(
      `No phone number column found. Recognized headers: ${Object.keys(columnMapping).join(', ') || 'none'}`,
    );
  }

  const seen = new Set<string>();
  const valid: ImportedRow[] = [];
  const sampleErrors: Array<{ row: number; reason: string }> = [];
  let skippedInvalid = 0;
  let skippedDuplicate = 0;

  rows.forEach((raw, index) => {
    const { row, reason } = toImportedRow(raw, columnMapping);

    if (!row) {
      skippedInvalid += 1;
      // +2: one for the header row, one for 1-based spreadsheet numbering.
      if (sampleErrors.length < 10) sampleErrors.push({ row: index + 2, reason: reason ?? 'Invalid row' });
      return;
    }

    if (seen.has(row.phoneNumber)) {
      skippedDuplicate += 1;
      return;
    }

    seen.add(row.phoneNumber);
    valid.push(row);
  });

  const existing = await prisma.messagingContact.findMany({
    where: {
      phoneNumber: { in: valid.map((row) => row.phoneNumber) },
      ownerUserId: input.ownerUserId ?? null,
    },
    select: { phoneNumber: true },
  });
  const existingNumbers = new Set(existing.map((row) => row.phoneNumber));

  const BATCH = 500;
  for (let i = 0; i < valid.length; i += BATCH) {
    const slice = valid.slice(i, i + BATCH);

    await prisma.$transaction(
      slice.map((row) =>
        prisma.messagingContact.upsert({
          where: {
            ownerUserId_phoneNumber: {
              ownerUserId: input.ownerUserId ?? null,
              phoneNumber: row.phoneNumber,
            } as never,
          },
          create: {
            phoneNumber: row.phoneNumber,
            firstName: row.firstName,
            lastName: row.lastName,
            emailAddress: row.emailAddress,
            company: row.company,
            street: row.street,
            city: row.city,
            state: row.state,
            zip: row.zip,
            tags: [...new Set([...(row.tags ?? []), ...(input.defaultTags ?? [])])],
            source: 'import',
            ownerUserId: input.ownerUserId ?? null,
          },
          update: {
            // Only overwrite fields the sheet actually supplied — a partial
            // sheet must not blank out data captured elsewhere.
            ...(row.firstName ? { firstName: row.firstName } : {}),
            ...(row.lastName ? { lastName: row.lastName } : {}),
            ...(row.emailAddress ? { emailAddress: row.emailAddress } : {}),
            ...(row.company ? { company: row.company } : {}),
            ...(row.street ? { street: row.street } : {}),
            ...(row.city ? { city: row.city } : {}),
            ...(row.state ? { state: row.state } : {}),
            ...(row.zip ? { zip: row.zip } : {}),
            ...(row.tags?.length ? { tags: row.tags } : {}),
          },
        }),
      ),
    );
  }

  const updated = valid.filter((row) => existingNumbers.has(row.phoneNumber)).length;

  return {
    totalRows: rows.length,
    imported: valid.length - updated,
    updated,
    skippedInvalid,
    skippedDuplicate,
    columnMapping,
    sampleErrors,
  };
}

export async function listContacts(params: {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: 'ACTIVE' | 'BLOCKED';
}) {
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(params.pageSize) || 50));
  const search = String(params.search ?? '').trim();

  const where: Record<string, unknown> = {};
  if (params.status) where.status = params.status;

  if (search) {
    const normalized = normalizePhoneNumber(search);
    where.OR = [
      { phoneNumber: { contains: normalized ?? search } },
      { firstName: { contains: search, mode: 'insensitive' } },
      { lastName: { contains: search, mode: 'insensitive' } },
      { company: { contains: search, mode: 'insensitive' } },
      { emailAddress: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.messagingContact.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.messagingContact.count({ where }),
  ]);

  return { items, total, page, pageSize, hasMore: page * pageSize < total };
}

export async function createContact(input: ImportedRow & { ownerUserId?: string | null; clientId?: string | null }) {
  const phoneNumber = normalizePhoneNumber(input.phoneNumber);
  if (!phoneNumber) throw new Error(`Invalid phone number: ${input.phoneNumber}`);

  return prisma.messagingContact.create({
    data: {
      phoneNumber,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      emailAddress: input.emailAddress ?? null,
      company: input.company ?? null,
      street: input.street ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      zip: input.zip ?? null,
      tags: input.tags ?? [],
      source: 'manual',
      ownerUserId: input.ownerUserId ?? null,
      clientId: input.clientId ?? null,
    },
  });
}
