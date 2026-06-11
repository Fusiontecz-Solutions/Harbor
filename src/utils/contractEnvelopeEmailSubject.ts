/** Fixed lender name in DocuSign signer email subject (maps to envelope `emailSubject`). */
export const DOCUSIGN_EMAIL_LENDER_NAME = String(
  process.env.DOCUSIGN_EMAIL_LENDER_NAME || 'KATAN CAPITAL LLC',
).trim();

/** DocuSign envelope email subject: fixed lender + per-deal client name. */
export function buildDocuSignEnvelopeEmailSubject(clientName: string): string {
  const client = String(clientName || '').trim() || 'Client';
  return `Complete with Docusign: ${DOCUSIGN_EMAIL_LENDER_NAME} - ${client}`;
}

export function normalizeContractCcEmailSubject(subject: string | null | undefined): string {
  const trimmed = String(subject || '').trim();
  return trimmed || 'Contract';
}
