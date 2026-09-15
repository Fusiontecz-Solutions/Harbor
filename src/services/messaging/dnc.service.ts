/**
 * Do-Not-Call lookups.
 *
 * DNC providers bill per lookup, so results are cached twice: in Redis for the
 * hot path and in `MessagingDncCheck` permanently, keyed on the number. A
 * number we have already checked is never paid for again unless the caller
 * explicitly forces a refresh.
 *
 * A "listed" result writes a `DNC_LIST` suppression, which is what actually
 * blocks sending — this module reports, the suppression module enforces.
 *
 * Configure with:
 *   DNC_API_URL      lookup endpoint, receives ?phone=<e164>
 *   DNC_API_KEY      bearer token
 *   DNC_CACHE_DAYS   how long a stored result stays authoritative (default 30)
 */
import axios from 'axios';
import prisma from '../../config/prismaClient';
import { cacheGet, cacheKeys, cacheSet } from './cache.service';
import { normalizePhoneNumber } from './phone';
import { addSuppression, removeSuppression } from './suppression.service';

export type DncStatus = 'listed' | 'clear' | 'unknown';

export interface DncResult {
  phoneNumber: string;
  status: DncStatus;
  carrier: string | null;
  numberType: string | null;
  checkedAt: Date;
  /** True when served from Redis or the stored result rather than the provider. */
  cached: boolean;
}

const REDIS_TTL_SECONDS = 60 * 60 * 24; // a day in the hot cache

const storedResultMaxAgeMs = (): number => {
  const days = Number(process.env.DNC_CACHE_DAYS ?? '30');
  const safeDays = Number.isFinite(days) && days > 0 ? days : 30;
  return safeDays * 24 * 60 * 60 * 1000;
};

const isProviderConfigured = (): boolean =>
  Boolean(String(process.env.DNC_API_URL || '').trim());

/**
 * Look up one number.
 *
 * Returns `unknown` rather than throwing when no provider is configured or the
 * provider errors — an unavailable DNC service must not block messaging, and
 * `unknown` is honest about what we know. Internal suppression still applies.
 */
export async function checkDnc(phoneNumber: string, options?: { force?: boolean; userId?: string | null }): Promise<DncResult> {
  const normalized = normalizePhoneNumber(phoneNumber);
  if (!normalized) {
    throw new Error(`Invalid phone number: ${phoneNumber}`);
  }

  if (!options?.force) {
    const hot = await cacheGet<DncResult>(cacheKeys.dncResult(normalized));
    if (hot) return { ...hot, checkedAt: new Date(hot.checkedAt), cached: true };

    const stored = await prisma.messagingDncCheck.findUnique({
      where: { phoneNumber: normalized },
      select: { status: true, carrier: true, numberType: true, checkedAt: true },
    });

    if (stored && Date.now() - stored.checkedAt.getTime() < storedResultMaxAgeMs()) {
      const result: DncResult = {
        phoneNumber: normalized,
        status: stored.status as DncStatus,
        carrier: stored.carrier,
        numberType: stored.numberType,
        checkedAt: stored.checkedAt,
        cached: true,
      };
      await cacheSet(cacheKeys.dncResult(normalized), result, REDIS_TTL_SECONDS);
      return result;
    }
  }

  const fresh = await queryProvider(normalized);

  await prisma.messagingDncCheck.upsert({
    where: { phoneNumber: normalized },
    create: {
      phoneNumber: normalized,
      status: fresh.status,
      carrier: fresh.carrier,
      numberType: fresh.numberType,
      rawResponse: fresh.raw as never,
      checkedById: options?.userId ?? null,
    },
    update: {
      status: fresh.status,
      carrier: fresh.carrier,
      numberType: fresh.numberType,
      rawResponse: fresh.raw as never,
      checkedAt: new Date(),
      checkedById: options?.userId ?? null,
    },
  });

  // Keep the suppression table in step with the latest verdict.
  if (fresh.status === 'listed') {
    await addSuppression({
      phoneNumber: normalized,
      reason: 'DNC_LIST',
      source: 'DNC lookup',
      createdById: options?.userId ?? null,
    });
  } else if (fresh.status === 'clear') {
    await removeSuppression(normalized, 'DNC_LIST');
  }

  const result: DncResult = {
    phoneNumber: normalized,
    status: fresh.status,
    carrier: fresh.carrier,
    numberType: fresh.numberType,
    checkedAt: new Date(),
    cached: false,
  };

  await cacheSet(cacheKeys.dncResult(normalized), result, REDIS_TTL_SECONDS);
  return result;
}

