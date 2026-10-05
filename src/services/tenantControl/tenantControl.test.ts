import crypto from 'crypto';
import { canonicalString, verifySignature } from './signature';

const queryRaw = jest.fn();
jest.mock('../../config/prismaClient', () => ({ __esModule: true, default: { $queryRaw: (...args: unknown[]) => queryRaw(...args) } }));
jest.mock('./state', () => ({
  SENDING_DISABLED_CODE: 'TENANT_SENDING_DISABLED',
  getSendingState: jest.fn(),
  getQuotaConfig: jest.fn(),
}));

import { getQuotaConfig, getSendingState } from './state';
import { periodStart, resetQuotaCache } from './quota';
import { resolveRange } from './counting';
import { toBroadcastStatus } from './reports';
import { InfobipRequestError, sendSms } from '../messaging/infobip.service';

const SECRET = 'test-secret';
const sign = (ts: string, method: string, endpoint: string, body: string) =>
  crypto.createHmac('sha256', SECRET).update(canonicalString(ts, method, endpoint, body)).digest('hex');

const NO_QUOTA = { limit: null, countBy: 'messages', scope: 'monthly', resetDay: 1, updatedAt: null };

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

  it('covers the query string', () => {
    const sig = sign(ts, 'GET', '/usage?from=2026-09-01&to=2026-09-30', '');
    expect(verifySignature(SECRET, ts, sig, 'GET', '/usage?from=2026-09-01&to=2026-09-30', '', now)).toBe(true);
    expect(verifySignature(SECRET, ts, sig, 'GET', '/usage?from=2026-01-01&to=2026-09-30', '', now)).toBe(false);
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
  beforeEach(() => {
    resetQuotaCache();
    queryRaw.mockReset();
    (getSendingState as jest.Mock).mockResolvedValue({ enabled: true, reason: null, updatedAt: null, updatedBy: null });
    (getQuotaConfig as jest.Mock).mockResolvedValue(NO_QUOTA);
  });

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

  it('refuses to send once the quota is used up, without retry', async () => {
    (getQuotaConfig as jest.Mock).mockResolvedValue({ ...NO_QUOTA, limit: 100, updatedAt: 'x' });
    queryRaw.mockResolvedValue([{ used: BigInt(100) }]);

    const err = await sendSms({ to: '+15555550100', text: 'hi' }).catch((e) => e);
    expect(err).toBeInstanceOf(InfobipRequestError);
    expect(err.statusCode).toBe(429);
    expect(err.retryable).toBe(false);
    expect(err.providerCode).toBe('TENANT_LIMIT_REACHED');
  });

  it('lets sends through when usage cannot be measured', async () => {
    (getQuotaConfig as jest.Mock).mockResolvedValue({ ...NO_QUOTA, limit: 100, updatedAt: 'y' });
    queryRaw.mockRejectedValue(new Error('db down'));

    const err = await sendSms({ to: '+15555550100', text: 'hi' }).catch((e) => e);
    expect((err as InfobipRequestError | undefined)?.providerCode).not.toBe('TENANT_LIMIT_REACHED');
  });
});

describe('quota window', () => {
  const at = new Date('2026-10-01T15:30:00Z');

  it('starts daily windows at UTC midnight', () => {
    expect(periodStart({ scope: 'daily', resetDay: 1 }, at)?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('starts monthly windows on the reset day, falling back to last month', () => {
    expect(periodStart({ scope: 'monthly', resetDay: 1 }, at)?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(periodStart({ scope: 'monthly', resetDay: 15 }, at)?.toISOString()).toBe('2026-09-15T00:00:00.000Z');
  });

  it('never resets a total quota', () => {
    expect(periodStart({ scope: 'total', resetDay: 1 }, at)).toBeNull();
  });
});

describe('report helpers', () => {
  it('defaults to the last 30 days and orders swapped bounds', () => {
    const now = new Date('2026-10-01T15:30:00Z');
    expect(resolveRange({}, now)).toMatchObject({ from: '2026-09-02', to: '2026-10-01' });
    const r = resolveRange({ from: '2026-09-30', to: '2026-09-01' }, now);
    expect([r.from, r.to]).toEqual(['2026-09-01', '2026-09-30']);
    expect(r.end.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('maps Harbor broadcast statuses onto the contract', () => {
    const now = new Date('2026-10-01T12:00:00Z');
    expect(toBroadcastStatus('PENDING_APPROVAL', null, now)).toBe('draft');
    expect(toBroadcastStatus('QUEUED', new Date('2026-10-02T00:00:00Z'), now)).toBe('scheduled');
    expect(toBroadcastStatus('QUEUED', null, now)).toBe('sending');
    expect(toBroadcastStatus('RUNNING', null, now)).toBe('sending');
    expect(toBroadcastStatus('COMPLETED', null, now)).toBe('completed');
  });
});
