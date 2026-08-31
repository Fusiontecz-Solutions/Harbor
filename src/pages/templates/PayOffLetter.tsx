import type { TemplateComponentProps, TemplateVariable } from "./types";
import { pick } from "./types";
import { APP_COMPANY_NAME } from "@/constants/appBranding";

/**
 * Harbor View Capital payoff letter merge fields — matches the dedicated blanks
 * on the Balance / Payoff letter PDF (RE, DEAR, On date, company, amount).
 * Wire instructions are fixed in the letter HTML (not merge fields).
 */
export const PAY_OFF_LETTER_VARIABLES: TemplateVariable[] = [
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

/** Fixed line under the sender name in legacy Alliance letter (kept for shared import). */
export const PAY_OFF_LETTER_SIGNATURE_TITLE = "Account Specialist";

/** Hosted Harbor View Capital logo used in the in-app letter preview. */
const PAYOFF_LETTER_LOGO_SRC =
  "https://res.cloudinary.com/xnuzlpvy/image/upload/v1788194947/WhatsApp_Image_2026-08-28_at_00.09.40.jpg";

/** Fixed Flagstar / Funding Club 18 wire block from the Harbor View PDF. */
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

const v = PAY_OFF_LETTER_VARIABLES.reduce<Record<string, TemplateVariable>>(
  (acc, variable) => {
    acc[variable.key] = variable;
    return acc;
  },
  {},
);

export default function PayOffLetter({ values }: TemplateComponentProps) {
  const accountName = pick(values, v.account_name);
  const salutationName = pick(values, v.salutation_name);
  const agreementDate = pick(values, v.agreement_date);
  const payoffAmount = pick(values, v.payoff_amount);

  return (
    <table
      role="presentation"
      cellPadding={0}
      cellSpacing={0}
      style={{
        borderCollapse: "collapse",
        width: "100%",
        maxWidth: 640,
        fontFamily: "Georgia, 'Times New Roman', Times, serif",
        fontSize: 13,
        lineHeight: 1.55,
        color: "#4b5563",
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
          <td style={{ padding: "28px 36px 36px", backgroundColor: "#ffffff" }}>
            <div style={{ textAlign: "center", marginBottom: 20 }}>
              <img
                src={PAYOFF_LETTER_LOGO_SRC}
                alt={APP_COMPANY_NAME}
                width={160}
                style={{
                  display: "block",
                  margin: "0 auto 16px",
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
                Payoff Letter
              </p>
            </div>

            <p
              style={{
                margin: "28px 0 18px",
                fontFamily: "Arial, Helvetica, sans-serif",
                fontSize: 13,
                color: "#6b7280",
                textTransform: "uppercase",
              }}
            >
              RE: {accountName}
            </p>

            <p
              style={{
                margin: "0 0 18px",
                fontFamily: "Arial, Helvetica, sans-serif",
                fontSize: 13,
                color: "#6b7280",
                textTransform: "uppercase",
              }}
            >
              DEAR, {salutationName}
            </p>

            <p
              style={{
                margin: "0 0 14px",
                fontFamily: "Arial, Helvetica, sans-serif",
                fontSize: 13,
                lineHeight: 1.6,
                color: "#6b7280",
              }}
            >
              This letter is to confirm an account activity that has been
              established between{" "}
              <strong style={{ color: "#111827" }}>
                {APP_COMPANY_NAME.toUpperCase()}
              </strong>{" "}
              and{" "}
              <strong style={{ color: "#111827" }}>{accountName}</strong>.
            </p>

            <p
              style={{
                margin: "0 0 18px",
                fontFamily: "Arial, Helvetica, sans-serif",
                fontSize: 13,
                lineHeight: 1.6,
                color: "#6b7280",
              }}
            >
              On <strong style={{ color: "#111827" }}>{agreementDate}</strong>,
              we have entered into a merchant agreement to purchase part of a
              Merchants future receivables for the amount defined herein as
              &quot;total due&quot; The merchant agreed to deliver to us a fixed
              daily amount for a designated term, until the agreement has been
              fully satisfied. Upon receipt of this amount, we will close this
              contract and our security interest in your company will be released
              and satisfied. Any overpayment shall be refunded within 10 days. We
              appreciate your business and look forward to having the opportunity
              to serve you again.
            </p>

            <p
              style={{
                margin: "0 0 22px",
                fontFamily: "Arial, Helvetica, sans-serif",
                fontSize: 13,
                color: "#374151",
              }}
            >
              Balance Due: $ {payoffAmount.replace(/^\$\s*/, "")}
            </p>

            <p
              style={{
                margin: "0 0 8px",
                fontFamily: "Arial, Helvetica, sans-serif",
                fontSize: 13,
                fontWeight: 700,
                color: "#111827",
              }}
            >
              Wire Instruction
            </p>
            <p
              style={{
                margin: "0 0 2px",
                fontFamily: "Arial, Helvetica, sans-serif",
                fontSize: 13,
                color: "#111827",
              }}
            >
              <strong>Bank Name:</strong> {HARBOR_VIEW_WIRE.bankName}
            </p>
            <p
              style={{
                margin: "0 0 2px",
                fontFamily: "Arial, Helvetica, sans-serif",
                fontSize: 13,
                color: "#111827",
              }}
            >
              <strong>Bank Address:</strong> {HARBOR_VIEW_WIRE.bankAddressLine1}
            </p>
            <p
              style={{
                margin: "0 0 2px",
                fontFamily: "Arial, Helvetica, sans-serif",
                fontSize: 13,
                color: "#111827",
              }}
            >
              {HARBOR_VIEW_WIRE.bankAddressLine2}
            </p>
            <p
              style={{
                margin: "0 0 2px",
                fontFamily: "Arial, Helvetica, sans-serif",
                fontSize: 13,
                color: "#111827",
              }}
            >
              <strong>Beneficiary Name:</strong>{" "}
              {HARBOR_VIEW_WIRE.beneficiaryName}
            </p>
            <p
              style={{
                margin: "0 0 2px",
                fontFamily: "Arial, Helvetica, sans-serif",
                fontSize: 13,
                color: "#111827",
              }}
            >
              <strong>Beneficiary Address:</strong>{" "}
              {HARBOR_VIEW_WIRE.beneficiaryAddressLine1}
            </p>
            <p
              style={{
                margin: "0 0 2px",
                fontFamily: "Arial, Helvetica, sans-serif",
                fontSize: 13,
                color: "#111827",
              }}
            >
              {HARBOR_VIEW_WIRE.beneficiaryAddressLine2}
            </p>
            <p
              style={{
                margin: "0 0 2px",
                fontFamily: "Arial, Helvetica, sans-serif",
                fontSize: 13,
                color: "#111827",
              }}
            >
              <strong>Routing Number:</strong> {HARBOR_VIEW_WIRE.routingNumber}
            </p>
            <p
              style={{
                margin: 0,
                fontFamily: "Arial, Helvetica, sans-serif",
                fontSize: 13,
                color: "#111827",
              }}
            >
              <strong>Account Number:</strong> {HARBOR_VIEW_WIRE.accountNumber}
            </p>
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
