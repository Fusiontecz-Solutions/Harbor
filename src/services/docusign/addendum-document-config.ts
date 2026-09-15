import { isClearCapitalFunderName } from './utils/clear-capital-contract-layout';

/**
 * Addendum PDF tab coordinates for DocuSign merged envelopes.
 *
 * Harbor View Capital is the source of truth (same sit-on-blank mapping as
 * `ADDENDUM_P` / CA / NY / VA). Clear Capital reuses those coords; CA page 3
 * and VA page 2 only shift because the printed funder name is shorter.
 *
 * Measured from Harbor View Capital + Clear Capital addendum PDFs
 * (letter 612×792, top-left origin). Use `resolveAddendumPdfVariant` when
 * building layouts so Clear Capital gets the guarantee-page offsets.
 *
 * `tabLabel` values are unscoped PDF variables — CRM prefill ids are
 * `{scope}{tabLabel}` via `layout-prefill-scope.ts` (e.g. `addendum_p_addendum_dated`).
 *
 * Field → value mapping follows the disclosures/addendums setup guide:
 * - Addendum P (REFI): dated/agreement=today, merchant blank=business name,
 *   pay up to=REFI balance, agreement to=label name, print name/title=merchant/OWNER
 * - Addendum CA / NY / VA: agreement dated=today, merchant blank=business name,
 *   CA APR %=APR, print name/title=merchant/OWNER (repeat on later pages)
 */

export type AddendumDocumentTabParty = 'primary' | 'secondary';

/** PDF geometry variant — guarantee pages differ between these funders. */
export type AddendumPdfVariant = 'harbor_view' | 'clear_capital';

export interface AddendumDocumentFieldConfig {
  documentId: string;
  pageNumber: string;
  signHere: {
    x: string;
    y: string;
    pageNumber?: string;
    signerParty?: AddendumDocumentTabParty;
  }[];
  dateTabs: {
    x: string;
    y: string;
    pageNumber?: string;
    tabLabel?: string;
    signerParty?: AddendumDocumentTabParty;
  }[];
  textTabs: {
    tabLabel: string;
    x: string;
    y: string;
    pageNumber?: string;
    width?: string;
    height?: string;
    optional?: boolean;
    lockedForSigner?: boolean;
  }[];
  initialHereTabs?: { x: string; y: string; pageNumber?: string }[];
}

/**
 * Sit-on-blank (same visual as ACH Account Holder fields):
 * measured underscore y is the printed line. DocuSign yPosition is the TOP
 * of a 14px tab — lift so the bottom edge *touches* the blank from above
 * instead of sitting on / cutting through the line and the labels under it.
 */
const ADDENDUM_BLANK_UPLIFT_PX = 8;
/**
 * SignHere extra lift aligns the ~22px Sign box bottom with the 14px
 * Print Name / Print Title tabs on the same underscore.
 */
const ADDENDUM_SIGN_HERE_EXTRA_UPLIFT_PX = 8;

const sitOnBlankY = (y: number, extraUplift = 0): string =>
  String(Math.max(0, Math.round(y) - ADDENDUM_BLANK_UPLIFT_PX - extraUplift));

const lockedText = (
  tabLabel: string,
  x: number,
  y: number,
  opts?: { pageNumber?: string; width?: number; height?: number; optional?: boolean },
): AddendumDocumentFieldConfig['textTabs'][number] => ({
  tabLabel,
  x: String(Math.round(x)),
  y: sitOnBlankY(y),
  pageNumber: opts?.pageNumber,
  width: opts?.width != null ? String(Math.round(opts.width)) : undefined,
  height: opts?.height != null ? String(Math.round(opts.height)) : '14',
  optional: opts?.optional === true,
  lockedForSigner: true,
});

/**
 * Paragraph underscores (dates / merchant / APR in the sentence).
 * DocuSign y is the TOP of the tab. Lift so the baseline sits on the blank
 * (touching from above) without covering the words on the same line.
 */
const ADDENDUM_INLINE_UPLIFT_PX = 8;

