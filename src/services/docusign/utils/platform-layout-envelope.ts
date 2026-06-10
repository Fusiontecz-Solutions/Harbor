import prisma from '../../../config/prismaClient';
import {
  DOCUMENT_LAYOUT_KEYS,
  getDocumentLayout,
  type DocumentLayoutKey,
} from '../layouts/document-layout.registry';
import {
  isDocumentLayoutKey,
  loadPlatformDocumentPdfBase64,
  normalizeSupplementalLayoutKeys,
} from '../platform-document-registry';
import type { DocumentLayout } from './convert-docusign-template-export';
import {
  buildEnvelopeFromLayouts,
  prefillFieldsToValueMap,
  type LayoutSignerInput,
} from './build-envelope-from-layout';
import { fetchPdfAsBase64, resolveTemplateRefForMerge } from './merge-template-resolve';
import { DOCUSIGN_DEFAULT_ROLE_NAME } from './docusign-client';

const DOCUSIGN_SECONDARY_SIGNER_ROLE_NAME =
  process.env.DOCUSIGN_SECONDARY_ROLE_NAME || 'Signer';

export type DocumentLayoutWithBase64 = DocumentLayout & { documentBase64: string };

export async function loadLatestContractLayoutPackage(): Promise<DocumentLayoutWithBase64> {
  const layoutKey = DOCUMENT_LAYOUT_KEYS.contract;
  const layout = getDocumentLayout(layoutKey);
  try {
    const documentBase64 = await loadPlatformDocumentPdfBase64(layoutKey);
    return { ...layout, documentBase64 };
  } catch {
    const latest = await prisma.contractTemplate.findFirst({
      orderBy: { createdAt: 'desc' },
    });
    if (!latest?.url) {
      throw new Error(
        'No contract PDF configured. Set PLATFORM_CONTRACT_PDF_URL or upload a contract PDF from the Final Underwriter dashboard.',
      );
    }
    const documentBase64 = await fetchPdfAsBase64(latest.url);
    return { ...layout, documentBase64 };
  }
}

export async function loadSupplementalLayoutPackage(
  ref: string,
): Promise<DocumentLayoutWithBase64> {
  const sourceRef = String(ref || '').trim();
  if (isDocumentLayoutKey(sourceRef)) {
    const layout = getDocumentLayout(sourceRef);
    const documentBase64 = await loadPlatformDocumentPdfBase64(sourceRef);
    return { ...layout, documentBase64 };
  }

  const resolved = await resolveTemplateRefForMerge(sourceRef);
  if (!resolved.layoutKey) {
    throw new Error(`Supplemental document "${resolved.name || ref}" has no layoutKey.`);
  }
  const layout = getDocumentLayout(resolved.layoutKey);
  const pdfUrl = String(resolved.pdfUrl || '').trim();
  const documentBase64 = pdfUrl.startsWith('platform://')
    ? await loadPlatformDocumentPdfBase64(resolved.layoutKey)
    : await fetchPdfAsBase64(pdfUrl);
  return { ...layout, documentBase64 };
}

export function signerRolesToLayoutSigners(
  roles: Array<Record<string, unknown>>,
): LayoutSignerInput[] {
  return roles
    .map((r, idx) => ({
      roleName: String(r.roleName || r.signerRole || `Signer ${idx + 1}`).trim(),
      name: String(r.signerName || '').trim(),
      email: String(r.signerEmail || '').trim(),
      routingOrder: Number(r.signerOrder ?? idx + 1),
    }))
    .filter((s) => s.email);
}

function roleLabelFromRow(row: Record<string, unknown>): string {
  return String(row.roleName || row.signerRole || '').trim();
}

/** Map CRM / template signer rows to DocuSign Client + Owner 2 slots for layout routing. */
export function collapseSignerRolesForLayoutEnvelope(
  roles: Array<Record<string, unknown>>,
  ownerCount: number,
): Array<Record<string, unknown>> {
  const withEmail = roles.filter((r) => String(r.signerEmail || '').trim());
  if (!withEmail.length) return roles;

  const primary =
    withEmail.find((r) => /^client|merchant|customer|receiver/i.test(roleLabelFromRow(r))) ||
    withEmail.find((r) => /^owner$/i.test(roleLabelFromRow(r))) ||
    withEmail.find((r) => /^guarantor$/i.test(roleLabelFromRow(r))) ||
    withEmail[0];

  if (ownerCount < 2) {
    return primary
      ? [
          {
            ...primary,
            signerRole: DOCUSIGN_DEFAULT_ROLE_NAME,
            roleName: DOCUSIGN_DEFAULT_ROLE_NAME,
            signerOrder: 1,
          },
        ]
      : roles;
  }

  let secondary =
    withEmail.find((r) => /owner\s*2/i.test(roleLabelFromRow(r))) ||
    withEmail.find((r) => /guarantor\s*2/i.test(roleLabelFromRow(r)));

  if (!secondary) {
    const primaryEmail = String(primary?.signerEmail || '').trim().toLowerCase();
    const secondaryCandidates = withEmail.filter((r) => {
      if (r === primary) return false;
      const label = roleLabelFromRow(r);
      const email = String(r.signerEmail || '').trim().toLowerCase();
      if (!email || email === primaryEmail) return false;
      return (
        /owner\s*2|guarantor\s*2/i.test(label) ||
        /^owner(\s*2)?$/i.test(label) ||
        /^guarantor(\s*2)?$/i.test(label) ||
        /^signer$/i.test(label)
      );
    });
    secondary =
      secondaryCandidates[secondaryCandidates.length - 1] ||
      withEmail.find((r) => {
        if (r === primary) return false;
        const email = String(r.signerEmail || '').trim().toLowerCase();
        return Boolean(email && email !== primaryEmail);
      }) ||
      withEmail[1];
  }

  const out: Array<Record<string, unknown>> = [];
  if (primary) {
    out.push({
      ...primary,
      signerRole: DOCUSIGN_DEFAULT_ROLE_NAME,
      roleName: DOCUSIGN_DEFAULT_ROLE_NAME,
      signerOrder: 1,
    });
  }
  if (secondary && secondary !== primary) {
    out.push({
      ...secondary,
      signerRole: DOCUSIGN_SECONDARY_SIGNER_ROLE_NAME,
      roleName: DOCUSIGN_SECONDARY_SIGNER_ROLE_NAME,
      signerOrder: 2,
    });
  }
  return out.length ? out : roles;
}

