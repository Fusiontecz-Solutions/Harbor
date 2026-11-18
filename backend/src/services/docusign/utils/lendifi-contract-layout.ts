import type {
  DocumentLayout,
  DocumentLayoutPlacement,
} from './convert-docusign-template-export';

/**
 * Lendifi (Elite Funders Group LLC) main contract tweaks on top of Harbor View's
 * `contract.layout.json`. Lendifi's PDF shares Harbor View's geometry except:
 *
 * - Page 1: the logo header is shorter and "LENDIFI" fits on the first line, so
 *   the agreement date and merchant block (legal name … phone) sit 13.7pt higher,
 *   and the "dated ____" blank starts at x≈198 (justified like Clear Capital).
 *   Fields from y=300 (purchase amount) down are unchanged.
 * - Page 13 (G1 Guarantee): "HARBOR VIEW CAPITAL" wraps the merchant blank to the
 *   next line; with "LENDIFI" the blank stays on the funder line after `and`
 *   (underscore starts at x≈414.6, baseline one line up).
 * - Page 20: the line reflows — the date blank starts at x≈274.5 and the merchant
 *   blank starts the next line at x=72.
 *
 * Offsets measured with pdf.js against the Harbor View contract PDF
 * (letter 612×792, DocuSign top-left origin).
 */
const PAGE1_MERCHANT_BLOCK_Y_MAX = 280;
const PAGE1_Y_OFFSET = -14;
/** "dated ____" blank starts at x≈198.2 (Harbor View 209.8) — same justification as Clear Capital. */
const PAGE1_AGREEMENT_DATE_X = '198';
const PAGE13_LEGAL_NAME_X = '415';
const PAGE13_LEGAL_NAME_Y_DELTA = -12;
const PAGE13_LEGAL_NAME_WIDTH = '160';
const PAGE20_AGREEMENT_DATE_X = '275';
const PAGE20_LEGAL_NAME_X = '72';

export function isLendifiFunderName(value?: string | null): boolean {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (!normalized) return false;
  return normalized.includes('lendifi') || normalized.includes('elite funders group');
}

function shiftY(raw: string | undefined, delta: number): string {
  const n = parseFloat(String(raw ?? '0').trim());
  if (!Number.isFinite(n)) return String(raw ?? '0');
  return String(Math.max(0, Math.round(n + delta)));
}

function applyLendifiPlacement(placement: DocumentLayoutPlacement): DocumentLayoutPlacement {
  const page = String(placement.pageNumber || '').trim();
  const variable = String(placement.variable || '').trim().toLowerCase();
  const y = parseFloat(String(placement.y ?? '0').trim());

  if (page === '1' && Number.isFinite(y) && y < PAGE1_MERCHANT_BLOCK_Y_MAX) {
    return {
      ...placement,
      y: shiftY(placement.y, PAGE1_Y_OFFSET),
      ...(variable === 'agreement_date' ? { x: PAGE1_AGREEMENT_DATE_X } : {}),
    };
  }

  if (page === '13' && variable === 'client_legal_name') {
    return {
      ...placement,
      x: PAGE13_LEGAL_NAME_X,
      y: shiftY(placement.y, PAGE13_LEGAL_NAME_Y_DELTA),
      width: PAGE13_LEGAL_NAME_WIDTH,
    };
  }

  if (page === '20' && variable === 'agreement_date') {
    return { ...placement, x: PAGE20_AGREEMENT_DATE_X };
  }

  if (page === '20' && variable === 'client_legal_name') {
    return { ...placement, x: PAGE20_LEGAL_NAME_X };
  }

  return placement;
}

/**
 * Reuse Harbor View `contract.layout.json` coords with Lendifi PDF tweaks.
 * No-op when the funder is not Lendifi.
 */
export function applyLendifiMainContractLayout(
  layout: DocumentLayout,
  hints?: {
    funderName?: string | null;
    displayName?: string | null;
    templateName?: string | null;
  },
): DocumentLayout {
  const match =
    isLendifiFunderName(hints?.funderName) ||
    isLendifiFunderName(hints?.displayName) ||
    isLendifiFunderName(hints?.templateName);
  if (!match) return layout;

  return {
    ...layout,
    placements: layout.placements.map(applyLendifiPlacement),
  };
}
