import type { Prisma } from '@prisma/client';
import type { KatanDealIdPrefix } from '../utils/katanFunderDealId';

/** First Katan deal id when none exist yet (e.g. `KK1001`, `KC1001`). */
export const KATAN_DEAL_ID_START = 1001;

type TransactionClient = Prisma.TransactionClient;

const KATAN_ADVISORY_LOCK_KEYS: Record<KatanDealIdPrefix, number> = {
    KK: 874_203_892,
    KC: 874_203_893,
};

/**
 * Next sequential Katan deal id for the given prefix (`KK` → Katan II, `KC` → Katan III).
 * Uses the highest numeric suffix among existing ids with that prefix (e.g. `KK1001` → `KK1002`).
 */
export async function allocateNextKatanDealId(
    prefix: KatanDealIdPrefix,
    tx: TransactionClient,
): Promise<string> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${KATAN_ADVISORY_LOCK_KEYS[prefix]})`;

    const rows = await tx.$queryRaw<Array<{ max_num: number | null }>>`
        SELECT MAX(
            (regexp_match(
                regexp_replace(upper("dealId"), '[^A-Z0-9]', '', 'g'),
                ${`^${prefix}([0-9]+)$`}
            ))[1]::integer
        ) AS max_num
        FROM "Application"
        WHERE "dealId" IS NOT NULL
        AND regexp_replace(upper("dealId"), '[^A-Z0-9]', '', 'g') ~ ${`^${prefix}[0-9]+$`}
    `;

    const maxNum = rows[0]?.max_num != null ? Number(rows[0].max_num) : 0;
    const next =
        Number.isFinite(maxNum) && maxNum >= KATAN_DEAL_ID_START ? maxNum + 1 : KATAN_DEAL_ID_START;
    return `${prefix}${next}`;
}