export function countOwnersFromRoles(roles: Array<Record<string, unknown>>): number {
  const distinctEmails = new Set(
    roles
      .map((r) => String(r.signerEmail || '').trim().toLowerCase())
      .filter(Boolean),
  );
  if (distinctEmails.size >= 2) return 2;

  let ownerLikeCount = 0;
  let hasExplicitSecond = false;
  for (const r of roles) {
    const roleName = String(r.roleName || r.signerRole || '').trim();
    const email = String(r.signerEmail || '').trim();
    if (!email) continue;
    if (/owner\s*2|guarantor\s*2/i.test(roleName)) {
      hasExplicitSecond = true;
    }
    if (/^owner(\s*2)?$/i.test(roleName) || /guarantor(\s*2)?/i.test(roleName)) {
      ownerLikeCount++;
    }
  }
  if (hasExplicitSecond) return 2;
  return ownerLikeCount > 0 ? Math.min(2, ownerLikeCount) : 1;
}

export function countGuarantorsFromRoles(roles: Array<Record<string, unknown>>): number {
  let count = 0;
  for (const r of roles) {
    const roleName = String(r.roleName || r.signerRole || '').trim();
    if (/^guarantor(\s*2)?$/i.test(roleName) && String(r.signerEmail || '').trim()) {
      count++;
    }
  }
  return Math.min(2, count);
}

/** Normalize supplemental refs to platform layout keys (code-defined documents). */
export async function filterSupplementalRefs(refs: string[]): Promise<string[]> {
  const layoutKeys: string[] = [];
  for (const ref of refs) {
    const trimmed = String(ref || '').trim();
    if (!trimmed) continue;
    if (isDocumentLayoutKey(trimmed)) {
      layoutKeys.push(trimmed);
      continue;
    }

    const row = await prisma.boldSignTemplate.findFirst({
      where: { OR: [{ id: trimmed }, { templateId: trimmed }, { layoutKey: trimmed }] },
      select: { layoutKey: true, type: true, templateId: true },
    });
    const fromRow = String(row?.layoutKey || row?.templateId || '').trim();
    if (isDocumentLayoutKey(fromRow)) {
      layoutKeys.push(fromRow);
    }
  }
  return normalizeSupplementalLayoutKeys(layoutKeys);
}

export async function resolveSupplementalRefsFromDb(filters: {
  state?: string | null;
  frequency?: string | null;
  type?: string | null;
}): Promise<string[]> {
  const normalize = (value: string | null | undefined) => {
    const v = String(value ?? '').trim().toLowerCase();
    return v || undefined;
  };
  const where: Record<string, string> = {};
  const state = normalize(filters.state);
  const frequency = normalize(filters.frequency);
  const type = normalize(filters.type);
  if (state) where.state = state;
  if (frequency) where.frequency = frequency;
  if (type) where.type = type;

  const rows = await prisma.boldSignTemplate.findMany({
    where,
    select: { id: true, pdfUrl: true },
  });
  return [...new Set(rows.filter((r) => r.pdfUrl).map((r) => r.id))];
}

export async function buildPlatformLayoutEnvelopeDefinition(options: {
  supplementalRefs?: string[];
  roles: Array<Record<string, unknown>>;
  prefillFields?: Array<{ id: string; value: string }>;
  ownerCount?: number;
  guarantorCount?: number;
  title?: string;
  message?: string;
}) {
  const layouts: DocumentLayoutWithBase64[] = [await loadLatestContractLayoutPackage()];

  for (const ref of options.supplementalRefs || []) {
    layouts.push(await loadSupplementalLayoutPackage(ref));
  }

  const ownerCount = options.ownerCount ?? countOwnersFromRoles(options.roles);
  const collapsedRoles = collapseSignerRolesForLayoutEnvelope(options.roles, ownerCount);
  const signers = signerRolesToLayoutSigners(collapsedRoles);
  if (!signers.length) {
    throw new Error('At least one signer with a valid email is required.');
  }
  const guarantorCount =
    options.guarantorCount ??
    (ownerCount >= 2 ? 2 : countGuarantorsFromRoles(options.roles));
  const values = prefillFieldsToValueMap(options.prefillFields || []);

  const envelope = buildEnvelopeFromLayouts({
    layouts,
    values,
    signers,
    ownerCount,
    guarantorCount,
  });

  const createTimePrefillTabCount = envelope.recipients.signers.reduce(
    (sum, s) =>
      sum +
      (s.tabs?.textTabs?.length || 0) +
      (s.tabs?.dateTabs?.length || 0),
    0,
  );

  return {
    envelopeDefinition: {
      ...envelope,
      emailSubject: options.title || 'Please sign this document',
      emailBlurb: options.message || '',
    },
    createTimePrefillTabCount,
    layoutKeys: layouts.map((l) => l.key),
  };
}
