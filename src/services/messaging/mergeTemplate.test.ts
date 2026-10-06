import { buildMergeDataFromSheetRow, renderTemplate } from './mergeTemplate';

describe('mergeTemplate', () => {
  it('resolves $FIRST_NAME and $BUSINESS from canonical merge keys', () => {
    const body = 'Hi $FIRST_NAME, regarding $BUSINESS — ok?';
    const mergeData = { firstName: 'Adam', company: 'Meridian LLC' };
    expect(renderTemplate(body, mergeData)).toBe('Hi Adam, regarding Meridian LLC — ok?');
  });

  it('resolves {{firstName}} and raw CSV header keys', () => {
    const body = 'Hi {{FIRST_NAME}} at {{BUSINESS}}';
    const mergeData = buildMergeDataFromSheetRow(
      { Phone: '+15551234567', FIRST_NAME: 'Zack', BUSINESS: 'Acme' },
      { Phone: 'phoneNumber', FIRST_NAME: 'firstName', BUSINESS: 'company' },
      'Phone',
    );
    expect(renderTemplate(body, mergeData)).toBe('Hi Zack at Acme');
  });

  it('strips unknown tokens', () => {
    expect(renderTemplate('Hi $MISSING and {{alsoMissing}}', { firstName: 'x' })).toBe('Hi  and ');
  });
});
