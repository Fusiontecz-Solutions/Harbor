import prisma from '../../config/prismaClient';
import { SENDING_DISABLED_CODE } from './counting';

export { SENDING_DISABLED_CODE };
const ROW_ID = 1;
const CACHE_MS = 15_000;

export interface SendingState {
  enabled: boolean;
  reason: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export type LimitCountBy = 'messages' | 'segments';
export type LimitScope = 'monthly' | 'daily' | 'total';

/** The quota the console set. `limit: null` means none. */
export interface QuotaConfig {
  limit: number | null;
  countBy: LimitCountBy;
  scope: LimitScope;
  resetDay: number;
  updatedAt: string | null;
}

interface ControlState {
  sending: SendingState;
  quota: QuotaConfig;
}

let cache: { state: ControlState; at: number } | null = null;

const DEFAULT_STATE: ControlState = {
  sending: { enabled: true, reason: null, updatedAt: null, updatedBy: null },
  quota: { limit: null, countBy: 'messages', scope: 'monthly', resetDay: 1, updatedAt: null },
};

type ControlRow = NonNullable<Awaited<ReturnType<typeof prisma.tenantControl.findUnique>>>;

function toState(row: ControlRow | null): ControlState {
  if (!row) return DEFAULT_STATE;
  return {
    sending: {
      enabled: row.sendingEnabled,
      reason: row.reason,
      updatedAt: row.updatedAt.toISOString(),
      updatedBy: row.updatedBy,
    },
    quota: {
      limit: row.messageLimit,
      countBy: row.limitCountBy === 'segments' ? 'segments' : 'messages',
      scope: row.limitScope === 'daily' || row.limitScope === 'total' ? row.limitScope : 'monthly',
      resetDay: row.limitResetDay,
      updatedAt: row.limitUpdatedAt?.toISOString() ?? null,
    },
  };
}

async function readState(options: { fresh?: boolean }): Promise<ControlState> {
  if (!options.fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.state;
  try {
    const state = toState(await prisma.tenantControl.findUnique({ where: { id: ROW_ID } }));
    cache = { state, at: Date.now() };
    return state;
  } catch (err) {
    // Quota columns missing (v2 migration not applied yet): the pause switch
    // must keep working, so read just the v1 columns.
    try {
      const row = await prisma.tenantControl.findUnique({
        where: { id: ROW_ID },
        select: { sendingEnabled: true, reason: true, updatedBy: true, updatedAt: true },
      });
      const state: ControlState = row
        ? {
            sending: {
              enabled: row.sendingEnabled,
              reason: row.reason,
              updatedAt: row.updatedAt.toISOString(),
              updatedBy: row.updatedBy,
            },
            quota: DEFAULT_STATE.quota,
          }
        : DEFAULT_STATE;
      cache = { state, at: Date.now() };
      return state;
    } catch {
      // Handled below.
    }
    // Missing table (migration not applied yet) or a DB blip must not stop
    // messaging; keep the last known state when there is one.
    console.error('[tenant-control] could not read control state:', (err as Error)?.message);
    return cache?.state ?? DEFAULT_STATE;
  }
}

export async function getSendingState(options: { fresh?: boolean } = {}): Promise<SendingState> {
  return (await readState(options)).sending;
}

export async function getQuotaConfig(options: { fresh?: boolean } = {}): Promise<QuotaConfig> {
  return (await readState(options)).quota;
}

export async function setSendingState(input: {
  enabled: boolean;
  reason?: string | null;
  updatedBy?: string | null;
}): Promise<SendingState> {
  const reason = input.enabled ? null : input.reason?.trim().slice(0, 500) || null;
  const updatedBy = input.updatedBy?.trim().slice(0, 200) || null;
  const row = await prisma.tenantControl.upsert({
    where: { id: ROW_ID },
    create: { id: ROW_ID, sendingEnabled: input.enabled, reason, updatedBy },
    update: { sendingEnabled: input.enabled, reason, updatedBy },
  });
  const state = toState(row);
  cache = { state, at: Date.now() };
  return state.sending;
}

export async function setQuotaConfig(input: {
  limit: number | null;
  countBy: LimitCountBy;
  scope: LimitScope;
  resetDay: number;
  updatedBy?: string | null;
}): Promise<QuotaConfig> {
  const data = {
    messageLimit: input.limit,
    limitCountBy: input.countBy,
    limitScope: input.scope,
    limitResetDay: input.resetDay,
    limitUpdatedBy: input.updatedBy?.trim().slice(0, 200) || null,
    limitUpdatedAt: new Date(),
  };
  const row = await prisma.tenantControl.upsert({
    where: { id: ROW_ID },
    create: { id: ROW_ID, ...data },
    update: data,
  });
  const state = toState(row);
  cache = { state, at: Date.now() };
  return state.quota;
}

/** Test hook. */
export function resetSendingStateCache(): void {
  cache = null;
}
