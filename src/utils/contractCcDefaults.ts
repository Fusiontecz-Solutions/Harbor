/** Always CC'd on every contract envelope (DocuSign / BoldSign). */
export const DEFAULT_CONTRACT_CC_EMAIL = 'admin@katancapital.com';

export function isDefaultContractCcEmail(email: string): boolean {
  return String(email || '').trim().toLowerCase() === DEFAULT_CONTRACT_CC_EMAIL.toLowerCase();
}

/** Default admin CC first, then any user-supplied addresses (deduped, case-insensitive). */
export function mergeDefaultContractCcEmails(
  emails?: string[] | null,
): string[] {
  const out: string[] = [DEFAULT_CONTRACT_CC_EMAIL];
  const seen = new Set<string>([DEFAULT_CONTRACT_CC_EMAIL.toLowerCase()]);
  for (const raw of emails || []) {
    const email = String(raw ?? '').trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}
