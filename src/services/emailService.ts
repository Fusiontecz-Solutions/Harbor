import fs from 'fs';
import path from 'path';
import sendMail, { isOutboundSmtpConfigured, sendSendGridMail } from '../config/nodemailer';
import { resolveEmailBrandDisplayName } from '../constants/emailBrand';
import {
  resolveCrmFrontendBaseUrl,
  resolveDecisionLogicInvitationBaseUrl,
} from '../utils/crmFrontendUrl';

/**
 * Inline brand logos used inside transactional email templates.
 * The light variant has dark artwork on a transparent background (suits
 * default white email canvases), while the dark variant has light artwork
 * for clients that render the message in dark mode.
 *
 * Files live under `<project-root>/public/` (NOT in `src/`) so they survive
 * the `tsc` build (`rootDir: ./src` would otherwise strip non-`.ts` files).
 */
const BRAND_ASSETS_DIR = path.resolve(__dirname, '..', '..', 'public');
const BRAND_LIGHT_LOGO_PATH = path.join(BRAND_ASSETS_DIR, 'katan_transparent.png');
const BRAND_DARK_LOGO_PATH = path.join(BRAND_ASSETS_DIR, 'katan_dark_theme_logo.png');

const BRAND_LIGHT_LOGO_CID = 'brand-logo-light@finexusai';
const BRAND_DARK_LOGO_CID = 'brand-logo-dark@finexusai';

const DEFAULT_BRAND_NAME = resolveEmailBrandDisplayName();

function brandLogoFileExists(filePath: string): boolean {
    try {
        return fs.existsSync(filePath);
    } catch {
        return false;
    }
}

export function hasBrandLogoAssets(): boolean {
    return (
        brandLogoFileExists(BRAND_LIGHT_LOGO_PATH) ||
        brandLogoFileExists(BRAND_DARK_LOGO_PATH)
    );
}

/**
 * Inline attachments (Content-ID) for the katan logo. Pass these to
 * `sendMail` whenever the HTML body contains the brand header so the
 * `cid:...` references in the markup resolve to real images.
 * Skips files that are not on disk so SMTP send does not fail with ENOENT.
 */
export function buildBrandLogoAttachments(): Array<{
    filename: false;
    path: string;
    cid: string;
    contentType: string;
    contentDisposition: 'inline';
}> {
    const attachments: Array<{
        filename: false;
        path: string;
        cid: string;
        contentType: string;
        contentDisposition: 'inline';
    }> = [];

    if (brandLogoFileExists(BRAND_LIGHT_LOGO_PATH)) {
        attachments.push({
            filename: false,
            path: BRAND_LIGHT_LOGO_PATH,
            cid: BRAND_LIGHT_LOGO_CID,
            contentType: 'image/png',
            contentDisposition: 'inline',
        });
    }

    if (brandLogoFileExists(BRAND_DARK_LOGO_PATH)) {
        attachments.push({
            filename: false,
            path: BRAND_DARK_LOGO_PATH,
            cid: BRAND_DARK_LOGO_CID,
            contentType: 'image/png',
            contentDisposition: 'inline',
        });
    }

    if (!attachments.length) {
        // eslint-disable-next-line no-console
        console.warn(
            '[email] Brand logo files not found under public/. Emails will use a text header instead. Expected:',
            BRAND_LIGHT_LOGO_PATH,
        );
    }

    return attachments;
}

/**
 * Theme-aware brand header (`<tr>` row) used at the top of every
 * transactional email. Non-Outlook clients paint the CID via CSS
 * `background-image` rather than `<img>` so Gmail Web does not wrap the graphic
 * in its image hover toolbar (download / Drive / Photos). Outlook Windows still
 * uses `<img>` (VML/Word layout) inside the `[if mso]` branch.
 *
 * Returns the table row markup only — callers paste it where the previous
 * `<span>FinexusAI</span>` row used to live.
 */
function buildBrandHeaderRowHtml(): string {
    if (!hasBrandLogoAssets()) {
        return `
                    <tr>
                        <td align="center" style="padding: 20px 24px 8px;">
                            <p style="margin:0; color:#276D9C; font-size:22px; font-weight:700; font-family: Arial, Helvetica, sans-serif; letter-spacing:0.02em;">
                                ${DEFAULT_BRAND_NAME}
                            </p>
                        </td>
                    </tr>`;
    }

    return `
                    <tr>
                        <td align="center" style="padding: 6px 16px 0; line-height: 0; font-size: 0;">
                            <!--[if !mso]><!-->
                            <table role="presentation" align="center" border="0" cellpadding="0" cellspacing="0" style="margin:0 auto;">
                                <tr>
                                    <td align="center" style="padding:0; line-height:0; font-size:0;">
                            <div class="brand-logo-bg-light brand-logo-bg-slot"
                                 role="presentation"
                                 aria-hidden="true"
                                 style="display:inline-block; margin:0; padding:0; vertical-align:top;
                                        width:180px; height:78px;
                                        background-image:url('cid:${BRAND_LIGHT_LOGO_CID}');
                                        background-position:center center;
                                        background-repeat:no-repeat;
                                        background-size:contain;"></div>
                            <div class="brand-logo-bg-dark brand-logo-bg-slot"
                                 role="presentation"
                                 aria-hidden="true"
                                 style="display:inline-block; margin:0; padding:0; vertical-align:top;
                                        width:180px; height:78px;
                                        background-image:url('cid:${BRAND_DARK_LOGO_CID}');
                                        background-position:center center;
                                        background-repeat:no-repeat;
                                        background-size:contain;"></div>
                                    </td>
                                </tr>
                            </table>
                            <!--<![endif]-->
                            <!--[if mso]>
                            <span style="line-height:normal; font-family: Arial, Helvetica, sans-serif; font-size: 1px; color:#ffffff">&nbsp;<br /></span>
                            <img src="cid:${BRAND_LIGHT_LOGO_CID}"
                                 alt="katan"
                                 width="180"
                                 border="0"
                                 style="display:block; margin: 0 auto; width:180px; height:auto; border:0; outline:none;" />
                            <![endif]-->
                        </td>
                    </tr>`;
}

/**
 * `<style>` + `<meta>` block that toggles which logo is visible based on
 * the recipient's email-client theme. Inserted inside `<head>` of every
 * branded template.
 */
function buildBrandHeaderStyles(): string {
    return `
    <meta name="color-scheme" content="light dark" />
    <meta name="supported-color-schemes" content="light dark" />
    <style>
        .brand-logo-bg-dark { display: none !important; width: 0 !important; height: 0 !important; overflow: hidden !important; }
        @media (prefers-color-scheme: dark) {
            .brand-logo-bg-light { display: none !important; width: 0 !important; height: 0 !important; overflow: hidden !important; }
            .brand-logo-bg-dark { display: inline-block !important; width: 180px !important; height: 78px !important; overflow: visible !important; }
        }
        [data-ogsc] .brand-logo-bg-light { display: none !important; width: 0 !important; height: 0 !important; overflow: hidden !important; }
        [data-ogsc] .brand-logo-bg-dark { display: inline-block !important; width: 180px !important; height: 78px !important; overflow: visible !important; }
    </style>`;
}

/** Katan Capital purple & blue palette — approval / offer-update client emails. */
const KATAN_EMAIL_THEME = {
    bgBody: '#f5f4f8',
    bgCard: '#ffffff',
    borderCard: '#e1dae6',
    purpleDeep: '#7a33a8',
    purpleAmethyst: '#a364c9',
    blueSky: '#1bb2e9',
    textPrimary: '#4b3658',
    textMuted: '#5a4b64',
    textDisabled: '#bca6cc',
    trackerLineInactive: '#cbd5e1',
    trackerBgInactive: '#f1ecf6',
    gradientHero: 'linear-gradient(135deg, #7a33a8 0%, #a364c9 50%, #1bb2e9 100%)',
    gradientCta: 'linear-gradient(to right, #a364c9, #1bb2e9)',
} as const;

/**
 * Logo shown above the hero banner on ISO "Application Approved" and "Offer Updated"
 * emails (white card background — use a dark logo URL).
 *
 * Set in `.env`:
 *   ISO_EMAIL_LOGO_URL=https://res.cloudinary.com/.../black_logo.svg
 *
 * Per-template overrides (optional):
 *   APPROVAL_BANNER_LOGO_URL=...
 *   OFFER_UPDATED_BANNER_LOGO_URL=...
 *
 * When empty, falls back to the inline katan brand header (CID attachments).
 */
const DEFAULT_ISO_EMAIL_LOGO_URL =
    'https://res.cloudinary.com/dfy6ahsqz/image/upload/v1780324705/white_logo_d8bsb1.svg';

