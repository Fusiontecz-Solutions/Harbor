import type { ContractPrefillField } from "./Contract";

export const EXHIBIT_A_SCOPE = "exhibit_a_";

/** Company rows on the Exhibit A PDF — same count as contract `exhibitAValue1` … `exhibitAValue10`. */
export const EXHIBIT_A_COMPANY_ROW_COUNT = 10;

export type ExhibitACompanyRow = {
    legalName?: string;
    ein?: string;
};

/**
 * Prefill fields for Exhibit A (Blanket Security Interest — additional parties).
 * Each company row prints legal name / EIN on one line. "Title: Owner" is printed on the PDF.
 */
export interface ExhibitAContractPrefillFields {
    /** Index 0 → Company 1. */
    companies?: readonly ExhibitACompanyRow[];
    /** Printed under the signature line. */
    ownerName?: string;
}

const COMPANY_FIELD_DEFS: Array<{
    id: keyof ExhibitACompanyRow;
    label: string;
    tabPrefix: string;
}> = [
    { id: "legalName", label: "Legal Name", tabPrefix: "company_name" },
    { id: "ein", label: "EIN", tabPrefix: "company_ein" },
];

export function exhibitACompanyTabLabel(
    field: keyof ExhibitACompanyRow,
    row: number,
): string {
    const def = COMPANY_FIELD_DEFS.find((d) => d.id === field);
    return `${EXHIBIT_A_SCOPE}${def?.tabPrefix ?? "company_name"}_${row}`;
}

export function buildExhibitAContractPrefillFields(
    values: ExhibitAContractPrefillFields = {},
): ContractPrefillField[] {
    const out: ContractPrefillField[] = [
        {
            id: `${EXHIBIT_A_SCOPE}print_name`,
            label: "Owner Name",
            value: String(values.ownerName ?? "").trim().toUpperCase(),
            section: "Signature",
        },
    ];
    for (let i = 0; i < EXHIBIT_A_COMPANY_ROW_COUNT; i++) {
        const company = values.companies?.[i] ?? {};
        for (const { id, label } of COMPANY_FIELD_DEFS) {
            out.push({
                id: exhibitACompanyTabLabel(id, i + 1),
                label,
                value: String(company[id] ?? "").trim().toUpperCase(),
                section: `Company ${i + 1}`,
            });
        }
    }
    return out;
}
