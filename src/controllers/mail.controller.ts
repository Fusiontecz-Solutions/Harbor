import { Request, Response } from 'express';
import sendMail, {
    getDefaultMailFrom,
    isOutboundSmtpConfigured,
} from '../config/nodemailer';

/**
 * POST /api/v1/mail/send
 * Send payment template emails via server SendGrid/SMTP (no Gmail OAuth).
 */
export async function sendPaymentMail(req: Request, res: Response): Promise<void> {
    try {
        if (!isOutboundSmtpConfigured()) {
            res.status(503).json({
                success: false,
                message:
                    'Outbound email is not configured. Set SENDGRID_API_KEY and SENDGRID_FROM_EMAIL on the server.',
            });
            return;
        }

        const { to, subject, body, cc, bcc, replyTo } = req.body;

        if (!to) {
            res.status(400).json({
                success: false,
                message: 'Recipient (to) is required',
            });
            return;
        }

        if (!body) {
            res.status(400).json({
                success: false,
                message: 'Email body is required',
            });
            return;
        }

        const result = await sendMail({
            to,
            subject: subject || '',
            html: body,
            cc,
            bcc,
            replyTo,
            from: getDefaultMailFrom(),
        });

        res.status(200).json({
            success: true,
            message: 'Email sent successfully',
            data: result,
        });
    } catch (error: any) {
        console.error('Send payment mail error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to send email',
        });
    }
}
