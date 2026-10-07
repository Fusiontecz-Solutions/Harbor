import type {
  DocumentLayout,
  DocumentLayoutPlacement,
} from './convert-docusign-template-export';
import {
  buildLayoutPrefillValueRecord,
  CRM_ID_TO_LAYOUT_VARIABLE,
  getPrefillDisplayLabel,
} from './prefill-layout-bridge';
import { normalizeFieldKey, type PrefillFieldInput } from './docusign-prefill';
import { DOCUSIGN_DEFAULT_ROLE_NAME, DOCUSIGN_SECONDARY_ROLE_NAME } from './docusign-client';
import {
  applyDocuSignPrefillTabStyle,
  isDocuSignWrapTextTab,
  resolveDocuSignFontSizeToken,
  resolveDocuSignPrefillTabWidth,
  wrapDocuSignTabValue,
} from './docusign-tab-style';
import { embedArialBoldPdfFont, embedArialPdfFont } from './embed-arial-pdf-font';
import { DOCUMENT_LAYOUT_KEYS } from '../layouts/document-layout.registry';
import { isFunderContractLayoutKey } from '../../../utils/funderContractLayout';
import {
  isAddressPlaceholderToken,
  isUsableDisclosureStreetLine,
  toUsStateAbbreviation,
} from '../../../utils/usStateMatch';
import {
  buildScopedValuesForLayout,
  DISCLOSURE_MERCHANT_BUSINESS_NAME_VARS,
  DISCLOSURE_RECIPIENT_ADDRESS_VARS,
  DISCLOSURE_ESTIMATED_PAYMENT_VARS,
  isMainContractLayoutKey,
  isStateDisclosureTextPlacement,
  resolveDisclosureMerchantBusinessName,
  resolveDisclosureRecipientAddress,
  resolveDisclosureEstimatedPayment,
  resolveCanonicalSupplementalLayoutKey,
  resolveSupplementalEnvelopeTabLabel,
  toDisclosureScopedPrefillId,
} from './layout-prefill-scope';

const DOCUSIGN_SECONDARY_SIGNER_ROLE_NAME = DOCUSIGN_SECONDARY_ROLE_NAME;

export type LayoutSignerInput = {
  roleName: string;
  name: string;
  email: string;
  routingOrder?: number;
};

export function prefillFieldsToValueMap(
  fields: Array<{ id?: string; value?: string }>,
): Record<string, string> {
  const out = buildLayoutPrefillValueRecord(fields as PrefillFieldInput[]);
  return expandPrefillValues(out);
}

export type BuildEnvelopeFromLayoutOptions = {
  layouts: DocumentLayout[];
  /** Prefill values keyed by layout variable (snake_case data labels). */
  values: Record<string, string>;
  signers: LayoutSignerInput[];
  ownerCount?: number;
  guarantorCount?: number;
  /** Display name for the primary (first) PDF in the envelope. */
  primaryDocumentName?: string;
  /** Index in `layouts` that receives `primaryDocumentName` (main contract; default 0). */
  primaryLayoutIndex?: number;
  /**
   * When true, text/date values are already burned into document PDFs — only signature /
   * initial / attachment tabs are attached (visible to all recipients including CC).
   * @deprecated Prefer `flattenedLayoutKeys` when only some documents were flattened.
   */
  skipTextDateTabs?: boolean;
  /** Layout keys whose text/date prefill was burned into the PDF (skip duplicate tabs). */
  flattenedLayoutKeys?: ReadonlySet<string>;
  /** When true, text/date tabs are created locked (use only when sending immediately). */
  lockDataTabs?: boolean;
  /** Merged PDF bytes when multiple layouts are combined into one DocuSign document. */
  mergedDocument?: { name: string; documentBase64: string };
  /** Page offset per layout key (0-based) inside `mergedDocument`. */
  pageOffsetByLayoutKey?: Map<string, number>;
};

export async function countPdfPagesFromBase64(documentBase64: string): Promise<number> {
  const { PDFDocument } = await import('pdf-lib');
  const pdfDoc = await PDFDocument.load(Buffer.from(documentBase64, 'base64'));
  return pdfDoc.getPageCount();
}

export function maxPlacementPageNumber(layout: DocumentLayout): number {
  let max = 1;
  for (const placement of layout.placements) {
    const page = parseInt(String(placement.pageNumber || '1'), 10);
    if (Number.isFinite(page) && page > max) max = page;
  }
  return max;
}

export async function assertLayoutPlacementsFitPdfPages(
  layout: DocumentLayout & { documentBase64?: string },
): Promise<void> {
  const base64 = layout.documentBase64;
  if (!base64) return;
  const pageCount = await countPdfPagesFromBase64(base64);
  const required = maxPlacementPageNumber(layout);
  if (required <= pageCount) return;
  throw new Error(
    `Document "${layout.name}" PDF has ${pageCount} page(s) but DocuSign tabs require page ${required}. ` +
      `Re-upload a ${required}-page PDF or update tab coordinates in state-document-config.`,
  );
}

export type LayoutPartyCounts = {
  ownerCount: number;
  guarantorCount: number;
};

