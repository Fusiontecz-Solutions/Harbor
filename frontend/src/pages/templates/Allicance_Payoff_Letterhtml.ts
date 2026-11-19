import type { TemplateValues } from "./types";
import {
  PAYOFF_LETTER_VARIABLES,
  renderPayoffLetterHtml,
} from "./payoffLetterLayout";
import {
  CLEAR_CAPITAL_DEFAULT_LETTER_BRAND,
  decodeLetterBrand,
  LEGACY_LETTER_WIRE,
  LETTER_BRAND_VALUE_KEY,
} from "./letterBrand";

/** Clear Capital payoff letter merge fields (shared payoff layout). */
export const ALLIANCE_PAYOFF_LETTER_VARIABLES = PAYOFF_LETTER_VARIABLES;

/**
 * Clear Capital payoff letter (kept for saved references to this template).
 * Same layout as every funder; defaults to the Clear Capital brand and its
 * original built-in wire block when no funder brand / wire values are passed.
 */
export function renderAlliancePayoffLetterHtml(values: TemplateValues): string {
  const brand = decodeLetterBrand(values as Record<string, unknown>, CLEAR_CAPITAL_DEFAULT_LETTER_BRAND);
  const usingDefaultBrand = !(values as Record<string, unknown>)[LETTER_BRAND_VALUE_KEY];
  return renderPayoffLetterHtml(values, brand, {
    documentTitle: `${brand.brandName} Payoff Letter`,
    fallbackWire: usingDefaultBrand ? LEGACY_LETTER_WIRE : null,
  });
}
