import {
  analyzeSmsText,
  analyzeSmsTemplate,
  canConvertToSmsSafeText,
  convertToSmsSafeText,
} from './smsSegments';

describe('smsSegments', () => {
  it('counts GSM-7 single segment at 160 septets', () => {
    const text = 'a'.repeat(160);
    const info = analyzeSmsText(text);
    expect(info.encoding).toBe('gsm-7');
    expect(info.segments).toBe(1);
    expect(info.credits).toBe(1);
  });

  it('counts GSM-7 multipart at 153 per segment', () => {
    const text = 'a'.repeat(200);
    const info = analyzeSmsText(text);
    expect(info.encoding).toBe('gsm-7');
    expect(info.segments).toBe(2);
  });

  it('counts UCS-2 at 70 and 67 per segment', () => {
    const one = analyzeSmsText('😊'.padEnd(69, 'a'));
    expect(one.encoding).toBe('ucs-2');
    expect(one.segments).toBe(1);

    const two = analyzeSmsText('😊' + 'a'.repeat(99));
    expect(two.segments).toBe(2);
  });

  it('detects smart quotes as Unicode', () => {
    const info = analyzeSmsText('Hello “world”');
    expect(info.isUnicode).toBe(true);
    expect(info.unicodeTriggers.length).toBeGreaterThan(0);
  });

  it('convertToSmsSafeText fixes smart punctuation to GSM-7', () => {
    const safe = convertToSmsSafeText('Hi “there” — ok');
    expect(safe).toBe('Hi "there" - ok');
    expect(analyzeSmsText(safe).encoding).toBe('gsm-7');
    expect(analyzeSmsText(safe).segments).toBe(1);
  });

  it('convertToSmsSafeText strips emoji for lower cost', () => {
    const safe = convertToSmsSafeText('Deal closed 😊');
    expect(safe).toBe('Deal closed');
    expect(analyzeSmsText(safe).encoding).toBe('gsm-7');
  });

  it('canConvertToSmsSafeText is true when conversion helps', () => {
    expect(canConvertToSmsSafeText('Hello “world”')).toBe(true);
    expect(canConvertToSmsSafeText('Plain GSM text')).toBe(false);
  });

  it('uses merged bodies for template worst case', () => {
    const template = 'Hi {{firstName}}, ready?';
    const info = analyzeSmsTemplate(template, [{ firstName: 'Jo' }, { firstName: 'Christopher' }]);
    expect(info.characters).toBeGreaterThan(analyzeSmsText('Hi Jo, ready?').characters);
  });
});
