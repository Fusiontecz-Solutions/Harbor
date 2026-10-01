import prisma from '../../config/prismaClient';

/** Error code stored on messages refused while the tenant is paused. */
export const SENDING_DISABLED_CODE = 'TENANT_SENDING_DISABLED';
const ROW_ID = 1;
const CACHE_MS = 15_000;

export interface SendingState {
  enabled: boolean;
  reason: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

let cache: { state: SendingState; at: number } | null = null;

const DEFAULT_STATE: SendingState = { enabled: true, reason: null, updatedAt: null, updatedBy: null };

export async function getSendingState(options: { fresh?: boolean } = {}): Promise<SendingState> {
  if (!options.fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.state;
  try {
    const row = await prisma.tenantControl.findUnique({ where: { id: ROW_ID } });
    const state: SendingState = row
      ? {
          enabled: row.sendingEnabled,
          reason: row.reason,
          updatedAt: row.updatedAt.toISOString(),
          updatedBy: row.updatedBy,
        }
      : DEFAULT_STATE;
    cache = { state, at: Date.now() };
    return state;
  } catch (err) {
    // Missing table (migration not applied yet) or a DB blip must not stop
    // messaging; keep the last known state when there is one.
    console.error('[tenant-control] could not read sending state:', (err as Error)?.message);
    return cache?.state ?? DEFAULT_STATE;
  }
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
  const state: SendingState = {
    enabled: row.sendingEnabled,
    reason: row.reason,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
  cache = { state, at: Date.now() };
  return state;
}

/** Test hook. */
export function resetSendingStateCache(): void {
  cache = null;
}
