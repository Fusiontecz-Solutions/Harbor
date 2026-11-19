import type { FunderProfile } from "@/types/integrationSettingsTypes";
import {
  HARBOR_VIEW_LEGACY_LETTER_LOGO_SRC,
  LEGACY_FLAGSTAR_WIRE_BLOCK,
} from "./legacyLetterWire";

/**
 * Funder branding + wire block for payoff / zero balance letters.
 *
 * The brand comes from the funder profile (Settings → Funders): letter company
 * name, logo, legal name, address, contact and accent colour. The Letters page
 * passes it to the built-in letter renderers as JSON in the `__letter_brand`
 * merge value, so every letter (preview, email, PDF) uses the selected funder.
 */
export type LetterBrand = {
  /** Name used in the letter body, e.g. "Lendifi". */
  brandName: string;
  /** Legal entity when different from the brand (shown as "is a DBA of"). */
  legalName: string;
  addressLine: string;
  email: string;
  phone: string;
  logoUrl: string;
  /** Accent bar / highlight colour. */
  accent: string;
  /** Heading colour. */
  dark: string;
};

/** Six wire fields shown in the payoff letter and edited on the Letters page. */
export const LETTER_WIRE_FIELDS = [
  { key: "wire_bank_name", label: "Bank name" },
  { key: "wire_bank_address", label: "Bank address" },
  { key: "wire_beneficiary_name", label: "Beneficiary name" },
  { key: "wire_beneficiary_address", label: "Beneficiary address" },
  { key: "wire_routing_number", label: "Routing number (ABA)" },
  { key: "wire_account_number", label: "Account number" },
] as const;

export type LetterWireKey = (typeof LETTER_WIRE_FIELDS)[number]["key"];
export type LetterWireValues = Record<LetterWireKey, string>;

/** Where the wire details on a letter came from. */
export type LetterWireSource = "saved" | "built-in" | "missing";

export const LETTER_BRAND_VALUE_KEY = "__letter_brand";

const EMPTY_WIRE: LetterWireValues = {
  wire_bank_name: "",
  wire_bank_address: "",
  wire_beneficiary_name: "",
  wire_beneficiary_address: "",
  wire_routing_number: "",
  wire_account_number: "",
};

/**
 * Wire block printed on Harbor View Capital and Clear Capital letters before
 * per-funder wire details existed. Used only when that funder has no complete
 * set of saved wire details, so existing letters keep their current content.
 */
const LEGACY_FLAGSTAR_WIRE: LetterWireValues = {
  wire_bank_name: LEGACY_FLAGSTAR_WIRE_BLOCK.bankName,
  wire_bank_address: LEGACY_FLAGSTAR_WIRE_BLOCK.bankAddress,
  wire_beneficiary_name: LEGACY_FLAGSTAR_WIRE_BLOCK.beneficiaryName,
  wire_beneficiary_address: LEGACY_FLAGSTAR_WIRE_BLOCK.beneficiaryAddress,
  wire_routing_number: LEGACY_FLAGSTAR_WIRE_BLOCK.routingNumber,
  wire_account_number: LEGACY_FLAGSTAR_WIRE_BLOCK.accountNumber,
};

/** Harbor View Capital letterhead logo used by the original letters. */
export const HARBOR_VIEW_LETTER_LOGO_SRC = HARBOR_VIEW_LEGACY_LETTER_LOGO_SRC;

const DEFAULT_ACCENT = "#18181b";

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

/** "CLEAR CAPITAL" → "Clear Capital"; mixed-case names are left alone. */
function toDisplayCase(name: string): string {
  if (!name || name !== name.toUpperCase()) return name;
  return name.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase());
}

function normalizedName(funder: Pick<FunderProfile, "name" | "displayName">): string {
  return `${clean(funder.name)} ${clean(funder.displayName)}`.toLowerCase();
}

export function isHarborViewLetterFunder(funder: Pick<FunderProfile, "name" | "displayName">): boolean {
  return normalizedName(funder).includes("harbor view");
}

export function isClearCapitalLetterFunder(funder: Pick<FunderProfile, "name" | "displayName">): boolean {
  return normalizedName(funder).includes("clear capital");
}

function legacyWireFor(funder: Pick<FunderProfile, "name" | "displayName">): LetterWireValues | null {
  return isHarborViewLetterFunder(funder) || isClearCapitalLetterFunder(funder)
    ? { ...LEGACY_FLAGSTAR_WIRE }
    : null;
}

