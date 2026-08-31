import type {
  DocumentLayout,
  DocumentLayoutPlacement,
} from './convert-docusign-template-export';

/**
 * Clear Capital's uploaded MCA PDF shares Harbor View's page-2+ geometry, but
 * the page-1 header is taller (name + address vs phone/email) and a few
 * funder-name wraps differ. `contract.layout.json` is measured on Harbor View.
 *
 * Offsets measured from the live Cloudinary PDFs (letter 612×792, DocuSign
 * top-left origin).
 *
 * G1 Guarantee (page 13): "HARBOR VIEW CAPITAL" wraps the merchant blank to the
 * next line (left). "CLEAR CAPITAL" is shorter, so the blank stays on the
 * funder line after `and`.
 */
const PAGE1_MERCHANT_BLOCK_Y_MAX = 280;
const PAGE1_Y_OFFSET = 5;
const PAGE1_AGREEMENT_DATE_X = '198';
const PAGE20_AGREEMENT_DATE_X = '248';
const PAGE20_LEGAL_NAME_X = '72';
/** Start of the G1 merchant underscore after `CLEAR CAPITAL ("FUNDER") and`. */
const PAGE13_LEGAL_NAME_X = '408';
/**
 * Harbor G1 merchant wraps to the following line (y=134). Clear's blank is the
 * line under the second date (date2 y=110, ~17px line). Do not use the page-13
 * underscore dx/dy pair — that lands on the date2 line.
 */
const PAGE13_LEGAL_NAME_Y_DELTA = -12;
const PAGE13_LEGAL_NAME_WIDTH = '210';

export function isClearCapitalFunderName(value?: string | null): boolean {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (!normalized) return false;
  return (
    normalized === 'clear capital' ||
    normalized === 'clear' ||
    normalized.includes('clear capital') ||
    normalized.includes('clear_capital') ||
    normalized.includes('clear-capital')
  );
}

function shiftY(raw: string | undefined, delta: number): string {
  const n = parseFloat(String(raw ?? '0').trim());
  if (!Number.isFinite(n)) return String(raw ?? '0');
  return String(Math.max(0, Math.round(n + delta)));
}

function applyClearCapitalPlacement(
  placement: DocumentLayoutPlacement,
): DocumentLayoutPlacement {
  const page = String(placement.pageNumber || '').trim();
  const variable = String(placement.variable || '').trim().toLowerCase();
  const y = parseFloat(String(placement.y ?? '0').trim());

  if (page === '1' && Number.isFinite(y) && y < PAGE1_MERCHANT_BLOCK_Y_MAX) {
    return {
      ...placement,
      y: shiftY(placement.y, PAGE1_Y_OFFSET),
      ...(variable === 'agreement_date'
        ? { x: PAGE1_AGREEMENT_DATE_X }
        : {}),
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
 * Reuse Harbor View `contract.layout.json` coords with Clear Capital PDF tweaks.
 * No-op when the funder is not Clear Capital.
 */
export function applyClearCapitalMainContractLayout(
  layout: DocumentLayout,
  hints?: {
    funderName?: string | null;
    displayName?: string | null;
    templateName?: string | null;
  },
): DocumentLayout {
  const match =
    isClearCapitalFunderName(hints?.funderName) ||
    isClearCapitalFunderName(hints?.displayName) ||
    isClearCapitalFunderName(hints?.templateName);
  if (!match) return layout;

  return {
    ...layout,
    placements: layout.placements.map(applyClearCapitalPlacement),
  };
}
