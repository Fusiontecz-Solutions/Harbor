import type { TemplateValues, TemplateVariable } from "./types";
import { CLEAR_CAPITAL_DEFAULT_LETTER_BRAND, decodeLetterBrand } from "./letterBrand";
import { renderZeroBalanceLetterHtml } from "./zeroBalanceLetterLayout";

/** Clear Capital zero balance letter merge fields. */
export const ALLIANCE_ZERO_BALANCE_LETTER_VARIABLES: TemplateVariable[] = [
  { key: "letter_date", label: "Date", placeholder: "05/20/2024" },
  {
    key: "account_name",
    label: "Account Name",
    placeholder: "Acme LLC",
  },
];

/**
 * Clear Capital zero balance letter (kept for saved references to this
 * template). Same layout as every funder; defaults to the Clear Capital brand.
 */
export function renderAllianceZeroBalanceLetterHtml(values: TemplateValues): string {
  return renderZeroBalanceLetterHtml(
    values,
    decodeLetterBrand(values as Record<string, unknown>, CLEAR_CAPITAL_DEFAULT_LETTER_BRAND),
  );
}
