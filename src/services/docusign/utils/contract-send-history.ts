import type { Prisma } from '@prisma/client';
import prisma from '../../../config/prismaClient';

/** Prior main-contract DocuSign sends — stored on `Contract.contractPrefillOverrides`. */
export const CONTRACT_SEND_HISTORY_KEY = 'contractSendHistory';

export type ContractSendHistoryEntry = {
  envelopeId: string;
  status: string;
  sentAt?: string | null;
  completedAt?: string | null;
  archivedAt: string;
};

export function parseContractSendHistoryFromPrefill(raw: unknown): ContractSendHistoryEntry[] {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const list = (raw as Record<string, unknown>)[CONTRACT_SEND_HISTORY_KEY];
  if (!Array.isArray(list)) return [];
  const out: ContractSendHistoryEntry[] = [];
  for (const item of list) {
    if (item == null || typeof item !== 'object' || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const envelopeId = String(o.envelopeId ?? '').trim();
    if (!envelopeId) continue;
    out.push({
      envelopeId,
      status: String(o.status ?? 'draft').trim().toLowerCase(),
      sentAt: o.sentAt != null ? String(o.sentAt) : null,
      completedAt: o.completedAt != null ? String(o.completedAt) : null,
      archivedAt: String(o.archivedAt ?? new Date(0).toISOString()),
    });
  }
  return out;
}

export function appendContractSendHistoryEntry(
  baseRaw: unknown,
  entry: Omit<ContractSendHistoryEntry, 'archivedAt'> & { archivedAt?: string },
): Record<string, unknown> {
  const base =
    baseRaw && typeof baseRaw === 'object' && !Array.isArray(baseRaw)
      ? { ...(baseRaw as Record<string, unknown>) }
      : {};
  const prior = parseContractSendHistoryFromPrefill(base);
  const envelopeId = String(entry.envelopeId ?? '').trim();
  if (!envelopeId) return base;
  if (prior.some((row) => row.envelopeId === envelopeId)) return base;

  const next: ContractSendHistoryEntry = {
    envelopeId,
    status: String(entry.status ?? 'draft').trim().toLowerCase(),
    sentAt: entry.sentAt ?? null,
    completedAt: entry.completedAt ?? null,
    archivedAt: entry.archivedAt ?? new Date().toISOString(),
  };

  return {
    ...base,
    [CONTRACT_SEND_HISTORY_KEY]: [...prior, next],
  };
}

export async function archiveMainContractEnvelopeToHistory(
  applicationId: string,
  snapshot: {
    envelopeId: string;
    status: string;
    sentAt?: Date | string | null;
    completedAt?: Date | string | null;
  },
): Promise<boolean> {
  const appId = String(applicationId || '').trim();
  const envelopeId = String(snapshot.envelopeId || '').trim();
  if (!appId || !envelopeId) return false;

  const contract = await prisma.contract.findUnique({
    where: { applicationId: appId },
    select: { id: true, contractPrefillOverrides: true },
  });
  if (!contract) return false;

  const merged = appendContractSendHistoryEntry(contract.contractPrefillOverrides, {
    envelopeId,
    status: snapshot.status,
    sentAt: snapshot.sentAt ? new Date(snapshot.sentAt).toISOString() : null,
    completedAt: snapshot.completedAt ? new Date(snapshot.completedAt).toISOString() : null,
    archivedAt: new Date().toISOString(),
  });

  await prisma.contract.update({
    where: { id: contract.id },
    data: {
      contractPrefillOverrides: merged as Prisma.InputJsonValue,
      status: 'DRAFT',
    },
  });
  return true;
}