export const ISO_EMAIL_LOGO_URL =
    String(process.env.ISO_EMAIL_LOGO_URL || '').trim() || DEFAULT_ISO_EMAIL_LOGO_URL;

export const APPROVAL_BANNER_LOGO_URL =
    String(process.env.APPROVAL_BANNER_LOGO_URL || '').trim() || ISO_EMAIL_LOGO_URL;

export const OFFER_UPDATED_BANNER_LOGO_URL =
    String(process.env.OFFER_UPDATED_BANNER_LOGO_URL || '').trim() || ISO_EMAIL_LOGO_URL;

/** Logo row on white, then purple gradient title strip — approval / offer-update emails. */
function buildKatanCapitalEmailHeaderHtml(
    logoUrl: string | undefined,
    title: string,
    subtitle: string,
): string {
    const t = KATAN_EMAIL_THEME;
    const url = String(logoUrl || '').trim();
    const logoRow = url
        ? `
                    <tr>
                        <td align="center" style="padding: 24px 20px 16px; background-color: ${t.bgCard};">
                            <img src="${url}" alt="katan" width="180" style="display: block; margin: 0 auto; max-width: 180px; width: 180px; height: auto; border: 0; outline: none;" />
                        </td>
                    </tr>`
        : buildBrandHeaderRowHtml();

    return `
                    ${logoRow}
                    <tr>
                        <td style="padding: 0 20px 4px;">
                            <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background: ${t.gradientHero}; background-color: ${t.purpleDeep}; border-radius: 8px;">
                                <tr>
                                    <td align="center" style="padding: 28px 24px; color: #ffffff;">
                                        <div style="font-size: 22px; font-weight: bold; letter-spacing: 1px; margin-bottom: 5px;">${title}</div>
                                        <div style="font-size: 14px; opacity: 0.9;">${subtitle}</div>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>`;
}

type KatanEmailTrackerStep = { label: string; complete: boolean };

function buildKatanCapitalEmailTracker(steps: KatanEmailTrackerStep[]): string {
    const t = KATAN_EMAIL_THEME;
    return steps
        .map((step, index) => {
            const isLast = index === steps.length - 1;
            const connector = isLast
                ? ''
                : `<tr><td align="center" style="padding: 5px 0;"><div style="width: 0px; border-left: 2px dotted ${step.complete ? t.purpleAmethyst : t.trackerLineInactive}; height: 35px;"></div></td></tr>`;
            const circleBg = step.complete ? t.purpleDeep : t.trackerBgInactive;
            const circleColor = step.complete ? '#ffffff' : t.textDisabled;
            const labelColor = step.complete ? t.textPrimary : t.textDisabled;
            return `
            <tr><td align="center"><div style="width: 32px; height: 32px; background: ${circleBg}; border-radius: 50%; color: ${circleColor}; line-height: 32px; font-size: 16px;">${step.complete ? '&#10003;' : 'X'}</div></td></tr>
            <tr><td align="center" style="font-size: 11px; padding: 5px 0; color: ${labelColor}; line-height: 1.2;">${step.label}</td></tr>
            ${connector}`;
        })
        .join('');
}

function buildKatanCapitalCtaButton(href: string, label: string): string {
    const t = KATAN_EMAIL_THEME;
    return `
        <table border="0" cellpadding="0" cellspacing="0" style="margin: 20px 0 25px 0;">
            <tr>
                <td align="center" style="border-radius: 5px; background: ${t.gradientCta}; background-color: ${t.purpleAmethyst};">
                    <a href="${href}" style="display: inline-block; padding: 12px 25px; color: #ffffff; font-size: 16px; font-weight: bold; text-decoration: none;">${label}</a>
                </td>
            </tr>
        </table>`;
}

