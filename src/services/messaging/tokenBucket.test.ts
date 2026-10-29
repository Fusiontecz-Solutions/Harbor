const mockEval = jest.fn();
let mockRedis: { eval: jest.Mock } | null = { eval: mockEval };
jest.mock('../../config/redis', () => ({ getRedisClient: () => mockRedis }));

import { acquireTokens, getAccountBucket, getBroadcastBucket, getSenderBucket, takeUpTo } from './tokenBucket';

beforeEach(() => {
  mockEval.mockReset();
  mockRedis = { eval: mockEval };
  delete process.env.SENDER_RATE_PER_SECOND;
});

describe('multi-bucket token acquisition', () => {
  test('one atomic Redis call covers every bucket, with capacity/refill per key', async () => {
    mockEval.mockResolvedValue(7);
    const a = getAccountBucket();
    const b = getBroadcastBucket('b1', 5);
    expect(await takeUpTo([a, b], 50)).toBe(7);
    expect(mockEval).toHaveBeenCalledTimes(1);
    const [, numKeys, k1, k2, wanted, , cap1, refill1, cap2, refill2] = mockEval.mock.calls[0];
    expect(numKeys).toBe(2);
    expect([k1, k2]).toEqual([a.key, b.key]);
    expect(wanted).toBe('50');
    expect([cap1, refill1, cap2, refill2]).toEqual([String(a.capacity), String(a.refillPerSecond), '5', '5']);
    // same hash tag so the multi-key script is cluster-safe
    expect(k1).toContain('{harbor-rate}');
    expect(k2).toContain('{harbor-rate}');
  });

  test('never grants more than requested', async () => {
    mockEval.mockResolvedValue(99);
    expect(await takeUpTo([getAccountBucket()], 3)).toBe(3);
  });

  test('fails open without Redis (provider limits remain the backstop)', async () => {
    mockRedis = null;
    expect(await takeUpTo([getAccountBucket()], 12)).toBe(12);
  });

  test('acquireTokens waits for a partial grant and returns it', async () => {
    mockEval.mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockResolvedValueOnce(2);
    expect(await acquireTokens([getBroadcastBucket('b', 100)], 10, 5_000)).toBe(2);
    expect(mockEval).toHaveBeenCalledTimes(3);
  });

  test('acquireTokens returns 0 on timeout', async () => {
    mockEval.mockResolvedValue(0);
    expect(await acquireTokens([getBroadcastBucket('b', 100)], 10, 60)).toBe(0);
  });

  test('per-sender bucket only exists when SENDER_RATE_PER_SECOND is set', () => {
    expect(getSenderBucket('+15550001111')).toBeNull();
    process.env.SENDER_RATE_PER_SECOND = '3';
    const s = getSenderBucket('+15550001111')!;
    expect(s.refillPerSecond).toBe(3);
    expect(s.key).toContain('+15550001111');
  });
});
