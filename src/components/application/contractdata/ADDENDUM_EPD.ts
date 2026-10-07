import type { ContractPrefillField } from "./Contract";

export const ADDENDUM_EPD_SCOPE = "addendum_epd_";

/** Early-prepay tier rows on the EPD addendum — matches backend `ADDENDUM_EPD_TIER_COUNT`. */
export const ADDENDUM_EPD_TIER_COUNT = 4;

export interface AddendumEpdTier {
    /** "If paid in full within ___" (e.g. 30 DAYS). */
    paidWithin?: string;
    /** "payback will be at a discounted rate of ___" (e.g. 1.25 or 10%). */
    discountRate?: string;
}

/**
 * Prefill fields for the EPD Pre-Payment Addendum (`EPD- ADDENDUM- Harbor.pdf`).
 * Funder name and "Title: OWNER" are printed on the PDF, so they have no tabs.
 */
export interface AddendumEpdContractPrefillFields {
    agreementDated?: string;
    tiers?: AddendumEpdTier[];
    printName?: string;
    signatureDate?: string;
}

export function buildAddendumEpdContractPrefillFields(
    values: AddendumEpdContractPrefillFields = {},
): ContractPrefillField[] {
    const field = (tabLabel: string, label: string, value?: string): ContractPrefillField => ({
        id: `${ADDENDUM_EPD_SCOPE}${tabLabel}`,
        label,
        value: String(value ?? "").trim().toUpperCase(),
    });
    const tiers = Array.from({ length: ADDENDUM_EPD_TIER_COUNT }, (_, i) => {
        const tier = values.tiers?.[i] ?? {};
        const n = i + 1;
        return [
            field(`tier_${n}_paid_within`, `Tier ${n} — paid in full within`, tier.paidWithin),
            field(`tier_${n}_discount_rate`, `Tier ${n} — discounted rate`, tier.discountRate),
        ];
    }).flat();
    return [
        field("agreement_dated", "Contract dated", values.agreementDated),
        ...tiers,
        field("print_name", "Print name", values.printName),
        field("signature_date", "Date", values.signatureDate),
    ];
}