const lockedInlineText = (
  tabLabel: string,
  x: number,
  y: number,
  opts?: { pageNumber?: string; width?: number; height?: number; optional?: boolean },
): AddendumDocumentFieldConfig['textTabs'][number] => ({
  tabLabel,
  x: String(Math.round(x)),
  y: String(Math.max(0, Math.round(y) - ADDENDUM_INLINE_UPLIFT_PX)),
  pageNumber: opts?.pageNumber,
  width: opts?.width != null ? String(Math.round(opts.width)) : undefined,
  height: opts?.height != null ? String(Math.round(opts.height)) : '11',
  optional: opts?.optional === true,
  lockedForSigner: true,
});

const signHereTab = (
  x: number,
  y: number,
  opts?: { pageNumber?: string; signerParty?: AddendumDocumentTabParty },
): AddendumDocumentFieldConfig['signHere'][number] => ({
  x: String(Math.round(x)),
  y: sitOnBlankY(y, ADDENDUM_SIGN_HERE_EXTRA_UPLIFT_PX),
  pageNumber: opts?.pageNumber,
  signerParty: opts?.signerParty,
});

const ADDENDUM_P_SIGNATURE_TEXT: AddendumDocumentFieldConfig['textTabs'] = [
  lockedText('print_name', 93, 529, { width: 140 }),
  lockedText('print_title', 243, 529, { width: 140 }),
];

/** Addendum P (REFI) — Harbor View: merchant blank on the line above ("Merchant"). */
const ADDENDUM_P_HARBOR_VIEW: AddendumDocumentFieldConfig = {
  documentId: '1',
  pageNumber: '1',
  textTabs: [
    lockedInlineText('addendum_dated', 271, 132, { width: 120 }),
    lockedInlineText('agreement_dated', 357, 160, { width: 160 }),
    lockedInlineText('funder_and_business_name', 72, 214, { width: 430 }),
    lockedInlineText('pay_up_to_amount', 343, 242, { width: 107 }),
    lockedInlineText('agreement_to_label_name', 72, 298, { width: 347 }),
    ...ADDENDUM_P_SIGNATURE_TEXT,
  ],
  dateTabs: [],
  signHere: [signHereTab(394, 529)],
};

/**
 * Addendum P — Clear Capital. Opening-sentence blanks use inline tabs (the 8px
 * ACH lift floats them into the line above). Merchant sits on the long
 * underscore above ("Merchant"), not on the CLEAR CAPITAL line.
 */
const ADDENDUM_P_CLEAR_CAPITAL: AddendumDocumentFieldConfig = {
  documentId: '1',
  pageNumber: '1',
  textTabs: [
    lockedInlineText('addendum_dated', 271, 132, { width: 120 }),
    lockedInlineText('agreement_dated', 357, 160, { width: 160 }),
    lockedInlineText('funder_and_business_name', 72, 214, { width: 430 }),
    lockedInlineText('pay_up_to_amount', 343, 242, { width: 107 }),
    lockedInlineText('agreement_to_label_name', 72, 298, { width: 347 }),
    ...ADDENDUM_P_SIGNATURE_TEXT,
  ],
  dateTabs: [],
  signHere: [signHereTab(394, 529)],
};

const ADDENDUM_NY_SIGNATURE_TEXT: AddendumDocumentFieldConfig['textTabs'] = [
  lockedText('print_name', 93, 479, { width: 140 }),
  lockedText('print_title', 243, 479, { width: 140 }),
];

/** Addendum NY — Harbor View: merchant blank on the wrapped line. */
const ADDENDUM_NY_HARBOR_VIEW: AddendumDocumentFieldConfig = {
  documentId: '1',
  pageNumber: '1',
  textTabs: [
    lockedInlineText('agreement_dated', 254, 132, { width: 120 }),
    lockedInlineText('agreement_dated_2', 308, 145, { width: 180 }),
    lockedInlineText('funder_and_business_name', 72, 173, { width: 430 }),
    ...ADDENDUM_NY_SIGNATURE_TEXT,
  ],
  dateTabs: [],
  signHere: [signHereTab(394, 479)],
};

