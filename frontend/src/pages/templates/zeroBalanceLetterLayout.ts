import type { TemplateValues } from "./types";
import { escapeHtml } from "./applicationApprovalEmailShared";
import type { LetterBrand } from "./letterBrand";
import {
  LETTER_FONT,
  LETTER_MUTED,
  LETTER_TEXT,
  renderFactRow,
  renderLetterhead,
  wrapLetterDocument,
} from "./payoffLetterLayout";

function pickOrNA(values: TemplateValues, key: string): string {
  const raw = values[key];
  if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  return "NA";
}

const t = (size: number, color: string, weight = "normal", extra = "") =>
  `font-family:${LETTER_FONT};font-size:${size}px;font-weight:${weight};color:${color};${extra}`;

/**
 * Gmail-safe HTML for the zero balance (balance) letter: funder letterhead,
 * date / account facts, $0.00 balance box, UCC-1 release statement,
 * signature and footer. Merge fields: `letter_date`, `account_name`.
 */
export function renderZeroBalanceLetterHtml(values: TemplateValues, brand: LetterBrand): string {
  const letterDate = escapeHtml(pickOrNA(values, "letter_date"));
  const accountName = escapeHtml(pickOrNA(values, "account_name"));
  const name = escapeHtml(brand.brandName);
  const upper = escapeHtml(brand.brandName.toUpperCase());

  const rows = `
  ${renderLetterhead(brand)}
  ${renderFactRow([
    ["Date", letterDate],
    ["Account", accountName],
    ["Status", "Paid in full"],
  ])}
  <tr><td class="content-pad" style="padding:24px 48px 4px 48px;${t(19, brand.dark, "bold")}">Zero Balance Letter</td></tr>
  <tr><td class="content-pad" style="padding:0 48px 18px 48px;${t(13, LETTER_MUTED)}">RE: ${accountName} &ndash; Future Receivables Purchase and Sale Contract</td></tr>
  <tr>
    <td class="content-pad" style="padding:0 48px 22px 48px;">
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;background-color:#f0fdf4;border:1px solid #bbf7d0;border-left:4px solid #16a34a;">
        <tr>
          <td style="padding:16px 18px;">
            <div style="${t(11, LETTER_MUTED, "normal", "letter-spacing:.6px;text-transform:uppercase;")}">Current balance</div>
            <div style="${t(28, "#166534", "bold", "padding-top:4px;line-height:1.2;")}">$0.00</div>
          </td>
          <td align="right" style="padding:16px 18px;${t(12, LETTER_MUTED, "normal", "line-height:1.8;")}">As of <strong style="color:${LETTER_TEXT};">${letterDate}</strong></td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td class="content-pad" style="padding:0 48px;${t(14, LETTER_TEXT, "normal", "line-height:1.65;")}">
      <p style="margin:0 0 14px 0;">To Whom It May Concern:</p>
      <p style="margin:0 0 16px 0;">In regards to the future receivables purchase and sale contract between <strong>${accountName}</strong> and <strong>${upper}</strong>, our records indicate that the current balance of purchased but unremitted receivables is <strong>$0</strong>.</p>
      <p style="margin:0 0 30px 0;"><strong>${upper}</strong> will close this contract and release its security interest reflected in the UCC-1 financing statement.</p>
      <p style="margin:0 0 40px 0;">Sincerely,<br /><strong>${name} Management</strong></p>
    </td>
  </tr>`;

  return wrapLetterDocument(`${brand.brandName} Zero Balance Letter`, rows);
}
