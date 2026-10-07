import crypto from 'crypto';

/**
 * Tenant Control API v1 request signing. Must stay byte-for-byte identical to
 * the Tenant Console's `src/lib/tenant-control/contract.ts`.
 */
export const TIMESTAMP_HEADER = 'x-tenant-control-timestamp';
export const SIGNATURE_HEADER = 'x-tenant-control-signature';
export const MAX_SKEW_SECONDS = 300;

export const canonicalString = (timestamp: string, method: string, endpoint: string, body: string): string =>
  `${timestamp}.${method.toUpperCase()}.${endpoint}.${body}`;

export function verifySignature(
  secret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  method: string,
  endpoint: string,
  body: string,
  now = Date.now(),
): boolean {
  if (!secret || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(canonicalString(timestamp, method, endpoint, body))
    .digest();
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
