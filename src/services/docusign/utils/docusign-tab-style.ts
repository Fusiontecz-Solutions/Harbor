/** DocuSign prefill styling — contract, ACH, and addendum templates all use Arial. */
export const DOCUSIGN_PREFILL_FONT = 'arial';
export const DOCUSIGN_PREFILL_FONT_COLOR = 'black';

/** Map layout tab height (px) to DocuSign fontSize token (templates mostly use size9). */
export function docuSignFontSizeFromTabHeight(height?: string | number): string {
  const h = parseFloat(String(height ?? '19')) || 19;
  if (h <= 14) return 'size7';
  if (h <= 17) return 'size8';
  return 'size9';
}

export function applyDocuSignPrefillTabStyle<T extends Record<string, string | undefined>>(
  tab: T,
  options?: { height?: string | number },
): T & { font: string; fontColor: string; fontSize: string } {
  return {
    ...tab,
    font: DOCUSIGN_PREFILL_FONT,
    fontColor: DOCUSIGN_PREFILL_FONT_COLOR,
    fontSize: docuSignFontSizeFromTabHeight(options?.height),
  };
}