function buildKatanCapitalClientEmailHtml({
    pageTitle,
    heroTitle,
    heroSubtitle,
    trackerSteps,
    bodyHtml,
    bannerLogoUrl,
}: {
    pageTitle: string;
    heroTitle: string;
    heroSubtitle: string;
    trackerSteps: KatanEmailTrackerStep[];
    bodyHtml: string;
    bannerLogoUrl?: string;
}): string {
    const t = KATAN_EMAIL_THEME;
    const emailHeader = buildKatanCapitalEmailHeaderHtml(bannerLogoUrl, heroTitle, heroSubtitle);
    return `
<!DOCTYPE html>
<html>
<head>
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <title>${pageTitle}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
    ${buildBrandHeaderStyles()}
</head>
<body style="margin: 0; padding: 0; background-color: ${t.bgBody}; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;">
    <table border="0" cellpadding="0" cellspacing="0" width="100%">
        <tr>
            <td style="padding: 20px 0;">
                <table align="center" border="0" cellpadding="0" cellspacing="0" width="600" style="background-color: ${t.bgCard}; border: 1px solid ${t.borderCard};">
                    ${emailHeader}
                    <tr>
                        <td style="padding: 30px 20px;">
                            <table border="0" cellpadding="0" cellspacing="0" width="100%">
                                <tr>
                                    <td width="110" valign="top" align="center">
                                        <table border="0" cellpadding="0" cellspacing="0" width="100%">
                                            ${buildKatanCapitalEmailTracker(trackerSteps)}
                                        </table>
                                    </td>
                                    <td valign="top" style="padding-left: 25px;">
                                        ${bodyHtml}
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;
}

/**
 * Href values in these templates (`viewApplicationUrl`, `publicPortalUrl`, `calculateApprovalUrl`, etc.)
 * are supplied by callers (e.g. `applicationController`) using `resolveCrmFrontendBaseUrl()` from `../utils/crmFrontendUrl`.
 * For local testing, set `LOCAL_FRONTEND_URL` (or `DEV_FRONTEND_URL`) in the API `.env` so links open your dev SPA;
 * in production, set `PUBLIC_SITE_ORIGIN` or `FRONTEND_URL` to the live client origin.
 */

/**
 * When true, application status templates (client/ISO recipient flows) are not sent (no `sendMail`).
 * Internal emails (e.g. welcome, underwriter notifications) are unaffected.
 */
const DISABLE_CLIENT_APPLICATION_EMAILS =
    String(process.env.DISABLE_CLIENT_APPLICATION_EMAILS || '').trim().toLowerCase() === 'true';

/** Resolves links like `{base}/application-details/:id/overview` (idempotent if `/overview` is already present). */
export function withApplicationDetailsOverviewHref(
    viewApplicationUrl: string | undefined,
): string {
    const u = (viewApplicationUrl || '').trim();
    if (!u) return '#';
    const base = u.replace(/\/$/, '');
    if (/\/overview$/i.test(base)) return base;
    return `${base}/overview`;
}

export interface WelcomeEmailParams {
    to: string;
    name: string;
    role: string;
    temporaryPassword: string;
    loginUrl: string;
}

export async function sendWelcomeEmail({
    to,
    name,
    role,
    temporaryPassword,
    loginUrl,
}: WelcomeEmailParams): Promise<void> {
    const safeName = name || to;
    const subject = 'Your In-House CRM Account Details';
    const body = `
    <h2>Hello ${safeName},</h2>
    <p>Your account has been created in <strong>In-House CRM</strong>.</p>
    <p><strong>Assigned role:</strong> ${role}</p>
    <p><strong>Login URL:</strong> <a href="${loginUrl}">${loginUrl}</a></p>
    <p><strong>Temporary password:</strong> ${temporaryPassword}</p>
    <p>For security, please log in and change your password after first sign-in.</p>
  `;

    try {
        await sendMail(to, subject, body);
    } catch (error) {
        // Log only – user creation must not fail because of email issues
        // eslint-disable-next-line no-console
        console.error('Welcome email send failed (user was created):', error);
    }
}

export interface ApplicationApprovalEmailParams {
    to: string;
    clientName: string;
    companyName: string;
    viewApplicationUrl?: string;
    calculateApprovalUrl?: string;
    /** Optional logo URL above the hero banner (overrides APPROVAL_BANNER_LOGO_URL). */
    bannerLogoUrl?: string;
    /** SendGrid webhook correlation id (`ocid` custom arg). */
    trackingId?: string;
}

export const buildApplicationApprovalEmailHtml = ({
    clientName,
    companyName,
    calculateApprovalUrl,
    bannerLogoUrl,
}: Omit<ApplicationApprovalEmailParams, 'to' | 'viewApplicationUrl'>): string => {
    const safeClientName = clientName || 'Valued Client';
    const safeCompanyName = companyName || 'your company';
    const t = KATAN_EMAIL_THEME;

    return buildKatanCapitalClientEmailHtml({
        pageTitle: 'Application Approved',
        heroTitle: 'APPLICATION APPROVED',
        heroSubtitle: 'Congratulations! Your application has been successfully processed.',
        bannerLogoUrl: bannerLogoUrl || APPROVAL_BANNER_LOGO_URL,
        trackerSteps: [
            { label: 'Application<br/>Submitted', complete: true },
            { label: 'Underwriting', complete: true },
            { label: 'Approved', complete: true },
            { label: 'Contract', complete: false },
            { label: 'Funding Call', complete: false },
            { label: 'Funded', complete: false },
        ],
        bodyHtml: `
            <p style="margin: 0 0 15px 0; font-size: 16px; color: ${t.textPrimary};">Hi ${safeClientName}!</p>
            <p style="font-size: 15px; color: ${t.textMuted}; line-height: 1.5;">
                We are pleased to inform you that your application for
                <strong style="color: ${t.purpleDeep};">'${safeCompanyName}'</strong>
                has been pre-approved for a katan Advance!
            </p>
            <p style="font-size: 14px; color: ${t.textMuted}; line-height: 1.5;">
                Please click the button below to calculate your approvals. You do not need a katan Advance CRM login to use our calculator — everyone on your team will have immediate access via this email.
            </p>
            ${buildKatanCapitalCtaButton(calculateApprovalUrl || '#', 'Calculate your Approval')}
            <h4 style="margin: 30px 0 10px 0; font-size: 15px; color: ${t.textPrimary}; text-decoration: underline;">REQUIRED STIPS FOR FUNDING</h4>
            <table border="0" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                    <td width="50%" valign="top" style="font-size: 12px; color: ${t.textPrimary}; padding-right: 10px;">
                        <strong>Provide with signed contracts:</strong>
                        <ul style="padding-left: 15px; margin-top: 8px; color: ${t.purpleAmethyst};">
                            <li><span style="color: ${t.textMuted};">Void Check</span></li>
                            <li><span style="color: ${t.textMuted};">Driver's License</span></li>
                        </ul>
                    </td>
                    <td width="50%" valign="top" style="font-size: 12px; color: ${t.textPrimary};">
                        <strong>Abc Company will take care of:</strong>
                        <ul style="padding-left: 15px; margin-top: 8px; color: ${t.purpleAmethyst};">
                            <li><span style="color: ${t.textMuted};">Merchant Interview</span></li>
                            <li><span style="color: ${t.textMuted};">Decision Logic/Bank Login</span></li>
                            <li><span style="color: ${t.textMuted};">Recent Bank Statements</span></li>
                        </ul>
                    </td>
                </tr>
            </table>
            <p style="font-size: 13px; color: ${t.textMuted}; margin-top: 30px; line-height: 1.4;">If you need more information or have any questions, please contact your representative directly.</p>
        `,
    });
};

/** @returns true when SMTP accepted the message; false if disabled, invalid `to`, or send failed */
export async function sendApplicationApprovalEmail({
    to,
    clientName,
    companyName,
    calculateApprovalUrl,
    bannerLogoUrl,
    trackingId,
}: ApplicationApprovalEmailParams): Promise<boolean> {
    const toTrimmed = String(to || '').trim();
    if (!toTrimmed) {
        // eslint-disable-next-line no-console
        console.warn('[email] Application approval skipped: empty recipient');
        return false;
    }

    if (DISABLE_CLIENT_APPLICATION_EMAILS) {
        // eslint-disable-next-line no-console
        console.warn(
            '[email] Application approval skipped: DISABLE_CLIENT_APPLICATION_EMAILS=true (set to false to deliver ISO approval template)',
            { to: toTrimmed },
        );
        return false;
    }

    const subject = 'Your Application Has Been Approved';
    const html = buildApplicationApprovalEmailHtml({
        clientName,
        companyName,
        calculateApprovalUrl,
        bannerLogoUrl,
    });

    try {
        await sendMail({
            to: toTrimmed,
            subject,
            html,
            attachments: buildBrandLogoAttachments(),
            trackingId,
            categories: ['approval'],
        });
        return true;
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Application approval email send failed:', { to: toTrimmed, error });
        return false;
    }
}

export interface OperationsIsoApprovalAlertEmailParams {
    to: string;
    operationsName?: string;
    isoName: string;
    applicationNumber: string;
    clientName: string;
    viewApplicationUrl?: string;
}

/** Operations alert email when ISO approves an application and contract creation can begin. */
export async function sendOperationsIsoApprovalAlertEmail({
    to,
    operationsName,
    isoName,
    applicationNumber,
    clientName,
    viewApplicationUrl,
}: OperationsIsoApprovalAlertEmailParams): Promise<boolean> {
    const toTrimmed = String(to || '').trim();
    if (!toTrimmed) {
        // eslint-disable-next-line no-console
        console.warn('[email] Operations ISO-approval alert skipped: empty recipient');
        return false;
    }

    const safeOperationsName = String(operationsName || '').trim() || 'Operations Team';
    const safeIsoName = String(isoName || '').trim() || 'ISO';
    const safeApplicationNumber = String(applicationNumber || '').trim() || 'N/A';
    const safeClientName = String(clientName || '').trim() || 'Client';
    const applicationHref = withApplicationDetailsOverviewHref(viewApplicationUrl);

    const subject = `ISO approved application #${safeApplicationNumber} - proceed to generate contract`;
    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
    <title>ISO Approval Alert</title>
    ${buildBrandHeaderStyles()}
</head>
<body style="margin:0; padding:0; background:#f4f7f9; font-family: Arial, Helvetica, sans-serif;">
    <table border="0" cellpadding="0" cellspacing="0" width="100%">
        <tr>
            <td style="padding: 20px 0;">
                <table align="center" border="0" cellpadding="0" cellspacing="0" width="600" style="background:#ffffff; border:1px solid #e5e7eb;">
                    ${buildBrandHeaderRowHtml()}
                    <tr>
                        <td style="padding: 20px 24px 8px;">
                            <h2 style="margin:0; color:#111827; font-size:22px;">ISO Approval Received</h2>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding: 0 24px 20px; color:#374151; font-size:14px; line-height:1.6;">
                            <p style="margin: 0 0 12px;">Hi ${safeOperationsName},</p>
                            <p style="margin: 0 0 8px;">
                                <strong>Application ID:</strong> #${safeApplicationNumber}
                            </p>
                            <p style="margin: 0 0 16px;">
                                <strong>ISO</strong> approved application <strong>#${safeApplicationNumber}</strong>.
                                The deal has been moved to the <strong>Contract Pending</strong> stage.
                                Now you can proceed to generate contract.
                            </p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;

    try {
        await sendMail({
            to: toTrimmed,
            subject,
            html,
            attachments: buildBrandLogoAttachments(),
        });
        return true;
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Operations ISO-approval alert email send failed:', { to: toTrimmed, error });
        return false;
    }
}

/** Client email when offer values are updated after approval comments. */
export interface ApplicationOfferUpdatedEmailParams {
    to: string;
    clientName: string;
    companyName: string;
    viewApplicationUrl?: string;
    calculateApprovalUrl?: string;
    /** Optional logo URL above the hero banner (overrides OFFER_UPDATED_BANNER_LOGO_URL). */
    bannerLogoUrl?: string;
    /** SendGrid webhook correlation id (`ocid` custom arg). */
    trackingId?: string;
}

export const buildApplicationOfferUpdatedEmailHtml = ({
    clientName,
    companyName,
    calculateApprovalUrl,
    bannerLogoUrl,
}: Omit<ApplicationOfferUpdatedEmailParams, 'to' | 'viewApplicationUrl'>): string => {
    const safeClientName = clientName || 'Valued Client';
    const safeCompanyName = companyName || 'your company';
    const t = KATAN_EMAIL_THEME;

    return buildKatanCapitalClientEmailHtml({
        pageTitle: 'Offer Updated',
        heroTitle: 'OFFER UPDATED',
        heroSubtitle: 'Your offer values have been updated based on the latest approval mail comment.',
        bannerLogoUrl: bannerLogoUrl || OFFER_UPDATED_BANNER_LOGO_URL,
        trackerSteps: [
            { label: 'Application<br/>Submitted', complete: true },
            { label: 'Underwriting', complete: true },
            { label: 'Approved', complete: true },
            { label: 'Offer Updated', complete: true },
            { label: 'Final Call', complete: false },
            { label: 'Funded', complete: false },
        ],
        bodyHtml: `
            <p style="margin: 0 0 15px 0; font-size: 16px; color: ${t.textPrimary};">Hi ${safeClientName}!</p>
            <p style="font-size: 15px; color: ${t.textMuted}; line-height: 1.5;">
                Your offer values for
                <strong style="color: ${t.purpleDeep};">'${safeCompanyName}'</strong>
                are now updated as mentioned in the last approval mail comment.
            </p>
            <p style="font-size: 14px; color: ${t.textMuted}; line-height: 1.5;">
                Please review the updated offer details and recalculate approval values if needed.
            </p>
            ${buildKatanCapitalCtaButton(calculateApprovalUrl || '#', 'Review Updated Offer')}
            <p style="font-size: 13px; color: ${t.textMuted}; margin-top: 20px; line-height: 1.4;">If you have questions, please reply to the latest approval mail comment thread or contact your representative.</p>
        `,
    });
};

