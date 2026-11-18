/// <reference types="jest" />
/**
 * New York daily page-3 signature / date sit-on-blank placement.
 *
 * Underscores measured from `NY - DISCLOSURE DAILY PAYMENT NO REFI.pdf` page 3:
 *   Recipient Signature: x=72–222, y=165.5–178.8
 *   Date:                x=252–354, y=165.5–178.8
 *   Labels start at y≈179.3 — SignHere must not cover them.
 */
import { getStateDocumentConfig } from './state-document-config';
import { buildDocumentLayoutFromStateDocumentConfig } from './utils/state-document-layout';

const SIGNATURE_BLANK = { x0: 72, x1: 222, y0: 165.5, y1: 178.8 };
const DATE_BLANK = { x0: 252, x1: 354, y0: 165.5, y1: 178.8 };
const LABEL_TOP = 179.3;

function num(value: string | undefined): number {
  return Number.parseFloat(String(value ?? ''));
}

describe('New York daily page 3 signature and date placement', () => {
  const keys = [
    ['daily', 'New York', 'norefi'],
    ['daily', 'New York', 'refi'],
    ['daily', 'New York', null],
  ] as const;

  it.each(keys)('resolves %s %s %s onto the page-3 blanks', (frequency, state, dealType) => {
    const config = getStateDocumentConfig(frequency, state, dealType);
    expect(config).toBeTruthy();

    const sign = config!.signHere[0];
    const date = config!.dateTabs[0];
    expect(sign.pageNumber).toBe('3');
    expect(date.pageNumber).toBe('3');
    expect(date.tabLabel).toBe('signature_date');

    const signX = num(sign.x);
    const signY = num(sign.y);
    const dateX = num(date.x);
    const dateY = num(date.y);

    expect(dateX).toBe(DATE_BLANK.x0);
    expect(dateY).toBeGreaterThanOrEqual(SIGNATURE_BLANK.y0 - 1);
    expect(dateY).toBeLessThan(LABEL_TOP);

    const signHeight = num(sign.height) || (sign.scaleValue ? 22 : 40);
    const signWidth = num(sign.width) || (sign.scaleValue ? 90 : 200);
    const signBottom = signY + signHeight;
    const signRight = signX + signWidth;

    expect(signX).toBeGreaterThanOrEqual(SIGNATURE_BLANK.x0);
    expect(signRight).toBeLessThanOrEqual(SIGNATURE_BLANK.x1);
    expect(signY).toBeLessThan(SIGNATURE_BLANK.y0);
    expect(signBottom).toBeGreaterThan(SIGNATURE_BLANK.y0 - 2);
    expect(signBottom).toBeLessThanOrEqual(LABEL_TOP);
    expect(sign.scaleValue).toBe('0.8');
  });

  it('builds daily New York layout placements on page 3 blanks', () => {
    const config = getStateDocumentConfig('daily', 'New York', 'norefi');
    expect(config).toBeTruthy();

    const layout = buildDocumentLayoutFromStateDocumentConfig({
      configKey: 'dailyNewYorkNorefi',
      config: config!,
      name: 'NY Daily NO REFI',
      fileName: 'NY - DISCLOSURE DAILY PAYMENT NO REFI.pdf',
    });

    const sign = layout.placements.find((p) => p.type === 'signature');
    const date = layout.placements.find(
      (p) => p.type === 'date' && p.variable === 'signature_date',
    );
    expect(sign).toBeTruthy();
    expect(date).toBeTruthy();
    expect(sign!.pageNumber).toBe('3');
    expect(date!.pageNumber).toBe('3');
    expect(num(sign!.x)).toBeGreaterThanOrEqual(SIGNATURE_BLANK.x0);
    expect(num(sign!.x) + num(sign!.width)).toBeLessThanOrEqual(SIGNATURE_BLANK.x1);
    expect(num(date!.x)).toBe(DATE_BLANK.x0);
    expect(num(date!.y)).toBe(165);
    expect(num(sign!.x)).toBe(72);
    expect(num(sign!.y)).toBe(157);
    expect(num(sign!.y) + num(sign!.height)).toBeLessThanOrEqual(LABEL_TOP);
  });
});
