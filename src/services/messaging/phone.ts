/**
 * Phone number normalization.
 *
 * Every number that crosses the messaging boundary — imported from a
 * spreadsheet, typed by an agent, echoed back by Infobip, or looked up in the
 * suppression table — is funneled through {@link normalizePhoneNumber} first.
 *
 * Without one canonical form, `(555) 123-4567`, `5551234567` and `+15551234567`
 * become three different contacts, three different conversations, and a blocked
 * number that still receives a broadcast. Normalization is the correctness
 * boundary for the whole module, not a formatting nicety.
 *
 * Storage format is E.164 (`+15551234567`). Display formatting lives in the FE.
 */

/** Default country calling code applied to bare national numbers. */
const DEFAULT_COUNTRY_CODE = String(process.env.MESSAGING_DEFAULT_COUNTRY_CODE || '1').replace(/\D/g, '') || '1';

/**
 * Convert user/provider input into E.164, or return null when the value cannot
 * be a dialable number. Callers MUST treat null as "reject this row" rather
 * than falling back to the raw string.
 */
export function normalizePhoneNumber(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;

  const input = String(raw).trim();
  if (!input) return null;

  // Preserve a leading + before stripping, so we can tell "already international"
  // from "national number that happens to start with the country code".
  const hadPlus = input.startsWith('+');
  const digits = input.replace(/\D/g, '');
  if (!digits) return null;

  if (hadPlus) {
    // Trust an explicit +, only sanity-check the length.
    return isPlausibleE164Digits(digits) ? `+${digits}` : null;
  }

  // NANP: 10 digits is a national number, 11 starting with 1 is already prefixed.
  if (DEFAULT_COUNTRY_CODE === '1') {
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    // Anything else without a + is ambiguous; accept only if it looks international.
    return isPlausibleE164Digits(digits) ? `+${digits}` : null;
  }

  if (digits.startsWith(DEFAULT_COUNTRY_CODE)) {
    return isPlausibleE164Digits(digits) ? `+${digits}` : null;
  }

  const prefixed = `${DEFAULT_COUNTRY_CODE}${digits}`;
  return isPlausibleE164Digits(prefixed) ? `+${prefixed}` : null;
}

/** E.164 allows 8–15 digits including the country code. */
function isPlausibleE164Digits(digits: string): boolean {
  return digits.length >= 8 && digits.length <= 15 && !/^0+$/.test(digits);
}

/**
 * Infobip returns destinations WITHOUT the leading `+`. Use this when building
 * request payloads; use {@link normalizePhoneNumber} when reading them back.
 */
export function toInfobipDestination(e164: string): string {
  return String(e164 || '').replace(/^\+/, '');
}

/**
 * Sender IDs may be alphanumeric ("HARBOR"), not just numbers. Normalize only
 * when the value looks like a phone number so branded senders survive intact.
 */
export function normalizeSender(raw: unknown): string {
  const input = String(raw ?? '').trim();
  if (!input) return '';
  if (/^[+\d][\d\s().-]*$/.test(input)) {
    return normalizePhoneNumber(input) ?? input;
  }
  return input;
}

/** Stable dedupe key for a conversation, independent of leg ordering. */
export function conversationKey(businessNumber: string, contactNumber: string): string {
  return `${normalizeSender(businessNumber)}::${normalizePhoneNumber(contactNumber) ?? contactNumber}`;
}