export async function sendApplicationOfferUpdatedEmail({
    to,
    clientName,
    companyName,
    calculateApprovalUrl,
    bannerLogoUrl,
    trackingId,
}: ApplicationOfferUpdatedEmailParams): Promise<boolean> {
    const toTrimmed = String(to || '').trim();
    if (!toTrimmed) {
        // eslint-disable-next-line no-console
        console.warn('[email] Offer update skipped: empty recipient');
        return false;
    }

    if (DISABLE_CLIENT_APPLICATION_EMAILS) {
        // eslint-disable-next-line no-console
        console.warn(
            '[email] Offer update skipped: DISABLE_CLIENT_APPLICATION_EMAILS=true',
            { to: toTrimmed },
        );
        return false;
    }

    const subject = 'Your Offer Values Have Been Updated';
    const html = buildApplicationOfferUpdatedEmailHtml({
        clientName,
        companyName,
        calculateApprovalUrl,
        bannerLogoUrl,
    });

    try {
        await sendMail({
            to: toTrimmed,
            subject,
            html,
            attachments: buildBrandLogoAttachments(),
            trackingId,
            categories: ['offer-updated'],
        });
        return true;
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Offer update email send failed:', { to: toTrimmed, error });
        return false;
    }
}

/** Client email when Operations updates Funding Call status (merchant interview / verification stage). */
export interface FundingCallPendingEmailParams {
    to: string;
    clientName?: string;
    companyName?: string;
}