/** Addendum NY — Clear Capital: merchant blank on the line under FUNDER, not on CLEAR CAPITAL. */
const ADDENDUM_NY_CLEAR_CAPITAL: AddendumDocumentFieldConfig = {
  documentId: '1',
  pageNumber: '1',
  textTabs: [
    lockedInlineText('agreement_dated', 254, 132, { width: 120 }),
    lockedInlineText('agreement_dated_2', 308, 145, { width: 180 }),
    lockedInlineText('funder_and_business_name', 72, 173, { width: 430 }),
    ...ADDENDUM_NY_SIGNATURE_TEXT,
  ],
  dateTabs: [],
  signHere: [signHereTab(394, 479)],
};

/** Shared CA pages 1–2 dates / APR / signatures (both funder PDFs). */
const ADDENDUM_CA_PAGES_1_2_SHARED: AddendumDocumentFieldConfig['textTabs'] = [
  lockedInlineText('agreement_dated', 254, 145, { width: 120 }),
  lockedInlineText('agreement_dated_2', 308, 159, { width: 180 }),
  lockedInlineText('agreement_apr_percent', 167, 584, { width: 48 }),
  lockedText('print_name', 93, 177, { pageNumber: '2', width: 140 }),
  lockedText('print_title', 243, 177, { pageNumber: '2', width: 140 }),
];

/** Harbor View CA — page 1 merchant wraps; guarantee page merchant on next line. */
const ADDENDUM_CA_HARBOR_VIEW: AddendumDocumentFieldConfig = {
  documentId: '1',
  pageNumber: '1',
  textTabs: [
    ...ADDENDUM_CA_PAGES_1_2_SHARED,
    lockedInlineText('funder_and_business_name', 72, 187, { width: 430 }),
    lockedText('agreement_dated_page3', 254, 142, { pageNumber: '3', width: 120 }),
    lockedText('agreement_dated_page3b', 110, 156, { pageNumber: '3', width: 120 }),
    lockedText('agreement_dated_page3', 199, 170, { pageNumber: '3', width: 180 }),
    lockedText('funder_and_business_name_page3', 72, 198, {
      pageNumber: '3',
      width: 340,
    }),
    lockedText('print_name_page3', 93, 497, { pageNumber: '3', width: 140 }),
    lockedText('print_title_page3', 243, 497, { pageNumber: '3', width: 140 }),
  ],
  dateTabs: [],
  signHere: [
    signHereTab(394, 177, { pageNumber: '2' }),
    signHereTab(394, 497, { pageNumber: '3' }),
    signHereTab(394, 607, { pageNumber: '3', signerParty: 'secondary' }),
  ],
};

/** Clear Capital CA — merchant blank continues on the funder line (page 1 and p3). */
const ADDENDUM_CA_CLEAR_CAPITAL: AddendumDocumentFieldConfig = {
  documentId: '1',
  pageNumber: '1',
  textTabs: [
    ...ADDENDUM_CA_PAGES_1_2_SHARED,
    lockedInlineText('funder_and_business_name', 72, 184, { width: 430 }),
    lockedText('agreement_dated_page3', 254, 142, { pageNumber: '3', width: 120 }),
    lockedText('agreement_dated_page3b', 110, 156, { pageNumber: '3', width: 120 }),
    lockedText('agreement_dated_page3', 196, 170, { pageNumber: '3', width: 180 }),
    lockedText('funder_and_business_name_page3', 200, 184, {
      pageNumber: '3',
      width: 340,
    }),
    lockedText('print_name_page3', 93, 483, { pageNumber: '3', width: 140 }),
    lockedText('print_title_page3', 243, 483, { pageNumber: '3', width: 140 }),
  ],
  dateTabs: [],
  signHere: [
    signHereTab(394, 177, { pageNumber: '2' }),
    signHereTab(394, 483, { pageNumber: '3' }),
    signHereTab(394, 593, { pageNumber: '3', signerParty: 'secondary' }),
  ],
};

