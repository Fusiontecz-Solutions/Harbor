/**
 * Built-in values from the original Harbor View Capital / Clear Capital letters
 * (moved here unchanged from payOffLetterEmailHtml.ts). Used only as a fallback
 * when a funder has no complete set of saved wire details in Settings.
 */
export const LEGACY_FLAGSTAR_WIRE_BLOCK = {
  bankName: "Flagstar Bank",
  bankAddress: "102 Duffy Ave, Hicksville NY 11801",
  beneficiaryName: "Funding Club 18 LLC",
  beneficiaryAddress: "16 Middle Neck RD, Great Neck NY 11021",
  routingNumber: "226071004",
  accountNumber: "609931762068",
} as const;

export const HARBOR_VIEW_LEGACY_LETTER_LOGO_SRC =
  "https://res.cloudinary.com/xnuzlpvy/image/upload/v1788194947/WhatsApp_Image_2026-08-28_at_00.09.40.jpg";
