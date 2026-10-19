/**
 * Broadcast throughput benchmark — fully mocked, never touches a database,
 * Redis or Infobip. Skipped unless BROADCAST_BENCH=1:
 *
 *   BROADCAST_BENCH=1 npx jest src/workers/broadcastThroughput.bench.test.ts
 *
 * Fake Postgres: every round trip costs BENCH_DB_LATENCY_MS (default 15) and
 * holds one of 10 pooled connections; a $transaction([...]) costs BEGIN +
 * each statement + COMMIT. Fake Infobip: every HTTP call costs
 * BENCH_HTTP_LATENCY_MS (default 250) whatever its size. Redis is absent, so
 * token buckets and caches are no-ops (this flatters the old per-message path,
 * which made ~5 Redis calls per message).
 */
import { randomUUID } from 'crypto';

const DB_LAT = Number(process.env.BENCH_DB_LATENCY_MS ?? '15');
const HTTP_LAT = Number(process.env.BENCH_HTTP_LATENCY_MS ?? '250');
const POOL = 10;

const stats = { dbRoundTrips: 0, http: 0, smsSent: 0, sentIds: [] as string[] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let free = POOL;
const waiters: Array<() => void> = [];
async function roundTrips<T>(n: number, fn: () => T): Promise<T> {
  if (free === 0) await new Promise<void>((r) => waiters.push(r));
  else free -= 1;
  try {
    for (let i = 0; i < n; i += 1) {
      stats.dbRoundTrips += 1;
      await sleep(DB_LAT);
    }
    return fn();
  } finally {
    const next = waiters.shift();
    if (next) next();
    else free += 1;
  }
}

/** Prisma-style lazy promise: runs only when awaited, so $transaction([...]) can own it. */
function lazy<T>(fn: () => T): PromiseLike<T> & { catch: (f: (e: unknown) => unknown) => Promise<unknown> } {
  let p: Promise<T> | null = null;
  const run = () => (p ??= roundTrips(1, fn));
  return {
    then: (a, b) => run().then(a, b),
    catch: (f) => run().catch(f),
  };
}

interface Row { id: string; broadcastId: string; phoneNumber: string; mergeData: unknown; status: string }
const recipients = new Map<string, Row>();
const broadcasts = new Map<string, Record<string, unknown>>();

const matchStatus = (want: unknown, status: string): boolean => {
  if (want === undefined) return true;
  if (typeof want === 'string') return want === status;
  const w = want as { in?: string[] };
  return w.in ? w.in.includes(status) : true;
};
const matchIds = (where: any, row: Row): boolean => {
  if (!where?.id) return true;
  if (typeof where.id === 'string') return where.id === row.id;
  return (where.id.in as string[]).includes(row.id);
};

const fakePrisma: any = {
  smsBroadcast: {
    findUnique: ({ where }: any) => lazy(() => broadcasts.get(where.id) ?? null),
    updateMany: () => lazy(() => ({ count: 0 })),
  },
  smsBroadcastRecipient: {
    findMany: ({ where }: any) =>
      lazy(() => [...recipients.values()].filter((r) => matchIds(where, r) && matchStatus(where.status, r.status)).map((r) => ({ ...r }))),
    updateMany: ({ where, data }: any) =>
      lazy(() => {
        let count = 0;
        for (const r of recipients.values()) {
          if (matchIds(where, r) && matchStatus(where.status, r.status)) {
            if (data.status) r.status = data.status;
            count += 1;
          }
        }
        return { count };
      }),
    update: ({ where, data }: any) =>
      lazy(() => {
        const r = recipients.get(where.id);
        if (r && data.status) r.status = data.status;
        return r;
      }),
  },
  messagingMessage: {
    findMany: () => lazy(() => []),
    create: () => lazy(() => ({ id: randomUUID() })),
    createMany: ({ data }: any) => lazy(() => ({ count: data.length })),
    update: () => lazy(() => ({})),
  },
  messagingContact: { findFirst: () => lazy(() => null), findMany: () => lazy(() => []) },
  messagingSuppression: { findFirst: () => lazy(() => null), findMany: () => lazy(() => []) },
  messagingConversation: {
    upsert: () => lazy(() => ({ id: randomUUID(), isOptedOut: false })),
    update: () => lazy(() => ({})),
  },
  tenantControl: { findUnique: () => lazy(() => null) },
  $transaction: (ops: unknown[]) => roundTrips(2 + ops.length, () => ops.map(() => ({}))),
  $executeRaw: (s: TemplateStringsArray, ...vals: unknown[]) =>
    lazy(() => {
      const sql = s.join('?');
      if (sql.includes('WITH v AS') && sql.includes('UPDATE "SmsBroadcastRecipient" r')) {
        // markBroadcastBatchSubmitted: arrays are (messageId, conversationId, recipientId, providerId, status, ...)
        const recipientIds = vals[2] as string[];
        const statuses = vals[4] as string[];
        let moved = 0;
        recipientIds.forEach((id, i) => {
          const r = recipients.get(id);
          if (r && r.status === 'SENDING') {
            r.status = statuses[i] === 'SENT' ? 'SENT' : 'FAILED';
            moved += 1;
          }
        });
        return moved;
      }
      return 0;
    }),
  $executeRawUnsafe: () => lazy(() => 0),
  $queryRaw: (s: TemplateStringsArray, ...vals: unknown[]) =>
    lazy(() => {
      const sql = Array.isArray(s) ? s.join('?') : String((s as any)?.sql ?? s);
      if (sql.includes('INSERT INTO "MessagingConversation"')) {
        const numbers = vals.find((v) => Array.isArray(v)) as string[];
        return numbers.map((n) => ({ id: randomUUID(), contactNumber: n }));
      }
      return [];
    }),
};

jest.mock('../config/prismaClient', () => ({ __esModule: true, default: fakePrisma }));
jest.mock('../config/redis', () => ({
  getRedisClient: () => null,
  isRedisAvailable: () => true,
  testRedisConnection: async () => undefined,
}));
jest.mock('../socket/messagingEvents', () => new Proxy({}, { get: () => () => undefined }));
jest.mock('../queues/smsBroadcastQueue', () => ({
  SMS_BROADCAST_QUEUE_NAME: 'sms-broadcast',
  enqueueBroadcastChunks: async () => 0,
  enqueueBroadcastRetry: async () => undefined,
  isSmsBroadcastQueueEnabled: () => false,
}));
jest.mock('../services/messaging/broadcastCounters', () => ({
  recordBroadcastCounter: () => undefined,
  scheduleBroadcastRecompute: () => undefined,
  flushBroadcastCounters: async () => undefined,
  completeBroadcastIfDrained: async () => undefined,
}));
jest.mock('axios', () => {
  const post = async (_url: string, payload: any) => {
    stats.http += 1;
    await sleep(HTTP_LAT);
    const messages = (payload.messages ?? [payload]).map((m: any) => {
      const id = m.destinations?.[0]?.messageId ?? m.head?.messageId;
      stats.smsSent += 1;
      stats.sentIds.push(id);
      return { messageId: id, status: { groupName: 'PENDING', name: 'PENDING_ENROUTE' }, smsCount: 1 };
    });
    return { status: 200, data: { bulkId: payload.bulkId ?? 'bulk', messages } };
  };
  const instance = { post, get: post };
  return { __esModule: true, default: { create: () => instance, isAxiosError: () => false }, create: () => instance };
});

process.env.INFOBIP_BASE_URL = 'https://bench.invalid';
process.env.INFOBIP_API_KEY = 'bench';

const BROADCASTS = Number(process.env.BENCH_BROADCASTS ?? '7');
const PER_BROADCAST = Number(process.env.BENCH_RECIPIENTS ?? '100');
const CHUNK = Number(process.env.BROADCAST_CHUNK_SIZE ?? '100');

const run = process.env.BROADCAST_BENCH === '1' ? test : test.skip;

run(
  `throughput: ${BROADCASTS} broadcasts x ${PER_BROADCAST} recipients`,
  async () => {
    const { processChunk } = await import('./smsBroadcastWorker');

    const plan: Array<{ id: string; chunks: string[][] }> = [];
    for (let b = 0; b < BROADCASTS; b += 1) {
      const id = randomUUID();
      broadcasts.set(id, {
        id,
        campaignKey: `ck-${b}`,
        body: 'Hi {{firstName}}, quick question about {{company}}',
        fromNumber: `+1555000${String(b).padStart(4, '0')}`,
        mediaUrls: [],
        status: 'RUNNING',
        throttlePerSecond: null,
        createdById: randomUUID(),
      });
      const ids: string[] = [];
      for (let i = 0; i < PER_BROADCAST; i += 1) {
        const rid = randomUUID();
        recipients.set(rid, {
          id: rid,
          broadcastId: id,
          phoneNumber: `+1212${String(b).padStart(2, '0')}${String(i).padStart(5, '0')}`,
          mergeData: { firstName: 'Pat', company: 'Acme' },
          status: 'QUEUED',
        });
        ids.push(rid);
      }
      const chunks: string[][] = [];
      for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
      plan.push({ id, chunks });
    }

    const started = Date.now();
    // One chunk at a time per broadcast (the Redis chunk lock), broadcasts in parallel.
    await Promise.all(
      plan.map(async (b) => {
        for (const [i, recipientIds] of b.chunks.entries()) {
          await processChunk({ broadcastId: b.id, recipientIds, chunkIndex: i });
        }
      }),
    );
    const seconds = (Date.now() - started) / 1000;
    const total = BROADCASTS * PER_BROADCAST;
    const sent = [...recipients.values()].filter((r) => r.status === 'SENT').length;

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          dbLatencyMs: DB_LAT,
          httpLatencyMs: HTTP_LAT,
          messages: total,
          recipientsSent: sent,
          providerSends: stats.smsSent,
          uniqueProviderIds: new Set(stats.sentIds).size,
          seconds,
          msgsPerSec: Math.round((total / seconds) * 10) / 10,
          dbRoundTripsPerMsg: Math.round((stats.dbRoundTrips / total) * 100) / 100,
          httpCallsPerMsg: Math.round((stats.http / total) * 1000) / 1000,
        },
        null,
        2,
      ),
    );

    expect(sent).toBe(total);
    expect(stats.smsSent).toBe(total);
    expect(new Set(stats.sentIds).size).toBe(total);
  },
  30 * 60_000,
);