/** Canonical CRM keys copied to legacy / duplicate tab labels automatically. */
const PREFILL_VALUE_ALIASES: Record<string, string[]> = {
  agreement_date: ['signature_date', 'disclosure_date', 'addendum_date', 'first_payment_date'],
  addendum_date: ['agreement_date', 'signature_date', 'disclosure_date'],
  signature_date: ['agreement_date', 'addendum_date', 'Signature_date', 'disclosure_date'],
  Signature_date: ['signature_date', 'agreement_date', 'addendum_date', 'disclosure_date'],
  disclosure_date: ['agreement_date', 'addendum_date', 'signature_date'],
  first_payment_date: ['agreement_date', 'signature_date', 'disclosure_date'],
  /** Texas ACH / page-11 owner date labels — prefill from shared agreement date. */
  agreement_date_owner1_p11: [
    'agreement_date',
    'signature_date',
    'disclosure_date',
    'addendum_date',
  ],
  agreement_date_owner2_p11: [
    'agreement_date',
    'signature_date',
    'disclosure_date',
    'addendum_date',
  ],
  agreement_date_owner1_p6: [
    'agreement_date',
    'signature_date',
    'disclosure_date',
    'addendum_date',
  ],
  agreement_date_owner2_p6: [
    'agreement_date',
    'signature_date',
    'disclosure_date',
    'addendum_date',
  ],
  date_by_which_amount_mustbe_received: ['prepayment_received_by_date'],
  funder_name: ['disclosure_funder_name'],
  client_legal_name: ['business_legal_name', 'merchant_legal_name', 'client_legal_name_p11_footer'],
  client_legal_name_p11_footer: ['client_legal_name', 'business_legal_name', 'merchant_legal_name'],
  seller_1_name: [
    'owner1_guarantor_name',
    'guaranty_owner1_name',
    'guaranty_guarantor1_name',
    'client_name',
    'owner_name',
  ],
  seller_2_name: [
    'owner2_guarantor_name',
    'guaranty_owner2_name',
    'guaranty_guarantor2_name',
    'merchant2_name',
  ],
  business_name_2: [
    'owner2_guarantor_name',
    'guaranty_owner2_name',
    'guaranty_guarantor2_name',
    'merchant2_name',
    'appendix_merchant2_name',
    'addendum_dated_principal_owner2_name',
  ],
  client_name: [
    'client_name_by',
    'addendum_client_name',
    'guaranty_client_name',
    'owner1_guarantor_name',
    'guaranty_owner1_name',
    'guaranty_guarantor1_name',
    'security_guarantor',
  ],
  addendum_client_name: [
    'client_name',
    'owner1_guarantor_name',
    'guaranty_owner1_name',
    'guaranty_guarantor1_name',
    'guaranty_client_name',
    'security_guarantor',
  ],
  business_address: [
    'security_business_address',
    'recipient_address',
    'recipient_address1',
    'ach_authorization_account_holder_address',
  ],
  business_address_city: [
    'security_business_address_city',
    'ach_authorization_account_holder_city',
  ],
  business_address_state: [
    'security_business_address_state',
    'ach_authorization_account_holder_state',
  ],
  business_address_zip: [
    'security_business_address_zip',
    'ach_authorization_account_holder_zip',
  ],
  /** Owner 1 home / contact — keep distinct from business location. */
  business_address_contract: ['guarantor_address'],
  business_address_contract_city: ['guarantor_address_city'],
  business_address_contract_state: ['guarantor_address_state'],
  business_address_contract_zip: ['guarantor_address_zip'],
  guarantor_address: ['business_address_contract'],
  guarantor_address_city: ['business_address_contract_city'],
  guarantor_address_state: ['business_address_contract_state'],
  guarantor_address_zip: ['business_address_contract_zip'],
  guarantor_email: ['client_email'],
  client_email: ['guarantor_email'],
  authorization_client_name: [
    'client_legal_name',
    'security_business_name',
    'business_legal_name',
  ],
  /** ACH auth page-13 signer line — business / merchant legal name. */
  authorization_client_signer_name: [
    'authorization_client_name',
    'client_legal_name',
    'security_business_name',
    'business_legal_name',
  ],
  /** ACH auth page-13 printed name — person / client name. */
  authorization_client_name_print: [
    'customer_name',
    'client_name',
    'owner1_guarantor_name',
  ],
  /**
   * ACH consent "Name/Title of Account Holder" is Owner 1 person name — set by
   * `normalizeAchAuthorizationNames`. Never alias business / legal names here.
   */
  ach_authorization_concent_account_holder_name_2: [
    'ach_authorization_concent_account_holder_name',
  ],
  ach_authorization_account_holder_bank_state: ['achauthorizationaccountholderbankstate'],
  ach_authorization_account_holder_bank_zip: ['achauthorizationaccountholderbankzip'],
  ach_authorization_account_holder_bank_branch_city: [
    'achauthorizationaccountholderbankbranchcity',
  ],
  ach_authorization_account_holder_bank_name: ['achauthorizationaccountholderbankname'],
  ach_authorization_account_holder_bank_routing_number: [
    'achauthorizationaccountholderbankroutingnumber',
  ],
  ach_authorization_account_holder_bank_account_number: [
    'achauthorizationaccountholderbankaccountnumber',
  ],
  /** ACH page-2 phone / DBA follow the business contact values (Katan client sync). */
  client_phone: ['authorized_business_phone'],
  authorized_business_phone: ['ach_authorization_account_holder_phone'],
  doing_business_as: ['ach_authorization_account_holder_dba'],
  entity_type: ['typeOfEntity1', 'typeofentity1'],
  typeofentity1: ['entity_type', 'typeOfEntity1'],
  typeOfEntity1: ['entity_type', 'typeofentity1'],
  owner_print_title: ['print_title', 'guarantor_print_title', 'owner_title'],
  guarantor_print_title: ['owner_print_title', 'print_title', 'owner_title'],
  print_title: ['owner_print_title', 'guarantor_print_title'],
  federal_tax_id_ein: ['security_tax_ein', 'authorization_client_tax_id'],
  security_tax_ein: ['federal_tax_id_ein', 'authorization_client_tax_id'],
  frequency: ['paymentterms', 'payment_terms'],
  remittance: [
    'estimated_payment',
    'estimated_payment_amount',
    'disclosure_estimated_payment',
    'theestimatedpayment',
    'weekly_payments',
    'fordailypayments',
  ],
  weekly_payments: [
    'fordailypayments',
    'disclosure_estimated_payment',
    'estimated_payment',
    'estimated_payment_amount',
    'remittance',
    'theestimatedpayment',
  ],
  fordailypayments: [
    'weekly_payments',
    'disclosure_estimated_payment',
    'estimated_payment',
    'estimated_payment_amount',
    'remittance',
    'theestimatedpayment',
  ],
  net_to_merchant: ['netfundprovided', 'net_fund_provided', 'NetFundProvided'],
  purchase_amount: [
    'disclosure_amount_financed',
    'funding_provided',
    'addendum_dated_principal_owner_amount',
  ],
  purchase_price: [
    'disclosure_total_payment',
    'total_repayment_amount',
    'estimatedTotalPaymentAmount',
    'addendum_dated_principal_owner_amount2',
  ],
  purchase_percent: ['specified_percentage', 'purchased_percent', 'percent_of_business_income'],
  percent_of_business_income: ['purchase_percent', 'specified_percentage', 'purchased_percent'],
  total_dollar_cost: [
    'finance_charge',
    'disclosure_finance_charge',
    'financeCharge',
    'total_dollar_cost_of_frinancing',
  ],
  finance_charge: [
    'total_dollar_cost',
    'disclosure_finance_charge',
    'financeCharge',
    'total_dollar_cost_of_frinancing',
  ],
  disclosure_finance_charge: [
    'total_dollar_cost',
    'finance_charge',
    'financeCharge',
    'total_dollar_cost_of_frinancing',
  ],
  total_amount_tobe_paid_to_provider: [
    'disclosure_total_payment',
    'total_repayment_amount',
    'purchase_price',
    'purchasePrice',
  ],
  total_amount_business_fund: ['disclosure_amount_financed', 'funding_provided'],
  total_amount_of_fund_disbursed: ['disclosure_recipient_funds', 'net_to_merchant'],
  total_amount_fund_disbursed: ['disclosure_recipient_funds', 'total_amount_of_fund_disbursed', 'net_to_merchant'],
  disclosure_recipient_funds: [
    'funding_provided_direct',
    'total_amount_of_fund_disbursed',
    'total_amount_fund_disbursed',
  ],
  estimated_annual_percentage_rate: ['disclosure_apr'],
  disclosure_apr: ['estimated_annual_percentage_rate'],
  total_amount_of_fund_provided: ['disclosure_amount_financed', 'funding_provided', 'total_amount_business_fund'],
  total_of_payments: ['disclosure_total_payment', 'total_repayment_amount', 'purchase_price'],
  total_amount_sales_based_financing: ['disclosure_amount_financed', 'funding_provided', 'total_amount_business_fund'],
  disbursement_amount: ['disclosure_recipient_funds', 'total_amount_fund_disbursed', 'net_to_merchant'],
  total_repayment_amount: ['disclosure_total_payment', 'purchase_price', 'estimatedTotalPaymentAmount'],
  estimated_number_of_payement: ['disclosure_term_days', 'estimated_number_of_payments'],
  disclosure_name: [
    'legal_name',
    'client_legal_name',
    'security_business_name',
    'business_legal_name',
    'disclosure_merchant_name',
    'recipient_name',
    'client_name',
  ],
  disclosure_merchant_name: [
    'legal_name',
    'client_legal_name',
    'security_business_name',
    'business_legal_name',
    'disclosure_name',
    'recipient_name',
    'client_name',
  ],
  disclosure_date2: ['disclosure_date', 'agreement_date', 'signature_date'],
  initials_date: ['disclosure_date', 'agreement_date', 'signature_date'],
  recipient_name: [
    'legal_name',
    'client_legal_name',
    'security_business_name',
    'business_legal_name',
    'disclosure_merchant_name',
    'disclosure_name',
    'client_name',
  ],
  recipient_name2: [
    'legal_name',
    'client_legal_name',
    'security_business_name',
    'business_legal_name',
    'disclosure_merchant_name',
    'recipient_name',
    'disclosure_name',
    'client_name',
  ],
  recipient_address2: ['recipient_address', 'recipient_address1'],
  recipient_address: ['recipient_address1', 'business_address'],
  total_amount_commercial_financing: ['funding_provided', 'disclosure_purchase_price', 'purchase_amount', 'total_amount_business_fund', 'disclosure_amount_financed'],
  total_commerical_financing: ['disclosure_recipient_funds', 'total_amount_of_fund_disbursed', 'amountFinanced', 'net_to_merchant'],
  deducted_at_disbursement: [
    'disclosure_fees_deducted',
    'fees_deducted',
    'disclosure_origination_fee',
  ],
  fees_deducted: [
    'disclosure_fees_deducted',
    'deducted_at_disbursement',
    'disclosure_origination_fee',
  ],
  estimated_time_periodic_paymement: ['disclosure_term_days', 'estimated_number_of_payments'],
  theestimatedpayment: ['disclosure_estimated_payment', 'estimated_payment'],
  payment_exceed_percent: [
    'disclosure_payment_terms',
    'percent_of_business_income',
    'payement_exceeded_percent',
    'payment_exceeded_percent',
  ],
  payement_exceeded_percent: [
    'disclosure_payment_terms',
    'percent_of_business_income',
    'payment_exceeded_percent',
    'payment_exceed_percent',
  ],
  payment_exceeded_percent: [
    'disclosure_payment_terms',
    'percent_of_business_income',
    'payement_exceeded_percent',
    'payment_exceed_percent',
  ],
  disclosure_payment_terms: [
    'payement_exceeded_percent',
    'payment_exceeded_percent',
    'payment_exceed_percent',
    'percent_of_business_income',
  ],
  signature1_date: ['disclosure_date', 'agreement_date', 'signature_date'],
  signature2_date: ['disclosure_date', 'agreement_date', 'signature_date'],
  estimated_payment_amount: ['disclosure_estimated_payment', 'estimated_payment', 'remittance'],
  monthly_income: ['disclosure_avg_monthly_revenue', 'avarage_monthly_income', 'etimated_average_income'],
  appendix_underwriting_fees: [
    'disclosure_broker_fee',
    'underwriter_fee',
    'underwriterfee',
    'underwriter_fees',
    'originationFee',
    'origination_fee',
  ],
  underwriter_fee: [
    'appendix_underwriting_fees',
    'underwriterfee',
    'underwriter_fees',
    'originationFee',
    'origination_fee',
  ],
  originationFee: [
    'appendix_underwriting_fees',
    'underwriter_fee',
    'underwriterfee',
    'underwriter_fees',
    'origination_fee',
  ],
  origination_fee: [
    'appendix_underwriting_fees',
    'underwriter_fee',
    'underwriterfee',
    'underwriter_fees',
    'originationFee',
  ],
  owner1_guarantor_name: ['guaranty_owner1_name', 'guaranty_guarantor1_name', 'guaranty_client_name'],
  guaranty_owner1_name: ['owner1_guarantor_name', 'guaranty_guarantor1_name', 'guaranty_client_name', 'client_name'],
  guaranty_guarantor1_name: ['owner1_guarantor_name', 'guaranty_owner1_name', 'guaranty_client_name', 'client_name'],
  guaranty_client_name: ['client_name', 'owner1_guarantor_name', 'guaranty_owner1_name', 'guaranty_guarantor1_name'],
  security_guarantor: ['guaranty_guarantor1_name', 'guaranty_owner1_name', 'owner1_guarantor_name', 'client_name'],
  guaranty_owner1_ss: ['guaranty_guarantor1_ss'],
  guaranty_guarantor1_ss: ['guaranty_owner1_ss'],
  owner2_guarantor_name: [
    'guaranty_owner2_name',
    'guaranty_guarantor2_name',
    'merchant2_name',
    'appendix_merchant2_name',
    'addendum_dated_principal_owner2_name',
    'business_name_2',
  ],
  guaranty_owner2_name: [
    'owner2_guarantor_name',
    'guaranty_guarantor2_name',
    'merchant2_name',
    'appendix_merchant2_name',
    'addendum_dated_principal_owner2_name',
    'business_name_2',
  ],
  guaranty_guarantor2_name: [
    'owner2_guarantor_name',
    'guaranty_owner2_name',
    'merchant2_name',
    'appendix_merchant2_name',
    'addendum_dated_principal_owner2_name',
    'business_name_2',
  ],
  merchant2_name: [
    'owner2_guarantor_name',
    'guaranty_owner2_name',
    'guaranty_guarantor2_name',
    'appendix_merchant2_name',
    'addendum_dated_principal_owner2_name',
    'business_name_2',
  ],
  appendix_merchant2_name: [
    'owner2_guarantor_name',
    'guaranty_owner2_name',
    'merchant2_name',
    'guaranty_guarantor2_name',
    'addendum_dated_principal_owner2_name',
    'business_name_2',
  ],
  guaranty_owner2_ss: ['guaranty_guarantor2_ss'],
  guaranty_guarantor2_ss: ['guaranty_owner2_ss'],
  guaranty_owner2_driver_license: ['guaranty_guarantor2_driver_license'],
  guaranty_guarantor2_driver_license: ['guaranty_owner2_driver_license'],
};

/**
 * Merchant #2 initials — just right of Merchant #1 on the footer line (not mid-page).
 * ~1 initial-width + small gap from the primary tab; slightly higher on Y.
 */
const OWNER2_INITIAL_OFFSET_X = 108;
const OWNER2_INITIAL_OFFSET_Y = -6;

/**
 * Optional extra nudge for the shared Harbor View / Clear Capital main contract
 * (`contract.layout.json`, including funder-scoped PDF storage keys).
 * Default 0 — layout JSON y values are already the DocuSign positions
 * (including the +3px-from-top shift baked into contract.layout.json).
 * Clear Capital page-1 header offset is applied in
 * `applyClearCapitalMainContractLayout`, not here.
 * Never apply to addendums, ACH, or state disclosures.
 */
const CONTRACT_TAB_Y_OFFSET = Number(process.env.DOCUSIGN_CONTRACT_TAB_Y_OFFSET ?? 0) || 0;

/**
 * Sit-on-blank: DocuSign yPosition is the TOP of the tab. A 14px tab matches
 * size9 text so the bottom edge rests on the underline (ACH account-holder look).
 * Do not apply a global Y lift — that floated dates / page-2 inline blanks.
 */
const SIT_ON_BLANK_TEXT_TAB_HEIGHT = '14';

/** Platform `contract` plus funder_<uuid> uploads that reuse contract.layout.json. */
function isSharedMainContractLayoutKey(layoutKey?: string): boolean {
  const key = String(layoutKey || '').trim();
  if (key === 'contract' || key === DOCUMENT_LAYOUT_KEYS.contract) return true;
  return isFunderContractLayoutKey(key);
}

/** P / CA / NY / VA / EPA / EPD addendums and Exhibit A — keep layout width so short values (e.g. SWE) do not shrink into a floating box. */
function isAddendumSitOnBlankLayout(layoutKey?: string): boolean {
  const key = String(layoutKey || '').trim().toLowerCase();
  if (!key) return false;
  return (
    key === 'addendum_p' ||
    key === 'addendum_ca' ||
    key === 'addendum_ny' ||
    key === 'addendum_va' ||
    key === 'addendum_epa' ||
    key === 'addendum_epd' ||
    key.includes('addendum_p') ||
    key.includes('addendum_ca') ||
    key.includes('addendum_ny') ||
    key.includes('addendum_va') ||
    key.includes('addendum_epa') ||
    key.includes('addendum_epd') ||
    key.includes('exhibit_a')
  );
}

