import fs from 'fs';
import path from 'path';
import prisma from '../../config/prismaClient';
import {
  BOLD_SIGN_TYPE_TO_LAYOUT_KEY,
  DOCUMENT_LAYOUT_KEYS,
  resolveLayoutKeyFromBoldSignType,
  type DocumentLayoutKey,
} from './layouts/document-layout.registry';

export type PlatformDocumentDefinition = {
  layoutKey: DocumentLayoutKey;
  name: string;
  type: string;
  /** HTTPS URL — set via env in production. */
  pdfUrlEnvKey: string;
  /** Optional repo-relative PDF under `docs/` for local dev. */
  localPdfFileName?: string;
};

export const PLATFORM_SIGNER_SLOTS = [
  { roleIndex: 1, roleName: 'Client', signerOrder: 1 },
  { roleIndex: 2, roleName: 'Owner 2', signerOrder: 2 },
] as const;

export const PLATFORM_DOCUMENTS: Record<DocumentLayoutKey, PlatformDocumentDefinition> = {
  [DOCUMENT_LAYOUT_KEYS.contract]: {
    layoutKey: DOCUMENT_LAYOUT_KEYS.contract,
    name: 'Katan Capital Funding Contract',
    type: 'contract',
    pdfUrlEnvKey: 'PLATFORM_CONTRACT_PDF_URL',
    localPdfFileName: 'KATAN_CAPITAL_-_FUNDING_CONTRACT.pdf',
  },
  [DOCUMENT_LAYOUT_KEYS.flexAddendum]: {
    layoutKey: DOCUMENT_LAYOUT_KEYS.flexAddendum,
    name: 'Katan Capital Flex Addendum',
    type: 'flex_addendum',
    pdfUrlEnvKey: 'PLATFORM_FLEX_ADDENDUM_PDF_URL',
    localPdfFileName: 'KATAN_CAPITAL_-_FLEX_ADDENDUM.pdf',
  },
  [DOCUMENT_LAYOUT_KEYS.balanceTransfer]: {
    layoutKey: DOCUMENT_LAYOUT_KEYS.balanceTransfer,
    name: 'Katan Capital Balance Transfer Sheet',
    type: 'balance_transfer',
    pdfUrlEnvKey: 'PLATFORM_BALANCE_TRANSFER_PDF_URL',
    localPdfFileName: 'KATAN_CAPITAL_-_BALANCE_TRANSFER_SHEET.pdf',
  },
  [DOCUMENT_LAYOUT_KEYS.achAuthorization]: {
    layoutKey: DOCUMENT_LAYOUT_KEYS.achAuthorization,
    name: 'Katan LLC ACH Authorization',
    type: 'ach_authorization',
    pdfUrlEnvKey: 'PLATFORM_ACH_AUTHORIZATION_PDF_URL',
    localPdfFileName: 'KATAN_CAPITAL_LLC_-_ACH_FORM.pdf',
  },
  [DOCUMENT_LAYOUT_KEYS.achAuthorizationStandalone]: {
    layoutKey: DOCUMENT_LAYOUT_KEYS.achAuthorizationStandalone,
    name: 'Katan LLC ACH Authorization (standalone)',
    type: 'ach_authorization',
    pdfUrlEnvKey: 'PLATFORM_ACH_AUTHORIZATION_PDF_URL',
    localPdfFileName: 'KATAN_CAPITAL_LLC_-_ACH_FORM.pdf',
  },
};

/** Supplemental documents available in the addendum picker (excludes main contract). */
export const SUPPLEMENTAL_PLATFORM_DOCUMENTS: PlatformDocumentDefinition[] = [
  PLATFORM_DOCUMENTS[DOCUMENT_LAYOUT_KEYS.flexAddendum],
  PLATFORM_DOCUMENTS[DOCUMENT_LAYOUT_KEYS.balanceTransfer],
  PLATFORM_DOCUMENTS[DOCUMENT_LAYOUT_KEYS.achAuthorization],
];

const LAYOUT_KEY_SET = new Set<string>(Object.values(DOCUMENT_LAYOUT_KEYS));

export function isDocumentLayoutKey(value: string): value is DocumentLayoutKey {
  return LAYOUT_KEY_SET.has(String(value || '').trim());
}

function docsRootDir(): string {
  return path.resolve(process.cwd(), '..', 'docs');
}

function readLocalPdfBase64(fileName: string): string | null {
  const filePath = path.join(docsRootDir(), fileName);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath).toString('base64');
}

function isValidRemotePdfUrl(url: string): boolean {
  const trimmed = String(url || '').trim();
  if (!trimmed || trimmed.startsWith('platform://')) return false;
  return /^https?:\/\//i.test(trimmed);
}

function layoutKeyMatchScore(
  layoutKey: DocumentLayoutKey,
  row: { layoutKey: string | null; type: string; pdfUrl: string | null },
): number {
  const rowLayoutKey = String(row.layoutKey || '').trim();
  if (rowLayoutKey === layoutKey) return 4;
  if (resolveLayoutKeyFromBoldSignType(row.type) === layoutKey) return 2;
  if (rowLayoutKey && resolveLayoutKeyFromBoldSignType(row.type) === layoutKey) return 3;
  return 0;
}

