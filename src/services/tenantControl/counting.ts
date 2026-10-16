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

/** Inbound MO — same billing unit as outbound in the tenant console. */
export const INBOUND_COUNTED_SQL = Prisma.sql`("direction"::text = 'INBOUND'
  AND "status"::text NOT IN ('QUEUED', 'SENDING'))`;

export const REFUSED_SQL = Prisma.sql`("direction"::text = 'OUTBOUND' AND "errorCode" IN (${Prisma.join(REFUSED_CODES)}))`;

export const FAILED_SQL = Prisma.sql`"status"::text IN ('FAILED', 'UNDELIVERABLE')`;

/** A message without a provider segment count still costs one segment. */
export const SEGMENTS_SQL = Prisma.sql`COALESCE("segmentCount", 1)`;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 800;

export const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const nextDay = (day: string) => dayKey(Date.parse(`${day}T00:00:00Z`) + DAY_MS);

/** Buckets used when the console sends no `tz`: the contract's original UTC days. */
export const DEFAULT_TZ = 'UTC';

/** True for an IANA zone this runtime knows (`America/New_York`, `UTC`, ...). */
export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Milliseconds `tz` is ahead of UTC at instant `ms` (negative west of Greenwich). */
function zoneOffsetMs(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The instant local midnight starts `day` in `tz`. DST-safe (US/EU shifts never hit midnight). */
export function zonedDayStart(day: string, tz: string): Date {
  const wall = Date.parse(`${day}T00:00:00Z`);
  let t = wall - zoneOffsetMs(wall, tz);
  t = wall - zoneOffsetMs(t, tz);
  return new Date(t);
}

/** The `YYYY-MM-DD` calendar day instant `ms` falls on in `tz`. */
export const zonedDayKey = (ms: number, tz: string) => dayKey(ms + zoneOffsetMs(ms, tz));

/** Every day key from `from` to `to`, inclusive. Steps calendar days, not 24h, so DST cannot skip one. */
export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = from; d <= to; d = nextDay(d)) days.push(d);
  return days;
}

/**
 * Inclusive `YYYY-MM-DD` bounds from `from`/`to`, defaulting to the last 30
 * days, read as calendar days in `tz` (UTC unless the console passes `tz`).
 * Returns the half-open instant range [start, end) the bounds cover.
 */
export function resolveRange(query: { from?: unknown; to?: unknown }, now = new Date(), tz = DEFAULT_TZ) {
  const valid = (v: unknown) =>
    typeof v === 'string' && DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null;
  let to = valid(query.to) ?? zonedDayKey(now.getTime(), tz);
  let from = valid(query.from) ?? dayKey(Date.parse(`${to}T00:00:00Z`) - 29 * DAY_MS);
  if (from > to) [from, to] = [to, from];
  const earliest = dayKey(Date.parse(`${to}T00:00:00Z`) - (MAX_RANGE_DAYS - 1) * DAY_MS);
  if (from < earliest) from = earliest;
  return { from, to, tz, start: zonedDayStart(from, tz), end: zonedDayStart(nextDay(to), tz) };
}
