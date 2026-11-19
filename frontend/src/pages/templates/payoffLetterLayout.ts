import type { TemplateValues, TemplateVariable } from "./types";
import {
  discourageAddressAutolink,
  escapeHtml,
} from "./applicationApprovalEmailShared";
import {
  wireFromValues,
  type LetterBrand,
  type LetterWireValues,
} from "./letterBrand";

/**
 * Shared payoff letter merge fields (every funder). Wire instructions are not
 * in this list: they come from the Letters page "Bank / wire details" section
 * (`wire_*` values), pre-filled from the funder's saved Letter Info.
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

export type PayoffLetterOptions = {
  /** `<title>` of the generated document. */
  documentTitle?: string;
  /** Used for any wire field left blank on the letter (null = leave blank). */
  fallbackWire?: LetterWireValues | null;
};

const EMAIL_WIDTH = 640;
export const LETTER_FONT = "Arial,Helvetica,sans-serif";
export const LETTER_TEXT = "#1f2937";
export const LETTER_MUTED = "#6b7280";
export const LETTER_LINE = "#e5e7eb";

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

function pickOrBlank(values: TemplateValues, variable: TemplateVariable): string {
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

function addr(value: string): string {
  return `<span x-apple-data-detectors="false" style="color:inherit;text-decoration:none;">${discourageAddressAutolink(escapeHtml(value))}</span>`;
}

const t = (size: number, color: string, weight = "normal", extra = "") =>
  `font-family:${LETTER_FONT};font-size:${size}px;font-weight:${weight};color:${color};${extra}`;

/** Letterhead: logo (or wordmark) left, lender details right, rule below. */
export function renderLetterhead(brand: LetterBrand): string {
  const name = escapeHtml(brand.brandName);
  const mark = brand.logoUrl
    ? `<img src="${escapeHtml(brand.logoUrl)}" alt="${name}" width="150" border="0" style="display:block;width:150px;max-width:150px;height:auto;border:0;outline:none;-ms-interpolation-mode:bicubic;" />`
    : `<span style="${t(24, brand.dark, "bold", "letter-spacing:1px;")}">${name}</span>`;
  const details = [
    brand.legalName ? escapeHtml(brand.legalName) : name,
    brand.addressLine ? addr(brand.addressLine) : "",
    [brand.phone ? escapeHtml(brand.phone) : "", brand.email ? escapeHtml(brand.email) : ""].filter(Boolean).join(" &nbsp;&middot;&nbsp; "),
  ]
    .filter(Boolean)
    .join("<br />");
  return `<tr>
    <td height="6" bgcolor="${brand.accent}" style="height:6px;line-height:6px;font-size:0;background-color:${brand.accent};">&nbsp;</td>
  </tr>
  <tr>
    <td class="content-pad" style="padding:28px 48px 18px 48px;">
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        <tr>
          <td valign="middle" style="padding:0;">${mark}</td>
          <td valign="middle" align="right" style="padding:0 0 0 16px;${t(11, LETTER_MUTED, "normal", "line-height:1.6;")}">${details}</td>
        </tr>
      </table>
    </td>
  </tr>
  <tr><td class="content-pad" style="padding:0 48px;"><table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid ${LETTER_LINE};font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr>`;
}

/** Row of small labelled facts (Date / Reference / …). */
export function renderFactRow(facts: Array<[string, string]>): string {
  const cells = facts
    .map(
      ([label, value]) =>
        `<td valign="top" style="padding:0 12px 0 0;${t(12, LETTER_MUTED, "normal", "line-height:1.7;")}">${escapeHtml(label)}<br /><span style="${t(13, LETTER_TEXT, "bold")}">${value}</span></td>`,
    )
    .join("");
  return `<tr><td class="content-pad" style="padding:22px 48px 0 48px;"><table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;"><tr>${cells}</tr></table></td></tr>`;
}

/** Footer: rights notice + "Brand is a DBA of Legal · address". */
export function renderLetterFooter(brand: LetterBrand, notice: string): string {
  const name = escapeHtml(brand.brandName);
  const legal = brand.legalName ? `${name} is a DBA of ${escapeHtml(brand.legalName)}` : name;
  const tail = [legal, brand.addressLine ? addr(brand.addressLine) : ""].filter(Boolean).join(" &nbsp;&middot;&nbsp; ");
  return `<tr>
    <td class="content-pad" style="padding:16px 48px 26px 48px;border-top:1px solid ${LETTER_LINE};${t(11, "#9ca3af", "normal", "line-height:1.6;")}">${notice}<br />${tail}</td>
  </tr>`;
}

/** Full document shell shared by the letters. */
export function wrapLetterDocument(title: string, rows: string): string {
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="x-apple-disable-message-reformatting" />
  <meta name="format-detection" content="telephone=no,address=no,email=no,date=no" />
  <title>${escapeHtml(title)}</title>
  <style type="text/css">
    body, table, td, p, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { border-collapse: collapse; mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { border: 0; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; display: block; }
    a { color: inherit !important; text-decoration: none !important; }
    a[x-apple-data-detectors] { color: inherit !important; text-decoration: none !important; font-size: inherit !important; font-family: inherit !important; font-weight: inherit !important; line-height: inherit !important; }
    @media only screen and (max-width: 660px) {
      .email-container { width: 100% !important; max-width: 100% !important; }
      .content-pad { padding-left: 22px !important; padding-right: 22px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;width:100%;background-color:#eef0f3;font-family:${LETTER_FONT};-webkit-font-smoothing:antialiased;">
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;background-color:#eef0f3;">
    <tr>
      <td align="center" style="padding:28px 10px;">
        <table role="presentation" class="email-container" border="0" cellpadding="0" cellspacing="0" width="${EMAIL_WIDTH}" style="width:${EMAIL_WIDTH}px;max-width:${EMAIL_WIDTH}px;border-collapse:collapse;background-color:#ffffff;border:1px solid #d9dde3;">
          ${rows}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Gmail-safe HTML for the formal payoff letter: funder letterhead, date /
 * reference facts, payoff summary box, wire instructions table with a
 * reference line, wire-fraud notice, validity note, signature and footer.
 * Blank merge fields surface "NA".
 */
export function renderPayoffLetterHtml(
  values: TemplateValues,
  brand: LetterBrand,
  options: PayoffLetterOptions = {},
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
  const payoffAmount = escapeHtml(formatAmount(pickOrNA(values, v.payoff_amount)));
  const validThrough = escapeHtml(pickOrBlank(values, v.good_through_date)) || "NA";
  const name = escapeHtml(brand.brandName);
  const wire = wireFromValues(values as Record<string, unknown>, options.fallbackWire ?? null);
  const dearLine = salutationName ? `Dear ${salutationName},` : "Dear Sir or Madam,";
  const reference = [dealId, accountName].filter((s) => s && s !== "NA").join(" &middot; ") || "NA";

  const wireRow = (label: string, value: string, mono = false) => `
    <tr>
      <td width="42%" style="padding:9px 14px;border-top:1px solid ${LETTER_LINE};${t(12, LETTER_MUTED)}">${label}</td>
      <td style="padding:9px 14px;border-top:1px solid ${LETTER_LINE};${mono ? `font-family:Consolas,Menlo,'Courier New',monospace;font-size:13px;font-weight:bold;color:${LETTER_TEXT};letter-spacing:.3px;` : t(13, LETTER_TEXT, "bold")}">${value || "NA"}</td>
    </tr>`;

  const rows = `
  ${renderLetterhead(brand)}
  ${renderFactRow([
    ["Date", asOfDate],
    ["Reference / Deal ID", dealId || "NA"],
    ["Agreement dated", agreementDate],
  ])}
  <tr><td class="content-pad" style="padding:24px 48px 4px 48px;${t(19, brand.dark, "bold")}">Payoff Letter</td></tr>
  <tr><td class="content-pad" style="padding:0 48px 18px 48px;${t(13, LETTER_MUTED)}">RE: ${accountName} &ndash; Merchant Cash Advance Agreement</td></tr>
  <tr>
    <td class="content-pad" style="padding:0 48px;${t(14, LETTER_TEXT, "normal", "line-height:1.65;")}">
      <p style="margin:0 0 14px 0;">${dearLine}</p>
      <p style="margin:0 0 18px 0;">This letter confirms the outstanding balance owed by <strong>${accountName}</strong> to ${name} under the Merchant Cash Advance Agreement dated <strong>${agreementDate}</strong>. Upon receipt and successful clearance of the payoff amount below, ${name} will consider the account paid in full, release the merchant from any further obligations under the agreement, and issue written confirmation that the advance has been satisfied in full.</p>
    </td>
  </tr>
  <tr>
    <td class="content-pad" style="padding:0 48px 22px 48px;">
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;background-color:#f7f8fa;border:1px solid ${LETTER_LINE};border-left:4px solid ${brand.accent};">
        <tr>
          <td style="padding:16px 18px;">
            <div style="${t(11, LETTER_MUTED, "normal", "letter-spacing:.6px;text-transform:uppercase;")}">Total payoff amount</div>
            <div style="${t(28, brand.dark, "bold", "padding-top:4px;line-height:1.2;")}">${payoffAmount}</div>
          </td>
          <td align="right" style="padding:16px 18px;${t(12, LETTER_MUTED, "normal", "line-height:1.8;")}">As of <strong style="color:${LETTER_TEXT};">${asOfDate}</strong><br />Valid through <strong style="color:${LETTER_TEXT};">${validThrough}</strong></td>
        </tr>
      </table>
    </td>
  </tr>
  <tr><td class="content-pad" style="padding:0 48px 8px 48px;${t(12, brand.dark, "bold", "text-transform:uppercase;letter-spacing:.6px;")}">Please remit your payment by wire to</td></tr>
  <tr>
    <td class="content-pad" style="padding:0 48px 12px 48px;">
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;border:1px solid ${LETTER_LINE};border-top:0;">
        ${wireRow("Bank name", escapeHtml(wire.wire_bank_name))}
        ${wireRow("Bank address", wire.wire_bank_address ? addr(wire.wire_bank_address) : "")}
        ${wireRow("Beneficiary name", escapeHtml(wire.wire_beneficiary_name))}
        ${wireRow("Beneficiary address", wire.wire_beneficiary_address ? addr(wire.wire_beneficiary_address) : "")}
        ${wireRow("Routing number (ABA)", escapeHtml(wire.wire_routing_number), true)}
        ${wireRow("Account number", escapeHtml(wire.wire_account_number), true)}
        ${wireRow("Reference / memo", reference)}
      </table>
    </td>
  </tr>
  <tr>
    <td class="content-pad" style="padding:0 48px 22px 48px;">
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;background-color:#fff7ed;border:1px solid #fed7aa;">
        <tr><td style="padding:10px 14px;${t(12, "#9a3412", "normal", "line-height:1.55;")}"><strong>Protect against wire fraud:</strong> ${name} will never change these wire instructions by email. Before sending funds, confirm the details by phone with our office using a number you already have on file.</td></tr>
      </table>
    </td>
  </tr>
  <tr>
    <td class="content-pad" style="padding:0 48px;${t(14, LETTER_TEXT, "normal", "line-height:1.65;")}">
      <p style="margin:0 0 18px 0;">This payoff amount is valid through <strong>${validThrough}</strong>. If payment is not received by that date, the payoff amount may be subject to adjustment.</p>
      <p style="margin:0 0 30px 0;">Sincerely,<br /><strong>${name} Management</strong></p>
    </td>
  </tr>
  ${renderLetterFooter(
    brand,
    `${name} reserves all rights under the Agreement until payment has been received and confirmed.${brand.email ? ` Questions about this payoff? Contact ${escapeHtml(brand.email)}.` : " Should you have any questions regarding this payoff, please contact our office."}`,
  )}`;

  return wrapLetterDocument(options.documentTitle || `${brand.brandName} Payoff Letter`, rows);
}
