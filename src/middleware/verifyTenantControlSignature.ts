import type { NextFunction, Request, Response } from 'express';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature } from '../services/tenantControl/signature';

/**
 * Authenticates calls from the central Tenant Console. Mounted outside the
 * user JWT chain: the HMAC over the raw body is the only credential.
 */
export function verifyTenantControlSignature(req: Request, res: Response, next: NextFunction): void {
  const secret = String(process.env.TENANT_CONTROL_SECRET || '').trim();
  if (!secret) {
    res.status(503).json({ success: false, message: 'Tenant control is not configured on this server.' });
    return;
  }

  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  const body = rawBody ? rawBody.toString('utf8') : '';
  const endpoint = req.path.replace(/\/+$/, '') || '/';
  const ok = verifySignature(
    secret,
    req.header(TIMESTAMP_HEADER),
    req.header(SIGNATURE_HEADER),
    req.method,
    endpoint,
    body,
  );

  if (!ok) {
    res.status(401).json({ success: false, message: 'Invalid tenant control signature.' });
    return;
  }
  next();
}