const ADDENDUM_VA_PAGE_1_SHARED: AddendumDocumentFieldConfig['textTabs'] = [
  lockedText('agreement_dated', 254, 129, { width: 120 }),
  lockedText('agreement_dated_2', 308, 142, { width: 180 }),
  lockedText('print_name', 93, 557, { width: 140 }),
  lockedText('print_title', 243, 557, { width: 140 }),
];

/** Harbor View VA — merchant blank on the wrapped line. */
const ADDENDUM_VA_HARBOR_VIEW: AddendumDocumentFieldConfig = {
  documentId: '1',
  pageNumber: '1',
  textTabs: [
    ...ADDENDUM_VA_PAGE_1_SHARED,
    lockedText('funder_and_business_name', 72, 170, { width: 340 }),
    lockedText('agreement_dated_page2', 254, 129, { pageNumber: '2', width: 120 }),
    lockedText('agreement_dated_page2b', 110, 142, { pageNumber: '2', width: 120 }),
    lockedText('agreement_dated_page2', 199, 156, { pageNumber: '2', width: 180 }),
    lockedText('funder_and_business_name_page2', 72, 184, {
      pageNumber: '2',
      width: 340,
    }),
    lockedText('print_name_page2', 93, 557, { pageNumber: '2', width: 140 }),
    lockedText('print_title_page2', 243, 557, { pageNumber: '2', width: 140 }),
  ],
  dateTabs: [],
  signHere: [
    signHereTab(394, 557),
    signHereTab(394, 557, { pageNumber: '2' }),
    signHereTab(394, 667, { pageNumber: '2', signerParty: 'secondary' }),
  ],
};

/** Clear Capital VA — page-1 opening blanks sit in the sentence (not ACH-style). */
const ADDENDUM_VA_CLEAR_CAPITAL: AddendumDocumentFieldConfig = {
  documentId: '1',
  pageNumber: '1',
  textTabs: [
    // "This is an Addendum dated ________" — after "dated", on the first line.
    lockedInlineText('agreement_dated', 272, 132, { width: 108 }),
    // "Agreement (\u201cAgreement\u201d) dated ________ by and"
    lockedInlineText('agreement_dated_2', 318, 146, { width: 140 }),
    // Long merchant underscore on the line under CLEAR CAPITAL ("FUNDER") and
    lockedInlineText('funder_and_business_name', 72, 174, { width: 430 }),
    lockedText('print_name', 93, 557, { width: 140 }),
    lockedText('print_title', 243, 557, { width: 140 }),
    lockedInlineText('agreement_dated_page2', 254, 129, { pageNumber: '2', width: 120 }),
    lockedInlineText('agreement_dated_page2b', 110, 142, { pageNumber: '2', width: 120 }),
    lockedInlineText('agreement_dated_page2', 196, 156, { pageNumber: '2', width: 180 }),
    lockedInlineText('funder_and_business_name_page2', 200, 170, {
      pageNumber: '2',
      width: 340,
    }),
    lockedText('print_name_page2', 93, 543, { pageNumber: '2', width: 140 }),
    lockedText('print_title_page2', 243, 543, { pageNumber: '2', width: 140 }),
  ],
  dateTabs: [],
  signHere: [
    signHereTab(394, 557),
    signHereTab(394, 543, { pageNumber: '2' }),
    signHereTab(394, 653, { pageNumber: '2', signerParty: 'secondary' }),
  ],
};

/**
 * EPA / EPD Pre-Payment Addendum — measured from
 * `EPD- ADDENDUM.pdf` / `EPD- ADDENDUM Cleard.pdf` (letter 612×792).
 * Both funder PDFs share the same geometry (7EVEN CAPITAL is white-inked).
 *
 * Opening line: date blank after "dated" (x 292–363), funder over "7EVEN CAPITAL".
 * Signature block: By: line (x=91, y=430.2 w=235), Name / Title / Date labels.
 */
