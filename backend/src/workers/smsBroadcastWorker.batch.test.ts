/**
 * Batched broadcast sending — correctness under mocks (no DB, Redis or Infobip).
 */
import { randomUUID } from 'crypto';

interface Row {
  id: string;
  broadcastId: string;
  phoneNumber: string;
  mergeData: unknown;
  status: string;
  errorMessage?: string | null;
  providerMessageId?: string | null;
  suppressedReason?: string | null;
}

const mockState = {
  recipients: new Map<string, Row>(),
  broadcasts: new Map<string, Record<string, unknown>>(),
  suppressed: new Set<string>(),
  posts: [] as any[],
  respond: null as null | ((payload: any) => any),
  retries: [] as Array<{ ids: string[]; pass: number }>,
  rawSql: [] as string[],
};

const matchIds = (where: any, r: Row) =>
  !where?.id ? true : typeof where.id === 'string' ? where.id === r.id : (where.id.in as string[]).includes(r.id);
const matchStatus = (want: any, s: string) =>
  want === undefined ? true : typeof want === 'string' ? want === s : want.in ? want.in.includes(s) : true;

const mockPrisma: any = {
  smsBroadcast: {
    findUnique: async ({ where }: any) => mockState.broadcasts.get(where.id) ?? null,
    updateMany: async ({ where, data }: any) => {
      const b = mockState.broadcasts.get(where.id);
      if (b && (!where.status || b.status === where.status)) Object.assign(b, data);
      return { count: b ? 1 : 0 };
    },
  },
  smsBroadcastRecipient: {
    findMany: async ({ where }: any) =>
      [...mockState.recipients.values()].filter((r) => matchIds(where, r) && matchStatus(where.status, r.status)).map((r) => ({ ...r })),
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const r of mockState.recipients.values()) {
        if (matchIds(where, r) && matchStatus(where.status, r.status)) {
          Object.assign(r, data);
          count += 1;
        }
      }
      return { count };
    },
    update: async ({ where, data }: any) => Object.assign(mockState.recipients.get(where.id)!, data),
  },
  messagingMessage: {
    findMany: async () => [],
    createMany: async ({ data }: any) => ({ count: data.length }),
    updateMany: async () => ({ count: 0 }),
  },
  messagingSuppression: {
    findMany: async ({ where }: any) =>
      (where.phoneNumber.in as string[]).filter((p) => mockState.suppressed.has(p)).map((p) => ({ phoneNumber: p, reason: 'STOP_KEYWORD', source: 'reply' })),
  },
  messagingContact: { findMany: async () => [] },
  tenantControl: { findUnique: async () => null },
  $queryRaw: async (s: TemplateStringsArray, ...vals: unknown[]) => {
    const numbers = vals.find((v) => Array.isArray(v)) as string[];
    return s.join('?').includes('INSERT INTO "MessagingConversation"') ? numbers.map((n) => ({ id: randomUUID(), contactNumber: n })) : [];
  },
  $executeRaw: async (s: TemplateStringsArray, ...vals: unknown[]) => {
    const sql = s.join('?');
    mockState.rawSql.push(sql);
    if (sql.includes('WITH v AS')) {
      const ids = vals[2] as string[];
      const providerIds = vals[3] as string[];
      const statuses = vals[4] as string[];
      let moved = 0;
      ids.forEach((id, i) => {
        const r = mockState.recipients.get(id);
        if (r?.status === 'SENDING') {
          r.status = statuses[i] === 'SENT' ? 'SENT' : 'FAILED';
          r.providerMessageId = providerIds[i];
          moved += 1;
        }
      });
      return moved;
    }
    if (sql.includes('UPDATE "SmsBroadcastRecipient" r') && sql.includes('delivery unknown')) {
      const [rids, mids] = vals.slice(-2) as string[][];
      let n = 0;
      rids.forEach((id, i) => {
        const r = mockState.recipients.get(id);
        if (r?.status === 'SENDING') {
          r.status = 'FAILED';
          r.providerMessageId = mids[i];
          r.errorMessage = 'delivery unknown';
          n += 1;
        }
      });
      return n;
    }
    return 0;
  },
};

