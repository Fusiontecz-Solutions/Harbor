import type { Prisma } from '@prisma/client';
import { allocateNextDealId } from '../services/nextDealIdService';

export { DEAL_ID_PREFIX } from '../services/nextDealIdService';

/**
 * Returns the next sequential `Application.dealId` as a bare number string
 * (e.g. `"15"` → `"16"`). Funder letter prefixes are applied later when a
 * contract funder is selected.
 */
export async function generateNextDealId(tx?: Prisma.TransactionClient): Promise<string> {
    return allocateNextDealId(tx);
}