const ADDENDUM_EPA_HARBOR_VIEW: AddendumDocumentFieldConfig = {
  documentId: '1',
  pageNumber: '1',
  textTabs: [
    lockedInlineText('agreement_dated', 292, 165, { width: 68 }),
    lockedInlineText('funder_name', 410, 167, { width: 130 }),
    lockedText('print_name', 110, 449, { width: 216 }),
    lockedText('signature_date', 100, 511, { width: 140 }),
  ],
  dateTabs: [],
  signHere: [signHereTab(91, 415)],
};

const ADDENDUM_EPA_CLEAR_CAPITAL: AddendumDocumentFieldConfig = {
  ...ADDENDUM_EPA_HARBOR_VIEW,
};

export const ADDENDUM_DOCUMENT_CONFIG: Record<string, AddendumDocumentFieldConfig> = {
  addendum_p: ADDENDUM_P_HARBOR_VIEW,
  addendum_ca: ADDENDUM_CA_HARBOR_VIEW,
  addendum_ny: ADDENDUM_NY_HARBOR_VIEW,
  addendum_va: ADDENDUM_VA_HARBOR_VIEW,
  addendum_epa: ADDENDUM_EPA_HARBOR_VIEW,
  addendum_p_harbor_view: ADDENDUM_P_HARBOR_VIEW,
  addendum_ny_harbor_view: ADDENDUM_NY_HARBOR_VIEW,
  addendum_ca_harbor_view: ADDENDUM_CA_HARBOR_VIEW,
  addendum_va_harbor_view: ADDENDUM_VA_HARBOR_VIEW,
  addendum_epa_harbor_view: ADDENDUM_EPA_HARBOR_VIEW,
  addendum_p_clear_capital: ADDENDUM_P_CLEAR_CAPITAL,
  addendum_ny_clear_capital: ADDENDUM_NY_CLEAR_CAPITAL,
  addendum_ca_clear_capital: ADDENDUM_CA_CLEAR_CAPITAL,
  addendum_va_clear_capital: ADDENDUM_VA_CLEAR_CAPITAL,
  addendum_epa_clear_capital: ADDENDUM_EPA_CLEAR_CAPITAL,
  // Legacy guarantor multi-entity form (kept for BoldSign / older paths).
  guarantorAddendum: {
    documentId: '1',
    pageNumber: '1',
    signHere: [
      { x: '118', y: '297', pageNumber: '1' },
      { x: '134', y: '460', pageNumber: '1' },
      { x: '118', y: '624', pageNumber: '1' },
    ],
    dateTabs: [
      { x: '272', y: '105', pageNumber: '1' },
      { x: '188', y: '117', pageNumber: '1' },
    ],
    textTabs: [
      { tabLabel: 'merchantBusinessName1', x: '205', y: '209', pageNumber: '1' },
      { tabLabel: 'dba1', x: '115', y: '229', pageNumber: '1' },
      { tabLabel: 'typeOfEntity1', x: '156', y: '245', pageNumber: '1' },
      { tabLabel: 'merchantBusinessEmail1', x: '169', y: '264', pageNumber: '4' },
      { tabLabel: 'einNumber1', x: '433', y: '244', pageNumber: '1' },
      { tabLabel: 'state1', x: '431', y: '265', pageNumber: '1' },
      { tabLabel: 'city1', x: '322', y: '267', pageNumber: '1' },
      { tabLabel: 'zip1', x: '492', y: '265', pageNumber: '1' },
      { tabLabel: 'merchantBusinessName2', x: '209', y: '376', pageNumber: '1' },
      { tabLabel: 'dba2', x: '124', y: '394', pageNumber: '1' },
      { tabLabel: 'typeOfEntity2', x: '159', y: '414', pageNumber: '1' },
      { tabLabel: 'merchantBusinessEmail2', x: '169', y: '428', pageNumber: '4' },
      { tabLabel: 'einNumber2', x: '438', y: '411', pageNumber: '1' },
      { tabLabel: 'state2', x: '430', y: '430', pageNumber: '1' },
      { tabLabel: 'city2', x: '324', y: '431', pageNumber: '1' },
      { tabLabel: 'zip2', x: '488', y: '431', pageNumber: '1' },
      { tabLabel: 'merchantBusinessName3', x: '212', y: '541', pageNumber: '1' },
      { tabLabel: 'dba3', x: '121', y: '561', pageNumber: '1' },
      { tabLabel: 'typeOfEntity3', x: '162', y: '579', pageNumber: '1' },
      { tabLabel: 'merchantBusinessEmail3', x: '169', y: '597', pageNumber: '4' },
      { tabLabel: 'einNumber3', x: '452', y: '578', pageNumber: '1' },
      { tabLabel: 'state3', x: '432', y: '597', pageNumber: '1' },
      { tabLabel: 'city3', x: '325', y: '599', pageNumber: '1' },
      { tabLabel: 'zip3', x: '496', y: '598', pageNumber: '1' },
      { tabLabel: 'merchantBusinessName1', x: '131', y: '328', pageNumber: '1' },
      { tabLabel: 'merchantBusinessName2', x: '129', y: '496', pageNumber: '1' },
      { tabLabel: 'merchantBusinessName3', x: '126', y: '656', pageNumber: '1' },
    ],
  },
};

