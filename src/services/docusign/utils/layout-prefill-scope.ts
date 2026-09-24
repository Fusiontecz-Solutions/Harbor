import type { DocumentLayout, DocumentLayoutPlacement } from './convert-docusign-template-export';
import { isUsableDisclosureStreetLine } from '../../../utils/usStateMatch';

/** CRM storage prefix — PDF tab labels on each layout stay unchanged for value lookup. */
export const LAYOUT_CRM_PREFIX: Record<string, string> = {
  flex_addendum: 'flex_addendum_',
  pre_payment_addendum: 'pre_payment_addendum_',
  balance_transfer: 'balance_transfer_',
  case_takeover_addendum: 'case_takeover_addendum_',
  addendum_p: 'addendum_p_',
  addendum_ca: 'addendum_ca_',
  addendum_ny: 'addendum_ny_',
  addendum_va: 'addendum_va_',
  addendum_epa: 'addendum_epa_',
  addendum_epd: 'addendum_epd_',
  exhibit_a: 'exhibit_a_',
  ach_authorization: 'ach_form_',
  ach_authorization_standalone: 'ach_form_',
  ach_authorization_texas: 'ach_form_texas_',
};

/** When CRM key differs from `{prefix}{pdfVariable}`. */
export const LAYOUT_VARIABLE_CRM_KEY: Record<string, Record<string, string>> = {
  flex_addendum: {
    client_legal_name: 'flex_addendum_merchant_legal_name',
  },
  balance_transfer: {
    balance_transfer_client_legal_name: 'balance_transfer_client_legal_name',
  },
};

export const DISCLOSURE_PDF_FIELD_PREFIX = 'disclosure_pdf:';

export function toDisclosureScopedPrefillId(pdfFieldId: string): string {
  return `${DISCLOSURE_PDF_FIELD_PREFIX}${String(pdfFieldId || '').trim()}`;
}

/** Disclosure PDF slots that must show the merchant business / legal name (never owner person). */
export const DISCLOSURE_MERCHANT_BUSINESS_NAME_VARS = new Set([
  'client_name',
  'recipient_name',
  'recipient_name2',
  'disclosure_name',
  'disclosure_merchant_name',
]);

export const DISCLOSURE_RECIPIENT_ADDRESS_VARS = new Set([
  'recipient_address',
  'recipient_address1',
  'recipient_address2',
]);

export const DISCLOSURE_ESTIMATED_PAYMENT_VARS = new Set([
  'weekly_payments',
  'fordailypayments',
]);

function pickPrefillValue(values: Record<string, string>, keys: string[]): string {
  for (const key of keys) {
    const v = String(values[key] ?? '').trim();
    if (v) return v;
  }
  return '';
}

/** Full street line for disclosure recipient address — never the state name alone. */
export function resolveDisclosureRecipientAddress(values: Record<string, string>): string {
  const direct = pickPrefillValue(values, [
    toDisclosureScopedPrefillId('recipient_address'),
    toDisclosureScopedPrefillId('recipient_address2'),
    toDisclosureScopedPrefillId('recipient_address1'),
    'recipient_address',
    'recipient_address2',
    'recipient_address1',
  ]);
  if (direct && isUsableDisclosureStreetLine(direct)) return direct;

  const street = pickPrefillValue(values, [
    'business_address',
    'security_business_address',
    'ach_authorization_account_holder_address',
  ]);
  if (!isUsableDisclosureStreetLine(street)) return '';

  const composed = [
    street,
    pickPrefillValue(values, ['business_address_city', 'security_business_address_city']),
    pickPrefillValue(values, ['business_address_state', 'security_business_address_state']),
    pickPrefillValue(values, ['business_address_zip', 'security_business_address_zip']),
  ]
    .filter(Boolean)
    .join(', ');
  return composed && isUsableDisclosureStreetLine(composed) ? composed : '';
}

export function resolveDisclosureEstimatedPayment(values: Record<string, string>): string {
  return pickPrefillValue(values, [
    toDisclosureScopedPrefillId('weekly_payments'),
    toDisclosureScopedPrefillId('fordailypayments'),
    toDisclosureScopedPrefillId('estimated_payment'),
    toDisclosureScopedPrefillId('disclosure_estimated_payment'),
    'weekly_payments',
    'fordailypayments',
    'estimated_payment',
    'disclosure_estimated_payment',
    'estimated_payment_amount',
    'remittance',
    'theestimatedpayment',
  ]);
}

