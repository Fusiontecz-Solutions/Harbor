import type { TemplateValues } from "./types";
import { APP_COMPANY_NAME } from "@/constants/appBranding";
import { escapeHtml } from "./applicationApprovalEmailShared";
import {
  PAYOFF_LETTER_VARIABLES,
  renderPayoffLetterHtml,
} from "./payoffLetterLayout";

/** Harbor View Capital payoff letter merge fields (shared payoff layout). */
export const PAY_OFF_LETTER_VARIABLES = PAYOFF_LETTER_VARIABLES;

/** Hosted Harbor View Capital logo for outbound payoff letter email. */
const PAY_OFF_LETTER_EMAIL_LOGO_SRC =
  "https://res.cloudinary.com/xnuzlpvy/image/upload/v1788194947/WhatsApp_Image_2026-08-28_at_00.09.40.jpg";

/** Fixed Flagstar / Funding Club 18 wire block (not merge fields). */
const HARBOR_VIEW_WIRE = {
  bankName: "Flagstar Bank",
  bankAddress: "102 Duffy Ave, Hicksville NY 11801",
  beneficiaryName: "Funding Club 18 LLC",
  beneficiaryAddress: "16 Middle Neck RD, Great Neck NY 11021",
  routingNumber: "226071004",
  accountNumber: "609931762068",
} as const;

/**
 * Gmail-safe HTML for the Harbor View Capital payoff letter — formal payoff
 * confirmation layout with the Harbor View logo letterhead.
 * Blank merge fields surface "NA".
 */
export function renderPayOffLetterEmailHtml(values: TemplateValues): string {
  const logoSrc = escapeHtml(PAY_OFF_LETTER_EMAIL_LOGO_SRC);
  const companyName = escapeHtml(APP_COMPANY_NAME);

  return renderPayoffLetterHtml(values, {
    companyName: APP_COMPANY_NAME,
    documentTitle: "Payoff Letter",
    letterheadHtml: `<img src="${logoSrc}" alt="${companyName}" width="180" border="0" style="display:block;width:180px;max-width:180px;height:auto;margin:0 auto;border:0;outline:none;-ms-interpolation-mode:bicubic;" />`,
    wire: HARBOR_VIEW_WIRE,
  });
}