export const buildFundingCallPendingEmailHtml = ({
    clientName,
    companyName,
}: Omit<FundingCallPendingEmailParams, 'to'>): string => {
    const safeClientName = clientName || 'Valued Client';
    const safeCompanyName = companyName || 'your business';

    return `<!DOCTYPE html>
<html>
<head>
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <title>Funding Call Stage</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
    ${buildBrandHeaderStyles()}
</head>
<body style="margin: 0; padding: 0; background-color: #f4f7f9; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;">
    <table border="0" cellpadding="0" cellspacing="0" width="100%">
        <tr>
            <td style="padding: 20px 0;">
                <table align="center" border="0" cellpadding="0" cellspacing="0" width="600" style="background-color: #ffffff; border: 1px solid #dddddd;">
                    
                    ${buildBrandHeaderRowHtml()}

                    <tr>
                        <td style="padding: 0 20px;">
                            <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background: linear-gradient(to right, #3b7ab0, #1a4a7c); background-color: #1a4a7c; border-radius: 8px;">
                                <tr>
                                    <td width="100" align="center" style="padding: 30px 0 30px 20px;">
                                        <div style="width: 70px; height: 70px; border: 2px solid #ffffff; border-radius: 50%; line-height: 70px; text-align: center; font-size: 35px; color: #ffffff;">📞</div>
                                    </td>
                                    <td style="padding: 30px 20px; color: #ffffff;">
                                        <div style="font-size: 22px; font-weight: bold; letter-spacing: 1px; margin-bottom: 5px;">FUNDING CALL PENDING</div>
                                        <div style="font-size: 14px; opacity: 0.9;">You're almost there! One final call to verify your funding details.</div>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <tr>
                        <td style="padding: 30px 20px;">
                            <table border="0" cellpadding="0" cellspacing="0" width="100%">
                                <tr>
                                    <td width="110" valign="top" align="center">
                                        <table border="0" cellpadding="0" cellspacing="0" width="100%">
                                            <tr><td align="center"><div style="width: 32px; height: 32px; background: #0b71a9; border-radius: 50%; color: #ffffff; line-height: 32px; font-size: 16px;">✓</div></td></tr>
                                            <tr><td align="center" style="font-size: 11px; padding: 5px 0; color: #333; line-height: 1.2;">Application<br/>Submitted</td></tr>
                                            <tr><td align="center" style="padding: 5px 0;"><div style="width: 0px; border-left: 2.5px dotted #0b71a9; height: 35px;"></div></td></tr>

                                            <tr><td align="center"><div style="width: 32px; height: 32px; background: #0b71a9; border-radius: 50%; color: #ffffff; line-height: 32px; font-size: 16px;">✓</div></td></tr>
                                            <tr><td align="center" style="font-size: 11px; padding: 5px 0; color: #333;">Underwriting</td></tr>
                                            <tr><td align="center" style="padding: 5px 0;"><div style="width: 0px; border-left: 2.5px dotted #0b71a9; height: 35px;"></div></td></tr>

                                            <tr><td align="center"><div style="width: 32px; height: 32px; background: #0b71a9; border-radius: 50%; color: #ffffff; line-height: 32px; font-size: 16px;">✓</div></td></tr>
                                            <tr><td align="center" style="font-size: 11px; padding: 5px 0; color: #333;">Approved</td></tr>
                                            <tr><td align="center" style="padding: 5px 0;"><div style="width: 0px; border-left: 2.5px dotted #0b71a9; height: 35px;"></div></td></tr>

                                            <tr><td align="center"><div style="width: 32px; height: 32px; background: #0b71a9; border-radius: 50%; color: #ffffff; line-height: 32px; font-size: 16px;">✓</div></td></tr>
                                            <tr><td align="center" style="font-size: 11px; padding: 5px 0; color: #333;">Contract</td></tr>
                                            <tr><td align="center" style="padding: 5px 0;"><div style="width: 0px; border-left: 2.5px dotted #0b71a9; height: 35px;"></div></td></tr>

                                            <tr><td align="center"><div style="width: 32px; height: 32px; background: #0b71a9; border-radius: 50%; color: #ffffff; line-height: 32px; font-size: 16px;">✓</div></td></tr>
                                            <tr><td align="center" style="font-size: 11px; padding: 5px 0; color: #333; font-weight: bold;">Funding Call</td></tr>
                                            <tr><td align="center" style="padding: 5px 0;"><div style="width: 0px; border-left: 2px dotted #cccccc; height: 35px;"></div></td></tr>

                                            <tr><td align="center"><div style="width: 32px; height: 32px; background: #cccccc; border-radius: 50%; color: #ffffff; line-height: 32px; font-size: 16px;">X</div></td></tr>
                                            <tr><td align="center" style="font-size: 11px; padding: 5px 0; color: #888;">Funded</td></tr>
                                        </table>
                                    </td>

                                    <td valign="top" style="padding-left: 25px;">
                                        <p style="margin: 0 0 15px 0; font-size: 16px; color: #444;">Hi ${safeClientName}!</p>
                                        
                                        <p style="font-size: 15px; color: #666; line-height: 1.5;">
                                            Your application for <strong style="color: #0b71a9;">'${safeCompanyName}'</strong> has reached the final verification stage: <strong>The Funding Call</strong>.
                                        </p>

                                        <p style="font-size: 14px; color: #666; line-height: 1.5;">
                                            To complete the process and release your funds, we need to conduct a brief merchant interview. This call is to verify the terms of the advance and confirm your business details. 
                                        </p>

                                      

                                       
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;
};

export async function sendFundingCallPendingEmail({
    to,
    clientName,
    companyName,
}: FundingCallPendingEmailParams): Promise<void> {
    if (DISABLE_CLIENT_APPLICATION_EMAILS) return;

    const subject = 'Funding call — next step for your application';
    const html = buildFundingCallPendingEmailHtml({ clientName, companyName });

    try {
        await sendMail({
            to,
            subject,
            html,
            attachments: buildBrandLogoAttachments(),
        });
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Funding call pending email send failed:', error);
    }
}

/** Client email when disbursement is confirmed (funds released notification). */
export interface ApplicationFundedEmailParams {
    to: string;
    clientName?: string;
    companyName?: string;
}

export const buildApplicationFundedEmailHtml = ({
    clientName,
    companyName,
}: Omit<ApplicationFundedEmailParams, 'to'>): string => {
    const safeClientName = clientName || 'Valued Client';
    const safeCompanyName = companyName || 'your business';

    return `<!DOCTYPE html>
<html>
<head>
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <title>Application Funded</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
    ${buildBrandHeaderStyles()}
</head>
<body style="margin: 0; padding: 0; background-color: #f4f7f9; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;">
    <table border="0" cellpadding="0" cellspacing="0" width="100%">
        <tr>
            <td style="padding: 20px 0;">
                <table align="center" border="0" cellpadding="0" cellspacing="0" width="600" style="background-color: #ffffff; border: 1px solid #dddddd;">
                    
                    ${buildBrandHeaderRowHtml()}

                    <tr>
                        <td style="padding: 0 20px;">
                            <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background: linear-gradient(to right, #3b7ab0, #1a4a7c); background-color: #1a4a7c; border-radius: 8px;">
                                <tr>
                                    <td width="100" align="center" style="padding: 30px 0 30px 20px;">
                                        <div style="width: 70px; height: 70px; border: 2px solid #ffffff; border-radius: 50%; line-height: 70px; text-align: center; font-size: 35px; color: #ffffff;">💰</div>
                                    </td>
                                    <td style="padding: 30px 20px; color: #ffffff;">
                                        <div style="font-size: 22px; font-weight: bold; letter-spacing: 1px; margin-bottom: 5px;">FUNDS RELEASED</div>
                                        <div style="font-size: 14px; opacity: 0.9;">Success! Your funding has been processed and sent.</div>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <tr>
                        <td style="padding: 30px 20px;">
                            <table border="0" cellpadding="0" cellspacing="0" width="100%">
                                <tr>
                                    <td width="110" valign="top" align="center">
                                        <table border="0" cellpadding="0" cellspacing="0" width="100%">
                                            <tr><td align="center"><div style="width: 32px; height: 32px; background: #0b71a9; border-radius: 50%; color: #ffffff; line-height: 32px; font-size: 16px;">✓</div></td></tr>
                                            <tr><td align="center" style="font-size: 11px; padding: 5px 0; color: #333; line-height: 1.2;">Application<br/>Submitted</td></tr>
                                            <tr><td align="center" style="padding: 5px 0;"><div style="width: 0px; border-left: 2px dotted #0b71a9; height: 35px;"></div></td></tr>

                                            <tr><td align="center"><div style="width: 32px; height: 32px; background: #0b71a9; border-radius: 50%; color: #ffffff; line-height: 32px; font-size: 16px;">✓</div></td></tr>
                                            <tr><td align="center" style="font-size: 11px; padding: 5px 0; color: #333;">Underwriting</td></tr>
                                            <tr><td align="center" style="padding: 5px 0;"><div style="width: 0px; border-left: 2px dotted #0b71a9; height: 35px;"></div></td></tr>

                                            <tr><td align="center"><div style="width: 32px; height: 32px; background: #0b71a9; border-radius: 50%; color: #ffffff; line-height: 32px; font-size: 16px;">✓</div></td></tr>
                                            <tr><td align="center" style="font-size: 11px; padding: 5px 0; color: #333;">Approved</td></tr>
                                            <tr><td align="center" style="padding: 5px 0;"><div style="width: 0px; border-left: 2px dotted #0b71a9; height: 35px;"></div></td></tr>

                                            <tr><td align="center"><div style="width: 32px; height: 32px; background: #0b71a9; border-radius: 50%; color: #ffffff; line-height: 32px; font-size: 16px;">✓</div></td></tr>
                                            <tr><td align="center" style="font-size: 11px; padding: 5px 0; color: #333;">Verification</td></tr>
                                            <tr><td align="center" style="padding: 5px 0;"><div style="width: 0px; border-left: 2px dotted #0b71a9; height: 35px;"></div></td></tr>

                                            <tr><td align="center"><div style="width: 32px; height: 32px; background: #0b71a9; border-radius: 50%; color: #ffffff; line-height: 32px; font-size: 16px;">✓</div></td></tr>
                                            <tr><td align="center" style="font-size: 11px; padding: 5px 0; color: #333;">Final Review</td></tr>
                                            <tr><td align="center" style="padding: 5px 0;"><div style="width: 0px; border-left: 2px dotted #0b71a9; height: 35px;"></div></td></tr>

                                            <tr><td align="center"><div style="width: 32px; height: 32px; background: #0b71a9; border-radius: 50%; color: #ffffff; line-height: 32px; font-size: 16px;">✓</div></td></tr>
                                            <tr><td align="center" style="font-size: 11px; padding: 5px 0; color: #333; font-weight: bold;">Funded</td></tr>
                                        </table>
                                    </td>

                                    <td valign="top" style="padding-left: 25px;">
                                        <p style="margin: 0 0 15px 0; font-size: 16px; color: #444;">Hi ${safeClientName}!</p>
                                        
                                        <p style="font-size: 15px; color: #666; line-height: 1.5;">
                                            We are excited to inform you that your application for <strong style="color: #0b71a9;">'${safeCompanyName}'</strong> is now fully <strong>Funded</strong>.
                                        </p>

                                        <p style="font-size: 14px; color: #666; line-height: 1.5;">
                                            The funds have been successfully released to your designated bank account. Depending on your bank's processing time, you should see the capital reflected in your balance shortly.
                                        </p>

                                    
                                        <p style="font-size: 13px; color: #777; margin-top: 20px; line-height: 1.4;">
                                            Thank you for choosing FinexusAI as your funding partner. We look forward to supporting your business growth!
                                        </p>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;
};

export async function sendApplicationFundedEmail({
    to,
    clientName,
    companyName,
}: ApplicationFundedEmailParams): Promise<void> {
    if (DISABLE_CLIENT_APPLICATION_EMAILS) return;

    const subject = 'Your application is funded — funds released';
    const html = buildApplicationFundedEmailHtml({ clientName, companyName });

    try {
        await sendMail({
            to,
            subject,
            html,
            attachments: buildBrandLogoAttachments(),
        });
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Application funded email send failed:', error);
    }
}

/** Client email when an agent sends the application to Underwriting — prefer `publicPortalUrl` (token link; no CRM login). */
export interface ApplicationSentToUnderwritingClientEmailParams {
    to: string;
    clientName?: string;
    companyName?: string;
    agentName?: string;
    applicationNumber?: number | string;
    /** Optional CRM deep link for internal staff only. */
    viewApplicationUrl?: string;
    /** Public secure URL: /public/application/status/:token */
    publicPortalUrl?: string;
}

export const buildApplicationSentToUnderwritingClientEmailHtml = ({
    clientName,
    companyName,
    agentName,
    applicationNumber,
    viewApplicationUrl,
    publicPortalUrl,
}: Omit<ApplicationSentToUnderwritingClientEmailParams, 'to'>): string => {
    const safeClientName = clientName || 'Valued Client';
    const safeCompanyName = companyName || 'your business';
    const safeAgentName = agentName || 'your representative';
    const safeAppRef = applicationNumber != null && String(applicationNumber).trim() !== ''
        ? String(applicationNumber).trim()
        : null;
    const externalHref = (publicPortalUrl || '').trim();
    const internalFallback = withApplicationDetailsOverviewHref(viewApplicationUrl);
    const primaryHref = externalHref || internalFallback;
    const hasValidPortalLink = primaryHref !== '#' && primaryHref.length > 1;
    const isPublicTokenLink = Boolean(externalHref);

    const portalButtonBlock = hasValidPortalLink
        ? `<table border="0" cellpadding="0" cellspacing="0" style="margin: 20px 0;">
                                            <tr>
                                                <td align="center" bgcolor="#3b7ab0" style="border-radius: 5px;">
                                                    <a href="${primaryHref}" style="display: inline-block; padding: 12px 25px; color: #ffffff; font-size: 16px; font-weight: bold; text-decoration: none;">View your application</a>
                                                </td>
                                            </tr>
                                        </table>
                                        ${isPublicTokenLink
            ? `<p style="font-size: 12px; color: #777; margin: 8px 0 0 0;">No FinexusAI login required. This personal link expires after 90 days; do not forward to anyone you do not trust.</p>`
            : ''
        }`
        : `<p style="font-size: 13px; color: #777;">We could not generate a secure portal link. Please contact your representative for an updated link.</p>`;

    return `
<!DOCTYPE html>
<html>
<head>
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <title>Application Submitted</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
    ${buildBrandHeaderStyles()}
</head>
<body style="margin: 0; padding: 0; background-color: #f4f7f9; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;">
    <table border="0" cellpadding="0" cellspacing="0" width="100%">
        <tr>
            <td style="padding: 20px 0;">
                <table align="center" border="0" cellpadding="0" cellspacing="0" width="600" style="background-color: #ffffff; border: 1px solid #dddddd;">
                    
                    ${buildBrandHeaderRowHtml()}

                    <tr>
                        <td style="padding: 0 20px;">
                            <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background: linear-gradient(to right, #3b7ab0, #1a4a7c); background-color: #1a4a7c; border-radius: 8px;">
                                <tr>
                                    <td width="100" align="center" style="padding: 30px 0 30px 20px;">
                                        <div style="width: 70px; height: 70px; border: 2px solid #ffffff; border-radius: 50%; line-height: 70px; text-align: center; font-size: 35px; color: #ffffff;">📩</div>
                                    </td>
                                    <td style="padding: 30px 20px; color: #ffffff;">
                                        <div style="font-size: 22px; font-weight: bold; letter-spacing: 1px; margin-bottom: 5px;">APPLICATION SUBMITTED</div>
                                        <div style="font-size: 14px; opacity: 0.9;">Your application has been successfully submitted.</div>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <tr>
                        <td style="padding: 30px 20px;">
                            <table border="0" cellpadding="0" cellspacing="0" width="100%">
                                <tr>
                                    <td width="120" valign="top" align="center">
                                        <table border="0" cellpadding="0" cellspacing="0" width="100%">
                                            <tr><td align="center"><div style="width: 35px; height: 35px; background: #0b71a9; border-radius: 50%; color: #ffffff; line-height: 35px; font-size: 18px;">✓</div></td></tr>
                                            <tr><td align="center" style="font-size: 11px; padding: 5px 0; color: #333; font-weight: bold; line-height: 1.2;">Application<br/>Submitted</td></tr>
                                            <tr><td align="center" style="padding: 2px 0;"><div style="width: 0px; border-left: 2px dotted #cccccc; height: 30px;"></div></td></tr>

                                            <tr><td align="center"><div style="width: 35px; height: 35px; background: #cccccc; border-radius: 50%; color: #ffffff; line-height: 35px; font-size: 18px;">X</div></td></tr>
                                            <tr><td align="center" style="font-size: 11px; padding: 5px 0; color: #888;">Underwriting</td></tr>
                                            <tr><td align="center" style="padding: 2px 0;"><div style="width: 0px; border-left: 2px dotted #cccccc; height: 30px;"></div></td></tr>

                                            <tr><td align="center"><div style="width: 35px; height: 35px; background: #cccccc; border-radius: 50%; color: #ffffff; line-height: 35px; font-size: 18px;">X</div></td></tr>
                                            <tr><td align="center" style="font-size: 11px; padding: 5px 0; color: #888;">Approved</td></tr>
                                            <tr><td align="center" style="padding: 2px 0;"><div style="width: 0px; border-left: 2px dotted #cccccc; height: 30px;"></div></td></tr>

                                            <tr><td align="center"><div style="width: 35px; height: 35px; background: #cccccc; border-radius: 50%; color: #ffffff; line-height: 35px; font-size: 18px;">X</div></td></tr>
                                            <tr><td align="center" style="font-size: 11px; padding: 5px 0; color: #888;">Contract</td></tr>
                                            <tr><td align="center" style="padding: 2px 0;"><div style="width: 0px; border-left: 2px dotted #cccccc; height: 30px;"></div></td></tr>

                                            <tr><td align="center"><div style="width: 35px; height: 35px; background: #cccccc; border-radius: 50%; color: #ffffff; line-height: 35px; font-size: 18px;">X</div></td></tr>
                                            <tr><td align="center" style="font-size: 11px; padding: 5px 0; color: #888;">Funding Call</td></tr>
                                            <tr><td align="center" style="padding: 2px 0;"><div style="width: 0px; border-left: 2px dotted #cccccc; height: 30px;"></div></td></tr>

                                            <tr><td align="center"><div style="width: 35px; height: 35px; background: #cccccc; border-radius: 50%; color: #ffffff; line-height: 35px; font-size: 18px;">X</div></td></tr>
                                            <tr><td align="center" style="font-size: 11px; padding: 5px 0; color: #888;">Funded</td></tr>
                                        </table>
                                    </td>

                                    <td valign="top" style="padding-left: 25px;">
                                        <p style="margin: 0 0 15px 0; font-size: 16px; color: #444;">Hi ${safeClientName}!</p>
                                        
                                        <p style="font-size: 15px; color: #666; line-height: 1.5;">
                                            Great news! Your application for 
                                            <strong style="color: #0b71a9;">'${safeCompanyName}'</strong> 
                                            has been <strong>successfully submitted</strong>.
                                        </p>

                                        <p style="font-size: 14px; color: #666; line-height: 1.5;">
                                            Our underwriting team will begin reviewing your request shortly.${hasValidPortalLink
            ? ' Use the button below to view status, leave comments, and upload documents — the same secure experience we use for approvals.'
            : ''
        }
                                        </p>

                                        ${portalButtonBlock}

                                        <p style="font-size: 13px; color: #777; margin-top: 20px; line-height: 1.4;">
                                            Need help or have questions? Open the link above — you can leave a comment for your representative from that page.
                                        </p>
                                        
                                        <table border="0" cellpadding="0" cellspacing="0" style="margin-top: 10px;">
                                            <tr>
                                                <td align="center" bgcolor="#eeeeee" style="border-radius: 5px;">
                                                    <a href="${hasValidPortalLink ? primaryHref : '#'}" style="display: inline-block; padding: 10px 20px; color: #555555; font-size: 14px; font-weight: bold; text-decoration: none;">Write a comment</a>
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`
};

export async function sendApplicationSentToUnderwritingClientEmail({
    to,
    clientName,
    companyName,
    agentName,
    applicationNumber,
    viewApplicationUrl,
    publicPortalUrl,
}: ApplicationSentToUnderwritingClientEmailParams): Promise<void> {
    if (DISABLE_CLIENT_APPLICATION_EMAILS) return;

    const safeAppRef = applicationNumber != null && String(applicationNumber).trim() !== ''
        ? String(applicationNumber).trim()
        : '';
    const subject = safeAppRef
        ? `Your application #${safeAppRef} is with Underwriting`
        : 'Your application is with Underwriting';

    const html = buildApplicationSentToUnderwritingClientEmailHtml({
        clientName,
        companyName,
        agentName,
        applicationNumber,
        viewApplicationUrl,
        publicPortalUrl,
    });

    try {
        await sendMail({
            to,
            subject,
            html,
            attachments: buildBrandLogoAttachments(),
        });
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Client sent-to-underwriting email send failed:', error);
    }
}

/** Client email when an Underwriter forwards the application to Final Underwriter (initial underwriting complete). */
export interface ApplicationUnderwritingCompletedClientEmailParams {
    to: string;
    clientName?: string;
    companyName?: string;
    /** Optional CRM deep link */
    viewApplicationUrl?: string;
    /** Public secure URL: /public/application/status/:token */
    publicPortalUrl?: string;
    applicationNumber?: number | string;
}

export const buildApplicationUnderwritingCompletedClientEmailHtml = ({
    clientName,
    companyName,
    viewApplicationUrl,
    publicPortalUrl,
}: Omit<ApplicationUnderwritingCompletedClientEmailParams, 'to' | 'applicationNumber'>): string => {
    const safeClientName = clientName || 'Valued Client';
    const safeCompanyName = companyName || 'your business';
    const externalHref = (publicPortalUrl || '').trim();
    const internalFallback = withApplicationDetailsOverviewHref(viewApplicationUrl);
    const primaryHref = externalHref || internalFallback;
    const hasValidPortalLink = primaryHref !== '#' && primaryHref.length > 1;

    const statusButtonBlock = hasValidPortalLink
        ? `<table border="0" cellpadding="0" cellspacing="0" style="margin: 20px 0;">
                                            <tr>
                                                <td align="center" bgcolor="#3b7ab0" style="border-radius: 5px;">
                                                    <a href="${primaryHref}" style="display: inline-block; padding: 12px 25px; color: #ffffff; font-size: 16px; font-weight: bold; text-decoration: none;">View Review Status</a>
                                                </td>
                                            </tr>
                                        </table>`
        : `<p style="font-size: 13px; color: #777;">We could not generate a secure portal link. Please contact your representative for an updated link.</p>`;

    return `<!DOCTYPE html>
<html>
<head>
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <title>Underwriting Completed</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
    ${buildBrandHeaderStyles()}
</head>
<body style="margin: 0; padding: 0; background-color: #f4f7f9; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;">
    <table border="0" cellpadding="0" cellspacing="0" width="100%">
        <tr>
            <td style="padding: 20px 0;">
                <table align="center" border="0" cellpadding="0" cellspacing="0" width="600" style="background-color: #ffffff; border: 1px solid #dddddd;">
                    
                    ${buildBrandHeaderRowHtml()}

                    <tr>
                        <td style="padding: 0 20px;">
                            <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background: linear-gradient(to right, #3b7ab0, #1a4a7c); background-color: #1a4a7c; border-radius: 8px;">
                                <tr>
                                    <td width="100" align="center" style="padding: 30px 0 30px 20px;">
                                        <div style="width: 70px; height: 70px; border: 2px solid #ffffff; border-radius: 50%; line-height: 70px; text-align: center; font-size: 35px; color: #ffffff;">✅</div>
                                    </td>
                                    <td style="padding: 30px 20px; color: #ffffff;">
                                        <div style="font-size: 22px; font-weight: bold; letter-spacing: 1px; margin-bottom: 5px;">UNDERWRITING COMPLETED</div>
                                        <div style="font-size: 14px; opacity: 0.9;">Great news! The initial underwriting review is finished.</div>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <tr>
                        <td style="padding: 30px 20px;">
                            <table border="0" cellpadding="0" cellspacing="0" width="100%">
                                <tr>
                                    <td width="120" valign="top" align="center">
                                        <table border="0" cellpadding="0" cellspacing="0" width="100%">
                                            <tr><td align="center"><div style="width: 35px; height: 35px; background: #0b71a9; border-radius: 50%; color: #ffffff; line-height: 35px; font-size: 18px;">✓</div></td></tr>
                                            <tr><td align="center" style="font-size: 11px; padding: 5px 0; color: #333; line-height: 1.2;">Application<br/>Submitted</td></tr>
                                            <tr><td align="center" style="padding: 2px 0;"><div style="width: 0px; border-left: 2.5px dotted #0b71a9; height: 30px;"></div></td></tr>

                                            <tr><td align="center"><div style="width: 35px; height: 35px; background: #0b71a9; border-radius: 50%; color: #ffffff; line-height: 35px; font-size: 18px;">✓</div></td></tr>
                                            <tr><td align="center" style="font-size: 11px; padding: 5px 0; color: #333; font-weight: bold;">Underwriting</td></tr>
                                            <tr><td align="center" style="padding: 2px 0;"><div style="width: 0px; border-left: 2px dotted #cccccc; height: 30px;"></div></td></tr>

                                            <tr><td align="center"><div style="width: 35px; height: 35px; background: #cccccc; border-radius: 50%; color: #ffffff; line-height: 35px; font-size: 18px;">X</div></td></tr>
                                            <tr><td align="center" style="font-size: 11px; padding: 5px 0; color: #888;">Approved</td></tr>
                                            <tr><td align="center" style="padding: 2px 0;"><div style="width: 0px; border-left: 2px dotted #cccccc; height: 30px;"></div></td></tr>

                                            <tr><td align="center"><div style="width: 35px; height: 35px; background: #cccccc; border-radius: 50%; color: #ffffff; line-height: 35px; font-size: 18px;">X</div></td></tr>
                                            <tr><td align="center" style="font-size: 11px; padding: 5px 0; color: #888;">Contract</td></tr>
                                            <tr><td align="center" style="padding: 2px 0;"><div style="width: 0px; border-left: 2px dotted #cccccc; height: 30px;"></div></td></tr>

                                            <tr><td align="center"><div style="width: 35px; height: 35px; background: #cccccc; border-radius: 50%; color: #ffffff; line-height: 35px; font-size: 18px;">X</div></td></tr>
                                            <tr><td align="center" style="font-size: 11px; padding: 5px 0; color: #888;">Funding Call</td></tr>
                                            <tr><td align="center" style="padding: 2px 0;"><div style="width: 0px; border-left: 2px dotted #cccccc; height: 30px;"></div></td></tr>

                                            <tr><td align="center"><div style="width: 35px; height: 35px; background: #cccccc; border-radius: 50%; color: #ffffff; line-height: 35px; font-size: 18px;">X</div></td></tr>
                                            <tr><td align="center" style="font-size: 11px; padding: 5px 0; color: #888;">Funded</td></tr>
                                        </table>
                                    </td>

                                    <td valign="top" style="padding-left: 25px;">
                                        <p style="margin: 0 0 15px 0; font-size: 16px; color: #444;">Hi ${safeClientName}!</p>
                                        
                                        <p style="font-size: 15px; color: #666; line-height: 1.5;">
                                            We are happy to inform you that our underwriters have finished 
                                            analyzing your application for <strong style="color: #0b71a9;">'${safeCompanyName}'</strong>.
                                        </p>

                                        <p style="font-size: 14px; color: #666; line-height: 1.5;">
                                            The review stage is now complete. Your application is being prepared for the <strong>Approval</strong> stage. Please check your dashboard to see if any specific conditions or additional documents are needed to finalize the offer.
                                        </p>

                                        ${statusButtonBlock}

                                        <p style="font-size: 13px; color: #777; margin-top: 20px; line-height: 1.4;">
                                            Our team will reach out shortly if further clarification is required. You can also leave a direct comment for the underwriter below.
                                        </p>
                                        
                                        <table border="0" cellpadding="0" cellspacing="0" style="margin-top: 10px;">
                                            <tr>
                                                <td align="center" bgcolor="#eeeeee" style="border-radius: 5px;">
                                                    <a href="${hasValidPortalLink ? primaryHref : '#'}" style="display: inline-block; padding: 10px 20px; color: #555555; font-size: 14px; font-weight: bold; text-decoration: none;">Write a Comment</a>
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;
};

export async function sendApplicationUnderwritingCompletedClientEmail({
    to,
    clientName,
    companyName,
    viewApplicationUrl,
    publicPortalUrl,
    applicationNumber,
}: ApplicationUnderwritingCompletedClientEmailParams): Promise<void> {
    if (DISABLE_CLIENT_APPLICATION_EMAILS) return;

    const safeAppRef =
        applicationNumber != null && String(applicationNumber).trim() !== ''
            ? String(applicationNumber).trim()
            : '';
    const subject = safeAppRef
        ? `Application #${safeAppRef}: underwriting complete — next step is approval`
        : 'Your application: underwriting complete';

    const html = buildApplicationUnderwritingCompletedClientEmailHtml({
        clientName,
        companyName,
        viewApplicationUrl,
        publicPortalUrl,
    });

    try {
        await sendMail({
            to,
            subject,
            html,
            attachments: buildBrandLogoAttachments(),
        });
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Client underwriting-completed email send failed:', error);
    }
}

export interface UnderwriterNewApplicationEmailParams {
    to: string;
    underwriterName?: string;
    agentName: string;
    applicationNumber?: number | string;
    clientName?: string;
    viewApplicationUrl?: string;
}

export async function sendUnderwriterNewApplicationEmail({
    to,
    underwriterName,
    agentName,
    applicationNumber,
    clientName,
    viewApplicationUrl,
}: UnderwriterNewApplicationEmailParams): Promise<void> {
    const safeUnderwriterName = underwriterName || to;
    const safeAgentName = agentName || 'Agent';
    const safeClientName = clientName || 'Client';
    const safeApplicationNumber = applicationNumber ? String(applicationNumber) : '';

    const subject = `New application${safeApplicationNumber ? ` #${safeApplicationNumber}` : ''} sent to Underwriting`;

    const buttonHtml = viewApplicationUrl
        ? `<p style="margin:24px 0;">
        <a href="${viewApplicationUrl}"
           style="display:inline-block; padding:12px 18px; background-color:#1E88E5; color:#ffffff; text-decoration:none; font-family:Arial,Helvetica,sans-serif; font-size:14px; font-weight:600; border-radius:6px;">
          View application
        </a>
      </p>`
        : '';

    const html = `
    <div style="font-family:Arial,Helvetica,sans-serif; color:#111827; line-height:1.5;">
      <h2 style="margin:0 0 12px 0;">Hi ${safeUnderwriterName},</h2>
      <p style="margin:0 0 10px 0;">
        <strong>${safeAgentName}</strong> sent a new application${safeApplicationNumber ? ` <strong>#${safeApplicationNumber}</strong>` : ''} to <strong>Underwriting</strong>.
      </p>
      <p style="margin:0 0 10px 0;">
        Client: <strong>${safeClientName}</strong>
      </p>
      ${buttonHtml}
      <p style="margin:18px 0 0 0; font-size:12px; color:#6B7280;">
        This is an automated notification from In-House CRM.
      </p>
    </div>
  `;

    try {
        await sendMail(to, subject, html);
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Underwriter new application email send failed:', error);
    }
}

/** Hostname (+ port) only, `www.` stripped — for detecting duplicate primary vs katan hosted link. */
function decisionLogicInvitationHostKey(raw: string): string | null {
    const t = String(raw || '').trim();
    if (!t || t.startsWith('(')) return null;
    try {
        const url = /^https?:/i.test(t) ? new URL(t) : new URL(`https://${t}`);
        const host = url.hostname.toLowerCase().replace(/^www\./, '');
        const port =
            url.port && url.port !== '80' && url.port !== '443'
                ? `:${url.port}`
                : '';
        return `${host}${port}`;
    } catch {
        return null;
    }
}