jest.mock('../config/prismaClient', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../config/redis', () => ({ getRedisClient: () => null, isRedisAvailable: () => true }));
jest.mock('../socket/messagingEvents', () => new Proxy({}, { get: () => () => undefined }));
jest.mock('../queues/smsBroadcastQueue', () => ({
  SMS_BROADCAST_QUEUE_NAME: 'sms-broadcast',
  enqueueBroadcastChunks: async () => 0,
  enqueueBroadcastRetry: async (_b: string, ids: string[], _c: number, pass: number) => {
    mockState.retries.push({ ids, pass });
  },
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
    mockState.posts.push(payload);
    if (mockState.respond) return mockState.respond(payload);
    return {
      status: 200,
      data: {
        bulkId: payload.bulkId,
        // Deliberately reversed: results must be matched by messageId, not position.
        messages: [...payload.messages].reverse().map((m: any) => ({
          messageId: m.destinations[0].messageId,
          status: { groupName: 'PENDING', name: 'PENDING_ENROUTE' },
          smsCount: 1,
        })),
      },
    };
  };
  const instance = { post, get: post };
  return { __esModule: true, default: { create: () => instance }, create: () => instance };
});

process.env.INFOBIP_BASE_URL = 'https://test.invalid';
process.env.INFOBIP_API_KEY = 'test';
process.env.SMS_SEND_GAP_MIN_MS = '0';
process.env.SMS_SEND_GAP_MAX_MS = '0';
process.env.INFOBIP_BATCH_SIZE = '4';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const worker = require('./smsBroadcastWorker') as typeof import('./smsBroadcastWorker');

function seed(count: number, opts: { mediaUrls?: string[] } = {}) {
  const id = randomUUID();
  mockState.broadcasts.set(id, {
    id,
    campaignKey: 'ck',
    body: 'Hi {{firstName}}',
    fromNumber: '+15550001111',
    mediaUrls: opts.mediaUrls ?? [],
    status: 'RUNNING',
    throttlePerSecond: null,
    createdById: randomUUID(),
  });
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const rid = randomUUID();
    mockState.recipients.set(rid, {
      id: rid,
      broadcastId: id,
      phoneNumber: `+1212555${String(i).padStart(4, '0')}`,
      mergeData: { firstName: `N${i}` },
      status: 'QUEUED',
    });
    ids.push(rid);
  }
  return { id, ids };
}
const rows = (ids: string[]) => ids.map((id) => mockState.recipients.get(id)!);

beforeEach(() => {
  mockState.recipients.clear();
  mockState.broadcasts.clear();
  mockState.suppressed.clear();
  mockState.posts = [];
  mockState.respond = null;
  mockState.retries = [];
  mockState.rawSql = [];
});

