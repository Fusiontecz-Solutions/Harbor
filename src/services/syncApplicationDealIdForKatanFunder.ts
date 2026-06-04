import type { Prisma } from '@prisma/client';
import {
    resolveKatanFunderFromName,
    shouldAllocateKatanDealId,
} from '../utils/katanFunderDealId';
import { allocateNextKatanDealId } from './nextDealIdService';

type TransactionClient = Prisma.TransactionClient;

export type KatanFunderDealIdSyncResult = {
    dealId: string;
    organization: 'Katan II' | 'Katan III';
    assignedNewDealId: boolean;
};

/**
 * When funder is Katan II / III, sync `organization` + `BusinessInfo.funderName`.
 * Assigns a new `KK` / `KC` serial only when `dealId` is null or switching KC ↔ KK.
 */
export async function syncApplicationDealIdForKatanFunder(
    applicationId: string,
    funderName: string | null | undefined,
    tx: TransactionClient,
): Promise<KatanFunderDealIdSyncResult | null> {
    const resolved = resolveKatanFunderFromName(funderName);
    if (!resolved) return null;

    const app = await tx.application.findUnique({
        where: { id: applicationId },
        select: { dealId: true, note: true },
    });
    if (!app) return null;

    let dealId = String(app.dealId ?? '').trim();
    let assignedNewDealId = false;

    if (shouldAllocateKatanDealId(dealId, resolved.prefix)) {
        dealId = await allocateNextKatanDealId(resolved.prefix, tx);
        assignedNewDealId = true;
    }

    const applicationUpdate: {
        organization: 'Katan II' | 'Katan III';
        dealId?: string;
        note?: string;
    } = {
        organization: resolved.organization,
    };

    if (assignedNewDealId) {
        applicationUpdate.dealId = dealId;
        const dealIdMarker = `[DEAL_ID:${dealId}]`;
        const currentNote = String(app.note ?? '').trim();
        if (currentNote && !currentNote.toLowerCase().includes(dealIdMarker.toLowerCase())) {
            applicationUpdate.note = `${currentNote}\n${dealIdMarker}`;
        } else if (!currentNote) {
            applicationUpdate.note = dealIdMarker;
        }
    }

    await tx.application.update({
        where: { id: applicationId },
        data: applicationUpdate,
    });

    await tx.businessInfo.updateMany({
        where: { applicationId },
        data: { funderName: resolved.organization },
    });

    return {
        dealId,
        organization: resolved.organization,
        assignedNewDealId,
    };
}
