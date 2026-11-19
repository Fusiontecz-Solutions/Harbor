import type { TemplateValues } from "./types";
import {
  PAYOFF_LETTER_VARIABLES,
  renderPayoffLetterHtml,
} from "./payoffLetterLayout";
import {
  decodeLetterBrand,
  HARBOR_VIEW_DEFAULT_LETTER_BRAND,
  LEGACY_LETTER_WIRE,
  LETTER_BRAND_VALUE_KEY,
} from "./letterBrand";

/** Payoff letter merge fields (shared payoff layout, every funder). */
export const PAY_OFF_LETTER_VARIABLES = PAYOFF_LETTER_VARIABLES;

/**
 * Gmail-safe HTML for the payoff letter. The Letters page passes the selected
 * funder's brand (`__letter_brand`) and wire details (`wire_*`); without them
 * it renders the original Harbor View Capital letter and built-in wire block.
 */
export function renderPayOffLetterEmailHtml(values: TemplateValues): string {
  const brand = decodeLetterBrand(values as Record<string, unknown>, HARBOR_VIEW_DEFAULT_LETTER_BRAND);
  // Built-in wire only for callers that pass no funder brand (the Letters page
  // always passes both brand and wire_* values, so blanks stay blank there).
  const usingDefaultBrand = !(values as Record<string, unknown>)[LETTER_BRAND_VALUE_KEY];
  return renderPayoffLetterHtml(values, brand, {
    documentTitle: `${brand.brandName} Payoff Letter`,
    fallbackWire: usingDefaultBrand ? LEGACY_LETTER_WIRE : null,
  });
}
