import fs from 'fs';
import path from 'path';
import type { DocumentLayout } from '../utils/convert-docusign-template-export';
import contractLayoutFallback from './contract.layout.json';
import { buildAddendumDocumentLayout } from '../utils/addendum-document-layout';

/**
 * Read contract.layout.json from disk on every lookup.
 * A static `import` is frozen until Node restarts, so JSON edits were ignored
 * until nodemon recycled — and existing DocuSign envelopes never update.
 */
function readLayoutFromDisk(fileName: string): DocumentLayout | null {
  const srcPath = path.join(
    process.cwd(),
    'src',
    'services',
    'docusign',
    'layouts',
    fileName,
  );
  const nextToModule = path.join(__dirname, fileName);
  const filePath = fs.existsSync(srcPath) ? srcPath : nextToModule;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as DocumentLayout;
  } catch {
    return null;
  }
}

function loadContractLayoutFromDisk(): DocumentLayout {
  const layout = readLayoutFromDisk('contract.layout.json');
  if (!layout) return contractLayoutFallback as DocumentLayout;
  const p12 = (layout.placements || []).find(
    (p) => p.id === 'p12' || p.variable === 'purchase_percent',
  );
  if (p12) {
    console.log(
      `[DocuSign] contract.layout.json ${p12.variable || p12.id} x=${p12.x} y=${p12.y}`,
    );
  }
  return layout;
}

/**
 * ACH authorization coordinates live in JSON next to contract.layout.json and are
 * read per lookup for the same reason: a static import freezes until Node restarts.
 * `ach_authorization` is the variant merged into a contract package;
 * `ach_authorization_standalone` is the same placements plus
 * `skipOwner2InitialMirror`, used when the ACH form is sent on its own.
 */
function loadAchLayoutFromDisk(fileName: string, key: DocumentLayoutKey) {
  return (): DocumentLayout => {
    const layout = readLayoutFromDisk(fileName);
    if (!layout) {
      throw new Error(`Missing ACH layout file for key: ${key} (${fileName})`);
    }
    return layout;
  };
}

/** Document type keys used with BoldSignTemplate.type and merge order. */
export const DOCUMENT_LAYOUT_KEYS = {
  contract: 'contract',
  addendum_p: 'addendum_p',
  addendum_ca: 'addendum_ca',
  addendum_ny: 'addendum_ny',
  addendum_va: 'addendum_va',
  addendum_epa: 'addendum_epa',
  ach_authorization: 'ach_authorization',
  ach_authorization_standalone: 'ach_authorization_standalone',
} as const;

export type DocumentLayoutKey =
  (typeof DOCUMENT_LAYOUT_KEYS)[keyof typeof DOCUMENT_LAYOUT_KEYS];

/** Maps BoldSignTemplate.type values to coordinate layouts. */
export const BOLD_SIGN_TYPE_TO_LAYOUT_KEY: Record<string, DocumentLayoutKey> = {
  contract: DOCUMENT_LAYOUT_KEYS.contract,
  addendum_p: DOCUMENT_LAYOUT_KEYS.addendum_p,
  addendum_ca: DOCUMENT_LAYOUT_KEYS.addendum_ca,
  addendum_ny: DOCUMENT_LAYOUT_KEYS.addendum_ny,
  addendum_va: DOCUMENT_LAYOUT_KEYS.addendum_va,
  addendum_epa: DOCUMENT_LAYOUT_KEYS.addendum_epa,
  ach_authorization: DOCUMENT_LAYOUT_KEYS.ach_authorization,
  ach_authorization_standalone: DOCUMENT_LAYOUT_KEYS.ach_authorization_standalone,
};

function requireAddendumLayout(key: DocumentLayoutKey): DocumentLayout {
  const layout = buildAddendumDocumentLayout(key);
  if (!layout) {
    throw new Error(`Failed to build addendum layout for key: ${key}`);
  }
  return layout;
}

const REGISTRY: Record<DocumentLayoutKey, () => DocumentLayout> = {
  [DOCUMENT_LAYOUT_KEYS.contract]: loadContractLayoutFromDisk,
  [DOCUMENT_LAYOUT_KEYS.addendum_p]: () =>
    requireAddendumLayout(DOCUMENT_LAYOUT_KEYS.addendum_p),
  [DOCUMENT_LAYOUT_KEYS.addendum_ca]: () =>
    requireAddendumLayout(DOCUMENT_LAYOUT_KEYS.addendum_ca),
  [DOCUMENT_LAYOUT_KEYS.addendum_ny]: () =>
    requireAddendumLayout(DOCUMENT_LAYOUT_KEYS.addendum_ny),
  [DOCUMENT_LAYOUT_KEYS.addendum_va]: () =>
    requireAddendumLayout(DOCUMENT_LAYOUT_KEYS.addendum_va),
  [DOCUMENT_LAYOUT_KEYS.addendum_epa]: () =>
    requireAddendumLayout(DOCUMENT_LAYOUT_KEYS.addendum_epa),
  [DOCUMENT_LAYOUT_KEYS.ach_authorization]: loadAchLayoutFromDisk(
    'ach_authorization.layout.json',
    DOCUMENT_LAYOUT_KEYS.ach_authorization,
  ),
  [DOCUMENT_LAYOUT_KEYS.ach_authorization_standalone]: loadAchLayoutFromDisk(
    'ach_authorization_standalone.layout.json',
    DOCUMENT_LAYOUT_KEYS.ach_authorization_standalone,
  ),
};

export function getDocumentLayout(key: DocumentLayoutKey): DocumentLayout {
  const loader = REGISTRY[key];
  if (!loader) {
    throw new Error(`Unknown document layout key: ${key}`);
  }
  return loader();
}

export function resolveLayoutKeyFromBoldSignType(type: string): DocumentLayoutKey | null {
  const normalized = String(type || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  return BOLD_SIGN_TYPE_TO_LAYOUT_KEY[normalized] || null;
}

/** Default merge order for a full contract package (Harbor / Clear Capital MCA is self-contained). */
export const DEFAULT_MERGE_LAYOUT_ORDER: DocumentLayoutKey[] = [
  DOCUMENT_LAYOUT_KEYS.contract,
];
