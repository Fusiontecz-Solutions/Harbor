import type { TemplateValues } from "./types";
import { decodeLetterBrand, HARBOR_VIEW_DEFAULT_LETTER_BRAND } from "./letterBrand";
import { renderZeroBalanceLetterHtml } from "./zeroBalanceLetterLayout";

/**
 * Gmail-safe HTML for the zero balance letter. The Letters page passes the
 * selected funder's brand (`__letter_brand`); without it this renders the
 * Harbor View Capital letter.
 */
export function renderZeroBalanceLetterEmailHtml(values: TemplateValues): string {
  return renderZeroBalanceLetterHtml(
    values,
    decodeLetterBrand(values as Record<string, unknown>, HARBOR_VIEW_DEFAULT_LETTER_BRAND),
  );
}
