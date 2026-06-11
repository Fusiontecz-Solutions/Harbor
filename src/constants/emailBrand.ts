/** Canonical sender / header brand for all outbound CRM email. */
export const EMAIL_BRAND_DISPLAY_NAME = 'KATAN CAPITAL';

/**
 * Resolves the display name for email From headers and HTML text fallbacks.
 * Woodmere (legacy env) is never used — always KATAN CAPITAL instead.
 */
export function resolveEmailBrandDisplayName(): string {
    const raw =
        process.env.MAIL_FROM_NAME?.trim() ||
        process.env.SENDGRID_FROM_NAME?.trim() ||
        '';
    if (raw && !/woodmere/i.test(raw)) {
        return raw;
    }
    return EMAIL_BRAND_DISPLAY_NAME;
}
