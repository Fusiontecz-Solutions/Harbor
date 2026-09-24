import jwt from 'jsonwebtoken';
import type { Request } from 'express';

/**
 * DocuSign sender-view URLs are strictly single use.
 *
 * `POST .../envelopes/{id}/views/sender` returns
 * `https://apps-d.docusign.com/api/send/auth-from-console-1ds?code=…`. The first GET
 * 302s into the sending console and burns the `code`; every later GET returns 400,
 * which the DocuSign web app renders as
 * `/error?cause=initialization&widget_path=/send/authentication`
 * ("An error has occurred — make sure your connection is stable and try again").
 *
 * Handing that raw URL to a browser is therefore fragile: a reload, a back/forward,
 * a duplicated `window.open`, a link prefetch or a browser extension touching the URL
 * first is enough to make the tab the user actually looks at fail.
 *
 * So the CRM hands out its own redirect instead. The token below is a short-lived,
 * signed pointer at (user, envelope); `GET /docusign/open-sender-view/:token` mints a
 * brand new DocuSign code on every navigation and 302s to it. Reloading the tab just
 * mints another one.
 *
 * The token travels in a URL the browser navigates to, so it cannot carry an
 * Authorization header — the signature is the credential. Keep the TTL short and the
 * scope narrow (one envelope, one user, this purpose only).
 */
const HANDOFF_PURPOSE = 'docusign_sender_view';
const HANDOFF_TTL_SECONDS = 15 * 60;

/** Path on the DocuSign router (mounted at `/api/v1/docusign`). */
export const SENDER_VIEW_HANDOFF_PATH = '/open-sender-view';

export type SenderViewHandoffClaims = {
  userId: string;
  envelopeId: string;
  returnUrl: string;
  applicationId?: string;
  contractId?: number;
  funderName?: string;
  contractState?: string;
};

type SignedClaims = SenderViewHandoffClaims & { purpose: typeof HANDOFF_PURPOSE };

function handoffSecret(): string | null {
  return String(process.env.JWT_SECRET || '').trim() || null;
}

export function createSenderViewHandoffToken(
  claims: SenderViewHandoffClaims,
): string | null {
  const secret = handoffSecret();
  if (!secret) {
    console.warn(
      '[DocuSign] JWT_SECRET missing — sender-view handoff link disabled (raw one-time URL only).',
    );
    return null;
  }
  const userId = String(claims.userId || '').trim();
  const envelopeId = String(claims.envelopeId || '').trim();
  if (!userId || !envelopeId) return null;

  const payload: SignedClaims = {
    purpose: HANDOFF_PURPOSE,
    userId,
    envelopeId,
    returnUrl: String(claims.returnUrl || '').trim(),
    ...(claims.applicationId ? { applicationId: String(claims.applicationId).trim() } : {}),
    ...(Number.isFinite(Number(claims.contractId)) && Number(claims.contractId) > 0
      ? { contractId: Number(claims.contractId) }
      : {}),
    ...(claims.funderName ? { funderName: String(claims.funderName).trim() } : {}),
    ...(claims.contractState ? { contractState: String(claims.contractState).trim() } : {}),
  };

  return jwt.sign(payload, secret, { expiresIn: HANDOFF_TTL_SECONDS });
}

export function verifySenderViewHandoffToken(
  token: string,
): SenderViewHandoffClaims | null {
  const secret = handoffSecret();
  if (!secret) return null;
  try {
    const decoded = jwt.verify(String(token || '').trim(), secret) as Partial<SignedClaims>;
    if (decoded?.purpose !== HANDOFF_PURPOSE) return null;
    const userId = String(decoded.userId || '').trim();
    const envelopeId = String(decoded.envelopeId || '').trim();
    if (!userId || !envelopeId) return null;
    return {
      userId,
      envelopeId,
      returnUrl: String(decoded.returnUrl || '').trim(),
      applicationId: decoded.applicationId,
      contractId: decoded.contractId,
      funderName: decoded.funderName,
      contractState: decoded.contractState,
    };
  } catch {
    return null;
  }
}

/** Absolute link the browser can navigate to, derived from the request that asked for it. */
export function buildSenderViewHandoffUrl(req: Request, token: string): string {
  const path = `${req.baseUrl.replace(/\/+$/, '')}${SENDER_VIEW_HANDOFF_PATH}/${token}`;
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim();
  const proto = forwardedProto || req.protocol || 'https';
  const host = req.get('host');
  return host ? `${proto}://${host}${path}` : path;
}