/**
 * Business / legal name for state disclosure merchant fields.
 * Do not use `client_name` — package sends overwrite that with Owner 1 person name.
 */
export function resolveDisclosureMerchantBusinessName(
  values: Record<string, string>,
): string {
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const v = String(values[key] ?? '').trim();
      if (v) return v;
    }
    return '';
  };
  return (
    pick(
      toDisclosureScopedPrefillId('disclosure_merchant_name'),
      toDisclosureScopedPrefillId('disclosure_name'),
      toDisclosureScopedPrefillId('client_name'),
      'disclosure_merchant_name',
      'disclosure_name',
      'client_legal_name',
      'business_legal_name',
      'security_business_name',
      'legal_name',
      'merchant_legal_name',
      'doing_business_as',
      'authorization_client_name',
      'authorization_application',
    ) || ''
  );
}

/** Map funder-specific layout keys to platform coordinate layouts. */
export function resolveCanonicalSupplementalLayoutKey(layoutKey: string): string | null {
  const k = String(layoutKey || '').trim().toLowerCase();
  if (!k) return null;
  if (k === 'flex_addendum' || k.endsWith('_flex_addendum')) return 'flex_addendum';
  if (k === 'pre_payment_addendum' || k.endsWith('_pre_payment_addendum')) {
    return 'pre_payment_addendum';
  }
  // Must run before balance_transfer — legacy key ends with `_balance_transfer`.
  if (
    k === 'case_takeover_addendum' ||
    k.endsWith('_case_takeover_addendum') ||
    k === 'case_takeover_balance_transfer' ||
    k.endsWith('_case_takeover_balance_transfer')
  ) {
    return 'case_takeover_addendum';
  }
  if (k === 'balance_transfer' || k.endsWith('_balance_transfer')) return 'balance_transfer';
  // Before addendum_p — named uploads are `funder_<id>_addendum_exhibit_a`.
  if (k === 'exhibit_a' || k.includes('exhibit_a')) return 'exhibit_a';
  if (
    k === 'addendum_epd' ||
    k.endsWith('_addendum_epd') ||
    k.includes('addendum_epd_')
  ) {
    return 'addendum_epd';
  }
  if (
    k === 'addendum_epa' ||
    k.endsWith('_addendum_epa') ||
    k.includes('addendum_epa_')
  ) {
    return 'addendum_epa';
  }
  if (
    k === 'addendum_p' ||
    k.endsWith('_addendum_p') ||
    k.endsWith('_addendum_p_refi') ||
    k.includes('addendum_p_')
  ) {
    return 'addendum_p';
  }
  if (k === 'addendum_ca' || k.endsWith('_addendum_ca') || k.includes('addendum_ca_')) {
    return 'addendum_ca';
  }
  if (k === 'addendum_ny' || k.endsWith('_addendum_ny') || k.includes('addendum_ny_')) {
    return 'addendum_ny';
  }
  if (k === 'addendum_va' || k.endsWith('_addendum_va') || k.includes('addendum_va_')) {
    return 'addendum_va';
  }
  if (
    k === 'ach_authorization' ||
    k === 'ach_authorization_standalone' ||
    k.endsWith('_ach_authorization') ||
    (k.includes('_ach_') && !k.includes('texas'))
  ) {
    return 'ach_authorization';
  }
  if (k === 'ach_authorization_texas' || k.endsWith('_ach_authorization_texas')) {
    return 'ach_authorization_texas';
  }
  return null;
}

export function isMainContractLayoutKey(layoutKey: string): boolean {
  const k = String(layoutKey || '').trim();
  if (
    k === 'contract' ||
    k === 'alliance_bridge_contract' ||
    k === 'texas_funding_group_contract'
  ) {
    return true;
  }
  if (!k.startsWith('funder_')) return false;
  return !/_flex_addendum|_pre_payment_addendum|_case_takeover_addendum|_case_takeover_balance_transfer|_balance_transfer|_ach_|_disclosure|_addendum_|_exhibit_a/.test(k);
}

export function resolveCrmKeyForLayoutVariable(layoutKey: string, pdfVariable: string): string {
  const pdfVar = String(pdfVariable || '').trim();
  const canonical = resolveCanonicalSupplementalLayoutKey(layoutKey) ?? layoutKey;
  const mapped = LAYOUT_VARIABLE_CRM_KEY[canonical]?.[pdfVar];
  if (mapped) return mapped;
  const prefix = LAYOUT_CRM_PREFIX[canonical];
  if (prefix) return `${prefix}${pdfVar}`;
  return pdfVar;
}

