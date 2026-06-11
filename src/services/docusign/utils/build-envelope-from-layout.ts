import type {
  DocumentLayout,
  DocumentLayoutPlacement,
} from './convert-docusign-template-export';
import {
  buildLayoutPrefillValueRecord,
  CRM_ID_TO_LAYOUT_VARIABLE,
  getPrefillDisplayLabel,
} from './prefill-layout-bridge';
import type { PrefillFieldInput } from './docusign-prefill';
import { DOCUSIGN_DEFAULT_ROLE_NAME } from './docusign-client';

const DOCUSIGN_SECONDARY_SIGNER_ROLE_NAME =
  process.env.DOCUSIGN_SECONDARY_ROLE_NAME || 'Signer';

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
  /**
   * When true, text/date values are already burned into document PDFs — only signature /
   * initial / attachment tabs are attached (visible to all recipients including CC).
   */
  skipTextDateTabs?: boolean;
  /** When true, text/date tabs are created locked (use only when sending immediately). */
  lockDataTabs?: boolean;
};

export type LayoutPartyCounts = {
  ownerCount: number;
  guarantorCount: number;
};

/** Canonical CRM keys copied to legacy / duplicate tab labels automatically. */
const PREFILL_VALUE_ALIASES: Record<string, string[]> = {
  agreement_date: ['signature_date'],
  signature_date: ['agreement_date'],
  client_legal_name: ['business_legal_name', 'merchant_legal_name'],
  client_name: [
    'client_name_by',
    'guaranty_client_name',
    'owner1_guarantor_name',
    'guaranty_owner1_name',
    'guaranty_guarantor1_name',
  ],
  entity_type: ['typeOfEntity1', 'typeofentity1'],
  typeofentity1: ['entity_type', 'typeOfEntity1'],
  typeOfEntity1: ['entity_type', 'typeofentity1'],
  federal_tax_id_ein: ['security_tax_ein', 'authorization_client_tax_id'],
  security_tax_ein: ['federal_tax_id_ein', 'authorization_client_tax_id'],
  frequency: ['paymentterms', 'payment_terms'],
  net_to_merchant: ['netfundprovided', 'net_fund_provided'],
  purchase_percent: ['specified_percentage', 'purchased_percent'],
  appendix_underwriting_fees: ['underwriter_fee', 'underwriterfee', 'underwriter_fees'],
  owner1_guarantor_name: ['guaranty_owner1_name', 'guaranty_guarantor1_name', 'guaranty_client_name'],
  guaranty_owner1_name: ['owner1_guarantor_name', 'guaranty_guarantor1_name', 'guaranty_client_name', 'client_name'],
  guaranty_guarantor1_name: ['owner1_guarantor_name', 'guaranty_owner1_name', 'guaranty_client_name', 'client_name'],
  guaranty_client_name: ['client_name', 'owner1_guarantor_name', 'guaranty_owner1_name', 'guaranty_guarantor1_name'],
  security_guarantor: ['guaranty_guarantor1_name', 'guaranty_owner1_name', 'owner1_guarantor_name', 'client_name'],
  guaranty_owner1_ss: ['guaranty_guarantor1_ss'],
  guaranty_guarantor1_ss: ['guaranty_owner1_ss'],
  owner2_guarantor_name: ['guaranty_owner2_name', 'guaranty_guarantor2_name', 'merchant2_name'],
  guaranty_owner2_name: ['owner2_guarantor_name', 'guaranty_guarantor2_name', 'merchant2_name'],
  guaranty_guarantor2_name: ['owner2_guarantor_name', 'guaranty_owner2_name', 'merchant2_name'],
  merchant2_name: ['owner2_guarantor_name', 'guaranty_owner2_name', 'guaranty_guarantor2_name'],
  appendix_merchant2_name: [
    'owner2_guarantor_name',
    'guaranty_owner2_name',
    'merchant2_name',
    'guaranty_guarantor2_name',
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

const PARTY2_NAME_KEYS = [
  'owner2_guarantor_name',
  'guaranty_owner2_name',
  'guaranty_guarantor2_name',
  'merchant2_name',
  'appendix_merchant2_name',
] as const;

const PARTY1_NAME_KEYS = [
  'client_name',
  'owner1_guarantor_name',
  'guaranty_owner1_name',
  'guaranty_guarantor1_name',
  'guaranty_client_name',
  'security_guarantor',
] as const;

const PARTY1_SS_KEYS = ['guaranty_owner1_ss', 'guaranty_guarantor1_ss'] as const;
const PARTY1_DL_KEYS = [
  'guaranty_owner1_driver_license',
  'guaranty_guarantor1_driver_license',
] as const;

const PARTY2_SS_KEYS = ['guaranty_owner2_ss', 'guaranty_guarantor2_ss'] as const;
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

function expandPrefillValues(values: Record<string, string>): Record<string, string> {
  const out = { ...values };
  mirrorIdentityFields(out, PARTY1_NAME_KEYS);
  mirrorIdentityFields(out, PARTY1_SS_KEYS);
  mirrorIdentityFields(out, PARTY1_DL_KEYS);
  mirrorIdentityFields(out, PARTY2_NAME_KEYS);
  mirrorIdentityFields(out, PARTY2_SS_KEYS);
  mirrorIdentityFields(out, PARTY2_DL_KEYS);
  for (const [canonical, aliases] of Object.entries(PREFILL_VALUE_ALIASES)) {
    const v = String(out[canonical] || '').trim();
    if (!v) continue;
    for (const alias of aliases) {
      if (!String(out[alias] || '').trim()) out[alias] = v;
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
  const primaryName = String(
    signers.find((s) => /receiver|client|merchant|customer/i.test(s.roleName))?.name ||
      signers.find((s) => /^owner$/i.test(s.roleName))?.name ||
      signers.find((s) => /^guarantor$/i.test(s.roleName))?.name ||
      signers[0]?.name ||
      '',
  ).trim();
  if (primaryName) {
    for (const k of PRIMARY_GUARANTOR_NAME_VARIABLES) {
      if (!String(out[k] || '').trim()) out[k] = primaryName;
    }
    for (const k of PARTY1_NAME_KEYS) {
      if (!String(out[k] || '').trim()) out[k] = primaryName;
    }
  }
  if (ownerCount >= 2) {
    const party2FromPrefill = PARTY2_NAME_KEYS.map((k) => String(out[k] || '').trim()).find(
      Boolean,
    );
    if (party2FromPrefill) {
      mirrorIdentityFields(out, PARTY2_NAME_KEYS);
      mirrorIdentityFields(out, PARTY2_SS_KEYS);
      mirrorIdentityFields(out, PARTY2_DL_KEYS);
    } else {
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
      }
    }
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
    signers.find((s) => /receiver|client|merchant|customer/i.test(s.roleName))?.roleName ||
    signers.find((s) => /^owner$/i.test(s.roleName))?.roleName ||
    signers.find((s) => /^guarantor$/i.test(s.roleName))?.roleName ||
    signers.find((s) => /^signer$/i.test(s.roleName))?.roleName ||
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
): string {
  const party = placement.signerParty;

  if (isSecondaryParty(party)) {
    if (counts.ownerCount >= 2) {
      return resolveSecondarySignerRoleName(signers);
    }
    // One signer deal: secondary-slot initials (e.g. page 11) go to the merchant/owner1.
    if (placement.type === 'initial') {
      return resolvePrimarySignerRoleName(signers);
    }
    return resolveSecondarySignerRoleName(signers);
  }

  if (isPrimaryParty(party)) {
    return resolvePrimarySignerRoleName(signers);
  }

  const legacy = String(placement.signerRole || '').trim();
  if (!legacy || legacy.toLowerCase() === 'signer') {
    return resolvePrimarySignerRoleName(signers);
  }

  const match = signers.find((s) => s.roleName.toLowerCase() === legacy.toLowerCase());
  if (match) return match.roleName;

  // DocuSign template exports use legacy role names (e.g. "Receiver") that do not
  // match platform signer roles ("Client", "Owner 2"). Prefill tabs must attach to
  // the primary merchant signer or they are dropped at envelope build time.
  return resolvePrimarySignerRoleName(signers);
}

const PRIMARY_GUARANTOR_NAME_VARIABLES = [
  'owner1_guarantor_name',
  'guaranty_owner1_name',
  'guaranty_guarantor1_name',
  'guaranty_client_name',
  'client_name',
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

function resolveTextPlacementValue(
  variable: string,
  values: Record<string, string>,
): string {
  const key = String(variable || '').trim();
  if (!key) return '';
  const candidates = [
    key,
    key.toLowerCase(),
    CRM_ID_TO_LAYOUT_VARIABLE[key.toLowerCase()] || '',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const direct = String(values[candidate] || '').trim();
    if (direct) return direct;
    const aliases = PREFILL_VALUE_ALIASES[candidate] || PREFILL_VALUE_ALIASES[candidate.toLowerCase()];
    if (aliases) {
      for (const alias of aliases) {
        const v = String(values[alias] || '').trim();
        if (v) return v;
      }
    }
  }
  return '';
}

function placementAllowed(
  placement: DocumentLayoutPlacement,
  counts: LayoutPartyCounts,
  values: Record<string, string> = {},
): boolean {
  const when = String(placement.when || '').trim();
  if (when === 'owners >= 2' && counts.ownerCount < 2) return false;
  if (when === 'guarantors >= 2' && counts.ownerCount < 2) return false;

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
  if (variable) {
    if (/owner2|owner_2/.test(variable) && counts.ownerCount < 2) return false;
    if (/guarantor2|guarantor_2/.test(variable) && counts.ownerCount < 2) return false;
  }

  return true;
}

function toTextTab(
  placement: DocumentLayoutPlacement,
  value: string,
  envelopeDocumentId: string,
  lockDataTabs = false,
): DocuSignTab {
  const variable = String(placement.variable || '').trim();
  const displayLabel =
    getPrefillDisplayLabel(variable) ||
    String(placement.sourceTabLabel || '').trim() ||
    variable ||
    placement.slot;
  return {
    tabLabel: displayLabel,
    name: variable || undefined,
    documentId: envelopeDocumentId,
    pageNumber: placement.pageNumber,
    xPosition: placement.x,
    yPosition: placement.y,
    value,
    ...(lockDataTabs ? { locked: 'true' } : {}),
    shared: 'true',
    ...(placement.width ? { width: placement.width } : {}),
    ...(placement.height ? { height: placement.height } : {}),
  };
}

/** Stamp layout text/date values onto the base PDF for CC email (DocuSign download is often blank). */
export async function renderFlattenedLayoutPdf(
  layout: DocumentLayout & { documentBase64: string },
  values: Record<string, string>,
  counts: LayoutPartyCounts,
): Promise<Buffer> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const pdfDoc = await PDFDocument.load(Buffer.from(layout.documentBase64, 'base64'));
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages = pdfDoc.getPages();
  const expanded = expandPrefillValues(values);

  for (const placement of layout.placements) {
    if (placement.type !== 'text' && placement.type !== 'date') continue;
    if (!placementAllowed(placement, counts, expanded)) continue;
    const text = resolveTextPlacementValue(placement.variable || '', expanded);
    if (!text) continue;

    const pageIndex = Math.max(0, parseInt(String(placement.pageNumber || '1'), 10) - 1);
    const page = pages[pageIndex];
    if (!page) continue;

    const tabHeight = parseFloat(String(placement.height || '19')) || 19;
    const fontSize = Math.min(11, Math.max(7, Math.round(tabHeight * 0.55)));
    const { height: pageHeight } = page.getSize();
    const x = parseFloat(String(placement.x || '0')) || 0;
    const yTop = parseFloat(String(placement.y || '0')) || 0;
    const y = pageHeight - yTop - fontSize;

    page.drawText(text, {
      x,
      y: Math.max(2, y),
      size: fontSize,
      font,
      color: rgb(0, 0, 0),
      maxWidth: placement.width ? parseFloat(String(placement.width)) || undefined : undefined,
    });
  }

  return Buffer.from(await pdfDoc.save());
}

function toSignTab(
  placement: DocumentLayoutPlacement,
  envelopeDocumentId: string,
): DocuSignTab {
  return {
    tabLabel: placement.slot || `${placement.type}_${placement.id}`,
    documentId: envelopeDocumentId,
    pageNumber: placement.pageNumber,
    xPosition: placement.x,
    yPosition: placement.y,
    optional: placement.optional ? 'true' : 'false',
  };
}

function toAttachmentTab(
  placement: DocumentLayoutPlacement,
  envelopeDocumentId: string,
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
    yPosition: placement.y,
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
  const signerTabs = new Map<string, SignerTabBuckets>();

  const ensureSigner = (roleName: string) => {
    if (!signerTabs.has(roleName)) {
      signerTabs.set(roleName, emptySignerTabBuckets());
    }
    return signerTabs.get(roleName)!;
  };

  for (const placement of layout.placements) {
    if (!placementAllowed(placement, counts, values)) continue;

    const roleName = resolvePlacementSignerRoleName(placement, signers, counts);

    const bucket = ensureSigner(roleName);

    if (placement.type === 'text' || placement.type === 'date') {
      const variable = placement.variable || '';
      const value = resolveTextPlacementValue(variable, values);
      if (!value) continue;
      const tab = toTextTab(placement, value, envelopeDocumentId);
      if (placement.type === 'date') bucket.dateTabs.push(tab);
      else bucket.textTabs.push(tab);
      continue;
    }

    if (placement.type === 'signature') {
      bucket.signHereTabs.push(toSignTab(placement, envelopeDocumentId));
      continue;
    }

    if (placement.type === 'initial') {
      bucket.initialHereTabs.push(toSignTab(placement, envelopeDocumentId));
      continue;
    }

    if (placement.type === 'attachment') {
      bucket.signerAttachmentTabs.push(toAttachmentTab(placement, envelopeDocumentId));
    }
  }

  return signerTabs;
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
    expandPrefillValues(options.values),
    options.signers,
    counts.ownerCount,
  );
  const documents: Array<{ documentId: string; name: string; documentBase64: string }> =
    [];
  /** Map each layout package to envelope document id (1-based merge order). */
  const layoutKeyToEnvelopeDocId = new Map<string, string>();

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
      name: layout.document.originalFileName || layout.name,
      documentBase64: base64,
    });
  });

  const signerTabs = new Map<string, SignerTabBuckets>();

  const ensureSigner = (roleName: string) => {
    if (!signerTabs.has(roleName)) {
      signerTabs.set(roleName, emptySignerTabBuckets());
    }
    return signerTabs.get(roleName)!;
  };

  const expandedLayouts = expandLayoutsWithOwner2Initials(options.layouts, counts.ownerCount);

  for (const layout of expandedLayouts) {
    const envelopeDocId = layoutKeyToEnvelopeDocId.get(layout.key) || '1';

    for (const placement of layout.placements) {
      if (!placementAllowed(placement, counts, values)) continue;

      const roleName = resolvePlacementSignerRoleName(placement, options.signers, counts);

      const bucket = ensureSigner(roleName);

      if (placement.type === 'text' || placement.type === 'date') {
        if (options.skipTextDateTabs) continue;
        const variable = placement.variable || '';
        const value = resolveTextPlacementValue(variable, values);
        if (!value) continue;
        const tab = toTextTab(placement, value, envelopeDocId, options.lockDataTabs);
        if (placement.type === 'date') bucket.dateTabs.push(tab);
        else bucket.textTabs.push(tab);
        continue;
      }

      if (placement.type === 'signature') {
        bucket.signHereTabs.push(toSignTab(placement, envelopeDocId));
        continue;
      }

      if (placement.type === 'initial') {
        bucket.initialHereTabs.push(toSignTab(placement, envelopeDocId));
        continue;
      }

      if (placement.type === 'attachment') {
        bucket.signerAttachmentTabs.push(toAttachmentTab(placement, envelopeDocId));
      }
    }
  }

  const emptyTabs = emptySignerTabBuckets;

  const mappedSigners = options.signers.map((s) => {
    const tabs = signerTabs.get(s.roleName) || emptyTabs();
    return {
      roleName: s.roleName,
      name: s.name,
      email: s.email,
      routingOrder: s.routingOrder,
      tabs,
    };
  });

  if (counts.ownerCount >= 2) {
    const secondaryRole = resolveSecondarySignerRoleName(options.signers);
    const secondaryTabs = signerTabs.get(secondaryRole);
    const hasSecondaryRecipient = mappedSigners.some(
      (s) => s.roleName.toLowerCase() === secondaryRole.toLowerCase() && signerHasTabs(s.tabs),
    );
    if (!hasSecondaryRecipient && secondaryTabs && signerHasTabs(secondaryTabs)) {
      const primaryEmail = String(
        options.signers.find((s) => /client|merchant|customer/i.test(s.roleName))?.email ||
          options.signers[0]?.email ||
          '',
      )
        .trim()
        .toLowerCase();
      const secondaryInput =
        options.signers.find((s) => s.roleName.toLowerCase() === secondaryRole.toLowerCase()) ||
        options.signers.find((s) => {
          const email = String(s.email || '').trim().toLowerCase();
          return Boolean(email && email !== primaryEmail);
        });
      if (secondaryInput) {
        mappedSigners.push({
          roleName: secondaryRole,
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