export const ADDENDUM_LAYOUT_DISPLAY_NAMES: Record<string, string> = {
  addendum_p: 'Addendum P (REFI)',
  addendum_ca: 'Addendum CA',
  addendum_ny: 'Addendum NY',
  addendum_va: 'Addendum VA',
  addendum_epa: 'EPA Addendum',
};

const ADDENDUM_CANONICAL_KEYS = [
  'addendum_p',
  'addendum_ca',
  'addendum_ny',
  'addendum_va',
  'addendum_epa',
] as const;
export type CanonicalAddendumLayoutKey = (typeof ADDENDUM_CANONICAL_KEYS)[number];

function haystackLooksLikeClearCapital(value?: string | null): boolean {
  const hay = String(value || '').toLowerCase();
  if (!hay) return false;
  return (
    isClearCapitalFunderName(value) ||
    hay.includes('clear_capital') ||
    hay.includes('clear-capital') ||
    hay.includes('clear capital') ||
    /addendum[^a-z0-9]+(?:ca|va|ny|p)[^a-z0-9]+clear/.test(hay) ||
    /(?:^|_)clear_capital(?:_|$)/.test(hay)
  );
}

/**
 * Detect which addendum PDF geometry to use.
 * Clear Capital guarantee pages shift blanks ~14–28px vs Harbor View.
 * Detection matches the main-contract helper (`isClearCapitalFunderName`) so
 * "Clear" / "CLEAR CAPITAL" funder rows pick the same variant.
 */
export function resolveAddendumPdfVariant(hints?: {
  name?: string | null;
  pdfUrl?: string | null;
  funderName?: string | null;
  fileName?: string | null;
  layoutKey?: string | null;
}): AddendumPdfVariant {
  const parts = [
    hints?.funderName,
    hints?.name,
    hints?.fileName,
    hints?.pdfUrl,
    hints?.layoutKey,
  ];
  if (parts.some((v) => haystackLooksLikeClearCapital(v))) {
    return 'clear_capital';
  }
  return 'harbor_view';
}

