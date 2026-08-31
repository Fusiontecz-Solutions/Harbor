import type {
  TemplateComponentProps,
  TemplateVariable,
} from "./types";
import { pick } from "./types";
import { APP_COMPANY_NAME } from "@/constants/appBranding";

/**
 * Harbor View Capital zero-balance / balance letter merge fields — matches the
 * dedicated blanks on the Balance Letter PDF (Date, company name).
 * Keep this list in sync with `zeroBalanceLetterEmailHtml.ts`.
 */
export const ZERO_BALANCE_LETTER_VARIABLES: TemplateVariable[] = [
  { key: "letter_date", label: "Date", placeholder: "05/20/2024" },
  {
    key: "account_name",
    label: "Account Name",
    placeholder: "Acme LLC",
  },
];

/** Kept for Clear Capital / Alliance zero balance letter imports. */
export const ZERO_BALANCE_LETTER_SIGNATURE_TITLE = "Account Specialist";

/** Hosted Harbor View Capital logo used in the in-app letter preview. */
const ZERO_BALANCE_LETTER_LOGO_SRC =
  "https://res.cloudinary.com/xnuzlpvy/image/upload/v1788194947/WhatsApp_Image_2026-08-28_at_00.09.40.jpg";

const v = ZERO_BALANCE_LETTER_VARIABLES.reduce<
  Record<string, TemplateVariable>
>((acc, variable) => {
  acc[variable.key] = variable;
  return acc;
}, {});

export default function ZeroBalanceLetter({ values }: TemplateComponentProps) {
  const letterDate = pick(values, v.letter_date);
  const accountName = pick(values, v.account_name);
  const companyNameUpper = APP_COMPANY_NAME.toUpperCase();

  return (
    <table
      role="presentation"
      cellPadding={0}
      cellSpacing={0}
      style={{
        borderCollapse: "collapse",
        width: "100%",
        maxWidth: 640,
        fontFamily: "Arial, Helvetica, sans-serif",
        fontSize: 13,
        lineHeight: 1.55,
        color: "#6b7280",
        backgroundColor: "#ffffff",
        border: "1px solid #d1d5db",
      }}
    >
      <tbody>
        <tr>
          <td style={{ padding: 0, lineHeight: 0, fontSize: 0 }}>
            <div style={{ height: 12, backgroundColor: "#71717a" }} />
            <div style={{ height: 12, backgroundColor: "#18181b" }} />
          </td>
        </tr>
        <tr>
          <td style={{ padding: "48px 36px 0", backgroundColor: "#ffffff" }}>
            <div style={{ textAlign: "center", marginBottom: 48 }}>
              <img
                src={ZERO_BALANCE_LETTER_LOGO_SRC}
                alt={APP_COMPANY_NAME}
                width={160}
                style={{
                  display: "block",
                  margin: "0 auto 18px",
                  width: 160,
                  maxWidth: "55%",
                  height: "auto",
                }}
              />
              <p
                style={{
                  margin: 0,
                  fontFamily: "Arial, Helvetica, sans-serif",
                  fontSize: 13,
                  fontWeight: 600,
                  letterSpacing: "0.18em",
                  color: "#6b7280",
                  textTransform: "uppercase",
                }}
              >
                Balance Letter
              </p>
            </div>

            <p
              style={{
                margin: "0 0 14px",
                fontFamily: "Arial, Helvetica, sans-serif",
                fontSize: 13,
                color: "#6b7280",
              }}
            >
              Date: {letterDate}
            </p>

            <p
              style={{
                margin: "0 0 36px",
                fontFamily: "Arial, Helvetica, sans-serif",
                fontSize: 13,
                fontWeight: "bold",
                color: "#111827",
              }}
            >
              {accountName}
            </p>

            <p
              style={{
                margin: "0 0 20px",
                fontFamily: "Arial, Helvetica, sans-serif",
                fontSize: 13,
                color: "#6b7280",
              }}
            >
              To Whom It May Concern:
            </p>

            <p
              style={{
                margin: 0,
                fontFamily: "Arial, Helvetica, sans-serif",
                fontSize: 13,
                lineHeight: 1.65,
                color: "#6b7280",
              }}
            >
              In regards to the future receivables purchase and sale contract
              between{" "}
              <strong style={{ color: "#111827" }}>{accountName}</strong> and{" "}
              <strong style={{ color: "#111827" }}>{companyNameUpper}</strong>,
              our records indicate that the current balance of purchased but
              unremitted receivables is{" "}
              <strong style={{ color: "#111827" }}>$0</strong>.{" "}
              <strong style={{ color: "#111827" }}>{companyNameUpper}</strong>{" "}
              will close this contract and release its security interest
              reflected in the UCC-1 financing statement.
            </p>

            <div style={{ height: 280 }} aria-hidden="true" />
          </td>
        </tr>
        <tr>
          <td style={{ padding: 0, lineHeight: 0, fontSize: 0 }}>
            <div style={{ height: 12, backgroundColor: "#18181b" }} />
            <div style={{ height: 12, backgroundColor: "#71717a" }} />
          </td>
        </tr>
      </tbody>
    </table>
  );
}
