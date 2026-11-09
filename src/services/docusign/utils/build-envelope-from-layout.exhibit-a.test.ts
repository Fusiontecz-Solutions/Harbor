import { buildRecipientTabsByRoleForLayout } from './build-envelope-from-layout';
import { buildAddendumDocumentLayout } from './addendum-document-layout';

jest.mock('../../../config/prismaClient', () => ({ __esModule: true, default: {} }));

describe('Exhibit A EIN tabs', () => {
  const einTab = (variable: string) => {
    const layout = buildAddendumDocumentLayout('exhibit_a')!;
    const signers = [{ roleName: 'Client', name: 'Owner', email: 'owner@example.com' }];
    const tabs = buildRecipientTabsByRoleForLayout(
      layout,
      '1',
      { exhibit_a_value_1: 'FUSIONTECZ' },
      signers as never,
      { ownerCount: 1, guarantorCount: 0 },
    ).get('Client')!;
    return tabs.textTabs.find((t) => t.name === variable)!;
  };

  it('requires an editable EIN on a row with a company', () => {
    const tab = einTab('company_ein_1');
    expect(tab.required).toBe('true');
    expect(tab.optional).toBe('false');
    expect(tab.locked).toBeUndefined();
  });

  it('keeps the EIN optional on a row with no company', () => {
    const tab = einTab('company_ein_2');
    expect(tab.optional).toBe('true');
    expect(tab.required).toBeUndefined();
  });
});
