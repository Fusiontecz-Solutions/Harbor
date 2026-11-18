import type { TemplateValues, TemplateVariable } from "./types";
import {
  discourageAddressAutolink,
  escapeHtml,
} from "./applicationApprovalEmailShared";

/**
 * Shared payoff letter merge fields (Harbor View Capital + Clear Capital).
 * Matches the blanks on the formal payoff confirmation PDF: ID, Dear, company,
 * agreement date, "As of" date, total payoff amount and "valid through" date.
 * Wire instructions are fixed per funder (not merge fields).
 */
export const PAYOFF_LETTER_VARIABLES: TemplateVariable[] = [
  {
    key: "deal_id",
    label: "ID",
    placeholder: "FN0000000",
  },
  {
    key: "salutation_name",
    label: "Dear",
    placeholder: "John",
  },
  {
    key: "account_name",
    label: "Business Name",
    placeholder: "Acme LLC",
  },
  {
    key: "agreement_date",
    label: "Agreement Date",
    placeholder: "09/09/2026",
  },
  {
    key: "letter_date",
    label: "As Of Date",
    placeholder: "10/05/2026",
  },
  {
    key: "payoff_amount",
    label: "Total Payoff Amount",
    placeholder: "$40,147.04",
  },
  {
    key: "good_through_date",
    label: "Valid Through",
    placeholder: "10/12/2026",
  },
];

export type PayoffLetterWire = {
  bankName: string;
  bankAddress: string;
  beneficiaryName: string;
  beneficiaryAddress: string;
  routingNumber: string;
  accountNumber: string;
};

export type PayoffLetterBrand = {
  /** Legal / display name used in the letter body (e.g. "Harbor View Capital"). */
  companyName: string;
  /** Pre-escaped HTML for the centered letterhead (logo image or wordmark). */
  letterheadHtml: string;
  /** `<title>` of the generated document. */
  documentTitle: string;
  wire: PayoffLetterWire;
};

const EMAIL_WIDTH = 640;
const FONT = "Arial,Helvetica,sans-serif";
const TEXT = "#111827";
const MUTED = "#9ca3af";

const v = PAYOFF_LETTER_VARIABLES.reduce<Record<string, TemplateVariable>>(
  (acc, variable) => {
    acc[variable.key] = variable;
    return acc;
  },
  {},
);

/** Supplied value or `"NA"` — never placeholder text in outbound mail. */
function pickOrNA(values: TemplateValues, variable: TemplateVariable): string {
  const raw = values[variable.key];
  if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  return "NA";
}

function pickOrBlank(
  values: TemplateValues,
  variable: TemplateVariable,
): string {
  const raw = values[variable.key];
  if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  return "";
}

/** Ensure the amount renders as `$1,234.56` whether or not `$` was supplied. */
function formatAmount(raw: string): string {
  const bare = raw.replace(/^\$\s*/, "").trim();
  if (!bare || bare === "NA") return "NA";
  return `$${bare}`;
}

/** Blank underline used when an optional date is not supplied (as on the PDF). */
const BLANK_FIELD = `<span style="display:inline-block;min-width:110px;border-bottom:1px solid #d1d5db;">&nbsp;</span>`;

function addr(value: string): string {
  return `<span x-apple-data-detectors="false" style="color:${TEXT};text-decoration:none;">${discourageAddressAutolink(escapeHtml(value))}</span>`;
}

/**
 * Gmail-safe HTML for the formal payoff confirmation letter. Layout mirrors the
 * payoff PDF: ID top-right, centered letterhead, Dear line, confirmation +
 * payoff paragraph, remit paragraph, bold-label wire block, "valid through"
 * notice, signature, and a muted footer disclaimer.
 */
