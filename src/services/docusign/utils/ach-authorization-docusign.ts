import type { Prisma } from '@prisma/client';
import prisma from '../../../config/prismaClient';

/** Stored on `Contract.contractPrefillOverrides` — separate from main contract envelope. */
export const ACH_AUTHORIZATION_DOCUSIGN_KEY = 'achAuthorizationDocuSign';

export type AchAuthorizationDocuSignCapsuleStatus = 'DRAFT' | 'SENT' | 'VIEWED' | 'SIGNED';

export type AchAuthorizationDocuSignMeta = {
  envelopeId: string;
  status: AchAuthorizationDocuSignCapsuleStatus;
  sentAt?: string | null;
  updatedAt?: string | null;
};

export function mapInternalEnvelopeStatusToAchCapsule(
  internalStatus: unknown,
): AchAuthorizationDocuSignCapsuleStatus {
  const k = String(internalStatus ?? '')
    .trim()
    .toLowerCase();
  if (k === 'completed' || k === 'signed') return 'SIGNED';
  if (k === 'viewed' || k === 'delivered') return 'VIEWED';
  if (k === 'sent' || k === 'processing') return 'SENT';
  return 'DRAFT';
}

export function parseAchAuthorizationDocuSignFromPrefill(
  raw: unknown,
): AchAuthorizationDocuSignMeta | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const blob = (raw as Record<string, unknown>)[ACH_AUTHORIZATION_DOCUSIGN_KEY];
  if (blob == null || typeof blob !== 'object' || Array.isArray(blob)) return null;
  const o = blob as Record<string, unknown>;
  const envelopeId = String(o.envelopeId ?? '').trim();
  if (!envelopeId) return null;
  const statusRaw = String(o.status ?? 'DRAFT').trim().toUpperCase();
  const status: AchAuthorizationDocuSignCapsuleStatus =
    statusRaw === 'SENT' || statusRaw === 'VIEWED' || statusRaw === 'SIGNED'
      ? statusRaw
      : 'DRAFT';
  return {
    envelopeId,
    status,
    sentAt: o.sentAt != null ? String(o.sentAt) : null,
    updatedAt: o.updatedAt != null ? String(o.updatedAt) : null,
  };
}

export function mergeAchAuthorizationDocuSignIntoPrefill(
  baseRaw: unknown,
  patch: Partial<AchAuthorizationDocuSignMeta> & { envelopeId: string },
): Record<string, unknown> {
  const base =
    baseRaw && typeof baseRaw === 'object' && !Array.isArray(baseRaw)
      ? { ...(baseRaw as Record<string, unknown>) }
      : {};
  const prior = parseAchAuthorizationDocuSignFromPrefill(base) ?? {
    envelopeId: patch.envelopeId,
    status: 'DRAFT' as const,
  };
  const status = patch.status ?? prior.status;
  const now = new Date().toISOString();
  const meta: AchAuthorizationDocuSignMeta = {
    envelopeId: String(patch.envelopeId || prior.envelopeId).trim(),
    status,
    sentAt:
      patch.sentAt !== undefined
        ? patch.sentAt
        : status === 'SENT' || status === 'VIEWED' || status === 'SIGNED'
          ? prior.sentAt ?? now
          : prior.sentAt ?? null,
    updatedAt: patch.updatedAt ?? now,
  };
  return {
    ...base,
    [ACH_AUTHORIZATION_DOCUSIGN_KEY]: meta,
  };
}

export async function contractHasAchAuthorizationEnvelope(envelopeId: string): Promise<boolean> {
  const eid = String(envelopeId || '').trim();
  if (!eid) return false;
  const count = await prisma.contract.count({
    where: {
      contractPrefillOverrides: {
        path: [ACH_AUTHORIZATION_DOCUSIGN_KEY, 'envelopeId'],
        equals: eid,
      },
    },
  });
  return count > 0;
}

export async function linkAchAuthorizationEnvelopeToContract(
  applicationId: string,
  envelopeId: string,
  internalStatus = 'draft',
): Promise<void> {
  const appId = String(applicationId || '').trim();
  const eid = String(envelopeId || '').trim();
  if (!appId || !eid) return;

  const capsule = mapInternalEnvelopeStatusToAchCapsule(internalStatus);
  const now = new Date().toISOString();

  const contracts = await prisma.contract.findMany({
    where: { applicationId: appId },
    select: { id: true, contractPrefillOverrides: true },
    orderBy: { id: 'desc' },
    take: 1,
  });

  for (const contract of contracts) {
    const merged = mergeAchAuthorizationDocuSignIntoPrefill(contract.contractPrefillOverrides, {
      envelopeId: eid,
      status: capsule,
      sentAt: capsule !== 'DRAFT' ? now : null,
      updatedAt: now,
    });
    await prisma.contract.update({
      where: { id: contract.id },
      data: { contractPrefillOverrides: merged as Prisma.InputJsonValue },
    });
  }
}

export async function updateAchAuthorizationDocuSignStatus(
  envelopeId: string,
  internalStatus: string,
): Promise<boolean> {
  const eid = String(envelopeId || '').trim();
  if (!eid) return false;

  const capsule = mapInternalEnvelopeStatusToAchCapsule(internalStatus);
  const now = new Date().toISOString();

  const contracts = await prisma.contract.findMany({
    where: {
      contractPrefillOverrides: {
        path: [ACH_AUTHORIZATION_DOCUSIGN_KEY, 'envelopeId'],
        equals: eid,
      },
    },
    select: { id: true, contractPrefillOverrides: true },
  });

  if (!contracts.length) return false;

  for (const contract of contracts) {
    const merged = mergeAchAuthorizationDocuSignIntoPrefill(contract.contractPrefillOverrides, {
      envelopeId: eid,
      status: capsule,
      updatedAt: now,
    });
    await prisma.contract.update({
      where: { id: contract.id },
      data: { contractPrefillOverrides: merged as Prisma.InputJsonValue },
    });
  }
  return true;
}