export function isStateDisclosureTextPlacement(placement?: DocumentLayoutPlacement): boolean {
  return Boolean(String(placement?.id || '').startsWith('sd_text_'));
}

function sameEntityName(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return !!a && !!b && norm(a) === norm(b);
}

function exhibitABusinessLegalName(values: Record<string, string>): string {
  return (
    String(values.exhibit_a_business_legal_name ?? '').trim() ||
    pickPrefillValue(values, [
      'client_legal_name',
      'legal_name',
      'business_legal_name',
      'security_business_name',
    ])
  );
}

/**
 * Exhibit A tab value: per-document value (already resolved into `current`),
 * else the contract's shared data, then print labels the PDF does not have.
 * - company_name_N → shared Exhibit A company list (Deal Review)
 * - company_entity_type_N / company_ein_N → business entity type / EIN when
 *   that row's company is the merchant business itself
 * - dba → "D/B/A …", omitted when it just repeats the legal name
 * - agreement_date → "DATE: …"
 */
function resolveExhibitAValue(
  pdfVar: string,
  current: string,
  values: Record<string, string>,
): string {
  let val = current;
  const row = /^company_(?:name|entity_type|ein)_(\d+)$/.exec(pdfVar)?.[1];
  if (!val && row) {
    if (pdfVar.startsWith('company_name_')) {
      val = pickPrefillValue(values, [`exhibit_a_value_${row}`, `exhibit_company_name_${row}`]);
    } else {
      const company = pickPrefillValue(values, [
        `exhibit_a_company_name_${row}`,
        `exhibit_a_value_${row}`,
        `exhibit_company_name_${row}`,
      ]);
      if (sameEntityName(company, exhibitABusinessLegalName(values))) {
        val = pdfVar.startsWith('company_ein_')
          ? pickPrefillValue(values, ['federal_tax_id_EIN', 'federal_tax_id_ein', 'ein'])
          : pickPrefillValue(values, ['entity_type', 'business_entity_type']);
      }
    }
  }
  if (!val && pdfVar === 'business_legal_name') {
    val = exhibitABusinessLegalName(values);
  }
  if (pdfVar === 'dba') {
    if (!val) val = pickPrefillValue(values, ['doing_business_as']);
    if (!val || sameEntityName(val, exhibitABusinessLegalName(values))) return '';
    return /^d\/?b\/?a\b/i.test(val) ? val : `D/B/A ${val}`;
  }
  if (pdfVar === 'agreement_date' && val) {
    return /^date\b/i.test(val) ? val : `DATE: ${val}`;
  }
  return val;
}