export async function sendDecisionLogicEmail(
    to: string,
    token: string,
): Promise<void> {
    if (!isOutboundSmtpConfigured()) {
        throw new Error(
            'Decision Logic invitation email cannot be sent: outbound mail is not configured. ' +
                'Set SENDGRID_API_KEY (recommended: SendGrid SMTP via smtp.sendgrid.net, user "apikey") ' +
                'or SMTP_AUTH_USER + SMTP_AUTH_PASS. Also set a verified From address: SMTP_FROM, MAIL_FROM, ' +
                'SENDGRID_FROM_EMAIL, or SENDGRID_AUTH_USER.',
        );
    }

    const hostedOrigin = String(
        process.env.katan_HOSTED_ORIGIN ||
            process.env.DECISION_LOGIC_HOSTED_FALLBACK_ORIGIN ||
            'https://katan.finexusai.com',

    )
        .trim()
        .replace(/\/$/, '');
    const base =
        resolveDecisionLogicInvitationBaseUrl() ||
        resolveCrmFrontendBaseUrl()?.replace(/\/$/, '') ||
        '';
    const link = base
        ? `${base}/decision-logic?token=${encodeURIComponent(token)}`
        : `(configure a frontend base URL in env) token=${encodeURIComponent(token)}`;
    const hostedLink = `${hostedOrigin}/decision-logic?token=${encodeURIComponent(token)}`;
    const primaryHost = decisionLogicInvitationHostKey(base);
    const hostedHost = decisionLogicInvitationHostKey(hostedOrigin);
    const primaryIsHosted =
        primaryHost != null &&
        hostedHost != null &&
        primaryHost === hostedHost;
    const subject = 'Bank verification — Decision Logic';
    const hostedBlock =
        primaryIsHosted
            ? ''
            : `
      <p style="margin-top:14px;"><a href="${hostedLink}">Open Decision Logic (hosted — katan.finexusai.com)</a></p>
      <p style="font-size:12px; color:#6B7280;">Hosted URL (copy/paste): ${hostedLink}</p>
    `;
    const html = `
    <div style="font-family:Arial,Helvetica,sans-serif; color:#111827; line-height:1.5;">
      <p>You have been invited to complete bank verification.</p>
      <p><a href="${link}">Open Decision Logic</a></p>
      <p style="font-size:12px; color:#6B7280;">If the link does not work, copy and paste this URL: ${link}</p>
      ${hostedBlock}
    </div>
  `;
    await sendMail(to, subject, html);
}