export function letterBrandFromFunder(funder: FunderProfile): LetterBrand {
  const brandName = toDisplayCase(
    clean(funder.letterCompanyName) || clean(funder.displayName) || clean(funder.name),
  );
  const legal = clean(funder.legalName);
  const cityLine = [clean(funder.addressCity), [clean(funder.addressState), clean(funder.addressZip)].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
  return {
    brandName,
    legalName: legal && legal.toLowerCase() !== brandName.toLowerCase() ? legal : "",
    addressLine: [clean(funder.addressLine1), cityLine].filter(Boolean).join(", "),
    email: clean(funder.contactEmail),
    phone: clean(funder.contactPhone),
    // Letter logo first; Harbor View keeps the letterhead image its letters always
    // used (its funder logo is a light contract-stamp image); others use the funder logo.
    logoUrl:
      clean(funder.letterLogoUrl) ||
      (isHarborViewLetterFunder(funder) ? HARBOR_VIEW_LETTER_LOGO_SRC : clean(funder.logoUrl)),
    accent: clean(funder.letterAccentStripDark) || DEFAULT_ACCENT,
    dark: "#111827",
  };
}

/** Saved wire fields from the funder profile (bank address joins line 1 + city/state/zip). */
export function savedLetterWire(funder: FunderProfile): LetterWireValues {
  return {
    wire_bank_name: clean(funder.letterWireBankName),
    wire_bank_address: [clean(funder.letterWireAddressLine1), clean(funder.letterWireCityStateZip)]
      .filter(Boolean)
      .join(", "),
    wire_beneficiary_name: clean(funder.letterWireBeneficiaryName),
    wire_beneficiary_address: clean(funder.letterWireBeneficiaryAddress),
    wire_routing_number: clean(funder.letterWireRoutingNumber),
    wire_account_number: clean(funder.letterWireAccountNumber),
  };
}

/**
 * Wire details to pre-fill on a letter. Saved details are used as a complete
 * set only when both routing and account numbers are saved, so a new
 * beneficiary is never paired with an old account number. Otherwise Harbor
 * View / Clear Capital keep their original built-in block; other funders start
 * from whatever is saved (numbers blank) and must be completed before sending.
 */
export function resolveLetterWire(funder: FunderProfile | null | undefined): {
  wire: LetterWireValues;
  source: LetterWireSource;
} {
  if (!funder) return { wire: { ...EMPTY_WIRE }, source: "missing" };
  const saved = savedLetterWire(funder);
  if (saved.wire_routing_number && saved.wire_account_number) {
    return { wire: saved, source: "saved" };
  }
  const legacy = legacyWireFor(funder);
  if (legacy) return { wire: legacy, source: "built-in" };
  return { wire: saved, source: "missing" };
}

/** Funder profile fields to PATCH when saving a letter's wire details as the funder default. */
export function letterWireToFunderPatch(wire: LetterWireValues) {
  const address = clean(wire.wire_bank_address);
  const comma = address.indexOf(",");
  return {
    letterWireBankName: clean(wire.wire_bank_name) || null,
    letterWireAddressLine1: (comma >= 0 ? address.slice(0, comma) : address).trim() || null,
    letterWireCityStateZip: comma >= 0 ? address.slice(comma + 1).trim() || null : null,
    letterWireBeneficiaryName: clean(wire.wire_beneficiary_name) || null,
    letterWireBeneficiaryAddress: clean(wire.wire_beneficiary_address) || null,
    letterWireRoutingNumber: clean(wire.wire_routing_number) || null,
    letterWireAccountNumber: clean(wire.wire_account_number) || null,
  };
}

export function encodeLetterBrand(brand: LetterBrand): string {
  return JSON.stringify(brand);
}

/** Brand passed by the Letters page, or `fallback` for previews / older callers. */
export function decodeLetterBrand(values: Record<string, unknown>, fallback: LetterBrand): LetterBrand {
  const raw = values[LETTER_BRAND_VALUE_KEY];
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<LetterBrand>;
    return { ...fallback, ...parsed, brandName: clean(parsed.brandName) || fallback.brandName };
  } catch {
    return fallback;
  }
}

/** Wire values from the merge values, falling back to `fallback` for any blank key. */
export function wireFromValues(values: Record<string, unknown>, fallback: LetterWireValues | null): LetterWireValues {
  const out = { ...EMPTY_WIRE };
  for (const f of LETTER_WIRE_FIELDS) {
    const v = clean(values[f.key]);
    out[f.key] = v || (fallback ? fallback[f.key] : "");
  }
  return out;
}

/** Original letters' default brands — used when no funder brand is passed. */
export const HARBOR_VIEW_DEFAULT_LETTER_BRAND: LetterBrand = {
  brandName: "Harbor View Capital",
  legalName: "",
  addressLine: "16 Middle Neck Road, Suite 2054, Great Neck, NY 11021",
  email: "admin@harborviewcapitals.com",
  phone: "(713) 519-3936",
  logoUrl: HARBOR_VIEW_LETTER_LOGO_SRC,
  accent: DEFAULT_ACCENT,
  dark: "#111827",
};

export const CLEAR_CAPITAL_DEFAULT_LETTER_BRAND: LetterBrand = {
  ...HARBOR_VIEW_DEFAULT_LETTER_BRAND,
  brandName: "Clear Capital",
  email: "",
  logoUrl: "",
};

export const LEGACY_LETTER_WIRE: LetterWireValues = { ...LEGACY_FLAGSTAR_WIRE };
