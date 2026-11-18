import prisma from '../config/prismaClient';
import { resolveApplicationAttributedUserIdForActor } from '../middleware/authMiddleware';
import { sanitizePaymentFrequencyForPersist } from '../utils/sanitizePaymentFrequency';

function parseTermInt(term: unknown): number {
    if (term == null) return 10;
    const match = String(term).match(/(\d+)/);
    const parsed = match ? Number(match[1]) : Number(term);
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 10;
}

export type SyncTermsOfferPreload = {
    offerDecision?: {
        decision?: string | null;
        offer?: number | null;
        rate?: number | null;
        totalRemit?: number | null;
        repayPerPeriod?: number | null;
        term?: string | number | null;
        frequency?: string | null;
        position?: string | null;
    } | null;
    application?: {
        commissionPercentage?: number | null;
        createdById?: string | null;
        salesRepresentativeId?: string | null;
    } | null;
};

/**
 * Mirror the persisted offer-decision onto the latest terms offer (or create one)
 * so ISO public approval links show the same amounts the scrubbing approved.
 *
 * Super Admin proxy actors often have no tenant User row — never write their
 * platform id into TermsOffer.createdById (FK). Attribute to a real tenant user
 * or leave null so the sync still succeeds.
 */
export async function syncTermsOfferFromOfferDecision(
    applicationId: string,
    actorUserId?: string | null,
    preloaded?: SyncTermsOfferPreload | null,
): Promise<void> {
    const offerDecision =
        preloaded?.offerDecision ??
        (await prisma.offerDecision.findUnique({
            where: { applicationId },
        }));
    if (!offerDecision || offerDecision.decision === 'declined') return;

    const offer = offerDecision.offer != null ? Number(offerDecision.offer) : null;
    const rate = offerDecision.rate != null ? Number(offerDecision.rate) : null;
    if (!offer || offer <= 0 || !rate || rate <= 0) return;

    const application =
        preloaded?.application ??
        (await prisma.application.findUnique({
            where: { id: applicationId },
            select: {
                commissionPercentage: true,
                createdById: true,
                salesRepresentativeId: true,
            },
        }));
    if (!application) return;

    const termLength = parseTermInt(offerDecision.term);
    const paybackAmount =
        offerDecision.totalRemit != null && Number(offerDecision.totalRemit) > 0
            ? Number(offerDecision.totalRemit)
            : offer * rate;
    const paymentAmount =
        offerDecision.repayPerPeriod != null && Number(offerDecision.repayPerPeriod) > 0
            ? Number(offerDecision.repayPerPeriod)
            : paybackAmount / termLength;
    const commissionPercent = Number(application.commissionPercentage ?? 0);
    const commissionAmount = (offer * commissionPercent) / 100;
    const frequency =
        sanitizePaymentFrequencyForPersist(offerDecision.frequency) || 'Daily';
    const position = String(offerDecision.position || '1').trim() || '1';

    const offerExpiryDate = new Date();
    offerExpiryDate.setDate(offerExpiryDate.getDate() + 30);

    const payload = {
        approvedAmount: offer,
        factorRate: rate,
        paybackAmount,
        numberOfPayments: termLength,
        termLength,
        commissionPercent,
        paymentAmount,
        percentOfGross: 0,
        frequency,
        buyRate: rate,
        commissionAmount,
        position,
        paymentSchedule: frequency,
        offerExpiryDate,
    };

    const latest = await prisma.termsOffer.findFirst({
        where: { applicationId },
        orderBy: { createdAt: 'desc' },
    });

    if (latest) {
        await prisma.termsOffer.update({
            where: { id: latest.id },
            data: payload,
        });
        return;
    }

    const attributionContext: {
        createdById: string | null;
        salesRepresentativeId: string;
    } = {
        createdById: application.createdById ?? null,
        salesRepresentativeId: application.salesRepresentativeId ?? '',
    };

    const createdById = await resolveApplicationAttributedUserIdForActor(
        actorUserId,
        attributionContext,
    );

    await prisma.termsOffer.create({
        data: {
            ...payload,
            applicationId,
            createdById,
            paymentDays: [],
        },
    });
}