/** Map funder / variant keys (`funder_<id>_addendum_ca`, `addendum_ca_clear_capital`) to P/CA/NY/VA. */
export function canonicalAddendumLayoutKey(
  layoutKeyOrType?: string | null,
): CanonicalAddendumLayoutKey | null {
  const raw = String(layoutKeyOrType || '')
    .trim()
    .toLowerCase();
  if (!raw) return null;

  if (
    raw === 'addendum_epa' ||
    raw === 'addendum_epa_harbor_view' ||
    raw === 'addendum_epa_clear_capital' ||
    raw.endsWith('_addendum_epa') ||
    raw.includes('addendum_epa_')
  ) {
    return 'addendum_epa';
  }
  if (
    raw === 'addendum_p' ||
    raw === 'addendum_p_harbor_view' ||
    raw === 'addendum_p_clear_capital' ||
    raw.endsWith('_addendum_p') ||
    raw.endsWith('_addendum_p_refi') ||
    raw.includes('addendum_p_')
  ) {
    return 'addendum_p';
  }
  if (
    raw === 'addendum_ca' ||
    raw === 'addendum_ca_harbor_view' ||
    raw === 'addendum_ca_clear_capital' ||
    raw.endsWith('_addendum_ca') ||
    raw.includes('addendum_ca_')
  ) {
    return 'addendum_ca';
  }
  if (
    raw === 'addendum_ny' ||
    raw === 'addendum_ny_harbor_view' ||
    raw === 'addendum_ny_clear_capital' ||
    raw.endsWith('_addendum_ny') ||
    raw.includes('addendum_ny_')
  ) {
    return 'addendum_ny';
  }
  if (
    raw === 'addendum_va' ||
    raw === 'addendum_va_harbor_view' ||
    raw === 'addendum_va_clear_capital' ||
    raw.endsWith('_addendum_va') ||
    raw.includes('addendum_va_')
  ) {
    return 'addendum_va';
  }
  return null;
}

export function resolveAddendumDocumentConfigKey(
  layoutKeyOrType?: string | null,
): string | null {
  const raw = String(layoutKeyOrType || '')
    .trim()
    .toLowerCase();
  if (!raw) return null;
  if (raw === 'guarantoraddendum' || raw === 'guarantor_addendum') {
    return 'guarantorAddendum';
  }
  return canonicalAddendumLayoutKey(raw);
}

function configForKeyAndVariant(
  key: string,
  variant: AddendumPdfVariant,
): AddendumDocumentFieldConfig | null {
  if (key === 'addendum_epa' || key === 'addendum_epa_harbor_view' || key === 'addendum_epa_clear_capital') {
    return variant === 'clear_capital' ? ADDENDUM_EPA_CLEAR_CAPITAL : ADDENDUM_EPA_HARBOR_VIEW;
  }
  if (key === 'addendum_p' || key === 'addendum_p_harbor_view' || key === 'addendum_p_clear_capital') {
    return variant === 'clear_capital' ? ADDENDUM_P_CLEAR_CAPITAL : ADDENDUM_P_HARBOR_VIEW;
  }
  if (key === 'addendum_ny' || key === 'addendum_ny_harbor_view' || key === 'addendum_ny_clear_capital') {
    return variant === 'clear_capital' ? ADDENDUM_NY_CLEAR_CAPITAL : ADDENDUM_NY_HARBOR_VIEW;
  }
  if (key === 'addendum_ca' || key === 'addendum_ca_harbor_view' || key === 'addendum_ca_clear_capital') {
    return variant === 'clear_capital'
      ? ADDENDUM_CA_CLEAR_CAPITAL
      : ADDENDUM_CA_HARBOR_VIEW;
  }
  if (key === 'addendum_va' || key === 'addendum_va_harbor_view' || key === 'addendum_va_clear_capital') {
    return variant === 'clear_capital'
      ? ADDENDUM_VA_CLEAR_CAPITAL
      : ADDENDUM_VA_HARBOR_VIEW;
  }
  return ADDENDUM_DOCUMENT_CONFIG[key] || null;
}

export function getAddendumDocumentConfig(
  layoutKeyOrType?: string | null,
  variant: AddendumPdfVariant = 'harbor_view',
): AddendumDocumentFieldConfig | null {
  const key = resolveAddendumDocumentConfigKey(layoutKeyOrType);
  if (!key) return null;
  const fromKey = resolveAddendumPdfVariant({
    layoutKey: layoutKeyOrType,
    name: layoutKeyOrType,
  });
  const effective = fromKey === 'clear_capital' ? 'clear_capital' : variant;
  return configForKeyAndVariant(key, effective);
}
