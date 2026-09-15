import type { ContractPrefillField } from "./Contract";

export const ADDENDUM_EPA_SCOPE = "addendum_epa_";

/** Prefill fields for EPA / EPD Pre-Payment Addendum (both funders). */
export interface AddendumEpaContractPrefillFields {
    agreementDated?: string;
    funderName?: string;
    printName?: string;
    printTitle?: string;
    signatureDate?: string;
}

const FIELD_DEFS: Array<{
    id: keyof AddendumEpaContractPrefillFields;
    label: string;
}> = [
    { id: "agreementDated", label: "Contract dated" },
    { id: "funderName", label: "Funder name" },
    { id: "printName", label: "Print name" },
    { id: "printTitle", label: "Print title" },
    { id: "signatureDate", label: "Date" },
];

export const ADDENDUM_EPA_TAB_LABEL_BY_KEY: Record<
    keyof AddendumEpaContractPrefillFields,
    string
> = {
    agreementDated: `${ADDENDUM_EPA_SCOPE}agreement_dated`,
    funderName: `${ADDENDUM_EPA_SCOPE}funder_name`,
    printName: `${ADDENDUM_EPA_SCOPE}print_name`,
    printTitle: `${ADDENDUM_EPA_SCOPE}print_title`,
    signatureDate: `${ADDENDUM_EPA_SCOPE}signature_date`,
};

export function buildAddendumEpaContractPrefillFields(
    values: AddendumEpaContractPrefillFields = {},
): ContractPrefillField[] {
    const out: ContractPrefillField[] = [];
    for (const { id, label } of FIELD_DEFS) {
        const v = String(values[id] ?? "").trim().toUpperCase();
        out.push({
            id: ADDENDUM_EPA_TAB_LABEL_BY_KEY[id],
            label,
            value: v,
        });
    }
    return out;
}