/**
 * Batch lookup with bounded concurrency.
 *
 * Sequential lookups make checking a 5k-row import unusably slow; unbounded
 * parallelism gets us rate-limited by the DNC vendor. Ten at a time is the
 * same compromise Fivra settled on.
 */
export async function checkDncBulk(
  phoneNumbers: string[],
  options?: { userId?: string | null },
): Promise<DncResult[]> {
  const CONCURRENCY = Number(process.env.DNC_LOOKUP_CONCURRENCY ?? '10');
  const results: DncResult[] = [];

  for (let i = 0; i < phoneNumbers.length; i += CONCURRENCY) {
    const slice = phoneNumbers.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      slice.map((phone) => checkDnc(phone, { userId: options?.userId })),
    );

    for (const entry of settled) {
      if (entry.status === 'fulfilled') results.push(entry.value);
    }
  }

  return results;
}

interface ProviderResponse {
  status: DncStatus;
  carrier: string | null;
  numberType: string | null;
  raw: unknown;
}

async function queryProvider(phoneNumber: string): Promise<ProviderResponse> {
  if (!isProviderConfigured()) {
    return { status: 'unknown', carrier: null, numberType: null, raw: { reason: 'DNC_API_URL not configured' } };
  }

  try {
    const response = await axios.get(String(process.env.DNC_API_URL).trim(), {
      params: { phone: phoneNumber },
      timeout: Number(process.env.DNC_TIMEOUT_MS ?? '10000'),
      headers: {
        ...(process.env.DNC_API_KEY ? { Authorization: `Bearer ${String(process.env.DNC_API_KEY).trim()}` } : {}),
        Accept: 'application/json',
      },
      validateStatus: () => true,
    });

    if (response.status < 200 || response.status >= 300) {
      console.warn('[messaging:dnc] provider returned', response.status, 'for', phoneNumber);
      return { status: 'unknown', carrier: null, numberType: null, raw: response.data };
    }

    const body = response.data as Record<string, unknown>;
    return {
      status: interpretProviderStatus(body),
      carrier: body?.carrier ? String(body.carrier) : null,
      numberType: body?.numberType ? String(body.numberType) : body?.type ? String(body.type) : null,
      raw: body,
    };
  } catch (err) {
    console.warn('[messaging:dnc] lookup failed for', phoneNumber, (err as Error)?.message);
    return { status: 'unknown', carrier: null, numberType: null, raw: { error: (err as Error)?.message } };
  }
}

/**
 * DNC vendors disagree on response shape. Accept the common variants rather
 * than coupling to one vendor's schema, and fall back to `unknown` — never
 * guess "clear", because guessing clear is what sends a message to a listed
 * number.
 */
function interpretProviderStatus(body: Record<string, unknown>): DncStatus {
  const raw = String(body?.status ?? body?.result ?? body?.dncStatus ?? '').toLowerCase();

  if (['listed', 'dnc', 'blocked', 'do_not_call', 'true'].includes(raw)) return 'listed';
  if (['clear', 'ok', 'not_listed', 'safe', 'false'].includes(raw)) return 'clear';

  if (typeof body?.onDncList === 'boolean') return body.onDncList ? 'listed' : 'clear';
  if (typeof body?.isDnc === 'boolean') return body.isDnc ? 'listed' : 'clear';

  return 'unknown';
}