/** Resolve Cloudinary (or other HTTPS) pdfUrl from BoldSignTemplate for a platform layout key. */
export async function findBoldSignTemplatePdfUrlForLayout(
  layoutKey: DocumentLayoutKey,
): Promise<string | null> {
  const def = PLATFORM_DOCUMENTS[layoutKey];
  const typeVariants = new Set<string>([def.type, layoutKey]);
  for (const [type, key] of Object.entries(BOLD_SIGN_TYPE_TO_LAYOUT_KEY)) {
    if (key === layoutKey) typeVariants.add(type);
  }

  const rows = await prisma.boldSignTemplate.findMany({
    where: {
      OR: [
        { layoutKey },
        { templateId: layoutKey },
        { type: { in: [...typeVariants] } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    select: { pdfUrl: true, layoutKey: true, type: true },
  });

  const ranked = [...rows].sort(
    (a, b) => layoutKeyMatchScore(layoutKey, b) - layoutKeyMatchScore(layoutKey, a),
  );

  for (const row of ranked) {
    const url = String(row.pdfUrl || '').trim();
    if (isValidRemotePdfUrl(url)) return url;
  }
  return null;
}

async function fetchRemotePdfAsBase64(url: string, documentName: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download ${documentName} PDF (${res.status})`);
  }
  return Buffer.from(await res.arrayBuffer()).toString('base64');
}

export async function resolvePlatformDocumentPdfUrl(
  layoutKey: DocumentLayoutKey,
): Promise<string> {
  const def = PLATFORM_DOCUMENTS[layoutKey];
  const fromDb = await findBoldSignTemplatePdfUrlForLayout(layoutKey);
  if (fromDb) return fromDb;

  const fromEnv = String(process.env[def.pdfUrlEnvKey] || '').trim();
  if (fromEnv) return fromEnv;

  throw new Error(
    `Missing PDF URL for "${def.name}". Upload the PDF to Cloudinary and set pdfUrl on the BoldSignTemplate row with layoutKey "${layoutKey}", or set ${def.pdfUrlEnvKey}.`,
  );
}

export async function loadPlatformDocumentPdfBase64(
  layoutKey: DocumentLayoutKey,
): Promise<string> {
  const def = PLATFORM_DOCUMENTS[layoutKey];

  const fromDb = await findBoldSignTemplatePdfUrlForLayout(layoutKey);
  if (fromDb) {
    return fetchRemotePdfAsBase64(fromDb, def.name);
  }

  const fromEnv = String(process.env[def.pdfUrlEnvKey] || '').trim();
  if (fromEnv) {
    return fetchRemotePdfAsBase64(fromEnv, def.name);
  }

  if (def.localPdfFileName) {
    const local = readLocalPdfBase64(def.localPdfFileName);
    if (local) return local;
  }

  throw new Error(
    `No PDF configured for "${def.name}". Upload to Cloudinary and set BoldSignTemplate.pdfUrl with layoutKey "${layoutKey}", set ${def.pdfUrlEnvKey}, or add ${def.localPdfFileName ?? 'a PDF'} under docs/.`,
  );
}

export function normalizeSupplementalLayoutKeys(refs: string[]): DocumentLayoutKey[] {
  const out: DocumentLayoutKey[] = [];
  for (const ref of refs) {
    const key = String(ref || '').trim();
    if (!key) continue;
    if (isDocumentLayoutKey(key)) {
      out.push(key);
      continue;
    }
    throw new Error(
      `Unknown supplemental layout key "${key}". Use one of: ${[...LAYOUT_KEY_SET].join(', ')}`,
    );
  }
  return [...new Set(out)];
}

/** Keeps document-template-mapping FK working without manual BoldSignTemplate rows. */
export async function ensurePlatformBoldSignTemplateRow(
  layoutKey: DocumentLayoutKey,
): Promise<string> {
  const def = PLATFORM_DOCUMENTS[layoutKey];

  const existing = await prisma.boldSignTemplate.findFirst({
    where: { OR: [{ templateId: layoutKey }, { layoutKey }] },
    select: { id: true, pdfUrl: true },
  });
  if (existing?.id) {
    const currentPdfUrl = String(existing.pdfUrl || '').trim();
    if (!isValidRemotePdfUrl(currentPdfUrl)) {
      let resolvedPdfUrl = '';
      try {
        resolvedPdfUrl = await resolvePlatformDocumentPdfUrl(layoutKey);
      } catch {
        resolvedPdfUrl = '';
      }
      if (resolvedPdfUrl) {
        await prisma.boldSignTemplate.update({
          where: { id: existing.id },
          data: { pdfUrl: resolvedPdfUrl, layoutKey, name: def.name, type: def.type },
        });
      } else {
        await prisma.boldSignTemplate.update({
          where: { id: existing.id },
          data: { layoutKey, name: def.name, type: def.type },
        });
      }
    }
    return existing.id;
  }

  let pdfUrl = '';
  try {
    pdfUrl = await resolvePlatformDocumentPdfUrl(layoutKey);
  } catch {
    pdfUrl = '';
  }

  const created = await prisma.boldSignTemplate.create({
    data: {
      name: def.name,
      type: def.type,
      templateId: layoutKey,
      layoutKey,
      pdfUrl: pdfUrl || `platform://${layoutKey}`,
      state: 'all',
      frequency: 'all',
    },
    select: { id: true },
  });
  return created.id;
}

export function getPlatformTemplateRecipients() {
  return {
    success: true,
    source: 'platform-layout',
    roles: PLATFORM_SIGNER_SLOTS.map((slot) => ({
      roleIndex: slot.roleIndex,
      roleName: slot.roleName,
      signerName: '',
      signerEmail: '',
      signerOrder: slot.signerOrder,
    })),
  };
}
