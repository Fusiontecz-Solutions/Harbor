function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === 'localhost' ||
    /^127\.\d+\.\d+\.\d+$/.test(h) ||
    h === '[::1]'
  );
}

/** e.g. `https://host/backend/api/v1/uploads` → `https://host` (for email links to the SPA on the same host). */
function tryPublicOriginFromCrmApiUrl(): string | undefined {
  const raw = String(process.env.CRM_API_URL || '').trim();
  if (!raw) return undefined;
  try {
    const u = new URL(/^https?:/i.test(raw) ? raw : `https://${raw}`);
    if (isLocalHostname(u.hostname)) return undefined;
    return u.origin.replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

function normalizeToOrigin(raw: string): string | undefined {
  const t = String(raw || '').trim();
  if (!t) return undefined;

  if (/^https?:\/\//i.test(t)) {
    return t.replace(/\/$/, '');
  }

  const host = t.replace(/^\/+/, '');
  const isLocal =
    /^localhost\b/i.test(host) ||
    /^127\.\d+\.\d+\.\d+/.test(host) ||
    /^\[::1\]/.test(host);

  const scheme = isLocal ? 'http' : 'https';
  return `${scheme}://${host}`.replace(/\/$/, '');
}

/**
 * Pick the first defined env var, return its normalized origin (or undefined).
 * Used to honor an explicit `FRONTEND_URL` override regardless of `NODE_ENV`.
 */
function pickExplicitFrontendUrlEnv(): string | undefined {
    const candidates = [
        process.env.FRONTEND_URL,
        process.env.PUBLIC_FRONTEND_URL,
        process.env.APP_FRONTEND_URL,
    ];
    for (const raw of candidates) {
        const t = String(raw || '').trim();
        if (!t) continue;
        const normalized = normalizeToOrigin(t);
        if (normalized && normalized.length > 0) return normalized;
    }
    return undefined;
}

/** First non-localhost origin from env candidates (safe for outbound email links). */
function pickFirstPublicFrontendOrigin(
    candidates: Array<string | undefined>,
): string | undefined {
    for (const raw of candidates) {
        const t = String(raw || '').trim();
        if (!t) continue;
        const normalized = normalizeToOrigin(t);
        if (!normalized) continue;
        try {
            if (isLocalHostname(new URL(normalized).hostname)) continue;
        } catch {
            continue;
        }
        return normalized;
    }
    return undefined;
}

/**
 * Absolute origin for links in emails (must be the **frontend** host where `/public/...` routes exist).
 *
 * Resolution order (applies in both dev and prod so a single env flip controls email links):
 *   1. Explicit override: `FRONTEND_URL` / `PUBLIC_FRONTEND_URL` / `APP_FRONTEND_URL`.
 *   2. Public origin from `CRM_API_URL`, `PUBLIC_SITE_ORIGIN`, `DOCUSIGN_SENDER_RETURN_URL`, etc.
 *      (used even when `NODE_ENV` is development so approval emails never default to localhost
 *      when a deployed frontend is configured).
 *   3. **Local (`NODE_ENV` ≠ `production`):** `LOCAL_FRONTEND_URL` / `DEV_FRONTEND_URL`,
 *      otherwise `http://localhost:5173`.
 *   4. **Production:** `APP_LOGIN_URL` and other fallbacks.
 *
 * To switch the approval-email link between local and live, set `FRONTEND_URL` in `.env`:
 *   - Local:  `FRONTEND_URL=http://localhost:5173`
 *   - Live:   `FRONTEND_URL=https://www.katan.finexusai.com`
 */
/**
 * Base URL for Decision Logic email links (`/decision-logic?token=...`).
 * Prefer a dedicated public origin so invitees never receive `localhost` when the API runs in dev/staging.
 */
export function resolveDecisionLogicInvitationBaseUrl(): string {
  const pick = (raw: string | undefined): string | undefined => {
    const t = String(raw || '').trim();
    if (!t) return undefined;
    const normalized = normalizeToOrigin(t);
    if (!normalized) return undefined;
    try {
      if (isLocalHostname(new URL(normalized).hostname)) return undefined;
    } catch {
      return undefined;
    }
    return normalized.replace(/\/$/, '');
  };

  return (
    pick(process.env.DECISION_LOGIC_PUBLIC_FRONTEND_URL) ||
    pick(process.env.PUBLIC_SITE_ORIGIN) ||
    pick(process.env.FRONTEND_URL) ||
    pick(process.env.CLIENT_PORTAL_URL) ||
    resolveCrmFrontendBaseUrl()?.replace(/\/$/, '') ||
    ''
  );
}

/** Public ISO approval portal — no CRM login required (`/public/application/approval/:token`). */
export function buildPublicApprovalPortalUrl(
  baseUrl: string,
  token: string,
): string {
  const origin = String(baseUrl || '').trim().replace(/\/$/, '');
  const secret = String(token || '').trim();
  return `${origin}/public/application/approval/${secret}`;
}

export function resolveCrmFrontendBaseUrl(): string | undefined {
  const inProd = process.env.NODE_ENV === 'production';

  const explicit = pickExplicitFrontendUrlEnv();
  if (explicit) return explicit;

  const fromCrmApi = tryPublicOriginFromCrmApiUrl();
  const publicOrigin = pickFirstPublicFrontendOrigin([
    fromCrmApi,
    process.env.PUBLIC_SITE_ORIGIN,
    process.env.APP_APPLICATION_URL,
    process.env.CLIENT_PORTAL_URL,
    process.env.DOCUSIGN_SENDER_RETURN_URL,
    process.env.VITE_APP_URL,
    process.env.APP_BASE_URL,
  ]);
  if (publicOrigin) return publicOrigin;

  if (!inProd) {
    const devLocal = String(
      process.env.LOCAL_FRONTEND_URL || process.env.DEV_FRONTEND_URL || '',
    ).trim();
    const normalized = devLocal ? normalizeToOrigin(devLocal) : undefined;
    return normalized && normalized.length > 0 ? normalized : 'https://www.katan.finexusai.com/';
  }

  let raw: string | undefined;
  if (process.env.APP_LOGIN_URL) {
    raw = process.env.APP_LOGIN_URL.replace(/\/login\/?$/i, '');
  }

  if (raw) {
    const normalized = normalizeToOrigin(raw);
    if (normalized) {
      try {
        if (!isLocalHostname(new URL(normalized).hostname)) {
          return normalized;
        }
      } catch {
        /* ignore */
      }
    }
  }

  return undefined;
}