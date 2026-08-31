import type { TemplateValues, TemplateVariable } from "./types";
import { escapeHtml } from "./applicationApprovalEmailShared";

/**
 * Clear Capital zero-balance / balance letter merge fields — matches the
 * dedicated blanks on the Clear Capital ZBL PDF (Date, company name).
 */
export const ALLIANCE_ZERO_BALANCE_LETTER_VARIABLES: TemplateVariable[] = [
  { key: "letter_date", label: "Date", placeholder: "05/20/2024" },
  {
    key: "account_name",
    label: "Account Name",
    placeholder: "Acme LLC",
  },
];

/** Clear Capital brand shown in the letterhead + body. */
const CLEAR_CAPITAL_BRAND_NAME = "Clear Capital";

/** Accent ribbon colors (matches Harbor View / Clear Capital payoff letters). */
const STRIPE_GREY = "#71717a";
const STRIPE_BLACK = "#18181b";

const EMAIL_WIDTH = 600;

const v = ALLIANCE_ZERO_BALANCE_LETTER_VARIABLES.reduce<
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

/**
 * Gmail-safe HTML for the Clear Capital Zero Balance / Balance letter — text
 * letterhead matching the PDF (CLEAR CAPITAL heading, Date / company blanks,
 * body) with grey/black two-tone accent strips and PDF-style page height.
 */
export function renderAllianceZeroBalanceLetterHtml(
  values: TemplateValues,
): string {
  const letterDate = escapeHtml(pickOrNA(values, v.letter_date));
  const accountName = escapeHtml(pickOrNA(values, v.account_name));
  const brandNameUpper = escapeHtml(CLEAR_CAPITAL_BRAND_NAME.toUpperCase());

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="x-apple-disable-message-reformatting" />
  <title>Clear Capital Zero Balance Letter</title>
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
            <td class="content-pad" style="padding:48px 48px 0 48px;background-color:#ffffff;">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">

                <tr>
                  <td align="center" style="padding:0 0 10px 0;font-family:Georgia,'Times New Roman',Times,serif;font-size:34px;font-weight:normal;letter-spacing:2px;line-height:1.2;text-transform:uppercase;">
                    <span style="color:#111827;">CLEAR</span>&nbsp;<span style="color:#9ca3af;">CAPITAL</span>
                  </td>
                </tr>

                <tr>
                  <td align="center" style="padding:0 0 48px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;letter-spacing:3px;line-height:1.4;color:#9ca3af;text-transform:uppercase;">
                    Balance Letter
                  </td>
                </tr>

                <tr>
                  <td style="padding:0 0 14px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:#6b7280;">
                    Date: ${letterDate}
                  </td>
                </tr>

                <tr>
                  <td style="padding:0 0 36px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:#111827;font-weight:bold;">
                    ${accountName}
                  </td>
                </tr>

                <tr>
                  <td style="padding:0 0 20px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;color:#6b7280;">
                    To Whom It May Concern:
                  </td>
                </tr>

                <tr>
                  <td style="padding:0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.65;color:#6b7280;">
                    In regards to the future receivables purchase and sale contract between <strong style="color:#111827;">${accountName}</strong> and <strong style="color:#111827;">${brandNameUpper}</strong>, our records indicate that the current balance of purchased but unremitted receivables is <strong style="color:#111827;">$0</strong>. <strong style="color:#111827;">${brandNameUpper}</strong> will close this contract and release its security interest reflected in the UCC-1 financing statement.
                  </td>
                </tr>

                <!-- Extra page height / bottom breathing room (PDF-style) -->
                <tr>
                  <td height="280" style="height:280px;line-height:280px;font-size:0;padding:0;">&nbsp;</td>
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
