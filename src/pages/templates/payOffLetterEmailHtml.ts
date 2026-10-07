import { PAY_OFF_LETTER_VARIABLES } from "./PayOffLetter";
import type { TemplateValues, TemplateVariable } from "./types";
import { APP_COMPANY_NAME } from "@/constants/appBranding";
import { discourageAddressAutolink } from "./applicationApprovalEmailShared";

/** Hosted Harbor View Capital logo for outbound payoff letter email. */
const PAY_OFF_LETTER_EMAIL_LOGO_SRC =
  "https://res.cloudinary.com/xnuzlpvy/image/upload/v1788194947/WhatsApp_Image_2026-08-28_at_00.09.40.jpg";

/**
 * Fixed Flagstar / Funding Club 18 wire block from the Harbor View Capital
 * payoff / balance letter PDF (not merge fields).
 */
const HARBOR_VIEW_WIRE = {
  bankName: "Flagstar Bank",
  bankAddressLine1: "102 Duffy Ave",
  bankAddressLine2: "Hicksville NY 11801",
  beneficiaryName: "Funding Club 18 LLC",
  beneficiaryAddressLine1: "16 Middle Neck RD",
  beneficiaryAddressLine2: "Great Neck NY 11021",
  routingNumber: "226071004",
  accountNumber: "609931762068",
} as const;

const EMAIL_WIDTH = 600;

const v = PAY_OFF_LETTER_VARIABLES.reduce<
  Record<string, (typeof PAY_OFF_LETTER_VARIABLES)[number]>
>((acc, variable) => {
  acc[variable.key] = variable;
  return acc;
}, {});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Email-specific picker: returns the supplied value, or `"NA"` when the
 * merge field is blank. We intentionally do NOT fall back to the variable's
 * `placeholder` here so the outgoing email never contains dummy preview text.
 */
function pickOrNA(values: TemplateValues, variable: TemplateVariable): string {
  const raw = values[variable.key];
  if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  return "NA";
}

/**
 * Like {@link pickOrNA} but returns an empty string for blank merge fields.
 * Used for optional salutation so we can keep "DEAR," without printing "NA".
 */
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

/** Harbor View accent ribbon colors (matches other outbound brand emails). */
const STRIPE_GREY = "#71717a";
const STRIPE_BLACK = "#18181b";

/**
 * Gmail-safe HTML for the Harbor View Capital Payoff letter — clean white
 * letterhead matching the PDF (logo, title, RE / DEAR blanks, body, wire block)
 * with grey/black two-tone accent strips at top and bottom.
 * Blank merge fields surface "NA".
 */
export function renderPayOffLetterEmailHtml(values: TemplateValues): string {
  const accountName = escapeHtml(pickOrNA(values, v.account_name));
  const salutationName = escapeHtml(pickOrBlank(values, v.salutation_name));
  const agreementDate = escapeHtml(pickOrNA(values, v.agreement_date));
  const payoffAmount = escapeHtml(
    amountWithoutDollar(pickOrNA(values, v.payoff_amount)),
  );
  const companyName = escapeHtml(APP_COMPANY_NAME);
  const companyNameUpper = escapeHtml(APP_COMPANY_NAME.toUpperCase());
  const logoSrc = escapeHtml(PAY_OFF_LETTER_EMAIL_LOGO_SRC);

  const dearLine =
    salutationName !== ""
      ? `DEAR, ${salutationName}`
      : "DEAR,";

  const wire = {
    bankName: escapeHtml(HARBOR_VIEW_WIRE.bankName),
    bankAddressLine1: discourageAddressAutolink(
      escapeHtml(HARBOR_VIEW_WIRE.bankAddressLine1),
    ),
    bankAddressLine2: discourageAddressAutolink(
      escapeHtml(HARBOR_VIEW_WIRE.bankAddressLine2),
    ),
    beneficiaryName: escapeHtml(HARBOR_VIEW_WIRE.beneficiaryName),
    beneficiaryAddressLine1: discourageAddressAutolink(
      escapeHtml(HARBOR_VIEW_WIRE.beneficiaryAddressLine1),
    ),
    beneficiaryAddressLine2: discourageAddressAutolink(
      escapeHtml(HARBOR_VIEW_WIRE.beneficiaryAddressLine2),
    ),
    routingNumber: escapeHtml(HARBOR_VIEW_WIRE.routingNumber),
    accountNumber: escapeHtml(HARBOR_VIEW_WIRE.accountNumber),
  };

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="x-apple-disable-message-reformatting" />
  <meta name="format-detection" content="telephone=no,address=no,email=no,date=no" />
  <title>Payoff Letter</title>
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
            <td class="content-pad" style="padding:36px 48px 48px 48px;background-color:#ffffff;">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">

                <tr>
                  <td align="center" style="padding:0 0 14px 0;line-height:0;font-size:0;">
                    <img src="${logoSrc}" alt="${companyName}" width="160" border="0" style="display:block;width:160px;max-width:160px;height:auto;margin:0 auto;border:0;outline:none;-ms-interpolation-mode:bicubic;" />
                  </td>
                </tr>

                <tr>
                  <td align="center" style="padding:0 0 32px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;letter-spacing:3px;line-height:1.4;color:#6b7280;text-transform:uppercase;">
                    Payoff Letter
                  </td>
                </tr>

                <tr>
                  <td style="padding:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:#6b7280;text-transform:uppercase;">
                    RE: ${accountName}
                  </td>
                </tr>

                <tr>
                  <td style="padding:0 0 18px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:#6b7280;text-transform:uppercase;">
                    ${dearLine}
                  </td>
                </tr>

                <tr>
                  <td style="padding:0 0 14px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6;color:#6b7280;">
                    This letter is to confirm an account activity that has been established between<br />
                    <strong style="color:#111827;">${companyNameUpper}</strong> and <strong style="color:#111827;">${accountName}</strong>.
                  </td>
                </tr>

                <tr>
                  <td style="padding:0 0 18px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6;color:#6b7280;">
                    On <strong style="color:#111827;">${agreementDate}</strong>, we have entered into a merchant agreement to purchase part of a Merchants future receivables for the amount defined herein as &quot;total due&quot; The merchant agreed to deliver to us a fixed daily amount for a designated term, until the agreement has been fully satisfied. Upon receipt of this amount, we will close this contract and our security interest in your company will be released and satisfied. Any overpayment shall be refunded within 10 days. We appreciate your business and look forward to having the opportunity to serve you again.
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
                    <strong>Bank Address:</strong> <span x-apple-data-detectors="false" style="color:#111827;text-decoration:none;">${wire.bankAddressLine1}</span><br />
                    <span x-apple-data-detectors="false" style="color:#111827;text-decoration:none;">${wire.bankAddressLine2}</span><br />
                    <strong>Beneficiary Name:</strong> ${wire.beneficiaryName}<br />
                    <strong>Beneficiary Address:</strong> <span x-apple-data-detectors="false" style="color:#111827;text-decoration:none;">${wire.beneficiaryAddressLine1}</span><br />
                    <span x-apple-data-detectors="false" style="color:#111827;text-decoration:none;">${wire.beneficiaryAddressLine2}</span><br />
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