function keepPrefillTabLayoutWidth(layoutKey?: string): boolean {
  return isSharedMainContractLayoutKey(layoutKey) || isAddendumSitOnBlankLayout(layoutKey);
}

function resolveTabYPosition(y: string | undefined, layoutKey?: string): string {
  const raw = String(y ?? '0').trim();
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return raw || '0';
  if (!CONTRACT_TAB_Y_OFFSET || !isSharedMainContractLayoutKey(layoutKey)) {
    return raw;
  }
  return String(Math.max(0, Math.round(n + CONTRACT_TAB_Y_OFFSET)));
}

/** Text/date tab top + height so the box sits on the underline instead of cutting through it. */
function resolveSitOnBlankTextTabMetrics(
  placement: DocumentLayoutPlacement,
  layoutKey?: string,
): { y: string; height: string } {
  const yRaw = resolveTabYPosition(placement.y, layoutKey);
  if (isDocuSignWrapTextTab(placement.height)) {
    return {
      y: yRaw,
      height: String(placement.height),
    };
  }
  const configured = parseFloat(String(placement.height ?? '').trim());
  const height =
    Number.isFinite(configured) && configured > 0 && configured < 14
      ? String(Math.round(configured))
      : SIT_ON_BLANK_TEXT_TAB_HEIGHT;
  return { y: yRaw, height };
}

const PARTY2_NAME_KEYS = [
  'owner2_guarantor_name',
  'guaranty_owner2_name',
  'guaranty_guarantor2_name',
  'merchant2_name',
  'appendix_merchant2_name',
  'addendum_dated_principal_owner2_name',
  'business_name_2',
  'seller_2_name',
] as const;

const PARTY2_NAME_PRIORITY = [
  'owner2_guarantor_name',
  'merchant2_name',
  'guaranty_owner2_name',
  'guaranty_guarantor2_name',
  'appendix_merchant2_name',
  'addendum_dated_principal_owner2_name',
  'business_name_2',
  'seller_2_name',
] as const;

const PARTY1_NAME_KEYS = [
  'client_name',
  'addendum_client_name',
  'owner1_guarantor_name',
  'guaranty_owner1_name',
  'guaranty_guarantor1_name',
  'guaranty_client_name',
  'security_guarantor',
  'seller_1_name',
] as const;

const PARTY1_NAME_PRIORITY = [
  'owner1_guarantor_name',
  'guaranty_owner1_name',
  'guaranty_guarantor1_name',
  'guaranty_client_name',
  'security_guarantor',
  'client_name',
  'addendum_client_name',
  'seller_1_name',
] as const;

/** Business / legal names that must not fill `client_name` (owner / client person). */
function resolveContractLegalNameValue(values: Record<string, string>): string {
  return String(
    values.client_legal_name ||
      values.business_legal_name ||
      values.merchant_legal_name ||
      values.security_business_name ||
      values.legal_name ||
      values.authorization_client_name ||
      '',
  ).trim();
}

/** Street + city + state + ZIP for single-line Contact Address tabs. */
function composeUsMailingAddress(
  street: string,
  city: string,
  state: string,
  zip: string,
): string {
  const line = String(street || '').trim();
  const cityPart = String(city || '').trim();
  const stateZip = [String(state || '').trim(), String(zip || '').trim()]
    .filter(Boolean)
    .join(' ');
  if (cityPart && line.toLowerCase().includes(cityPart.toLowerCase())) return line;
  const cityLine = [cityPart, stateZip].filter(Boolean).join(', ');
  return [line, cityLine].filter(Boolean).join(', ');
}

function resolveGuarantorFullAddress(values: Record<string, string>): string {
  const street = String(
    values.guarantor_address || values.business_address_contract || '',
  ).trim();
  const city = String(
    values.guarantor_address_city || values.business_address_contract_city || '',
  ).trim();
  const state = String(
    values.guarantor_address_state || values.business_address_contract_state || '',
  ).trim();
  const zip = String(
    values.guarantor_address_zip || values.business_address_contract_zip || '',
  ).trim();
  const composed = composeUsMailingAddress(street, city, state, zip);
  return composed && isUsableDisclosureStreetLine(composed) ? composed : street;
}

function resolveBusinessFullAddress(values: Record<string, string>): string {
  const street = String(
    values.business_address || values.security_business_address || '',
  ).trim();
  const city = String(
    values.business_address_city || values.security_business_address_city || '',
  ).trim();
  const state = String(
    values.business_address_state || values.security_business_address_state || '',
  ).trim();
  const zip = String(
    values.business_address_zip || values.security_business_address_zip || '',
  ).trim();
  const composed = composeUsMailingAddress(street, city, state, zip);
  return composed && isUsableDisclosureStreetLine(composed) ? composed : street;
}

function layoutDefinesVariable(
  layout: DocumentLayout | undefined,
  variable: string,
): boolean {
  if (!layout?.placements?.length) return false;
  const needle = String(variable || '').trim().toLowerCase();
  if (!needle) return false;
  return layout.placements.some(
    (placement) => String(placement.variable || '').trim().toLowerCase() === needle,
  );
}

/** Harbor page 1 is one street line; Alliance keeps separate city/state/ZIP tabs. */
function shouldComposeFullAddressOnStreetTab(
  layout: DocumentLayout | undefined,
  streetVariable: string,
): boolean {
  const base = String(streetVariable || '').trim().toLowerCase();
  if (!base || !layout?.placements?.length) return false;
  return !['city', 'state', 'zip'].some((part) =>
    layoutDefinesVariable(layout, `${base}_${part}`),
  );
}

/**
 * CRM clientName / layout `client_name` (e.g. client_name__p2_p87).
 * Prefer owner / client person name — never business legal name.
 */
function resolvePersonalClientNameValue(values: Record<string, string>): string {
  const legal = resolveContractLegalNameValue(values);
  const legalNorm = legal.toLowerCase();
  const isLegal = (raw: string) => Boolean(legalNorm && raw.toLowerCase() === legalNorm);
  const candidates = [
    values.owner1_guarantor_name,
    values.guaranty_owner1_name,
    values.guaranty_guarantor1_name,
    values.guaranty_client_name,
    values.security_guarantor,
    values.customer_name,
    values.client_name_by,
    values.client_name,
    values.addendum_client_name,
    values.seller_1_name,
  ];
  for (const raw of candidates) {
    const t = String(raw || '').trim();
    if (t && !isLegal(t)) return t;
  }
  return '';
}

const PARTY1_SS_KEYS = ['guaranty_owner1_ss', 'guaranty_guarantor1_ss'] as const;
const PARTY1_DL_KEYS = [
  'guaranty_owner1_driver_license',
  'guaranty_guarantor1_driver_license',
] as const;

const PARTY2_SS_KEYS = ['guaranty_owner2_ss', 'guaranty_guarantor2_ss'] as const;

/** Harbor contract page 19 — bank portal credentials left blank for signer. */
export const FILL_AT_SIGNING_VARIABLES = new Set([
  'ach_authorization_bank_portal_website',
  'ach_authorization_username',
  'ach_authorization_password',
  'ach_authorization_security_question1',
  'ach_authorization_security_answer1',
  'ach_authorization_security_question2',
  'ach_authorization_security_answer2',
  'ach_authorization_security_question3',
  'ach_authorization_security_answer3',
  'ach_authorization_other_infomation',
]);

/** Shared Harbor View / Clear Capital MCA — financial institution portal section. */
const HARBOR_CONTRACT_FILL_AT_SIGNING_PAGE = '19';

/** Harbor View + Clear Capital main contract (funder-scoped PDFs use the same coords). */
function usesHarborMainContractLayout(layoutKey: string | undefined): boolean {
  const key = String(layoutKey || '').trim();
  if (!key) return true;
  return isSharedMainContractLayoutKey(key);
}

/** Contract page 1 — merchant may confirm/enter phone at signing (optional, stays editable). */
export const OPTIONAL_SIGNER_EDITABLE_VARIABLES = new Set(['client_phone']);

/** Text fields that must be filled by the signer (none currently — client_phone is optional). */
export const REQUIRED_SIGNER_EDITABLE_VARIABLES = new Set<string>([]);

function isOptionalSignerEditablePlacement(placement: DocumentLayoutPlacement): boolean {
  const variable = String(placement.variable || '').trim().toLowerCase();
  return OPTIONAL_SIGNER_EDITABLE_VARIABLES.has(variable);
}

function isRequiredSignerEditablePlacement(placement: DocumentLayoutPlacement): boolean {
  const variable = String(placement.variable || '').trim().toLowerCase();
  return REQUIRED_SIGNER_EDITABLE_VARIABLES.has(variable);
}

function isFillAtSigningPlacement(placement: DocumentLayoutPlacement): boolean {
  if (placement.fillAtSigning === true) return true;
  const variable = String(placement.variable || '').trim().toLowerCase();
  return FILL_AT_SIGNING_VARIABLES.has(variable);
}

function isHarborContractFillAtSigningPlacement(
  layoutKey: string | undefined,
  placement: DocumentLayoutPlacement,
): boolean {
  if (!usesHarborMainContractLayout(layoutKey)) return false;
  // Explicit fillAtSigning works on any page (portal / credentials stay signer-editable).
  if (placement.fillAtSigning === true) return true;
  return (
    String(placement.pageNumber || '') === HARBOR_CONTRACT_FILL_AT_SIGNING_PAGE &&
    isFillAtSigningPlacement(placement)
  );
}

/** Page-19 portal credentials start blank; page-1 client phone keeps CRM prefill on the live tab. */
function clearsValueAtSend(
  layoutKey: string | undefined,
  placement: DocumentLayoutPlacement,
): boolean {
  return isHarborContractFillAtSigningPlacement(layoutKey, placement);
}

function isSignerEditableTextPlacement(
  layoutKey: string | undefined,
  placement: DocumentLayoutPlacement,
): boolean {
  // Page-1 client_phone stays signer-editable (optional) on every contract layout.
  if (isOptionalSignerEditablePlacement(placement)) return true;
  if (isRequiredSignerEditablePlacement(placement)) return true;
  if (isHarborContractFillAtSigningPlacement(layoutKey, placement)) return true;
  return false;
}

/** Portal credential fields on Harbor contract page 19, plus any explicitly required signer text. */
function isRequiredSignerTextField(
  placement: DocumentLayoutPlacement,
  layoutKey?: string,
): boolean {
  if (placement.type !== 'text') return false;
  if (isRequiredSignerEditablePlacement(placement)) return true;
  return isHarborContractFillAtSigningPlacement(layoutKey, placement);
}