/** Build values for one layout only — prevents cross-document tab bleed. */
export function buildScopedValuesForLayout(
  layout: DocumentLayout,
  globalValues: Record<string, string>,
): Record<string, string> {
  const layoutKey = String(layout.key || '').trim();
  if (isMainContractLayoutKey(layoutKey)) {
    return { ...globalValues };
  }

  const canonicalKey = resolveCanonicalSupplementalLayoutKey(layoutKey) ?? layoutKey;
  const prefix = LAYOUT_CRM_PREFIX[canonicalKey];
  const out: Record<string, string> = {};

  for (const placement of layout.placements) {
    if (placement.type !== 'text' && placement.type !== 'date') continue;
    const pdfVar = String(placement.variable || '').trim();
    if (!pdfVar) continue;

    if (isStateDisclosureTextPlacement(placement)) {
      // Individual data labels use unique sourceTabLabel (e.g. funder_name_5) so
      // repeated PDF slots stay independent in DocuSign. Prefer that value, but
      // always also expose the shared pdfVar so envelope value lookup works.
      const uniqueKey = String(placement.sourceTabLabel || '').trim();
      const perPlacement = uniqueKey
        ? String(globalValues[toDisclosureScopedPrefillId(uniqueKey)] ?? '').trim()
        : '';
      const scoped = String(globalValues[toDisclosureScopedPrefillId(pdfVar)] ?? '').trim();
      const pdfVarNorm = pdfVar.toLowerCase();
      // Prefer business/legal name over package-synced Owner 1 person name on client_name.
      const businessName = DISCLOSURE_MERCHANT_BUSINESS_NAME_VARS.has(pdfVarNorm)
        ? resolveDisclosureMerchantBusinessName(globalValues)
        : '';
      const composedAddress = DISCLOSURE_RECIPIENT_ADDRESS_VARS.has(pdfVarNorm)
        ? resolveDisclosureRecipientAddress(globalValues)
        : '';
      const estimatedPayment = DISCLOSURE_ESTIMATED_PAYMENT_VARS.has(pdfVarNorm)
        ? resolveDisclosureEstimatedPayment(globalValues)
        : '';
      const legacy = String(globalValues[pdfVar] ?? '').trim();
      const raw = perPlacement || scoped || legacy;
      const rawOk =
        raw &&
        !(DISCLOSURE_RECIPIENT_ADDRESS_VARS.has(pdfVarNorm) && !isUsableDisclosureStreetLine(raw));
      const val = (rawOk ? raw : '') || composedAddress || estimatedPayment || businessName;
      if (val) {
        if (uniqueKey) out[uniqueKey] = val;
        out[pdfVar] = val;
      }
      continue;
    }

    if (prefix) {
      const crmKey = resolveCrmKeyForLayoutVariable(canonicalKey, pdfVar);
      let val = String(globalValues[crmKey] ?? '').trim();
      // Case Takeover funder name must stay document-scoped. Shared `funder_name` is
      // forced to platform disclosure "Woodmere" when a state disclosure is merged —
      // same pattern as Flex/BT using their own CRM keys instead of bare funder_name.
      const skipSharedFunderNameFallback =
        canonicalKey === 'case_takeover_addendum' && pdfVar === 'funder_name';
      if (!val && !skipSharedFunderNameFallback) {
        val = String(globalValues[pdfVar] ?? '').trim();
      }
      if (
        !val &&
        (placement.type === 'date' ||
          /^(agreement_date|signature_date)/i.test(pdfVar))
      ) {
        val =
          String(globalValues.agreement_date ?? '').trim() ||
          String(globalValues.signature_date ?? '').trim() ||
          String(globalValues.Signature_date ?? '').trim() ||
          String(globalValues.disclosure_date ?? '').trim() ||
          String(globalValues.addendum_date ?? '').trim();
      }
      if (
        !val &&
        canonicalKey === 'flex_addendum' &&
        pdfVar === 'business_name_2'
      ) {
        for (const fallbackKey of [
          'business_name_2',
          'merchant2_name',
          'owner2_guarantor_name',
          'guaranty_owner2_name',
          'guaranty_guarantor2_name',
        ]) {
          const candidate = String(globalValues[fallbackKey] ?? '').trim();
          if (candidate) {
            val = candidate;
            break;
          }
        }
      }
      if (canonicalKey === 'exhibit_a') {
        val = resolveExhibitAValue(pdfVar, val, globalValues);
      }
      if (val) out[pdfVar] = val;
      continue;
    }

    const disclosureScoped = String(
      globalValues[toDisclosureScopedPrefillId(pdfVar)] ?? '',
    ).trim();
    const direct = String(globalValues[pdfVar] ?? '').trim();
    const val = disclosureScoped || direct;
    if (val) out[pdfVar] = val;
  }

  return out;
}

/**
 * Unique DocuSign tab label for supplemental layouts (avoids shared-tab sync with contract).
 * Prefer CRM-scoped id so editing one document's tab never rewrites another document.
 */
export function resolveSupplementalEnvelopeTabLabel(
  layoutKey: string,
  placement: DocumentLayoutPlacement,
  pdfVariable: string,
): string | null {
  const layout = String(layoutKey || '').trim();
  if (isMainContractLayoutKey(layout)) {
    // Main contract: keep explicit source labels, but uniquify footer clone.
    const src = String(placement.sourceTabLabel || '').trim();
    if (src) return src;
    return null;
  }

  if (isStateDisclosureTextPlacement(placement)) {
    const unique = String(placement.sourceTabLabel || '').trim();
    if (unique) return `disclosure_${unique}`;
    const pdfVar = String(pdfVariable || '').trim();
    return pdfVar ? `disclosure_${pdfVar}` : null;
  }

  const canonical = resolveCanonicalSupplementalLayoutKey(layout);
  if (!canonical || !LAYOUT_CRM_PREFIX[canonical]) {
    const pdfVar = String(pdfVariable || '').trim();
    if (!pdfVar) return null;
    // State disclosures / other supplementals without a CRM prefix still need unique labels.
    const token = layout.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'doc';
    return `${token}_${pdfVar}`;
  }
  const pdfVar = String(pdfVariable || '').trim();
  if (!pdfVar) return null;
  return resolveCrmKeyForLayoutVariable(canonical, pdfVar);
}
