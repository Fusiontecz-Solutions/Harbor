import crypto from 'crypto';
import { canonicalString, verifySignature } from './signature';

jest.mock('../../config/prismaClient', () => ({ __esModule: true, default: {} }));
jest.mock('./state', () => ({
  SENDING_DISABLED_CODE: 'TENANT_SENDING_DISABLED',
  getSendingState: jest.fn(),
}));

import { getSendingState } from './state';
import { InfobipRequestError, sendSms } from '../messaging/infobip.service';

const SECRET = 'test-secret';
const sign = (ts: string, method: string, endpoint: string, body: string) =>
  crypto.createHmac('sha256', SECRET).update(canonicalString(ts, method, endpoint, body)).digest('hex');

describe('tenant control signature', () => {
  const now = 1_790_000_000_000;
  const ts = String(Math.floor(now / 1000));

  it('accepts a correctly signed request', () => {
    const body = '{"enabled":false}';
    expect(verifySignature(SECRET, ts, sign(ts, 'PUT', '/sending', body), 'PUT', '/sending', body, now)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const sig = sign(ts, 'PUT', '/sending', '{"enabled":false}');
    expect(verifySignature(SECRET, ts, sig, 'PUT', '/sending', '{"enabled":true}', now)).toBe(false);
  });

  it('rejects a stale timestamp', () => {
    const old = String(Math.floor(now / 1000) - 301);
    expect(verifySignature(SECRET, old, sign(old, 'GET', '/status', ''), 'GET', '/status', '', now)).toBe(false);
  });

  it('rejects a missing secret or signature', () => {
    expect(verifySignature('', ts, sign(ts, 'GET', '/status', ''), 'GET', '/status', '', now)).toBe(false);
    expect(verifySignature(SECRET, ts, undefined, 'GET', '/status', '', now)).toBe(false);
  });
});

describe('sendSms gate', () => {
  it('refuses to send while the tenant is paused, without retry', async () => {
    (getSendingState as jest.Mock).mockResolvedValue({
      enabled: false,
      reason: 'Unpaid invoice',
      updatedAt: null,
      updatedBy: null,
    });

    const err = await sendSms({ to: '+15555550100', text: 'hi' }).catch((e) => e);
    expect(err).toBeInstanceOf(InfobipRequestError);
    expect(err.retryable).toBe(false);
    expect(err.providerCode).toBe('TENANT_SENDING_DISABLED');
    expect(err.message).toContain('Unpaid invoice');
  });
});