export function renderPayoffLetterHtml(
  values: TemplateValues,
  brand: PayoffLetterBrand,
): string {
  const dealId = escapeHtml(pickOrBlank(values, v.deal_id));
  const salutationName = escapeHtml(pickOrBlank(values, v.salutation_name));
  const accountName = escapeHtml(pickOrNA(values, v.account_name));
  const agreementDate = escapeHtml(pickOrNA(values, v.agreement_date));
  const asOfDate = escapeHtml(
    pickOrBlank(values, v.letter_date) ||
      (typeof values.as_of_date === "string" ? values.as_of_date.trim() : "") ||
      "NA",
  );
  const payoffAmount = escapeHtml(
    formatAmount(pickOrNA(values, v.payoff_amount)),
  );
  const validThroughRaw = pickOrBlank(values, v.good_through_date);
  const validThrough = validThroughRaw
    ? `<strong style="color:${TEXT};">${escapeHtml(validThroughRaw)}</strong>`
    : BLANK_FIELD;

  const companyName = escapeHtml(brand.companyName);
  const wire = brand.wire;

  const dearLine = salutationName ? `Dear ${salutationName},` : "Dear,";

  const paragraph = (html: string, padBottom = 20) =>
    `<tr><td style="padding:0 0 ${padBottom}px 0;font-family:${FONT};font-size:14px;line-height:1.6;color:${TEXT};">${html}</td></tr>`;

  const wireRow = (label: string, value: string) =>
    `<tr><td style="padding:0 0 8px 0;font-family:${FONT};font-size:14px;line-height:1.5;color:${TEXT};"><strong>${label}:</strong> ${value}</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="x-apple-disable-message-reformatting" />
  <meta name="format-detection" content="telephone=no,address=no,email=no,date=no" />
  <title>${escapeHtml(brand.documentTitle)}</title>
  <style type="text/css">
    body, table, td, p, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { border-collapse: collapse; mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { border: 0; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; display: block; }
    a { color: inherit !important; text-decoration: none !important; }
    a[x-apple-data-detectors] {
      color: inherit !important;
      text-decoration: none !important;
      font-size: inherit !important;
      font-family: inherit !important;
      font-weight: inherit !important;
      line-height: inherit !important;
    }
    @media only screen and (max-width: 660px) {
      .email-container { width: 100% !important; max-width: 100% !important; }
      .content-pad { padding-left: 24px !important; padding-right: 24px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;width:100%;background-color:#e5e7eb;font-family:${FONT};-webkit-font-smoothing:antialiased;">
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;background-color:#e5e7eb;">
    <tr>
      <td align="center" style="padding:24px 10px;">
        <table role="presentation" class="email-container" border="0" cellpadding="0" cellspacing="0" width="${EMAIL_WIDTH}" style="width:${EMAIL_WIDTH}px;max-width:${EMAIL_WIDTH}px;border-collapse:collapse;background-color:#ffffff;border:1px solid #d1d5db;">
          <tr>
            <td class="content-pad" style="padding:28px 56px 40px 56px;background-color:#ffffff;">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">

                <tr>
                  <td align="right" style="padding:0 0 12px 0;font-family:${FONT};font-size:13px;line-height:1.4;color:${TEXT};">
                    ID: ${dealId}
                  </td>
                </tr>

                <tr>
                  <td align="center" style="padding:0 0 40px 0;">
                    ${brand.letterheadHtml}
                  </td>
                </tr>

                ${paragraph(dearLine, 24)}

                ${paragraph(
                  `This letter serves as formal confirmation that <strong>${accountName}</strong><br />has an outstanding balance owed to ${companyName} under the Merchant Cash Advance Agreement dated <strong>${agreementDate}</strong><br />As of <strong>${asOfDate}</strong>, the Total Payoff Amount required to satisfy all obligations under the above-referenced agreement is <strong>${payoffAmount}</strong>`,
                  28,
                )}

                ${paragraph(
                  `Upon receipt and successful clearance of funds in the above-stated amount, ${companyName} will consider the account paid in full, release the merchant from any further obligations under the agreement, and issue written confirmation that the advance has been satisfied in full. Please remit your payments to the following:`,
                  32,
                )}

                <tr>
                  <td style="padding:0 0 24px 0;">
                    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
                      ${wireRow("Bank Name", escapeHtml(wire.bankName))}
                      ${wireRow("Bank Address", addr(wire.bankAddress))}
                      ${wireRow("Beneficiary Name", escapeHtml(wire.beneficiaryName))}
                      ${wireRow("Beneficiary Address", addr(wire.beneficiaryAddress))}
                      ${wireRow("Routing Number", escapeHtml(wire.routingNumber))}
                      ${wireRow("Account Number", escapeHtml(wire.accountNumber))}
                    </table>
                  </td>
                </tr>

                ${paragraph(
                  `This payoff amount is valid through ${validThrough}.<br />If payment is not received by that date, the payoff amount may be subject to adjustment.`,
                  32,
                )}

                ${paragraph(`Sincerely,<br /><strong>Management</strong>`, 48)}

                <tr>
                  <td style="padding:0;font-family:${FONT};font-size:12px;line-height:1.6;color:${MUTED};">
                    Please note, ${companyName} reserves all rights under the Agreement until payment has been received and confirmed. Should you have any questions regarding this payoff, please contact our office.
                  </td>
                </tr>

              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
