import type { TemplateValues, TemplateVariable } from "./types";
import { escapeHtml } from "./applicationApprovalEmailShared";

/**
 * Clear Capital payoff letter merge fields — matches the dedicated blanks on
 * the Clear Capital Balance / Payoff letter PDF (RE, DEAR, company, On date,
 * Balance Due). Wire instructions are fixed in the letter HTML.
 */
export const ALLIANCE_PAYOFF_LETTER_VARIABLES: TemplateVariable[] = [
  {
    key: "account_name",
    label: "Account Name",
    placeholder: "Acme LLC",
  },
  {
    key: "salutation_name",
    label: "Dear",
    placeholder: "John Doe",
  },
  {
    key: "agreement_date",
    label: "Agreement Date",
    placeholder: "May 20, 2024",
  },
  {
    key: "payoff_amount",
    label: "Balance Due",
    placeholder: "$5,678.90",
  },
];

/** Clear Capital brand shown in the letterhead + body. */
const CLEAR_CAPITAL_BRAND_NAME = "Clear Capital";

/**
 * Fixed Flagstar / Funding Club 18 wire block from the Clear Capital PDF
 * (same destination as Harbor View Capital balance / payoff letter).
 */
const CLEAR_CAPITAL_WIRE = {
  bankName: "Flagstar Bank",
  bankAddressLine1: "102 Duffy Ave",
  bankAddressLine2: "Hicksville NY 11801",
  beneficiaryName: "Funding Club 18 LLC",
  beneficiaryAddressLine1: "16 Middle Neck RD",
  beneficiaryAddressLine2: "Great Neck NY 11021",
  routingNumber: "226071004",
  accountNumber: "609931762068",
} as const;

/** Accent ribbon colors (matches Harbor View / brand emails). */
const STRIPE_GREY = "#71717a";
const STRIPE_BLACK = "#18181b";

const EMAIL_WIDTH = 600;

const v = ALLIANCE_PAYOFF_LETTER_VARIABLES.reduce<
  Record<string, TemplateVariable>
>((acc, variable) => {
  acc[variable.key] = variable;
  return acc;
}, {});

/**
 * Email-specific picker: returns the supplied value, or `"NA"` when blank.
 * Does not fall back to placeholders so outbound mail never shows dummy text.
 */
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

/** Strip a leading `$` so the letter can render `Balance Due: $ {value}`. */
function amountWithoutDollar(raw: string): string {
  return raw.replace(/^\$\s*/, "").trim() || "NA";
}

/**
 * Gmail-safe HTML for the Clear Capital Payoff letter — text letterhead
 * matching the PDF (CLEAR CAPITAL heading, RE / DEAR blanks, body, wire block)
 * with grey/black two-tone accent strips at top and bottom.
 */
