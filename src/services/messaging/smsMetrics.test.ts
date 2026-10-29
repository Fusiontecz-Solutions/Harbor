jest.mock('../../config/prismaClient', () => ({ __esModule: true, default: {} }));
jest.mock('../../socket/messagingEvents', () => ({ emitBroadcastProgress: jest.fn(), emitMessageStatusUpdate: jest.fn() }));
jest.mock('./cache.service', () => ({ cacheDel: jest.fn(), cacheBumpGeneration: jest.fn(), cacheGeneration: jest.fn(), cacheGet: jest.fn(), cacheKeys: {}, cacheSet: jest.fn() }));

import { bucketDelta, decideTransition, isSentBucket, mapProviderStatus, messageCost, outboundBucket, usdRate } from './smsMetrics';
import { lowerRankedStatuses, planStatusUpdate, type StoredMessageForStatus } from './deliveryStatus.service';
import { countersFromRows } from './broadcastCounters';
import { nextCheckDelayMs } from './deliveryReconciler';
import { addDays, zonedDay, zonedMidnight } from '../reports/reportTime';

describe('status transitions', () => {
  it('moves forward', () => {
    expect(decideTransition('SENT', 'DELIVERED')).toEqual({ changed: true, from: 'SENT', to: 'DELIVERED' });
    expect(decideTransition('QUEUED', 'SENT').changed).toBe(true);
    expect(decideTransition('SENT', 'UNDELIVERABLE').changed).toBe(true);
  });

  it('ignores duplicates (equal status)', () => {
    expect(decideTransition('DELIVERED', 'DELIVERED')).toEqual({ changed: false, from: 'DELIVERED', to: 'DELIVERED' });
    expect(decideTransition('SENT', 'SENT').changed).toBe(false);
  });

  it('ignores late receipts that would move backwards', () => {
    expect(decideTransition('DELIVERED', 'SENT').changed).toBe(false);
    expect(decideTransition('DELIVERED', 'UNDELIVERABLE').changed).toBe(false);
    expect(decideTransition('UNDELIVERABLE', 'SENT').changed).toBe(false);
  });

  it('first final outcome wins between equal-rank failures', () => {
    expect(decideTransition('UNDELIVERABLE', 'FAILED').changed).toBe(false);
    expect(decideTransition('FAILED', 'UNDELIVERABLE').changed).toBe(false);
  });

  it('lets a handset receipt override an earlier carrier failure', () => {
    expect(decideTransition('UNDELIVERABLE', 'DELIVERED')).toEqual({ changed: true, from: 'UNDELIVERABLE', to: 'DELIVERED' });
  });
});

describe('counter deltas', () => {
  it('moves one unit between buckets on a real transition', () => {
    expect(bucketDelta(decideTransition('UNDELIVERABLE', 'DELIVERED'), true)).toEqual({ undeliverable: -1, delivered: 1 });
    expect(bucketDelta(decideTransition('SENT', 'DELIVERED'), true)).toEqual({ pending: -1, delivered: 1 });
  });

  it('moves nothing on duplicates or late receipts', () => {
    expect(bucketDelta(decideTransition('DELIVERED', 'DELIVERED'), true)).toEqual({});
    expect(bucketDelta(decideTransition('DELIVERED', 'SENT'), true)).toEqual({});
  });

  it('a duplicate storm never changes the totals', () => {
    let status = 'SENT';
    const totals: Record<string, number> = { pending: 1 };
    for (const incoming of ['DELIVERED', 'DELIVERED', 'SENT', 'UNDELIVERABLE', 'DELIVERED']) {
      const t = decideTransition(status, incoming);
      for (const [k, v] of Object.entries(bucketDelta(t, true))) totals[k] = (totals[k] ?? 0) + (v ?? 0);
      status = t.to;
    }
    expect(status).toBe('DELIVERED');
    expect(Object.values(totals).reduce((a, b) => a + b, 0)).toBe(1);
    expect(totals.delivered).toBe(1);
  });
});

describe('definitions', () => {
  it('sent = accepted by provider, whatever the outcome', () => {
    expect(isSentBucket(outboundBucket({ status: 'SENT', hasProviderId: true }))).toBe(true);
    expect(isSentBucket(outboundBucket({ status: 'DELIVERED', hasProviderId: true }))).toBe(true);
    expect(isSentBucket(outboundBucket({ status: 'UNDELIVERABLE', hasProviderId: true }))).toBe(true);
  });

  it('failed is never sent', () => {
    expect(outboundBucket({ status: 'FAILED', hasProviderId: true })).toBe('failed');
    expect(isSentBucket('failed')).toBe(false);
    expect(outboundBucket({ status: 'SENT', hasProviderId: false })).toBe('failed');
  });

  it('suppressed and queued are separate', () => {
    expect(outboundBucket({ status: 'FAILED', hasProviderId: false, suppressed: true })).toBe('suppressed');
    expect(outboundBucket({ status: 'QUEUED', hasProviderId: false })).toBe('queued');
  });

  it('maps provider groups without inventing statuses', () => {
    expect(mapProviderStatus('Delivered')).toBe('DELIVERED');
    expect(mapProviderStatus('EXPIRED')).toBe('UNDELIVERABLE');
    expect(mapProviderStatus('Undeliverable')).toBe('UNDELIVERABLE');
    expect(mapProviderStatus('REJECTED')).toBe('FAILED');
    expect(mapProviderStatus('Pending')).toBe('SENT');
    expect(mapProviderStatus('something else')).toBeNull();
  });

  it('broadcast counters come straight from row buckets', () => {
    const c = countersFromRows(
      { queued: 1, suppressed: 2, sent: 10, delivered: 7, undeliverable: 2, pending: 1, failed: 3 },
      { repliers: 4, optOuts: 1 },
    );
    expect(c.sentCount).toBe(c.deliveredCount + c.undeliverableCount + c.pendingCount);
    expect(c.failedCount).toBe(3);
    expect(c.repliedCount).toBe(4);
    expect(c.optOutCount).toBe(1);
  });
});

