import { EMAIL_BRAND_DISPLAY_NAME } from '../constants/emailBrand';
import { sanitizeLetterPdfFilename } from '../services/pdf/letterHtmlToPdf.service';

/** Lender prefix for contract envelope email subjects and PDF names. */
export const CONTRACT_ENVELOPE_LENDER_NAME = String(
  process.env.DOCUSIGN_EMAIL_LENDER_NAME || EMAIL_BRAND_DISPLAY_NAME,
).trim();

/** Contract envelope subject / PDF name: {FunderName}: BusinessName */
export function buildContractEnvelopeEmailSubject(
  businessName: string,
  _offerAmount?: number | string | null,
  funderName?: string | null,
): string {
  const business = String(businessName || '').trim() || 'Business';
  const lender =
    String(funderName || '').trim() || CONTRACT_ENVELOPE_LENDER_NAME;
  return `${lender}: ${business}`;
}

/** ACH / standalone subject / PDF name: {FunderName}: BusinessName - ACH */
export function buildAchFormEnvelopeEmailSubject(
  businessName: string,
  _offerAmount?: number | string | null,
  funderName?: string | null,
): string {
  const business = String(businessName || '').trim() || 'Business';
  const lender =
    String(funderName || '').trim() || CONTRACT_ENVELOPE_LENDER_NAME;
  return `${lender}: ${business} - ACH`;
}

export function buildContractEnvelopePdfFilename(subject: string): string {
  return sanitizeLetterPdfFilename(subject);
}

export function buildContractEnvelopeDocumentName(subject: string): string {
  return buildContractEnvelopePdfFilename(subject).replace(/\.pdf$/i, '');
}

export function normalizeContractCcEmailSubject(subject: string | null | undefined): string {
  const trimmed = String(subject || '').trim();
  return trimmed || 'Contract';
}

/** @deprecated Use buildContractEnvelopeEmailSubject */
export function buildDocuSignEnvelopeEmailSubject(
  businessName: string,
  offerAmount?: number | string | null,
  funderName?: string | null,
): string {
  return buildContractEnvelopeEmailSubject(businessName, offerAmount, funderName);
}
