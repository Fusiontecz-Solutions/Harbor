import type { TemplateValues } from "./types";
import {
  PAYOFF_LETTER_VARIABLES,
  renderPayoffLetterHtml,
} from "./payoffLetterLayout";

/** Clear Capital payoff letter merge fields (shared payoff layout). */
export const ALLIANCE_PAYOFF_LETTER_VARIABLES = PAYOFF_LETTER_VARIABLES;

/** Clear Capital brand shown in the letterhead + body. */
const CLEAR_CAPITAL_BRAND_NAME = "Clear Capital";

/**
 * Fixed Flagstar / Funding Club 18 wire block from the Clear Capital PDF
 * (same destination as Harbor View Capital payoff letter).
 */
const CLEAR_CAPITAL_WIRE = {
  bankName: "Flagstar Bank",
  bankAddress: "102 Duffy Ave, Hicksville NY 11801",
  beneficiaryName: "Funding Club 18 LLC",
  beneficiaryAddress: "16 Middle Neck RD, Great Neck NY 11021",
  routingNumber: "226071004",
  accountNumber: "609931762068",
} as const;

/** Text wordmark letterhead (CLEAR dark / CAPITAL grey). */
const CLEAR_CAPITAL_LETTERHEAD = `<div style="font-family:Georgia,'Times New Roman',Times,serif;font-size:34px;font-weight:normal;letter-spacing:2px;line-height:1.2;text-transform:uppercase;"><span style="color:#111827;">CLEAR</span>&nbsp;<span style="color:#9ca3af;">CAPITAL</span></div>`;

/**
 * Gmail-safe HTML for the Clear Capital payoff letter — formal payoff
 * confirmation layout with the CLEAR CAPITAL wordmark letterhead.
 */
export function renderAlliancePayoffLetterHtml(values: TemplateValues): string {
  return renderPayoffLetterHtml(values, {
    companyName: CLEAR_CAPITAL_BRAND_NAME,
    documentTitle: "Clear Capital Payoff Letter",
    letterheadHtml: CLEAR_CAPITAL_LETTERHEAD,
    wire: CLEAR_CAPITAL_WIRE,
  });
}
