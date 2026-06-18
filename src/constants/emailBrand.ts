/** Canonical sender / header brand for all outbound CRM email. */
export const EMAIL_BRAND_DISPLAY_NAME = 'KATAN CAPITAL';

const LEGACY_BRAND_NAME_RE = /woodmere|barclays|hardrock/i;

/**
 * Resolves the display name for email From headers and HTML text fallbacks.
 * Legacy third-party brand env values are ignored — always KATAN CAPITAL instead.
 */
export function resolveEmailBrandDisplayName(): string {
    const raw =
        process.env.MAIL_FROM_NAME?.trim() ||
        process.env.SENDGRID_FROM_NAME?.trim() ||
        '';
    if (raw && !LEGACY_BRAND_NAME_RE.test(raw)) {
        return raw;
    }
    return EMAIL_BRAND_DISPLAY_NAME;
}
