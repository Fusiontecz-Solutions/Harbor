import { Prisma } from '@prisma/client';
import prisma from '../../config/prismaClient';
import { LIMIT_REACHED_CODE } from './counting';
import { resetSendingStateCache } from './state';

export class PrepaidExhaustedError extends Error {
  readonly code = LIMIT_REACHED_CODE;
  constructor() {
    super('Prepaid SMS balance is exhausted. Top up in the Tenant Console.');
    this.name = 'PrepaidExhaustedError';
  }
}

/** Console-managed prepaid balance surfaced on GET /status. */
export interface PrepaidState {
  balance: number;
  pricePerUnit: number;
  inboundPricePerUnit: number | null;
  currency: string;
  chargeBy: 'messages' | 'segments';
  updatedAt: string | null;
}

const ROW_ID = 1;
const CACHE_MS = 5_000;
let cache: { state: PrepaidState | null; at: number } | null = null;

const money = (v: Prisma.Decimal | number | null | undefined): number =>
  v === null || v === undefined ? 0 : Math.round(Number(v) * 1_000_000) / 1_000_000;

function rowToPrepaid(row: {
  prepaidBalance: Prisma.Decimal | null;
  prepaidUnitPrice: Prisma.Decimal | null;
  prepaidInboundUnitPrice?: Prisma.Decimal | null;
  prepaidCurrency: string | null;
  prepaidChargeBy: string | null;
  prepaidUpdatedAt: Date | null;
}): PrepaidState | null {
  if (row.prepaidUnitPrice === null) return null;
  const inbound =
    row.prepaidInboundUnitPrice === null || row.prepaidInboundUnitPrice === undefined
      ? null
      : money(row.prepaidInboundUnitPrice);
  return {
    balance: money(row.prepaidBalance),
    pricePerUnit: money(row.prepaidUnitPrice),
    inboundPricePerUnit: inbound,
    currency: row.prepaidCurrency?.trim() || 'USD',
    chargeBy: row.prepaidChargeBy === 'segments' ? 'segments' : 'messages',
    updatedAt: row.prepaidUpdatedAt?.toISOString() ?? null,
  };
}

export async function getPrepaidState(options: { fresh?: boolean } = {}): Promise<PrepaidState | null> {
  if (!options.fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.state;
  try {
    const row = await prisma.tenantControl.findUnique({ where: { id: ROW_ID } });
    const state = row ? rowToPrepaid(row) : null;
    cache = { state, at: Date.now() };
    return state;
  } catch (err) {
    console.error('[tenant-control] could not read prepaid state:', (err as Error)?.message);
    return cache?.state ?? null;
  }
}

export async function setPrepaidState(input: {
  balance: number;
  pricePerUnit: number;
  inboundPricePerUnit?: number | null;
  currency?: string;
  chargeBy?: 'messages' | 'segments';
  updatedBy?: string | null;
}): Promise<PrepaidState> {
  const data: {
    prepaidBalance: Prisma.Decimal;
    prepaidUnitPrice: Prisma.Decimal;
    prepaidInboundUnitPrice?: Prisma.Decimal | null;
    prepaidCurrency: string;
    prepaidChargeBy: string;
    prepaidUpdatedBy: string | null;
    prepaidUpdatedAt: Date;
  } = {
    prepaidBalance: new Prisma.Decimal(Math.max(0, input.balance).toFixed(4)),
    prepaidUnitPrice: new Prisma.Decimal(input.pricePerUnit.toFixed(6)),
    prepaidCurrency: (input.currency ?? 'USD').trim().slice(0, 8) || 'USD',
    prepaidChargeBy: input.chargeBy === 'segments' ? 'segments' : 'messages',
    prepaidUpdatedBy: input.updatedBy?.trim().slice(0, 200) || null,
    prepaidUpdatedAt: new Date(),
  };
  if (input.inboundPricePerUnit !== undefined) {
    data.prepaidInboundUnitPrice =
      input.inboundPricePerUnit === null
        ? null
        : new Prisma.Decimal(input.inboundPricePerUnit.toFixed(6));
  }
  const row = await prisma.tenantControl.upsert({
    where: { id: ROW_ID },
    create: { id: ROW_ID, ...data },
    update: data,
  });
  const state = rowToPrepaid(row)!;
  cache = { state, at: Date.now() };
  resetSendingStateCache();
  return state;
}

function unitCost(state: PrepaidState, segments: number | null, direction: 'outbound' | 'inbound'): number {
  const units = state.chargeBy === 'segments' ? Math.max(1, segments ?? 1) : 1;
  const rate =
    direction === 'inbound' ? state.inboundPricePerUnit ?? state.pricePerUnit : state.pricePerUnit;
  return units * rate;
}

/**
 * Refuses the send when prepaid is configured and balance is too low.
 * `count` lets a provider batch check its whole cost once.
 */
export async function assertPrepaidBalance(segments: number | null, count = 1): Promise<void> {
  const state = await getPrepaidState();
  if (!state || state.pricePerUnit <= 0) return;
  const cost = unitCost(state, segments, 'outbound') * Math.max(1, count);
  if (state.balance + 1e-9 < cost) throw new PrepaidExhaustedError();
}

/** Deduct after Infobip accepted the message. */
export async function deductPrepaidAfterSend(segments: number | null): Promise<void> {
  const state = await getPrepaidState({ fresh: true });
  if (!state || state.pricePerUnit <= 0) return;
  const cost = unitCost(state, segments, 'outbound');
  try {
    await prisma.$executeRaw`
      UPDATE "TenantControl"
         SET "prepaidBalance" = GREATEST(0, COALESCE("prepaidBalance", 0) - ${cost}),
             "prepaidUpdatedAt" = NOW()
       WHERE "id" = ${ROW_ID}`;
    cache = null;
  } catch (err) {
    console.error('[tenant-control] prepaid deduct failed:', (err as Error)?.message);
  }
}

/** Batch variant: one read + one UPDATE for every message a provider batch accepted. */
export async function deductPrepaidAfterSendBatch(segments: Array<number | null>): Promise<void> {
  if (segments.length === 0) return;
  const state = await getPrepaidState({ fresh: true });
  if (!state || state.pricePerUnit <= 0) return;
  const cost = segments.reduce<number>((sum, s) => sum + unitCost(state, s, 'outbound'), 0);
  try {
    await prisma.$executeRaw`
      UPDATE "TenantControl"
         SET "prepaidBalance" = GREATEST(0, COALESCE("prepaidBalance", 0) - ${cost}),
             "prepaidUpdatedAt" = NOW()
       WHERE "id" = ${ROW_ID}`;
    cache = null;
  } catch (err) {
    console.error('[tenant-control] prepaid batch deduct failed:', (err as Error)?.message);
  }
}

export async function deductPrepaidAfterInbound(segments: number | null): Promise<void> {
  const state = await getPrepaidState({ fresh: true });
  if (!state || state.pricePerUnit <= 0) return;
  const cost = unitCost(state, segments, 'inbound');
  try {
    await prisma.$executeRaw`
      UPDATE "TenantControl"
         SET "prepaidBalance" = GREATEST(0, COALESCE("prepaidBalance", 0) - ${cost}),
             "prepaidUpdatedAt" = NOW()
       WHERE "id" = ${ROW_ID}`;
    cache = null;
  } catch (err) {
    console.error('[tenant-control] prepaid inbound deduct failed:', (err as Error)?.message);
  }
}

export function resetPrepaidCache(): void {
  cache = null;
}