describe('batched broadcast send', () => {
  test('sends many messages per provider request, each with its own body and messageId', async () => {
    const { id, ids } = seed(10);
    await worker.processChunk({ broadcastId: id, recipientIds: ids, chunkIndex: 0 });

    expect(mockState.posts).toHaveLength(3); // 4 + 4 + 2
    const messages = mockState.posts.flatMap((p) => p.messages);
    expect(messages).toHaveLength(10);
    expect(new Set(messages.map((m: any) => m.destinations[0].messageId)).size).toBe(10);
    expect(messages.map((m: any) => m.text)).toContain('Hi N7');
    expect(mockState.posts[0].bulkId).toBe('ck');
    expect(rows(ids).every((r) => r.status === 'SENT')).toBe(true);
    // providerMessageId mapped by id even though the response order was reversed
    for (const p of mockState.posts) for (const m of p.messages) {
      const r = rows(ids).find((x) => x.providerMessageId === m.destinations[0].messageId);
      expect(r).toBeDefined();
    }
  });

  test('a duplicate delivery of the same chunk does not resend', async () => {
    const { id, ids } = seed(6);
    await worker.processChunk({ broadcastId: id, recipientIds: ids, chunkIndex: 0 });
    await worker.processChunk({ broadcastId: id, recipientIds: ids, chunkIndex: 0 });
    expect(mockState.posts.flatMap((p) => p.messages)).toHaveLength(6);
  });

  test('suppressed numbers are never sent and are recorded as suppressed', async () => {
    const { id, ids } = seed(5);
    const stopped = mockState.recipients.get(ids[2])!.phoneNumber;
    mockState.suppressed.add(stopped);
    await worker.processChunk({ broadcastId: id, recipientIds: ids, chunkIndex: 0 });

    const sentTo = mockState.posts.flatMap((p) => p.messages.map((m: any) => m.destinations[0].to));
    expect(sentTo).toHaveLength(4);
    expect(sentTo.some((to: string) => stopped.endsWith(to.replace(/^\+/, '')))).toBe(false);
    expect(mockState.recipients.get(ids[2])).toMatchObject({ status: 'FAILED', suppressedReason: 'STOP_KEYWORD' });
  });

  test('timeout with no response: never resent and never left as a plain FAILED without the provider id', async () => {
    const { id, ids } = seed(3);
    mockState.respond = () => {
      const err: any = new Error('timeout of 20000ms exceeded');
      err.isAxiosError = true;
      err.code = 'ECONNABORTED';
      throw err;
    };
    await worker.processChunk({ broadcastId: id, recipientIds: ids, chunkIndex: 0 });

    expect(mockState.posts).toHaveLength(1);
    expect(mockState.retries).toHaveLength(0);
    for (const r of rows(ids)) {
      expect(r.status).toBe('FAILED');
      expect(r.providerMessageId).toBeTruthy(); // a late DLR lifts it to DELIVERED
    }
  });

  test('429 from the provider requeues for a later pass instead of failing', async () => {
    const { id, ids } = seed(6);
    mockState.respond = () => ({ status: 429, data: { requestError: { serviceException: { text: 'Too many requests' } } } });
    await worker.processChunk({ broadcastId: id, recipientIds: ids, chunkIndex: 0 });

    expect(rows(ids).every((r) => r.status === 'QUEUED')).toBe(true);
    expect(mockState.retries).toHaveLength(1);
    expect(new Set(mockState.retries[0].ids)).toEqual(new Set(ids));
    expect(mockState.retries[0].pass).toBe(1);
  });

  test('a per-message REJECTED marks only that recipient FAILED', async () => {
    const { id, ids } = seed(3);
    mockState.respond = (payload) => ({
      status: 200,
      data: {
        messages: payload.messages.map((m: any, i: number) => ({
          messageId: m.destinations[0].messageId,
          status: i === 1 ? { groupName: 'REJECTED', id: 51, description: 'Invalid destination' } : { groupName: 'PENDING' },
        })),
      },
    });
    await worker.processChunk({ broadcastId: id, recipientIds: ids, chunkIndex: 0 });
    expect(rows(ids).map((r) => r.status)).toEqual(['SENT', 'FAILED', 'SENT']);
  });

  test('a paused broadcast sends nothing and leaves recipients queued', async () => {
    const { id, ids } = seed(4);
    mockState.broadcasts.get(id)!.status = 'PAUSED';
    await worker.processChunk({ broadcastId: id, recipientIds: ids, chunkIndex: 0 });
    expect(mockState.posts).toHaveLength(0);
    expect(rows(ids).every((r) => r.status === 'QUEUED')).toBe(true);
  });

  test('MMS broadcasts keep the per-message path', () => {
    expect(worker.useBatchedSend(['https://x/y.jpg'])).toBe(false);
    expect(worker.useBatchedSend([])).toBe(true);
  });
});

describe('isAmbiguousNetworkFailure', () => {
  test('timeouts and resets are ambiguous; refused connections and HTTP errors are not', () => {
    expect(worker.isAmbiguousNetworkFailure({ statusCode: 0, retryable: true, providerCode: 'ECONNABORTED' })).toBe(true);
    expect(worker.isAmbiguousNetworkFailure({ statusCode: 0, retryable: true, providerCode: 'ECONNRESET' })).toBe(true);
    expect(worker.isAmbiguousNetworkFailure({ statusCode: 0, retryable: true, providerCode: 'ECONNREFUSED' })).toBe(false);
    expect(worker.isAmbiguousNetworkFailure({ statusCode: 429, retryable: true, providerCode: null })).toBe(false);
    expect(worker.isAmbiguousNetworkFailure({ statusCode: 0, retryable: false, providerCode: null })).toBe(false);
  });
});
