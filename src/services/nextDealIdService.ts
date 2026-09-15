import type { Prisma } from '@prisma/client';
import prisma from '../config/prismaClient';

/**
 * @deprecated Deal ids are numeric on create; funder prefixes are applied later.
 * Kept for callers that still import the symbol.
 */
export const DEAL_ID_PREFIX = '';

type TransactionClient = Prisma.TransactionClient;
type DbClient = Prisma.TransactionClient | typeof prisma;

/** Postgres advisory lock key for serializing deal id sequence initialization. */
const ADVISORY_LOCK_KEY = 874_203_891;

let dealIdSeqReady: Promise<void> | null = null;

async function currentMaxDealNumber(db: DbClient): Promise<number> {
    const rows = await db.$queryRaw<Array<{ max_num: number | null }>>`
        SELECT MAX((regexp_match(trim("dealId"), '([0-9]+)$'))[1]::integer) AS max_num
        FROM "Application"
        WHERE "dealId" IS NOT NULL
          AND trim("dealId") <> ''
          AND trim("dealId") ~ '[0-9]+$'
    `;
    const maxNum = rows[0]?.max_num != null ? Number(rows[0].max_num) : 0;
    return Number.isFinite(maxNum) && maxNum >= 0 ? maxNum : 0;
}

type SeqStatus = { last_value: string | number; is_called: boolean };

async function readDealIdSeqStatus(): Promise<{ lastValue: number; isCalled: boolean }> {
    const seqRows = await prisma.$queryRaw<SeqStatus[]>`
        SELECT last_value::text AS last_value, is_called FROM application_deal_id_seq
    `;
    return {
        lastValue: Number(seqRows[0]?.last_value ?? 1),
        isCalled: Boolean(seqRows[0]?.is_called),
    };
}

/**
 * One-time per process: ensure the Postgres sequence exists. After it has issued
 * ids, skip the full-table regexp scan — that scan was making the first create
 * after every nodemon restart take many seconds.
 */
async function ensureDealIdSequence(): Promise<void> {
    if (!dealIdSeqReady) {
        dealIdSeqReady = (async () => {
            await prisma.$executeRaw`CREATE SEQUENCE IF NOT EXISTS application_deal_id_seq`;
            const status = await readDealIdSeqStatus();
            if (status.isCalled && status.lastValue > 0) {
                return;
            }

            await prisma.$executeRaw`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`;
            try {
                const locked = await readDealIdSeqStatus();
                if (locked.isCalled && locked.lastValue > 0) {
                    return;
                }
                const maxNum = await currentMaxDealNumber(prisma);
                const issued = locked.isCalled ? locked.lastValue : locked.lastValue - 1;
                const target = Math.max(issued, maxNum);
                if (target > 0) {
                    await prisma.$executeRaw`SELECT setval('application_deal_id_seq', ${target}::bigint, true)`;
                }
            } finally {
                await prisma.$executeRaw`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`;
            }
        })().catch((err) => {
            dealIdSeqReady = null;
            throw err;
        });
    }
    await dealIdSeqReady;
}

/** Call on server boot so the first create is not paying for sequence init. */
export function warmupDealIdSequence(): void {
    void ensureDealIdSequence().catch((err) => {
        console.error('[dealId] sequence warmup failed:', err);
    });
}

/** Returns the next deal id as a bare number string (`"1"`, `"2"`, …). */
export async function allocateNextDealId(tx?: TransactionClient): Promise<string> {
    await ensureDealIdSequence();
    const db: DbClient = tx ?? prisma;
    const rows = await db.$queryRaw<Array<{ n: string | number }>>`
        SELECT nextval('application_deal_id_seq')::text AS n
    `;
    return String(rows[0]?.n ?? 1);
}

/**
 * Allocate a deal id, then run `fn`. Avoids Prisma interactive transactions,
 * which wait up to 10s on Neon's pooled connections.
 */
export async function withAllocatedDealId<T>(
    fn: (dealId: string, tx: TransactionClient) => Promise<T>,
): Promise<T> {
    const dealId = await allocateNextDealId();
    return fn(dealId, prisma as unknown as TransactionClient);
}