describe('cost', () => {
  const env = { INFOBIP_BDT_PER_USD: '74' } as NodeJS.ProcessEnv;

  it('price is per segment: total = price × segments', () => {
    expect(messageCost({ pricePerSegment: 0.019, currency: 'USD', segments: 2 })).toEqual({ costAmount: 0.038, costUsd: 0.038 });
  });

  it('converts BDT with the configured rate, or not at all', () => {
    expect(messageCost({ pricePerSegment: 1.48, currency: 'BDT', segments: 1, env }).costUsd).toBeCloseTo(0.02, 6);
    expect(messageCost({ pricePerSegment: 1.48, currency: 'BDT', segments: 1, env: {} as NodeJS.ProcessEnv }).costUsd).toBeNull();
    expect(usdRate('usd', {} as NodeJS.ProcessEnv)).toBe(1);
  });
});

describe('planStatusUpdate', () => {
  const base: StoredMessageForStatus = {
    id: 'm1',
    conversationId: 'c1',
    broadcastId: 'b1',
    status: 'SENT',
    segmentCount: null,
    priceAmount: null,
    priceCurrency: null,
    costAmount: null,
    costUsd: null,
  };

  it('applies a transition and fills cost', () => {
    const plan = planStatusUpdate(base, { providerMessageId: 'p', status: 'DELIVERED', segmentCount: 2, priceAmount: 1.4, priceCurrency: 'BDT' }, {
      INFOBIP_BDT_PER_USD: '70',
    } as NodeJS.ProcessEnv);
    expect(plan.transition.changed).toBe(true);
    expect(plan.data.status).toBe('DELIVERED');
    expect(plan.data.costAmount).toBeCloseTo(2.8, 6);
    expect(plan.data.costUsd).toBeCloseTo(0.04, 6);
  });

  it('a duplicate receipt writes nothing', () => {
    const delivered = { ...base, status: 'DELIVERED', segmentCount: 1, priceAmount: 1, priceCurrency: 'BDT', costAmount: 1, costUsd: 0.01 };
    const plan = planStatusUpdate(delivered, { providerMessageId: 'p', status: 'DELIVERED', segmentCount: 1, priceAmount: 1, priceCurrency: 'BDT' });
    expect(plan.transition.changed).toBe(false);
    expect(plan.data).toEqual({});
  });

  it('exact USD from the export replaces a converted estimate', () => {
    const delivered = { ...base, status: 'DELIVERED', segmentCount: 1, priceAmount: 1, priceCurrency: 'BDT', costAmount: 1, costUsd: 0.0135 };
    const plan = planStatusUpdate(delivered, { providerMessageId: 'p', status: 'DELIVERED', costUsd: 0.019 });
    expect(plan.data).toEqual({ costUsd: 0.019 });
  });

  it('recipient mirror only overwrites lower-ranked statuses', () => {
    expect(lowerRankedStatuses('DELIVERED')).toEqual(['QUEUED', 'SENDING', 'SENT', 'FAILED', 'UNDELIVERABLE']);
    expect(lowerRankedStatuses('UNDELIVERABLE')).toEqual(['QUEUED', 'SENDING', 'SENT']);
    expect(lowerRankedStatuses('SENT')).toEqual(['QUEUED', 'SENDING']);
  });
});

describe('reconciler backoff', () => {
  it('grows and caps', () => {
    expect(nextCheckDelayMs(0, 1000, 10_000)).toBe(1000);
    expect(nextCheckDelayMs(2, 1000, 10_000)).toBe(4000);
    expect(nextCheckDelayMs(10, 1000, 10_000)).toBe(10_000);
  });
});

describe('US Eastern days', () => {
  it('midnight is 04:00Z in summer and 05:00Z in winter', () => {
    expect(zonedMidnight('2026-10-15').toISOString()).toBe('2026-10-15T04:00:00.000Z');
    expect(zonedMidnight('2026-12-01').toISOString()).toBe('2026-12-01T05:00:00.000Z');
    // DST ends 2026-11-01.
    expect(zonedMidnight('2026-11-01').toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(zonedMidnight('2026-11-02').toISOString()).toBe('2026-11-02T05:00:00.000Z');
  });

  it('an evening send stays on its Eastern day', () => {
    expect(zonedDay(new Date('2026-10-16T02:30:00Z'))).toBe('2026-10-15');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
  });
});

describe('Infobip logs chunking', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { chunkLogIds } = require('./infobip.service') as typeof import('./infobip.service');
  it('keeps each request under the 2048-char messageId cap', () => {
    const ids = Array.from({ length: 130 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);
    const chunks = chunkLogIds(ids, 100, 2000);
    expect(chunks.flat()).toEqual(ids);
    for (const c of chunks) expect(c.join('').length + c.length).toBeLessThanOrEqual(2000);
  });
});