export function renderAlliancePayoffLetterHtml(values: TemplateValues): string {
  const accountName = escapeHtml(pickOrNA(values, v.account_name));
  const salutationName = escapeHtml(pickOrBlank(values, v.salutation_name));
  const agreementDate = escapeHtml(pickOrNA(values, v.agreement_date));
  const payoffAmount = escapeHtml(
    amountWithoutDollar(pickOrNA(values, v.payoff_amount)),
  );
  const brandNameUpper = escapeHtml(CLEAR_CAPITAL_BRAND_NAME.toUpperCase());

  const dearLine =
    salutationName !== ""
      ? `DEAR: ${salutationName}`
      : "DEAR:";

  const wire = {
    bankName: escapeHtml(CLEAR_CAPITAL_WIRE.bankName),
    bankAddressLine1: escapeHtml(CLEAR_CAPITAL_WIRE.bankAddressLine1),
    bankAddressLine2: escapeHtml(CLEAR_CAPITAL_WIRE.bankAddressLine2),
    beneficiaryName: escapeHtml(CLEAR_CAPITAL_WIRE.beneficiaryName),
    beneficiaryAddressLine1: escapeHtml(
      CLEAR_CAPITAL_WIRE.beneficiaryAddressLine1,
    ),
    beneficiaryAddressLine2: escapeHtml(
      CLEAR_CAPITAL_WIRE.beneficiaryAddressLine2,
    ),
    routingNumber: escapeHtml(CLEAR_CAPITAL_WIRE.routingNumber),
    accountNumber: escapeHtml(CLEAR_CAPITAL_WIRE.accountNumber),
  };

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="x-apple-disable-message-reformatting" />
  <title>Clear Capital Payoff Letter</title>
  <style type="text/css">
    body, table, td, p, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { border-collapse: collapse; mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { border: 0; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; display: block; }
    a { text-decoration: none; }
    @media only screen and (max-width: 620px) {
      .email-container { width: 100% !important; max-width: 100% !important; }
      .content-pad { padding-left: 24px !important; padding-right: 24px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;width:100%;background-color:#e5e7eb;font-family:Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased;">
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;background-color:#e5e7eb;">
    <tr>
      <td align="center" style="padding:24px 10px;">
        <table role="presentation" class="email-container" border="0" cellpadding="0" cellspacing="0" width="${EMAIL_WIDTH}" style="width:${EMAIL_WIDTH}px;max-width:${EMAIL_WIDTH}px;border-collapse:collapse;background-color:#ffffff;border:1px solid #d1d5db;">

          <!-- Top two-tone accent strip (grey + black — Gmail/Outlook-safe) -->
          <tr>
            <td style="padding:0;line-height:0;font-size:0;">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="width:100%;border-collapse:collapse;margin:0;">
                <tr>
                  <td height="12" bgcolor="${STRIPE_GREY}" style="height:12px;line-height:12px;font-size:12px;background-color:${STRIPE_GREY};padding:0;">&nbsp;</td>
                </tr>
                <tr>
                  <td height="12" bgcolor="${STRIPE_BLACK}" style="height:12px;line-height:12px;font-size:12px;background-color:${STRIPE_BLACK};padding:0;">&nbsp;</td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td class="content-pad" style="padding:40px 48px 48px 48px;background-color:#ffffff;">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">

                <tr>
                  <td align="center" style="padding:0 0 10px 0;font-family:Georgia,'Times New Roman',Times,serif;font-size:34px;font-weight:normal;letter-spacing:2px;line-height:1.2;text-transform:uppercase;">
                    <span style="color:#111827;">CLEAR</span>&nbsp;<span style="color:#9ca3af;">CAPITAL</span>
                  </td>
                </tr>

                <tr>
                  <td align="center" style="padding:0 0 36px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;letter-spacing:3px;line-height:1.4;color:#9ca3af;text-transform:uppercase;">
                    Payoff Letter
                  </td>
                </tr>

                <tr>
                  <td style="padding:0 0 18px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:#6b7280;text-transform:uppercase;">
                    RE: ${accountName}
                  </td>
                </tr>

                <tr>
                  <td style="padding:0 0 20px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:#6b7280;text-transform:uppercase;">
                    ${dearLine}
                  </td>
                </tr>

                <tr>
                  <td style="padding:0 0 18px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.65;color:#6b7280;">
                    This letter is to confirm an account activity that has been established between <strong style="color:#111827;">${brandNameUpper}</strong> and <strong style="color:#111827;">${accountName}</strong> on <strong style="color:#111827;">${agreementDate}</strong>, we have entered into a merchant agreement to purchase part of a Merchant&#39;s future receivables for the amount defined herein as &quot;total due&quot; The merchant agreed to deliver to us a fixed daily amount for a designated term, until the agreement has been fully satisfied. Upon receipt of this amount, we will close this contract and our security interest in your company will be released and satisfied. Any overpayment shall be refunded within 10 days. We appreciate your business and look forward to having the opportunity to serve you again.
                  </td>
                </tr>

                <tr>
                  <td style="padding:0 0 22px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:#374151;">
                    Balance Due: $ ${payoffAmount}
                  </td>
                </tr>

                <tr>
                  <td style="padding:0 0 8px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;line-height:1.5;color:#111827;">
                    Wire Instruction
                  </td>
                </tr>
                <tr>
                  <td style="padding:0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.55;color:#111827;">
                    <strong>Bank Name:</strong> ${wire.bankName}<br />
                    <strong>Bank Address:</strong> ${wire.bankAddressLine1}<br />
                    ${wire.bankAddressLine2}<br />
                    <strong>Beneficiary Name:</strong> ${wire.beneficiaryName}<br />
                    <strong>Beneficiary Address:</strong> ${wire.beneficiaryAddressLine1}<br />
                    ${wire.beneficiaryAddressLine2}<br />
                    <strong>Routing Number:</strong> ${wire.routingNumber}<br />
                    <strong>Account Number:</strong> ${wire.accountNumber}
                  </td>
                </tr>

              </table>
            </td>
          </tr>

          <!-- Footer accent stripe ribbon (black + grey — Gmail/Outlook-safe) -->
          <tr>
            <td style="padding:0;line-height:0;font-size:0;">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="width:100%;border-collapse:collapse;margin:0;">
                <tr>
                  <td height="12" bgcolor="${STRIPE_BLACK}" style="height:12px;line-height:12px;font-size:12px;background-color:${STRIPE_BLACK};padding:0;">&nbsp;</td>
                </tr>
                <tr>
                  <td height="12" bgcolor="${STRIPE_GREY}" style="height:12px;line-height:12px;font-size:12px;background-color:${STRIPE_GREY};padding:0;">&nbsp;</td>
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
