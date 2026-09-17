import { getSocketIO } from '../socket/index';
import { isPayoffOrZeroBalanceLetterTemplate } from '../utils/payoffOrZeroBalanceLetter';

/** CRM Letters list listens for this after SendGrid open/delivered webhooks. */
export const LETTER_DELIVERY_STATUS_SOCKET_EVENT = 'letter:delivery-status';

export type LetterDeliveryStatusRealtimePayload = {
  applicationId: string;
  status: string;
  templateName: string;
  letterType: 'payoff' | 'zero_balance';
  recipient: string | null;
  sentAt: string | null;
  ocid?: string;
};

function resolveLetterType(templateName: string): 'payoff' | 'zero_balance' {
  const n = String(templateName || '').trim().toLowerCase();
  if (n.includes('zero balance')) return 'zero_balance';
  return 'payoff';
}

/**
 * Broadcast letter delivery/open status so the Letters page updates immediately
 * (no wait for the next list poll).
 */
export function emitLetterDeliveryStatusRealtime(
  input: LetterDeliveryStatusRealtimePayload,
): void {
  const applicationId = String(input.applicationId || '').trim();
  const status = String(input.status || '').trim().toLowerCase();
  if (!applicationId || !status) return;

  const io = getSocketIO();
  if (!io) return;

  const payload: LetterDeliveryStatusRealtimePayload = {
    applicationId,
    status,
    templateName: String(input.templateName || '').trim(),
    letterType: input.letterType || resolveLetterType(input.templateName),
    recipient: input.recipient?.trim() ? input.recipient.trim() : null,
    sentAt: input.sentAt ?? null,
    ocid: input.ocid,
  };

  try {
    io.emit(LETTER_DELIVERY_STATUS_SOCKET_EVENT, payload);
  } catch (err) {
    console.error('[letterDeliveryStatus] realtime emit failed:', err);
  }
}

export function letterTypeFromTemplateName(templateName: string): 'payoff' | 'zero_balance' {
  return resolveLetterType(templateName);
}

export function shouldBroadcastLetterStatus(templateName: string | null | undefined): boolean {
  return isPayoffOrZeroBalanceLetterTemplate(String(templateName || ''));
}
