import { Prisma } from '@prisma/client';

/** Error code stored on messages refused while the tenant is paused. */
export const SENDING_DISABLED_CODE = 'TENANT_SENDING_DISABLED';
/** Error code stored on messages refused because the console's quota is used up. */
export const LIMIT_REACHED_CODE = 'TENANT_LIMIT_REACHED';
/** Refusals never reach Infobip: they are reported as `blocked`, never as sent. */
export const REFUSED_CODES = [SENDING_DISABLED_CODE, LIMIT_REACHED_CODE];

export const DAY_MS = 86_400_000;

/**
 * Outbound messages handed to Infobip. Every count the console sees (status,
 * usage, quota, reps, broadcasts) uses this one definition so they agree.
 */
export const countedWhere = (range: { gte?: Date; lt?: Date } = {}): Prisma.MessagingMessageWhereInput => ({
  direction: 'OUTBOUND',
  status: { notIn: ['QUEUED', 'SENDING'] },
  OR: [{ errorCode: null }, { errorCode: { notIn: REFUSED_CODES } }],
  ...(range.gte || range.lt ? { createdAt: { ...(range.gte ? { gte: range.gte } : {}), ...(range.lt ? { lt: range.lt } : {}) } } : {}),
});

/** `countedWhere` for raw queries over "MessagingMessage". */
export const COUNTED_SQL = Prisma.sql`("direction"::text = 'OUTBOUND'
  AND "status"::text NOT IN ('QUEUED', 'SENDING')
  AND ("errorCode" IS NULL OR "errorCode" NOT IN (${Prisma.join(REFUSED_CODES)})))`;

export const REFUSED_SQL = Prisma.sql`("direction"::text = 'OUTBOUND' AND "errorCode" IN (${Prisma.join(REFUSED_CODES)}))`;

export const FAILED_SQL = Prisma.sql`"status"::text IN ('FAILED', 'UNDELIVERABLE')`;

/** A message without a provider segment count still costs one segment. */
export const SEGMENTS_SQL = Prisma.sql`COALESCE("segmentCount", 1)`;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 800;

export const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Inclusive UTC `YYYY-MM-DD` bounds from `from`/`to`, defaulting to the last 30
 * days. Returns the half-open instant range [start, end) the bounds cover.
 */
export function resolveRange(query: { from?: unknown; to?: unknown }, now = new Date()) {
  const valid = (v: unknown) =>
    typeof v === 'string' && DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null;
  let to = valid(query.to) ?? dayKey(now.getTime());
  let from = valid(query.from) ?? dayKey(Date.parse(`${to}T00:00:00Z`) - 29 * DAY_MS);
  if (from > to) [from, to] = [to, from];
  const end = Date.parse(`${to}T00:00:00Z`) + DAY_MS;
  const start = Math.max(Date.parse(`${from}T00:00:00Z`), end - MAX_RANGE_DAYS * DAY_MS);
  return { from: dayKey(start), to, start: new Date(start), end: new Date(end) };
}
