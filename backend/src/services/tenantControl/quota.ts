import { Prisma } from '@prisma/client';
import prisma from '../../config/prismaClient';
import { COUNTED_SQL, LIMIT_REACHED_CODE, SEGMENTS_SQL } from './counting';
import { getQuotaConfig, type LimitCountBy, type LimitScope, type QuotaConfig } from './state';

export { LIMIT_REACHED_CODE };

/** Shape the console reads from `GET /status` and `PUT /limit`. */
export interface LimitState {
  limit: number | null;
  countBy: LimitCountBy;
  scope: LimitScope;
  resetDay: number | null;
  used: number;
  remaining: number | null;
  exceededAt: string | null;
  periodStart: string | null;
}

/** Start of the window the quota applies to, or null when it never resets. */
export function periodStart(config: Pick<QuotaConfig, 'scope' | 'resetDay'>, now = new Date()): Date | null {
  if (config.scope === 'total') return null;
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  if (config.scope === 'daily') return new Date(Date.UTC(y, m, now.getUTCDate()));
  const thisMonth = Date.UTC(y, m, config.resetDay);
  return new Date(thisMonth <= now.getTime() ? thisMonth : Date.UTC(y, m - 1, config.resetDay));
}

const windowSql = (start: Date | null) => (start ? Prisma.sql`AND "createdAt" >= ${start}` : Prisma.empty);
const weightSql = (countBy: LimitCountBy) => (countBy === 'segments' ? SEGMENTS_SQL : Prisma.sql`1`);

/** Counted usage in the window, in the quota's unit. */
export async function measureUsage(config: Pick<QuotaConfig, 'countBy'>, start: Date | null): Promise<number> {
  const [row] = await prisma.$queryRaw<{ used: bigint | null }[]>`
    SELECT COALESCE(SUM(${weightSql(config.countBy)}), 0)::bigint AS used
      FROM "MessagingMessage"
     WHERE ${COUNTED_SQL} ${windowSql(start)}`;
  return Number(row?.used ?? 0);
}

/** When the running total first reached the cap in this window. */
async function findExceededAt(config: QuotaConfig, start: Date | null): Promise<string | null> {
  const [row] = await prisma.$queryRaw<{ at: Date }[]>`
    SELECT at FROM (
      SELECT "createdAt" AS at,
             SUM(${weightSql(config.countBy)}) OVER (ORDER BY "createdAt", "id") AS running
        FROM "MessagingMessage"
       WHERE ${COUNTED_SQL} ${windowSql(start)}
    ) t
    WHERE running >= ${config.limit}
    ORDER BY at
    LIMIT 1`;
  return row ? new Date(row.at).toISOString() : null;
}

export async function computeLimitState(config: QuotaConfig, now = new Date()): Promise<LimitState> {
  const start = periodStart(config, now);
  const used = await measureUsage(config, start);
  const exceededAt = config.limit !== null && used >= config.limit ? await findExceededAt(config, start) : null;
  return {
    limit: config.limit,
    countBy: config.countBy,
    scope: config.scope,
    resetDay: config.scope === 'monthly' ? config.resetDay : null,
    used,
    remaining: config.limit === null ? null : Math.max(0, config.limit - used),
    exceededAt,
    periodStart: start?.toISOString() ?? null,
  };
}

/** For `GET /status`: null when the console has set no quota. */
export async function getLimitState(now = new Date()): Promise<LimitState | null> {
  const config = await getQuotaConfig({ fresh: true });
  return config.limit === null ? null : computeLimitState(config, now);
}

// ── Enforcement ─────────────────────────────────────────────────────────────
// A COUNT per send would be too slow for broadcasts, so usage is re-measured
// at most every USAGE_TTL_MS and bumped locally after each accepted send.
// Several API instances can each admit a few sends before the next re-measure.

const USAGE_TTL_MS = 10_000;
let usage: { key: string; countBy: LimitCountBy; used: number; at: number } | null = null;

const usageKey = (config: QuotaConfig, start: Date | null) =>
  `${config.updatedAt}|${config.countBy}|${config.scope}|${start?.getTime() ?? 'all'}`;

/** True when the quota is set and already used up. Fails open on DB errors. */
export async function isOverQuota(now = new Date()): Promise<boolean> {
  const config = await getQuotaConfig();
  if (config.limit === null) return false;
  const start = periodStart(config, now);
  const key = usageKey(config, start);
  if (!usage || usage.key !== key || Date.now() - usage.at >= USAGE_TTL_MS) {
    try {
      usage = { key, countBy: config.countBy, used: await measureUsage(config, start), at: Date.now() };
    } catch (err) {
      console.error('[tenant-control] could not measure quota usage:', (err as Error)?.message);
      if (!usage || usage.key !== key) return false;
    }
  }
  return usage.used >= config.limit;
}

/** Called after Infobip accepted a send, so the cached usage keeps up between re-measures. */
export function recordQuotaUse(segments: number | null): void {
  if (!usage) return;
  usage.used += usage.countBy === 'segments' ? Math.max(1, segments ?? 1) : 1;
}

/** Test hook. */
export function resetQuotaCache(): void {
  usage = null;
}