/** True when a live DocuSign tab must stay unlocked at send (signer fills or confirms). */
export function isFillAtSigningTabRef(tab: {
  tabLabel?: string;
  name?: string;
  pageNumber?: string | number;
}): boolean {
  const stripUnique = (s: string) =>
    s.replace(/__p\d+_[a-z0-9]+$/i, '').replace(/__page\d+$/i, '');
  const raw = String(tab.tabLabel || tab.name || '')
    .trim()
    .toLowerCase();
  const label = stripUnique(raw);
  if (
    label &&
    (OPTIONAL_SIGNER_EDITABLE_VARIABLES.has(label) ||
      REQUIRED_SIGNER_EDITABLE_VARIABLES.has(label) ||
      FILL_AT_SIGNING_VARIABLES.has(label))
  ) {
    return true;
  }
  return false;
}

function shouldIncludeEmptyTextPlacement(
  placement: DocumentLayoutPlacement,
  layoutKey?: string,
): boolean {
  // DateSigned / date tabs must be present even when CRM has no value (DocuSign stamps on sign).
  if (placement.type === 'date') return true;
  if (placement.type !== 'text') return false;
  if (isSignerEditableTextPlacement(layoutKey, placement)) return true;
  if (isHarborContractFillAtSigningPlacement(layoutKey, placement)) return true;
  // ACH form pages 1–2: every field is a DocuSign tab even without CRM data (Katan
  // reference) so missing bank / DBA / fee values can still be filled on the form.
  if (placement.optional === true && isAchAuthorizationLayout(layoutKey)) return true;
  return includeEmptyLockedOptionalTextPlacement(placement);
}

/** Contract ACH account-holder name lines (pages 14 & 15 — owner person name). */
const WOODMERE_ACH_OWNER_NAME_VARIABLES = new Set([
  'ach_authorization_account_holder_name',
]);

/** ACH consent "Name/Title of Account Holder" lines — Owner 1 person name (not business). */
const ACH_CONSENT_OWNER_NAME_VARIABLES = [
  'ach_authorization_concent_account_holder_name',
  'ach_authorization_concent_account_holder_name_2',
] as const;