export {
    DOCUMENT_REQUEST_LABELS,
    humanizeDocumentRequestLabels,
} from '../constants/documentRequestTypes';

function humanizeSendGridErrorMessage(error: unknown): string {
    const raw =
        (error as { message?: string })?.message ||
        (error as { response?: string })?.response ||
        String(error || 'Unknown email error');
    if (/maximum credits exceeded/i.test(raw) || /\b451\b/.test(raw)) {
        return 'SendGrid account has exceeded its email credits. Add credits in your SendGrid billing settings and try again.';
    }
    return raw;
}

export interface SendDocumentRequestEmailParams {
    to: string[];
    cc?: string[];
    isoName?: string;
    clientName: string;
    applicationNumber: string | number;
    requestedDocumentLabels: string[];
    requestAdditional?: boolean;
    note?: string;
    viewApplicationUrl?: string;
}

export function buildDocumentRequestEmailHtml({
    isoName,
    clientName,
    applicationNumber,
    requestedDocumentLabels,
    requestAdditional,
    note,
    viewApplicationUrl,
}: Omit<SendDocumentRequestEmailParams, 'to' | 'cc'>): string {
    const safeIsoName = String(isoName || '').trim() || 'ISO Partner';
    const safeClientName = String(clientName || '').trim() || 'Client';
    const safeAppNumber = String(applicationNumber || '').trim() || 'N/A';
    const applicationHref =
        viewApplicationUrl &&
        (/\/documents(?:\/[^/?#]+)?$/i.test(viewApplicationUrl.trim()) ||
            /\/public\/application\/documents\//i.test(viewApplicationUrl.trim()))
            ? viewApplicationUrl.trim()
            : withApplicationDetailsOverviewHref(viewApplicationUrl);

    const docItems = [...(requestedDocumentLabels || [])];
    if (requestAdditional) {
        docItems.push('Additional documents (as discussed)');
    }
    const docListHtml =
        docItems.length > 0
            ? `<ul style="margin:12px 0; padding-left:20px; color:#374151; font-size:14px; line-height:1.6;">
                ${docItems.map((label) => `<li style="margin-bottom:6px;">${label}</li>`).join('')}
               </ul>`
            : `<p style="margin:12px 0; color:#374151; font-size:14px;">Additional documents are required for this application.</p>`;

    const noteBlock =
        note && String(note).trim()
            ? `<p style="margin:16px 0 0; padding:12px 14px; background:#f9fafb; border-left:3px solid #276D9C; color:#374151; font-size:14px; line-height:1.6;"><strong>Note from underwriting:</strong><br/>${String(note).trim().replace(/\n/g, '<br/>')}</p>`
            : '';

    return `
<!DOCTYPE html>
<html>
<head>
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
    <title>Document Request</title>
    ${buildBrandHeaderStyles()}
</head>
<body style="margin:0; padding:0; background:#f4f7f9; font-family: Arial, Helvetica, sans-serif;">
    <table border="0" cellpadding="0" cellspacing="0" width="100%">
        <tr>
            <td style="padding: 20px 0;">
                <table align="center" border="0" cellpadding="0" cellspacing="0" width="600" style="background:#ffffff; border:1px solid #e5e7eb;">
                    ${buildBrandHeaderRowHtml()}
                    <tr>
                        <td style="padding: 20px 24px 8px;">
                            <h2 style="margin:0; color:#111827; font-size:22px;">Document Request</h2>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding: 0 24px 20px; color:#374151; font-size:14px; line-height:1.6;">
                            <p style="margin: 0 0 12px;">Hi ${safeIsoName},</p>
                            <p style="margin: 0 0 12px;">
                                We need additional documents for <strong>${safeClientName}</strong> (Application <strong>#${safeAppNumber}</strong>).
                            </p>
                            <p style="margin: 0 0 4px; font-weight:600; color:#111827;">Requested documents:</p>
                            ${docListHtml}
                            ${noteBlock}
                            <p style="margin: 20px 0 0; text-align:center;">
                                <a href="${applicationHref}" style="display:inline-block; background:#276D9C; color:#ffffff; text-decoration:none; font-weight:600; font-size:14px; padding:12px 24px; border-radius:6px;">Upload requested documents</a>
                            </p>
                            <p style="margin: 20px 0 0; font-size:12px; color:#6b7280; line-height:1.5;">
                                Open the link above to upload each requested document. No login is required.
                                Underwriting will be notified automatically when files are received.
                            </p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;
}

/** Send ISO document-request email via SendGrid SMTP only. */
export async function sendDocumentRequestEmail(
    params: SendDocumentRequestEmailParams,
): Promise<{ sent: boolean; error?: string }> {
    const toList = (params.to || []).map((e) => String(e || '').trim()).filter(Boolean);
    if (!toList.length) {
        return { sent: false, error: 'No recipient email addresses provided.' };
    }

    const ccList = (params.cc || []).map((e) => String(e || '').trim()).filter(Boolean);
    const subject = `Document request — Application #${params.applicationNumber}`;
    const html = buildDocumentRequestEmailHtml(params);

    try {
        const attachments = buildBrandLogoAttachments();
        await sendSendGridMail({
            to: toList,
            cc: ccList.length ? ccList : undefined,
            subject,
            html,
            ...(attachments.length ? { attachments } : {}),
        });
        return { sent: true };
    } catch (error) {
        const errorMessage = humanizeSendGridErrorMessage(error);
        // eslint-disable-next-line no-console
        console.error('[email] Document request email send failed:', { to: toList, error });
        return { sent: false, error: errorMessage };
    }
}

