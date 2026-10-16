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
import { resolveRange, zonedDayKey, zonedDayStart } from './counting';
import { BadRequest, collectUsage, toBroadcastStatus } from './reports';
import { accFromRow, addAcc, emptyAcc, toMetrics } from './metrics';
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

describe('tz bucketing', () => {
  const ET = 'America/New_York';

  it('keeps UTC days when no tz is sent', () => {
    const r = resolveRange({ from: '2026-10-05', to: '2026-10-15' }, new Date());
    expect([r.start.toISOString(), r.end.toISOString(), r.tz]).toEqual(['2026-10-05T00:00:00.000Z', '2026-10-16T00:00:00.000Z', 'UTC']);
  });

  it('reads bounds as Eastern days, across the November DST change', () => {
    const r = resolveRange({ from: '2026-10-31', to: '2026-11-01' }, new Date(), ET);
    expect(r.start.toISOString()).toBe('2026-10-31T04:00:00.000Z'); // EDT
    expect(r.end.toISOString()).toBe('2026-11-02T05:00:00.000Z'); // EST — 1 Nov is a 25-hour day
    expect(zonedDayStart('2026-03-08', ET).toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(zonedDayStart('2026-03-09', ET).toISOString()).toBe('2026-03-09T04:00:00.000Z'); // 8 Mar is 23 hours
  });

  it('puts an evening-ET message on the Eastern day, not the next UTC day', () => {
    const evening = Date.parse('2026-10-15T23:30:00-04:00'); // 03:30Z on the 16th
    expect(zonedDayKey(evening, ET)).toBe('2026-10-15');
    expect(zonedDayKey(evening, 'UTC')).toBe('2026-10-16');
    expect(zonedDayKey(Date.parse('2026-11-01T23:59:00-05:00'), ET)).toBe('2026-11-01');
  });

  it('defaults "to" to today in the requested zone', () => {
    const now = new Date('2026-10-16T02:00:00Z'); // 22:00 ET on the 15th
    expect(resolveRange({}, now, ET).to).toBe('2026-10-15');
    expect(resolveRange({}, now).to).toBe('2026-10-16');
  });
});

describe('GET /usage metrics', () => {
  beforeEach(() => queryRaw.mockReset());

  const day = (date: string | null, extra: Record<string, unknown> = {}) => ({
    day: date, sent: 5n, delivered: 3n, failed: 2n, segments: 7n, blocked: 1n, replied: 4n, optOut: 1n,
    m_accepted: 4n, m_delivered: 3n, m_undeliverable: 1n, m_pending: 0n, m_failed: 1n, m_segments: 6n,
    m_cost: '1.100001', m_priced: 4n, m_currencies: 1n, m_currency: 'BDT', m_cost_usd: '0.015', m_cost_usd_missing: 1n,
    m_inbound: 4n, m_replies: 3n, m_repliers: 2n, m_opt_outs: 1n, ...extra,
  });

  it('rejects an unknown zone', async () => {
    await expect(collectUsage({ tz: 'Mars/Olympus' })).rejects.toBeInstanceOf(BadRequest);
  });

  it('passes tz to the bucket expression and keeps every legacy field', async () => {
    queryRaw.mockResolvedValue([day('2026-11-01'), day('2026-10-31'), day(null, { m_repliers: 3n, m_opt_outs: 1n })]);
    const out = await collectUsage({ from: '2026-10-31', to: '2026-11-01', tz: 'America/New_York' });
    const [, ...values] = queryRaw.mock.calls[0];
    expect(JSON.stringify(values)).toContain('"America/New_York"');
    expect(out.tz).toBe('America/New_York');
    expect(out.daily.map((d) => d.date)).toEqual(['2026-10-31', '2026-11-01']);
    expect(out.daily[0]).toMatchObject({ sent: 5, delivered: 3, failed: 2, segments: 7, blocked: 1, replied: 4, optOut: 1 });
    expect(out.daily[0].metrics).toEqual({
      accepted: 4, delivered: 3, undeliverable: 1, pending: 0, failedNotSent: 1, segments: 6,
      costAccount: 1.100001, currency: 'BDT', costUsd: 0.015, costUsdMissing: 1,
      inboundTotal: 4, replies: 3, repliers: 2, optOuts: 1,
    });
    // Additive totals are the exact sum of days; distinct ones come from the period row.
    expect(out.totals.metrics).toMatchObject({ accepted: 8, segments: 12, costAccount: 2.200002, costUsd: 0.03, repliers: 3, optOuts: 1 });
  });
});

describe('metrics definitions', () => {
  it('sums money in micro-units so days reconcile exactly with the period', () => {
    const total = emptyAcc();
    for (let i = 0; i < 10; i++) addAcc(total, accFromRow({ m_cost: '0.1', m_currency: 'BDT', m_currencies: 1n, m_cost_usd: '0.1' }));
    expect(toMetrics(total)).toMatchObject({ costAccount: 1, costUsd: 1 }); // not 0.9999999999999999
  });

  it('reports MIXED, not a meaningless sum, across currencies', () => {
    const total = addAcc(accFromRow({ m_cost: '1', m_currency: 'BDT', m_currencies: 1n }), accFromRow({ m_cost: '1', m_currency: 'USD', m_currencies: 1n }));
    expect(toMetrics(total)).toMatchObject({ costAccount: null, currency: 'MIXED' });
    expect(toMetrics(emptyAcc())).toMatchObject({ costAccount: null, currency: null, costUsd: 0 });
  });
});