/** Business / legal names that must never land on ACH person-name lines. */
function achBusinessLikeNames(values: Record<string, string>): Set<string> {
  return new Set(
    [
      values.client_legal_name,
      values.security_business_name,
      values.business_legal_name,
      values.merchant_legal_name,
      values.legal_name,
      values.authorization_client_name,
      values.doing_business_as,
      values.authorization_application,
    ]
      .map((v) => String(v || '').trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Owner 1 person name; falls back to any owner value when it equals the legal name (sole prop). */
function resolveAchOwnerPersonName(
  values: Record<string, string>,
  businessLike: Set<string>,
): string {
  const candidates = [
    ...PARTY1_NAME_PRIORITY.map((k) => values[k]),
    values.exhibit_owner_name,
    values.customer_name,
    values.client_name_by,
    values.ach_authorization_account_holder_name,
  ]
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  return candidates.find((name) => !businessLike.has(name.toLowerCase())) || candidates[0] || '';
}

/**
 * ACH authorization name mapping (Katan reference):
 * - `authorization_client_name` / `_signer_name` → business legal name (via aliases)
 * - `authorization_client_name_print` → Owner 1 person name
 * - `ach_authorization_account_holder_name` → stored / voided-check value, else Owner 1
 * - `ach_authorization_concent_account_holder_name` → Owner 1 person name, never business
 *
 * `source` supplies owner / business keys when `target` is scoped to the ACH layout only.
 */
function normalizeAchAuthorizationNames(
  target: Record<string, string>,
  source: Record<string, string> = target,
): void {
  const merged = source === target ? target : { ...source, ...target };
  const businessLike = achBusinessLikeNames(merged);
  const owner1 = resolveAchOwnerPersonName(merged, businessLike);
  if (!owner1) return;
  const isBusinessLike = (raw: string) => businessLike.has(raw.toLowerCase());

  const printName = String(target.authorization_client_name_print || '').trim();
  if (!printName || isBusinessLike(printName)) {
    target.authorization_client_name_print = owner1;
  }
  if (!String(target.ach_authorization_account_holder_name || '').trim()) {
    target.ach_authorization_account_holder_name = owner1;
  }
  for (const key of ACH_CONSENT_OWNER_NAME_VARIABLES) {
    const current = String(target[key] || '').trim();
    if (!current || isBusinessLike(current)) target[key] = owner1;
  }
}

/** Street / city / state / ZIP groups for the ACH Account Holder address, in priority order. */
const ACH_ACCOUNT_HOLDER_ADDRESS_SOURCES = [
  [
    'ach_authorization_account_holder_address',
    'ach_authorization_account_holder_city',
    'ach_authorization_account_holder_state',
    'ach_authorization_account_holder_zip',
  ],
  ['business_address', 'business_address_city', 'business_address_state', 'business_address_zip'],
  [
    'security_business_address',
    'security_business_address_city',
    'security_business_address_state',
    'security_business_address_zip',
  ],
  ['guarantor_address', 'guarantor_address_city', 'guarantor_address_state', 'guarantor_address_zip'],
  [
    'business_address_contract',
    'business_address_contract_city',
    'business_address_contract_state',
    'business_address_contract_zip',
  ],
] as const;

/**
 * ACH Account Holder address/city/ST/ZIP: stored ACH (voided check / edit) values when the
 * street is real, else the business address, else Owner 1 home. Placeholders such as
 * "USA" are skipped instead of leaving the tab blank.
 */
function normalizeAchAccountHolderAddress(
  target: Record<string, string>,
  source: Record<string, string> = target,
): void {
  const merged = source === target ? target : { ...source, ...target };
  const read = (key: string) => String(merged[key] || '').trim();
  const primary = ACH_ACCOUNT_HOLDER_ADDRESS_SOURCES.find((group) =>
    isUsableDisclosureStreetLine(read(group[0])),
  );
  const ordered = primary
    ? [primary, ...ACH_ACCOUNT_HOLDER_ADDRESS_SOURCES.filter((group) => group !== primary)]
    : [...ACH_ACCOUNT_HOLDER_ADDRESS_SOURCES];
  const pick = (index: number, usable: (value: string) => boolean): string => {
    for (const group of ordered) {
      const value = read(group[index]);
      if (usable(value)) return value;
    }
    return '';
  };
  const resolved = [
    primary ? read(primary[0]) : '',
    pick(1, (v) => Boolean(v) && !isAddressPlaceholderToken(v)),
    pick(2, (v) => Boolean(toUsStateAbbreviation(v))),
    pick(3, (v) => /^\d{5}(-?\d{4})?$/.test(v)),
  ];
  const targetKeys = ACH_ACCOUNT_HOLDER_ADDRESS_SOURCES[0];
  resolved.forEach((value, index) => {
    if (value) target[targetKeys[index]] = value;
  });
}

function isAchAuthorizationLayout(layoutKey?: string): boolean {
  const canonical = resolveCanonicalSupplementalLayoutKey(String(layoutKey || ''));
  return canonical === 'ach_authorization' || canonical === 'ach_authorization_texas';
}

/** Scoped values for one layout; ACH layouts re-apply the owner-name mapping on the scoped map. */
function scopeValuesForLayout(
  layout: DocumentLayout,
  values: Record<string, string>,
): Record<string, string> {
  const scoped = buildScopedValuesForLayout(layout, values);
  if (isAchAuthorizationLayout(layout.key)) {
    normalizeAchAuthorizationNames(scoped, values);
    normalizeAchAccountHolderAddress(scoped, values);
  }
  return scoped;
}

const ACH_PERSON_NAME_FIELD_VARIABLES = [
  'authorization_client_name_print',
  ...ACH_CONSENT_OWNER_NAME_VARIABLES,
  ...ACH_ACCOUNT_HOLDER_ADDRESS_SOURCES[0],
] as const;

/** Layout variable for an ACH person-name prefill id (`ach_form_*`, camelCase, compact). */
function achPersonNameVariableForPrefillId(id: string): string | null {
  let key = normalizeFieldKey(id);
  for (const prefix of ['ach_form_texas_', 'ach_form_', 'contract_ach_']) {
    if (key.startsWith(prefix)) {
      key = key.slice(prefix.length);
      break;
    }
  }
  const compact = key.replace(/__instance_\d+$/, '').replace(/_/g, '');
  return (
    ACH_PERSON_NAME_FIELD_VARIABLES.find((v) => v.replace(/_/g, '') === compact) ?? null
  );
}

/**
 * Draft tab sync writes prefill ids straight onto envelope tabs (no layout build) —
 * apply the same ACH owner-name mapping so consent / printed name never carry business names.
 */
export function normalizeAchAuthorizationPrefillFields<T extends { id: string; value: string }>(
  fields: T[],
): T[] {
  if (!fields.some((f) => achPersonNameVariableForPrefillId(f.id))) return fields;
  const values = prefillFieldsToValueMap(fields);
  return fields.map((field) => {
    const variable = achPersonNameVariableForPrefillId(field.id);
    if (!variable) return field;
    const next = String(values[variable] || '').trim();
    if (!next || next.toLowerCase() === String(field.value || '').trim().toLowerCase()) {
      return field;
    }
    return { ...field, value: next };
  });
}

/** Harbor pages with explicit owner-2 signature tabs — do not auto-mirror initials here. */
const HARBOR_CONTRACT_NO_OWNER2_INITIAL_MIRROR_PAGES = new Set(['18', '19']);
/** Legacy ACH owner-2 initials-only pages (unused on Harbor self-contained MCA). */
const WOODMERE_ACH_OWNER2_INITIALS_ONLY_PAGES = new Set<string>();

function placementPageOffset(
  placement: DocumentLayoutPlacement,
  pageOffset: number,
): DocumentLayoutPlacement {
  if (!pageOffset) return placement;
  const base = Math.max(1, parseInt(String(placement.pageNumber || '1'), 10) || 1);
  return { ...placement, pageNumber: String(base + pageOffset) };
}
const PARTY2_DL_KEYS = [
  'guaranty_owner2_driver_license',
  'guaranty_guarantor2_driver_license',
] as const;

function mirrorIdentityFields(
  out: Record<string, string>,
  keys: readonly string[],
): void {
  const value = keys.map((k) => String(out[k] || '').trim()).find(Boolean);
  if (!value) return;
  for (const k of keys) {
    if (!String(out[k] || '').trim()) out[k] = value;
  }
}

/** Owner / Merchant / Guarantor / Client 1 are the same person — force one canonical name. */
function syncParty1NameFields(out: Record<string, string>): void {
  const legal = resolveContractLegalNameValue(out);
  const legalNorm = legal.toLowerCase();
  const personal = resolvePersonalClientNameValue(out);
  const canonical =
    personal ||
    PARTY1_NAME_PRIORITY.map((k) => String(out[k] || '').trim()).find((v) => {
      if (!v) return false;
      // Prefer a non-legal name when available; sole-prop may equal legal.
      if (legalNorm && v.toLowerCase() === legalNorm && personal) return false;
      return true;
    });
  if (!canonical) return;
  for (const k of PARTY1_NAME_KEYS) {
    out[k] = canonical;
  }
}

/** Owner / Merchant / Guarantor / Client 2 are the same person — force one canonical name. */
function syncParty2NameFields(out: Record<string, string>): void {
  const canonical = PARTY2_NAME_PRIORITY.map((k) => String(out[k] || '').trim()).find(
    Boolean,
  );
  if (!canonical) return;
  for (const k of PARTY2_NAME_KEYS) {
    out[k] = canonical;
  }
}

function stripParty2ValueKeys(out: Record<string, string>): void {
  for (const k of [...PARTY2_NAME_KEYS, ...PARTY2_SS_KEYS, ...PARTY2_DL_KEYS]) {
    delete out[k];
  }
  for (const key of Object.keys(out)) {
    const norm = key.toLowerCase();
    if (
      /seller_2|discover_owner2|agreement_date_owner2|owner2|owner_2|guarantor2|guarantor_2|merchant2|merchant_2|appendix_merchant2|business_name_2/.test(
        norm,
      )
    ) {
      delete out[key];
    }
  }
}

function expandPrefillValues(
  values: Record<string, string>,
  ownerCount?: number,
): Record<string, string> {
  const out = { ...values };
  // Sanitize before party sync so a legal-name `client_name` does not pollute owner slots
  // or land on client_name__p2_p87.
  {
    const personal = resolvePersonalClientNameValue(out);
    const legal = resolveContractLegalNameValue(out);
    const current = String(out.client_name || '').trim();
    const currentIsLegal =
      Boolean(legal) && current.toLowerCase() === legal.toLowerCase();
    if (personal) {
      if (!current || currentIsLegal) out.client_name = personal;
    } else if (currentIsLegal) {
      out.client_name = '';
    }
  }
  // Capture disclosure merchant business name before Owner-1 person sync overwrites client_name.
  const disclosureBusinessBeforeSync = resolveDisclosureMerchantBusinessName(out);
  syncParty1NameFields(out);
  {
    const personal = resolvePersonalClientNameValue(out);
    if (personal) out.client_name = personal;
  }
  // Before alias fill so a stale business name on ACH person lines never propagates.
  normalizeAchAuthorizationNames(out);
  normalizeAchAccountHolderAddress(out);
  mirrorIdentityFields(out, PARTY1_SS_KEYS);
  mirrorIdentityFields(out, PARTY1_DL_KEYS);
  if (ownerCount === undefined || ownerCount >= 2) {
    syncParty2NameFields(out);
    mirrorIdentityFields(out, PARTY2_SS_KEYS);
    mirrorIdentityFields(out, PARTY2_DL_KEYS);
  } else {
    stripParty2ValueKeys(out);
  }

  const todayUs = new Date().toLocaleDateString('en-US');
  const agreementDate =
    String(out.agreement_date || '').trim() ||
    String(out.signature_date || '').trim() ||
    String(out.Signature_date || '').trim() ||
    String(out.disclosure_date || '').trim() ||
    String(out.addendum_date || '').trim() ||
    todayUs;
  if (!String(out.agreement_date || '').trim()) out.agreement_date = agreementDate;
  if (!String(out.signature_date || '').trim()) out.signature_date = agreementDate;
  if (!String(out.first_payment_date || '').trim()) out.first_payment_date = agreementDate;
  if (!String(out.guarantor_email || '').trim()) {
    out.guarantor_email = String(out.client_email || '').trim();
  }
  if (!String(out.client_email || '').trim()) {
    out.client_email = String(out.guarantor_email || '').trim();
  }
  if (!String(out.owner_print_title || '').trim()) out.owner_print_title = 'OWNER';
  if (!String(out.guarantor_print_title || '').trim()) {
    out.guarantor_print_title = String(out.owner_print_title || 'OWNER').trim() || 'OWNER';
  }

  for (const [canonical, aliases] of Object.entries(PREFILL_VALUE_ALIASES)) {
    const v = String(out[canonical] || '').trim();
    if (!v) continue;
    for (const alias of aliases) {
      if (!String(out[alias] || '').trim()) out[alias] = v;
    }
  }

  // Contract PDF “$___ per ____”: DAY / WEEK (not DAILY / WEEKLY).
  for (const key of [
    'frequency',
    'paymentterms',
    'payment_terms',
    'paymentfrequency',
    'payment_frequency',
  ]) {
    const raw = String(out[key] || '').trim();
    if (!raw) continue;
    const text = raw.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
    if (text === 'day' || text === 'daily') out[key] = 'DAY';
    else if (text === 'week' || text === 'weekly') out[key] = 'WEEK';
    else if (text === 'bi week' || text === 'biweekly') out[key] = 'BI-WEEK';
    else if (text === 'month' || text === 'monthly') out[key] = 'MONTH';
  }

  /**
   * State disclosure "Funding Provided" must be offer / purchase_amount — never recipient funds.
   */
  const offerAmount =
    String(out.purchase_amount || '').trim() ||
    String(out.approved_amount || '').trim() ||
    String(out.disclosure_amount_financed || '').trim();
  if (offerAmount) {
    out.funding_provided = offerAmount;
  }
  if (!String(out.funding_provided_direct || '').trim()) {
    out.funding_provided_direct =
      String(out.disclosure_recipient_funds || '').trim() ||
      String(out.funding_provided || '').trim() ||
      offerAmount;
  }
  if (!String(out.estimated_annual_percentage_rate || '').trim()) {
    out.estimated_annual_percentage_rate = String(out.disclosure_apr || '').trim();
  }
  if (!String(out.income_lookback_months || '').trim()) {
    out.income_lookback_months = '4';
  }

  /**
   * CA / NY page-3 auto-calc (before DocuSign):
   *   recipient_funds (top) = offer amount
   *   subtotal = recipient_funds + line_1 + line_2
   *   net      = subtotal − broker_fee
   */
  {
    const hasPage3 =
      String(out.disclosure_page3_subtotal ?? '').trim() !== '' ||
      String(out.disclosure_page3_net ?? '').trim() !== '' ||
      String(out.disclosure_page3_line_1 ?? '').trim() !== '' ||
      String(out.disclosure_page3_line_2 ?? '').trim() !== '' ||
      String(out.disclosure_broker_fee ?? '').trim() !== '' ||
      String(out.disclosure_recipient_funds ?? '').trim() !== '';
    if (hasPage3) {
      const parseMoney = (raw: unknown): number => {
        const n = Number.parseFloat(String(raw ?? '').replace(/[$,%\s]/g, ''));
        return Number.isFinite(n) ? n : 0;
      };
      const formatMoney = (n: number): string =>
        (Math.round(n * 100) / 100).toFixed(2);
      if (offerAmount) {
        out.disclosure_recipient_funds = offerAmount;
      }
      const top =
        parseMoney(out.disclosure_recipient_funds) ||
        parseMoney(out.funding_provided) ||
        parseMoney(out.purchase_amount);
      const line1 = parseMoney(out.disclosure_page3_line_1);
      const line2 = parseMoney(out.disclosure_page3_line_2);
      const broker =
        parseMoney(out.disclosure_broker_fee) ||
        parseMoney(out.appendix_underwriting_fees);
      const subtotal = top + line1 + line2;
      const net = Math.max(0, subtotal - broker);
      out.disclosure_page3_subtotal = formatMoney(subtotal);
      out.disclosure_page3_net = formatMoney(net);
      if (!String(out.disclosure_page3_line_1 ?? '').trim()) {
        out.disclosure_page3_line_1 = formatMoney(line1);
      }
      if (!String(out.disclosure_page3_line_2 ?? '').trim()) {
        out.disclosure_page3_line_2 = formatMoney(line2);
      }
    }
  }

  // After party-name sync, re-seed disclosure merchant fields from business/legal name.
  const disclosureBusiness =
    disclosureBusinessBeforeSync || resolveDisclosureMerchantBusinessName(out);
  if (disclosureBusiness) {
    for (const key of [
      'disclosure_merchant_name',
      'disclosure_name',
      'recipient_name',
      'recipient_name2',
    ] as const) {
      out[key] = disclosureBusiness;
    }
    for (const key of DISCLOSURE_MERCHANT_BUSINESS_NAME_VARS) {
      out[toDisclosureScopedPrefillId(key)] = disclosureBusiness;
    }
  }

  // Seed owner date labels (and Texas ACH CRM-scoped ids) so supplemental layouts can resolve.
  const owner1DateKeys = [
    'agreement_date_owner1_p11',
    'agreement_date_owner1_p6',
    'ach_form_texas_agreement_date_owner1_p11',
    'ach_form_signature_date',
  ];
  const owner2DateKeys = [
    'agreement_date_owner2_p11',
    'agreement_date_owner2_p6',
    'ach_form_texas_agreement_date_owner2_p11',
  ];
  for (const dateKey of owner1DateKeys) {
    if (!String(out[dateKey] || '').trim()) out[dateKey] = agreementDate;
  }
  if (ownerCount === undefined || ownerCount >= 2) {
    for (const dateKey of owner2DateKeys) {
      if (!String(out[dateKey] || '').trim()) out[dateKey] = agreementDate;
    }
  }

  return out;
}

function enrichValuesFromSigners(
  values: Record<string, string>,
  signers: LayoutSignerInput[],
  ownerCount: number,
): Record<string, string> {
  const out = { ...values };
  const legalNorm = resolveContractLegalNameValue(out).toLowerCase();
  const primaryName = String(
    signers.find((s) => /receiver|client|merchant|customer/i.test(s.roleName))?.name ||
      signers.find((s) => /^owner$/i.test(s.roleName))?.name ||
      signers.find((s) => /^guarantor$/i.test(s.roleName))?.name ||
      signers[0]?.name ||
      '',
  ).trim();
  // Do not stamp business/legal name onto client_name / owner person slots.
  if (primaryName && !(legalNorm && primaryName.toLowerCase() === legalNorm)) {
    for (const k of [...PRIMARY_GUARANTOR_NAME_VARIABLES, ...PARTY1_NAME_KEYS]) {
      out[k] = primaryName;
    }
  }
  syncParty1NameFields(out);
  {
    const personal = resolvePersonalClientNameValue(out);
    if (personal) out.client_name = personal;
  }
  if (ownerCount >= 2) {
    const primaryEmail = String(
      signers.find((s) => /receiver|client|merchant|customer/i.test(s.roleName))?.email ||
        signers[0]?.email ||
        '',
    )
      .trim()
      .toLowerCase();
    const secondarySigner =
      signers.find((s) => /owner\s*2|guarantor\s*2/i.test(s.roleName)) ||
      (signers.length >= 2 ? signers[signers.length - 1] : undefined) ||
      signers.find((s) => {
        const email = String(s.email || '').trim().toLowerCase();
        return Boolean(email && email !== primaryEmail);
      });
    const secondaryName = String(secondarySigner?.name || '').trim();
    const primaryNameNorm = primaryName.toLowerCase();
    if (secondaryName && secondaryName.toLowerCase() !== primaryNameNorm) {
      for (const k of PARTY2_NAME_KEYS) {
        out[k] = secondaryName;
      }
      if (!String(out.business_name_2 || '').trim()) {
        out.business_name_2 = secondaryName;
      }
    }
    syncParty2NameFields(out);
    mirrorIdentityFields(out, PARTY2_SS_KEYS);
    mirrorIdentityFields(out, PARTY2_DL_KEYS);
  } else {
    stripParty2ValueKeys(out);
  }
  return out;
}

type DocuSignTab = Record<string, string | undefined>;

type SignerTabBuckets = {
  textTabs: DocuSignTab[];
  dateTabs: DocuSignTab[];
  signHereTabs: DocuSignTab[];
  initialHereTabs: DocuSignTab[];
  signerAttachmentTabs: DocuSignTab[];
};

function emptySignerTabBuckets(): SignerTabBuckets {
  return {
    textTabs: [],
    dateTabs: [],
    signHereTabs: [],
    initialHereTabs: [],
    signerAttachmentTabs: [],
  };
}

function resolvePrimarySignerRoleName(signers: LayoutSignerInput[]): string {
  return (
    signers.find((s) => /^signer$/i.test(s.roleName))?.roleName ||
    signers.find((s) => /receiver|client|merchant|customer/i.test(s.roleName))?.roleName ||
    signers.find((s) => /^owner$/i.test(s.roleName))?.roleName ||
    signers.find((s) => /^guarantor$/i.test(s.roleName))?.roleName ||
    signers[0]?.roleName ||
    DOCUSIGN_DEFAULT_ROLE_NAME
  );
}

function resolveSecondarySignerRoleName(signers: LayoutSignerInput[]): string {
  const primaryRole = resolvePrimarySignerRoleName(signers).toLowerCase();
  return (
    signers.find((s) => /owner\s*2/i.test(s.roleName))?.roleName ||
    signers.find((s) => /guarantor\s*2/i.test(s.roleName))?.roleName ||
    signers.find(
      (s) =>
        /^signer$/i.test(s.roleName) &&
        s.roleName.toLowerCase() !== primaryRole,
    )?.roleName ||
    signers.find((s) => s.roleName.toLowerCase() !== primaryRole)?.roleName ||
    DOCUSIGN_SECONDARY_SIGNER_ROLE_NAME
  );
}

function resolvePrimarySignerIndex(signers: LayoutSignerInput[]): number {
  const primaryRole = resolvePrimarySignerRoleName(signers).toLowerCase();
  const idx = signers.findIndex((s) => s.roleName.toLowerCase() === primaryRole);
  return idx >= 0 ? idx : 0;
}

function resolveSecondarySignerIndex(signers: LayoutSignerInput[]): number {
  const secondaryRole = resolveSecondarySignerRoleName(signers).toLowerCase();
  const idx = signers.findIndex((s) => s.roleName.toLowerCase() === secondaryRole);
  if (idx >= 0) return idx;
  return signers.length > 1 ? 1 : 0;
}

function resolvePlacementSignerIndex(
  placement: DocumentLayoutPlacement,
  signers: LayoutSignerInput[],
  counts: LayoutPartyCounts,
  layoutKey?: string,
): number {
  // Prefill text → merchant #1. DateSigned for Owner 2 routes to secondary when present.
  // Do not reuse the same tabLabel on multiple pages (DocuSign groups them → green).
  if (placement.type === 'text') {
    return resolvePrimarySignerIndex(signers);
  }
  if (placement.type === 'date') {
    if (isSecondaryParty(placement.signerParty) && counts.ownerCount >= 2) {
      return resolveSecondarySignerIndex(signers);
    }
    return resolvePrimarySignerIndex(signers);
  }

  const party = placement.signerParty;
  const page = String(placement.pageNumber || '');

  if (isSecondaryParty(party)) {
    if (counts.ownerCount >= 2) {
      if (
        layoutKey === 'contract' &&
        WOODMERE_ACH_OWNER2_INITIALS_ONLY_PAGES.has(page) &&
        placement.type !== 'initial'
      ) {
        return resolvePrimarySignerIndex(signers);
      }
      if (placement.type === 'initial') {
        return resolveSecondarySignerIndex(signers);
      }
      return resolveSecondarySignerIndex(signers);
    }
    if (placement.type === 'initial') {
      return resolvePrimarySignerIndex(signers);
    }
    return signers.length > 1 ? resolveSecondarySignerIndex(signers) : 0;
  }

  if (isPrimaryParty(party)) {
    return resolvePrimarySignerIndex(signers);
  }

  const legacy = String(placement.signerRole || '').trim();
  if (legacy && legacy.toLowerCase() !== 'signer') {
    const idx = signers.findIndex((s) => s.roleName.toLowerCase() === legacy.toLowerCase());
    if (idx >= 0) return idx;
  }

  return resolvePrimarySignerIndex(signers);
}

function isSecondaryParty(party: string | undefined): boolean {
  return party === 'secondary' || party === 'owner2' || party === 'guarantor2';
}

function isPrimaryParty(party: string | undefined): boolean {
  return (
    party === 'primary' ||
    party === 'client' ||
    party === 'owner' ||
    party === 'guarantor'
  );
}

function resolvePlacementSignerRoleName(
  placement: DocumentLayoutPlacement,
  signers: LayoutSignerInput[],
  counts: LayoutPartyCounts,
  layoutKey?: string,
): string {
  const idx = resolvePlacementSignerIndex(placement, signers, counts, layoutKey);
  return signers[idx]?.roleName || resolvePrimarySignerRoleName(signers);
}

const PRIMARY_GUARANTOR_NAME_VARIABLES = [
  'owner1_guarantor_name',
  'guaranty_owner1_name',
  'guaranty_guarantor1_name',
  'guaranty_client_name',
  'client_name',
  'addendum_client_name',
  'security_guarantor',
] as const;

function primaryGuarantorNamePresent(values: Record<string, string>): boolean {
  return PRIMARY_GUARANTOR_NAME_VARIABLES.some((k) => String(values[k] || '').trim());
}

/**
 * Mirror each Merchant #1 (primary) initial as a Merchant #2 (secondary) initial when two owners sign.
 * Applied to the main contract and every merged supplemental layout (ACH, flex addendum, etc.).
 */
function expandLayoutsWithOwner2Initials(
  layouts: DocumentLayout[],
  ownerCount: number,
): DocumentLayout[] {
  if (ownerCount < 2) return layouts;

  return layouts.map((layout) => {
    if (layout.skipOwner2InitialMirror) {
      return layout;
    }
    const extras: DocumentLayoutPlacement[] = [];
    for (const placement of layout.placements) {
      if (placement.type !== 'initial') continue;
      if (placement.when === 'owners >= 2') continue;
      if (
        layout.key === 'contract' &&
        HARBOR_CONTRACT_NO_OWNER2_INITIAL_MIRROR_PAGES.has(
          String(placement.pageNumber || ''),
        )
      ) {
        continue;
      }
      if (isSecondaryParty(placement.signerParty)) continue;
      const party = placement.signerParty;
      if (party && !isPrimaryParty(party)) continue;

      const baseX = Number(placement.x);
      const baseY = Number(placement.y);
      if (!Number.isFinite(baseX) || !Number.isFinite(baseY)) continue;

      extras.push({
        ...placement,
        id: `${placement.id}_m2init`,
        slot: `${placement.slot || placement.id}_m2init`,
        x: String(baseX + OWNER2_INITIAL_OFFSET_X),
        y: String(Math.max(0, baseY + OWNER2_INITIAL_OFFSET_Y)),
        signerParty: 'secondary',
        when: 'owners >= 2',
        sourceTabLabel: `Merchant #2 ${placement.sourceTabLabel || placement.id}`,
      });
    }
    return { ...layout, placements: [...layout.placements, ...extras] };
  });
}

const FLEX_ADDENDUM_MONEY_VARIABLES = new Set([
  'daily_payment_1',
  'daily_payment_2',
  'receivable_purchase_1',
  'receivable_purchase_2',
]);

function formatFlexAddendumMoneyUsd(value: string): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  const n = Number(trimmed.replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) return trimmed;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

const ACH_ST_TAB_LABELS = new Set([
  'ach_authorization_account_holder_state',
  'ach_authorization_account_holder_bank_state',
]);

/** Contract ACH Address/City/ST tabs — street not country, ST as 2-letter code. */
function normalizeAchContractAddressTabValue(variable: string, value: string): string {
  const key = String(variable || '').trim().toLowerCase();
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if (key === 'ach_authorization_account_holder_address') {
    return isUsableDisclosureStreetLine(trimmed) ? trimmed : '';
  }
  if (key === 'ach_authorization_account_holder_city') {
    return isAddressPlaceholderToken(trimmed) ? '' : trimmed;
  }
  if (ACH_ST_TAB_LABELS.has(key)) {
    return toUsStateAbbreviation(trimmed) || trimmed;
  }
  return trimmed;
}

function resolveTextPlacementValue(
  variable: string,
  values: Record<string, string>,
  placement?: DocumentLayoutPlacement,
  layoutKey?: string,
  layout?: DocumentLayout,
): string {
  const key = String(variable || '').trim();
  if (!key) return '';

  const formatIfMoney = (raw: string) =>
    FLEX_ADDENDUM_MONEY_VARIABLES.has(key.toLowerCase())
      ? formatFlexAddendumMoneyUsd(normalizeAchContractAddressTabValue(key, raw))
      : normalizeAchContractAddressTabValue(key, raw);

  // State disclosures use per-slot sourceTabLabel keys (funder_name_5, client_name_1).
  // Resolve those before any owner-name remapping so Woodmere funder/merchant fills work.
  if (isStateDisclosureTextPlacement(placement)) {
    const uniqueKey = String(placement?.sourceTabLabel || '').trim();
    if (uniqueKey) {
      const perPlacement = String(
        values[toDisclosureScopedPrefillId(uniqueKey)] ?? values[uniqueKey] ?? '',
      ).trim();
      if (perPlacement) return formatIfMoney(perPlacement);
    }
    const sharedScoped = String(values[toDisclosureScopedPrefillId(key)] ?? '').trim();
    if (sharedScoped) return formatIfMoney(sharedScoped);
    // Merchant-name slots: prefer business/legal name over Owner-1 person synced into client_name.
    if (DISCLOSURE_MERCHANT_BUSINESS_NAME_VARS.has(key.toLowerCase())) {
      const business = resolveDisclosureMerchantBusinessName(values);
      if (business) return formatIfMoney(business);
    }
    const sharedDirect = String(values[key] ?? '').trim();
    if (DISCLOSURE_RECIPIENT_ADDRESS_VARS.has(key.toLowerCase())) {
      const address = resolveDisclosureRecipientAddress(values);
      if (address) return formatIfMoney(address);
      return '';
    }
    if (DISCLOSURE_ESTIMATED_PAYMENT_VARS.has(key.toLowerCase())) {
      const payment = resolveDisclosureEstimatedPayment(values);
      if (payment) return formatIfMoney(payment);
    }
    if (sharedDirect) return formatIfMoney(sharedDirect);
  }

  // ACH consent Name/Title: Owner 1 person name (never business / legal name).
  if ((ACH_CONSENT_OWNER_NAME_VARIABLES as readonly string[]).includes(key.toLowerCase())) {
    const normalized = { ...values };
    normalizeAchAuthorizationNames(normalized);
    const owner = String(normalized[key.toLowerCase()] || '').trim();
    if (owner) return formatIfMoney(owner);
  }

  if (
    !isStateDisclosureTextPlacement(placement) &&
    (key.toLowerCase() === 'client_name' ||
      key.toLowerCase() === 'addendum_client_name')
  ) {
    // client_name__p2_p87 — owner/client person name only, never business legal name.
    const personal = resolvePersonalClientNameValue(values);
    if (personal) return formatIfMoney(personal);
    return '';
  }

  if (key.toLowerCase() === 'guarantor_address') {
    const fullAddress = resolveGuarantorFullAddress(values);
    if (fullAddress) return formatIfMoney(fullAddress);
  }

  if (
    key.toLowerCase() === 'business_address' &&
    shouldComposeFullAddressOnStreetTab(layout, 'business_address')
  ) {
    const fullAddress = resolveBusinessFullAddress(values);
    if (fullAddress) return formatIfMoney(fullAddress);
  }

  if (
    key.toLowerCase() === 'business_address_contract' &&
    shouldComposeFullAddressOnStreetTab(layout, 'business_address_contract')
  ) {
    const fullAddress = resolveGuarantorFullAddress(values);
    if (fullAddress) return formatIfMoney(fullAddress);
  }

  if (
    layoutKey === 'contract' &&
    (String(placement?.pageNumber || '') === '14' ||
      String(placement?.pageNumber || '') === '15') &&
    WOODMERE_ACH_OWNER_NAME_VARIABLES.has(key.toLowerCase())
  ) {
    for (const aliasKey of PARTY1_NAME_KEYS) {
      const owner1 = String(values[aliasKey] || '').trim();
      if (owner1) return owner1;
    }
  }

  const candidates = [
    key,
    key.toLowerCase(),
    CRM_ID_TO_LAYOUT_VARIABLE[key.toLowerCase()] || '',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const direct = String(values[candidate] || '').trim();
    if (direct) return formatIfMoney(direct);
    const aliases = PREFILL_VALUE_ALIASES[candidate] || PREFILL_VALUE_ALIASES[candidate.toLowerCase()];
    if (aliases) {
      for (const alias of aliases) {
        const v = String(values[alias] || '').trim();
        if (v) return formatIfMoney(v);
      }
    }
  }
  return '';
}

function placementAllowed(
  placement: DocumentLayoutPlacement,
  counts: LayoutPartyCounts,
  values: Record<string, string> = {},
  layoutKey?: string,
): boolean {
  const when = String(placement.when || '').trim();
  if (when === 'owners >= 2' && counts.ownerCount < 2) return false;
  if (when === 'guarantors >= 2' && counts.ownerCount < 2) return false;

  if (
    layoutKey === 'contract' &&
    WOODMERE_ACH_OWNER2_INITIALS_ONLY_PAGES.has(String(placement.pageNumber || '')) &&
    isSecondaryParty(placement.signerParty) &&
    (placement.type === 'signature' || placement.type === 'date')
  ) {
    return false;
  }

  if (isSecondaryParty(placement.signerParty)) {
    if (counts.ownerCount < 2) return false;
  }

  if (
    placement.type === 'signature' &&
    placement.optional &&
    isPrimaryParty(placement.signerParty) &&
    !primaryGuarantorNamePresent(values)
  ) {
    return false;
  }

  const variable = String(placement.variable || '').trim().toLowerCase();
  const label = String(
    placement.sourceTabLabel || placement.slot || placement.variable || '',
  )
    .trim()
    .toLowerCase();
  if (variable || label) {
    const owner2Token = `${variable} ${label}`;
    if (
      /seller_2|discover_owner2|agreement_date_owner2|owner2|owner_2|guarantor2|guarantor_2/.test(
        owner2Token,
      ) &&
      counts.ownerCount < 2
    ) {
      return false;
    }
    if (/merchant2|merchant_2|appendix_merchant2|business_name_2/.test(owner2Token) && counts.ownerCount < 2) {
      return false;
    }
  }

  return true;
}

function includeEmptyLockedOptionalTextPlacement(
  placement: DocumentLayoutPlacement,
): boolean {
  return (
    placement.type === 'text' &&
    placement.optional === true &&
    placement.lockedForSigner === true
  );
}

/**
 * DocuSign auto-groups tabs that share the same Data Label (tabLabel) → green sync set.
 * Value fields must stay unique (blue/independent). Prefill still resolves via `variable`/`name`.
 */
function uniquifyEnvelopeTextTabLabel(
  baseLabel: string,
  placement: DocumentLayoutPlacement,
): string {
  const base = String(baseLabel || '').trim() || 'text';
  const id = String(placement.id || '').trim();
  if (!id) {
    const page = String(placement.pageNumber || '').trim();
    return page ? `${base}__page${page}` : base;
  }
  if (base === id || base.endsWith(`_${id}`) || base.endsWith(`__${id}`)) {
    return base;
  }
  const page = String(placement.pageNumber || '').trim();
  const suffix = page ? `p${page}_${id}` : id;
  if (base.includes(suffix)) return base;
  return `${base}__${suffix}`;
}

function toTextTab(
  placement: DocumentLayoutPlacement,
  value: string,
  envelopeDocumentId: string,
  lockDataTabs = false,
  layoutKey?: string,
): DocuSignTab {
  const signerEditable = isSignerEditableTextPlacement(layoutKey, placement);
  const tabValue = clearsValueAtSend(layoutKey, placement) ? '' : value;
  const variable = String(placement.variable || '').trim();
  const displayLabel =
    getPrefillDisplayLabel(variable) ||
    String(placement.sourceTabLabel || '').trim() ||
    variable ||
    placement.slot;
  const scopedTabLabel = resolveSupplementalEnvelopeTabLabel(
    layoutKey || '',
    placement,
    variable,
  );
  const baseLabel =
    scopedTabLabel ||
    String(placement.sourceTabLabel || '').trim() ||
    displayLabel ||
    `${variable || 'text'}_${placement.id}`;
  // Unique Data Label per field so page 14/15 (etc.) do not green-link as one group.
  const tabLabel = uniquifyEnvelopeTextTabLabel(baseLabel, placement);
  const width = resolveDocuSignPrefillTabWidth({
    value: tabValue,
    height: placement.height,
    layoutWidth: placement.width,
    fontSize: placement.fontSize,
    keepLayoutWidth: keepPrefillTabLayoutWidth(layoutKey),
  });
  const wrapWidthPx = parseFloat(width) || 0;
  const wrapFontPt =
    parseFloat(String(resolveDocuSignFontSizeToken({
      fontSize: placement.fontSize || '9',
      height: placement.height,
    })).replace(/^size/i, '')) || 9;
  const wrappedValue =
    tabValue && isDocuSignWrapTextTab(placement.height) && wrapWidthPx > 0
      ? wrapDocuSignTabValue(tabValue, wrapWidthPx, wrapFontPt)
      : tabValue;
  // Page-16 ACH and page-1 client phone stay editable; other prefilled text locks at send.
  const lockTab = signerEditable ? false : lockDataTabs || Boolean(placement.lockedForSigner);
  const optionalTab = !isRequiredSignerTextField(placement, layoutKey);
  // Fill-at-signing phones use unique labels — keep name in sync so CRM post-create
  // sync cannot rematch bare `authorized_business_phone`.
  const tabName = clearsValueAtSend(layoutKey, placement)
    ? tabLabel || variable || undefined
    : variable || undefined;
  const sitOnBlank = resolveSitOnBlankTextTabMetrics(placement, layoutKey);
  const fontSize = resolveDocuSignFontSizeToken({
    fontSize: placement.fontSize || '9',
    height: sitOnBlank.height,
  });
  return applyDocuSignPrefillTabStyle(
    {
      tabLabel,
      name: tabName,
      documentId: envelopeDocumentId,
      pageNumber: placement.pageNumber,
      xPosition: placement.x,
      yPosition: sitOnBlank.y,
      ...(wrappedValue ? { value: wrappedValue } : {}),
      ...(optionalTab ? { optional: 'true' } : { required: 'true', optional: 'false' }),
      ...(lockTab ? { locked: 'true' } : {}),
      ...(placement.bold ? { bold: 'true' } : {}),
      shared: 'false',
      // Keep explicit size9 — DocuSign auto-size was shrinking short tabs to ~size7.
      disableAutoSize: 'true',
      fontSize,
      width,
      height: sitOnBlank.height,
    },
    { height: sitOnBlank.height, fontSize },
  );
}

/** Stamp layout text/date values onto the base PDF for CC email (DocuSign download is often blank). */
export async function renderFlattenedLayoutPdf(
  layout: DocumentLayout & { documentBase64: string },
  values: Record<string, string>,
  counts: LayoutPartyCounts,
): Promise<Buffer> {
  const { PDFDocument, rgb } = await import('pdf-lib');
  const pdfDoc = await PDFDocument.load(Buffer.from(layout.documentBase64, 'base64'));
  const font = await embedArialPdfFont(pdfDoc);
  const boldFont = await embedArialBoldPdfFont(pdfDoc);
  const pages = pdfDoc.getPages();
  const expanded = expandPrefillValues(values, counts.ownerCount);
  const scopedExpanded = scopeValuesForLayout(layout, expanded);

  for (const placement of layout.placements) {
    if (placement.type !== 'text' && placement.type !== 'date') continue;
    if (!placementAllowed(placement, counts, scopedExpanded, layout.key)) continue;
    if (isHarborContractFillAtSigningPlacement(layout.key, placement)) continue;
    // Keep client_phone as a live DocuSign tab (optional + writable), never burn into PDF.
    if (
      isOptionalSignerEditablePlacement(placement) ||
      isRequiredSignerEditablePlacement(placement)
    ) {
      continue;
    }
    const text = resolveTextPlacementValue(
      placement.variable || '',
      scopedExpanded,
      placement,
      layout.key,
      layout,
    );
    if (!text) continue;

    const pageIndex = Math.max(0, parseInt(String(placement.pageNumber || '1'), 10) - 1);
    const page = pages[pageIndex];
    if (!page) continue;

    const sitOnBlank = resolveSitOnBlankTextTabMetrics(placement, layout.key);
    const fontSizeToken = resolveDocuSignFontSizeToken({
      fontSize: placement.fontSize,
      height: sitOnBlank.height,
    });
    const fontSize =
      parseFloat(String(fontSizeToken).replace(/^size/i, '')) || 9;
    const { height: pageHeight } = page.getSize();
    const x = parseFloat(String(placement.x || '0')) || 0;
    const yTop = parseFloat(sitOnBlank.y) || 0;
    const y = pageHeight - yTop - fontSize;

    const maxWidth = parseFloat(
      resolveDocuSignPrefillTabWidth({
        value: text,
        height: placement.height,
        layoutWidth: placement.width,
        fontSize: placement.fontSize,
        keepLayoutWidth: keepPrefillTabLayoutWidth(layout.key),
      }),
    );
    const wrapWidthPx = Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : 0;
    const drawText =
      isDocuSignWrapTextTab(placement.height) && wrapWidthPx > 0
        ? wrapDocuSignTabValue(text, wrapWidthPx, fontSize)
        : text;
    const lines = drawText.split(/\r?\n/).filter((line) => line.length > 0);
    const lineHeight = fontSize * 1.25;
    lines.forEach((line, index) => {
      page.drawText(line, {
        x,
        y: Math.max(2, y - index * lineHeight),
        size: fontSize,
        font: placement.bold ? boldFont : font,
        color: rgb(0, 0, 0),
        maxWidth: wrapWidthPx > 0 ? wrapWidthPx : undefined,
      });
    });
  }

  return Buffer.from(
    await pdfDoc.save({ useObjectStreams: false, updateFieldAppearances: false }),
  );
}

/** State disclosure PDFs often fail DocuSign validation after pdf-lib rewrite. */
export function shouldFlattenLayoutPdf(layout: DocumentLayout): boolean {
  return !String(layout.key || '').startsWith('state_disclosure_');
}

function layoutPrefillBurnedIntoPdf(
  layoutKey: string,
  options: BuildEnvelopeFromLayoutOptions,
): boolean {
  if (options.flattenedLayoutKeys) {
    return options.flattenedLayoutKeys.has(layoutKey);
  }
  return options.skipTextDateTabs === true;
}

function toSignTab(
  placement: DocumentLayoutPlacement,
  envelopeDocumentId: string,
  layoutKey?: string,
): DocuSignTab {
  // Prefer unique source label (GUID / page-specific); never reuse one Data Label across tabs.
  const baseLabel =
    String(placement.sourceTabLabel || '').trim() ||
    placement.slot ||
    `${placement.type}_${placement.id}`;
  const scoped =
    layoutKey && !isMainContractLayoutKey(layoutKey)
      ? `${String(layoutKey).replace(/[^a-zA-Z0-9]+/g, '_')}_${baseLabel}`
      : baseLabel;
  const id = String(placement.id || '').trim();
  const tabLabel =
    id && !scoped.includes(id) ? `${scoped}__${id}` : scoped;
  const tab: DocuSignTab = {
    tabLabel,
    documentId: envelopeDocumentId,
    pageNumber: placement.pageNumber,
    xPosition: placement.x,
    yPosition: resolveTabYPosition(placement.y, layoutKey),
    optional: placement.optional ? 'true' : 'false',
    shared: 'false',
  };
  if (placement.type === 'signature') {
    tab.name = 'SignHere';
    tab.stampType = 'signature';
    tab.tabType = 'signhere';
  } else if (placement.type === 'initial') {
    tab.name = 'InitialHere';
    tab.tabType = 'initialhere';
  }
  const scale = String(placement.scaleValue || '').trim();
  if (scale) tab.scaleValue = scale;
  if (placement.width) tab.width = String(placement.width);
  if (placement.height) tab.height = String(placement.height);
  return tab;
}

function toAttachmentTab(
  placement: DocumentLayoutPlacement,
  envelopeDocumentId: string,
  layoutKey?: string,
): DocuSignTab {
  const isOptional = placement.optional !== false;
  const tab: DocuSignTab = {
    tabLabel:
      String(placement.sourceTabLabel || '').trim() ||
      placement.slot ||
      `attachment_${placement.id}`,
    documentId: envelopeDocumentId,
    pageNumber: placement.pageNumber,
    xPosition: placement.x,
    yPosition: resolveTabYPosition(placement.y, layoutKey),
    scaleValue: '1',
  };
  if (isOptional) {
    // Match DocuSign template export: optional attachments use SignerAttachmentOptional
    // with optional=true only (no required property).
    tab.name = 'SignerAttachmentOptional';
    tab.optional = 'true';
  } else {
    tab.name = 'SignerAttachment';
    tab.optional = 'false';
    tab.required = 'true';
  }
  return tab;
}

export function buildRecipientTabsByRoleForLayout(
  layout: DocumentLayout,
  envelopeDocumentId: string,
  values: Record<string, string>,
  signers: LayoutSignerInput[],
  counts: LayoutPartyCounts,
): Map<string, SignerTabBuckets> {
  const signerTabs = new Map<number, SignerTabBuckets>();
  const scopedValues = scopeValuesForLayout(layout, values);

  const ensureSigner = (signerIndex: number) => {
    if (!signerTabs.has(signerIndex)) {
      signerTabs.set(signerIndex, emptySignerTabBuckets());
    }
    return signerTabs.get(signerIndex)!;
  };

  for (const placement of layout.placements) {
    if (!placementAllowed(placement, counts, scopedValues, layout.key)) continue;

    const signerIndex = resolvePlacementSignerIndex(placement, signers, counts, layout.key);

    const bucket = ensureSigner(signerIndex);

    if (placement.type === 'text' || placement.type === 'date') {
      const variable = placement.variable || '';
      const value = resolveTextPlacementValue(
        variable,
        scopedValues,
        placement,
        layout.key,
        layout,
      );
      if (!value && !shouldIncludeEmptyTextPlacement(placement, layout.key)) continue;
      const tab = toTextTab(placement, value, envelopeDocumentId, false, layout.key);
      if (placement.type === 'date') bucket.dateTabs.push(tab);
      else bucket.textTabs.push(tab);
      continue;
    }

    if (placement.type === 'signature') {
      bucket.signHereTabs.push(toSignTab(placement, envelopeDocumentId, layout.key));
      continue;
    }

    if (placement.type === 'initial') {
      bucket.initialHereTabs.push(toSignTab(placement, envelopeDocumentId, layout.key));
      continue;
    }

    if (placement.type === 'attachment') {
      bucket.signerAttachmentTabs.push(toAttachmentTab(placement, envelopeDocumentId, layout.key));
    }
  }

  const byRole = new Map<string, SignerTabBuckets>();
  signers.forEach((s, idx) => {
    const tabs = signerTabs.get(idx);
    if (tabs) byRole.set(s.roleName, tabs);
  });
  return byRole;
}

function signerHasTabs(tabs: SignerTabBuckets): boolean {
  return (
    tabs.textTabs.length +
      tabs.dateTabs.length +
      tabs.signHereTabs.length +
      tabs.initialHereTabs.length +
      tabs.signerAttachmentTabs.length >
    0
  );
}

/**
 * Builds DocuSign envelope definition from platform layouts + PDFs.
 * Same `variable` is written to every placement that references it (multi-page prefill).
 */
export function buildEnvelopeFromLayouts(options: BuildEnvelopeFromLayoutOptions) {
  const counts: LayoutPartyCounts = {
    ownerCount: options.ownerCount ?? 1,
    guarantorCount: options.guarantorCount ?? 0,
  };
  const values = enrichValuesFromSigners(
    expandPrefillValues(options.values, counts.ownerCount),
    options.signers,
    counts.ownerCount,
  );
  const documents: Array<{ documentId: string; name: string; documentBase64: string }> =
    [];
  /** Map each layout package to envelope document id (1-based merge order). */
  const layoutKeyToEnvelopeDocId = new Map<string, string>();
  const pageOffsetByLayoutKey = options.pageOffsetByLayoutKey ?? new Map<string, number>();

  if (options.mergedDocument?.documentBase64) {
    const mergedName =
      String(options.mergedDocument.name || '').trim() ||
      options.primaryDocumentName ||
      'Contract Package';
    documents.push({
      documentId: '1',
      name: mergedName,
      documentBase64: options.mergedDocument.documentBase64,
    });
    for (const layout of options.layouts) {
      layoutKeyToEnvelopeDocId.set(layout.key, '1');
    }
  } else {
    options.layouts.forEach((layout, idx) => {
      const envelopeDocId = String(idx + 1);
      layoutKeyToEnvelopeDocId.set(layout.key, envelopeDocId);
      const base64 = (layout as DocumentLayout & { documentBase64?: string })
        .documentBase64;
      if (!base64) {
        throw new Error(
          `Layout "${layout.key}" is missing documentBase64 on the merged envelope build.`,
        );
      }
      documents.push({
        documentId: envelopeDocId,
        name:
          idx === (options.primaryLayoutIndex ?? 0) && options.primaryDocumentName
            ? options.primaryDocumentName
            : layout.document.originalFileName || layout.name,
        documentBase64: base64,
      });
    });
  }

  const signerTabs = new Map<number, SignerTabBuckets>();

  const ensureSigner = (signerIndex: number) => {
    if (!signerTabs.has(signerIndex)) {
      signerTabs.set(signerIndex, emptySignerTabBuckets());
    }
    return signerTabs.get(signerIndex)!;
  };

  const expandedLayouts = expandLayoutsWithOwner2Initials(options.layouts, counts.ownerCount);

  for (const layout of expandedLayouts) {
    const envelopeDocId = layoutKeyToEnvelopeDocId.get(layout.key) || '1';
    const pageOffset = pageOffsetByLayoutKey.get(layout.key) ?? 0;
    const scopedValues = scopeValuesForLayout(layout, values);

    for (const placement of layout.placements) {
      if (!placementAllowed(placement, counts, scopedValues, layout.key)) continue;

      const signerIndex = resolvePlacementSignerIndex(
        placement,
        options.signers,
        counts,
        layout.key,
      );

      const bucket = ensureSigner(signerIndex);
      const tabPlacement = placementPageOffset(placement, pageOffset);

      if (placement.type === 'text' || placement.type === 'date') {
        if (
          layoutPrefillBurnedIntoPdf(layout.key, options) &&
          !shouldIncludeEmptyTextPlacement(placement, layout.key)
        ) {
          continue;
        }
        const variable = placement.variable || '';
        const value = resolveTextPlacementValue(
          variable,
          scopedValues,
          placement,
          layout.key,
          layout,
        );
        if (!value && !shouldIncludeEmptyTextPlacement(placement, layout.key)) continue;
        const tab = toTextTab(tabPlacement, value, envelopeDocId, options.lockDataTabs, layout.key);
        if (placement.type === 'date') bucket.dateTabs.push(tab);
        else bucket.textTabs.push(tab);
        continue;
      }

      if (placement.type === 'signature') {
        bucket.signHereTabs.push(toSignTab(tabPlacement, envelopeDocId, layout.key));
        continue;
      }

      if (placement.type === 'initial') {
        bucket.initialHereTabs.push(toSignTab(tabPlacement, envelopeDocId, layout.key));
        continue;
      }

      if (placement.type === 'attachment') {
        bucket.signerAttachmentTabs.push(toAttachmentTab(tabPlacement, envelopeDocId, layout.key));
      }
    }
  }

  const emptyTabs = emptySignerTabBuckets;

  const mappedSigners = options.signers.map((s, idx) => {
    const tabs = signerTabs.get(idx) || emptyTabs();
    return {
      roleName: s.roleName,
      name: s.name,
      email: s.email,
      routingOrder: s.routingOrder,
      tabs,
    };
  });

  if (counts.ownerCount >= 2) {
    const secondaryIdx = resolveSecondarySignerIndex(options.signers);
    const secondaryTabs = signerTabs.get(secondaryIdx);
    const hasSecondaryRecipient = mappedSigners.some(
      (s, idx) => idx === secondaryIdx && signerHasTabs(s.tabs),
    );
    if (!hasSecondaryRecipient && secondaryTabs && signerHasTabs(secondaryTabs)) {
      const secondaryInput = options.signers[secondaryIdx];
      if (secondaryInput) {
        mappedSigners.push({
          roleName:
            secondaryInput.roleName || resolveSecondarySignerRoleName(options.signers),
          name: secondaryInput.name,
          email: secondaryInput.email,
          routingOrder: secondaryInput.routingOrder ?? 2,
          tabs: secondaryTabs,
        });
      }
    }
  }

  const signers = mappedSigners
    .filter((s) => signerHasTabs(s.tabs))
    .map((s, idx) => ({
      roleName: s.roleName,
      name: s.name,
      email: s.email,
      recipientId: String(idx + 1),
      routingOrder: String(s.routingOrder ?? idx + 1),
      tabs: s.tabs,
    }));

  return {
    status: 'created',
    documents,
    recipients: { signers },
  };
}
