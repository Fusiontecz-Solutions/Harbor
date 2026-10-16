/**
 * Infobip provider adapter — the only module in Harbor that knows Infobip's
 * wire format exists.
 *
 * Everything above this file speaks Harbor's own vocabulary (E.164 numbers,
 * `MessagingMessageStatus`, normalized inbound events). That boundary is what
 * makes the provider swappable: Fivra hard-coded Twilio semantics through its
 * worker, webhook and stats layers, and unpicking them is most of the work in
 * this port. We are not repeating that.
 *
 * API references:
 *   Outbound SMS   POST {base}/sms/2/text/advanced
 *   Outbound MMS   POST {base}/mms/1/single
 *   Inbound SMS    https://www.infobip.com/docs/api/channels/sms/inbound-sms/receive-inbound-sms-messages
 *   Voice (WebRTC) POST {base}/webrtc/1/token
 *   Outbound call  POST {base}/calls/1/calls
 *
 * Required env:
 *   INFOBIP_BASE_URL        e.g. https://xxxxx.api.infobip.com
 *   INFOBIP_API_KEY         API key (sent as `Authorization: App <key>`)
 *   INFOBIP_SENDER          default sender ID / long code
 * Optional:
 *   INFOBIP_WEBHOOK_SECRET  shared secret required on inbound/DLR callbacks
 *   INFOBIP_CALLBACK_BASE_URL  public origin Infobip posts receipts back to
 *   INFOBIP_APPLICATION_ID  Calls configuration / application id for voice
 *   INFOBIP_TIMEOUT_MS      per-request budget (default 20000)
 */
import axios, { AxiosError, type AxiosInstance } from 'axios';
import { toInfobipDestination, toInfobipSender } from './phone';
import { getSendingState, SENDING_DISABLED_CODE } from '../tenantControl/state';
import { isOverQuota, LIMIT_REACHED_CODE, recordQuotaUse } from '../tenantControl/quota';
import { assertPrepaidBalance, deductPrepaidAfterSend, PrepaidExhaustedError } from '../tenantControl/prepaid';

export type NormalizedStatus =
  | 'QUEUED'
  | 'SENDING'
  | 'SENT'
  | 'DELIVERED'
  | 'FAILED'
  | 'UNDELIVERABLE'
  | 'RECEIVED';

export interface SendSmsInput {
  to: string;
  from?: string;
  text: string;
  mediaUrls?: string[];
  /** Our own id echoed back on every delivery report — the join key. */
  messageId?: string;
  /** Groups a broadcast's messages so Infobip reports can be fetched in bulk. */
  bulkId?: string;
  /** Opaque string returned on DLRs; we put the broadcast id here. */
  callbackData?: string;
}

export interface SendSmsResult {
  providerMessageId: string | null;
  providerBulkId: string | null;
  status: NormalizedStatus;
  /** Billable segments, when the provider reports them at submit time. */
  segmentCount: number | null;
  rawStatusName: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface InboundMessage {
  providerMessageId: string;
  from: string;
  to: string;
  text: string;
  mediaUrls: string[];
  receivedAt: Date;
  /** Infobip's own keyword extraction, when the number is keyword-enabled. */
  keyword: string | null;
  campaignReference: string | null;
}

export interface DeliveryReport {
  providerMessageId: string;
  providerBulkId: string | null;
  status: NormalizedStatus;
  rawStatusName: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  doneAt: Date | null;
  segmentCount: number | null;
  priceAmount: number | null;
  priceCurrency: string | null;
  callbackData: string | null;
}

export class InfobipNotConfiguredError extends Error {
  constructor(missing: string[]) {
    super(`Infobip is not configured — missing env: ${missing.join(', ')}`);
    this.name = 'InfobipNotConfiguredError';
  }
}

export class InfobipRequestError extends Error {
  readonly statusCode: number;
  readonly providerCode: string | null;
  /** Transient failures (5xx, 429, network) are worth retrying; 4xx are not. */
  readonly retryable: boolean;

  constructor(message: string, statusCode: number, providerCode: string | null, retryable: boolean) {
    super(message);
    this.name = 'InfobipRequestError';
    this.statusCode = statusCode;
    this.providerCode = providerCode;
    this.retryable = retryable;
  }
}

const env = (name: string): string => String(process.env[name] || '').trim();

export function isInfobipConfigured(): boolean {
  return Boolean(env('INFOBIP_BASE_URL') && env('INFOBIP_API_KEY'));
}

export function getDefaultSender(): string {
  return env('INFOBIP_SENDER');
}

function assertConfigured(): void {
  const missing: string[] = [];
  if (!env('INFOBIP_BASE_URL')) missing.push('INFOBIP_BASE_URL');
  if (!env('INFOBIP_API_KEY')) missing.push('INFOBIP_API_KEY');
  if (missing.length) throw new InfobipNotConfiguredError(missing);
}

let clientInstance: AxiosInstance | null = null;

function client(): AxiosInstance {
  assertConfigured();

  if (!clientInstance) {
    clientInstance = axios.create({
      baseURL: env('INFOBIP_BASE_URL').replace(/\/+$/, ''),
      timeout: Number(process.env.INFOBIP_TIMEOUT_MS ?? '20000'),
      headers: {
        Authorization: `App ${env('INFOBIP_API_KEY')}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      // Never throw on a status — we classify below so retryability is explicit.
      validateStatus: () => true,
    });
  }

  return clientInstance;
}

/**
 * Loud startup check. Without INFOBIP_CALLBACK_BASE_URL no `notifyUrl` is sent,
 * Infobip never POSTs delivery receipts, and every outcome has to be pulled by
 * the reconciler from the logs API (which only keeps ~48h). Called once at boot.
 */
export function warnIfCallbackUrlMissing(): void {
  if (env('INFOBIP_CALLBACK_BASE_URL') || !isInfobipConfigured()) return;
  const msg =
    '[messaging:infobip] INFOBIP_CALLBACK_BASE_URL is NOT set — Infobip will not send delivery reports. ' +
    'Messages will sit on "sent" until the reconciler pulls them. Set it to the public backend origin ' +
    '(e.g. https://api.example.com; receipts go to /api/v1/messaging/webhooks/infobip/delivery).';
  if (process.env.NODE_ENV === 'production') {
    console.error('*'.repeat(100));
    console.error(msg);
    console.error('*'.repeat(100));
  } else {
    console.warn(msg);
  }
}

/** Public URL Infobip posts delivery receipts to, or undefined when not exposed. */
function notifyUrl(): string | undefined {
  const base = env('INFOBIP_CALLBACK_BASE_URL').replace(/\/+$/, '');
  if (!base) return undefined;
  return `${base}/api/v1/messaging/webhooks/infobip/delivery`;
}

/**
 * Map Infobip's `status.groupName` onto our own status enum.
 *
 * Infobip groups: PENDING, UNDELIVERABLE, DELIVERED, EXPIRED, REJECTED.
 * We keep EXPIRED and REJECTED distinct from UNDELIVERABLE only in the raw
 * name — operationally all three mean "this number did not receive it".
 */
export function normalizeStatusGroup(groupName?: string | null): NormalizedStatus {
  switch (String(groupName || '').toUpperCase()) {
    case 'DELIVERED':
      return 'DELIVERED';
    case 'PENDING':
      return 'SENT';
    case 'UNDELIVERABLE':
    case 'EXPIRED':
      return 'UNDELIVERABLE';
    case 'REJECTED':
      return 'FAILED';
    default:
      return 'SENT';
  }
}

/**
 * Infobip puts a human description on EVERY status, success included — a
 * freshly accepted message comes back as PENDING_ENROUTE / "Message sent to
 * next instance". Storing that in `errorMessage` painted a red error line under
 * messages that had not failed, so only surface the description for a status
 * group that actually means failure.
 */
function failureDescription(status?: { groupName?: string; description?: string } | null): string | null {
  const group = String(status?.groupName || '').toUpperCase();
  const isFailure = group === 'REJECTED' || group === 'UNDELIVERABLE' || group === 'EXPIRED';
  return isFailure ? status?.description ?? null : null;
}

function classifyHttpFailure(status: number, body: unknown): InfobipRequestError {
  const requestError = (body as { requestError?: { serviceException?: { messageId?: string; text?: string } } })
    ?.requestError?.serviceException;

  const providerCode = requestError?.messageId ?? null;
  const message = requestError?.text ?? `Infobip request failed with status ${status}`;
  // 429 and 5xx are transient; everything else is a bad request we must not retry.
  const retryable = status === 429 || status >= 500;

  return new InfobipRequestError(message, status, providerCode, retryable);
}

/**
 * Send one SMS (or MMS when `mediaUrls` is present).
 *
 * `messageId` is our own uuid — Infobip echoes it on every delivery report, so
 * the DLR handler can find the row without a secondary lookup table.
 */
export async function sendSms(input: SendSmsInput): Promise<SendSmsResult> {
  const sending = await getSendingState();
  if (!sending.enabled) {
    throw new InfobipRequestError(
      sending.reason
        ? `SMS sending is paused by the platform administrator: ${sending.reason}`
        : 'SMS sending is paused by the platform administrator.',
      423,
      SENDING_DISABLED_CODE,
      false,
    );
  }
  // The console's message quota. isOverQuota re-measures at most every 10s and
  // fails open on DB errors, so this stays cheap on the broadcast hot path.
  if (await isOverQuota()) {
    throw new InfobipRequestError(
      'The SMS quota set in the Tenant Console has been reached.',
      429,
      LIMIT_REACHED_CODE,
      false,
    );
  }
  try {
    await assertPrepaidBalance(null);
  } catch (err) {
    if (err instanceof PrepaidExhaustedError) {
      throw new InfobipRequestError(err.message, 429, LIMIT_REACHED_CODE, false);
    }
    throw err;
  }

  const from = toInfobipSender(input.from?.trim() || getDefaultSender());
  if (!from) throw new InfobipNotConfiguredError(['INFOBIP_SENDER']);

  const result = input.mediaUrls && input.mediaUrls.length > 0 ? await sendMms({ ...input, from }) : await sendText(input, from);
  if (result.status !== 'FAILED') {
    recordQuotaUse(result.segmentCount);
    await deductPrepaidAfterSend(result.segmentCount);
  }
  return result;
}

async function sendText(input: SendSmsInput, from: string): Promise<SendSmsResult> {

  const payload: Record<string, unknown> = {
    messages: [
      {
        from,
        destinations: [
          {
            to: toInfobipDestination(input.to),
            ...(input.messageId ? { messageId: input.messageId } : {}),
          },
        ],
        text: input.text,
        ...(notifyUrl() ? { notifyUrl: notifyUrl(), notifyContentType: 'application/json' } : {}),
        ...(input.callbackData ? { callbackData: input.callbackData } : {}),
      },
    ],
  };

  if (input.bulkId) payload.bulkId = input.bulkId;

  const response = await client().post('/sms/2/text/advanced', payload);

  if (response.status < 200 || response.status >= 300) {
    throw classifyHttpFailure(response.status, response.data);
  }

  const result = (response.data as { bulkId?: string; messages?: Array<Record<string, any>> })?.messages?.[0];

  return {
    providerMessageId: result?.messageId ?? input.messageId ?? null,
    providerBulkId: (response.data as { bulkId?: string })?.bulkId ?? input.bulkId ?? null,
    status: normalizeStatusGroup(result?.status?.groupName),
    segmentCount: typeof result?.smsCount === 'number' ? result.smsCount : null,
    rawStatusName: result?.status?.name ?? null,
    errorCode: result?.status?.groupName === 'REJECTED' ? String(result?.status?.id ?? '') || null : null,
    errorMessage: failureDescription(result?.status),
  };
}

/** MMS uses a different endpoint and one request per destination. */
async function sendMms(input: SendSmsInput & { from: string }): Promise<SendSmsResult> {
  const response = await client().post('/mms/1/single', {
    head: {
      from: input.from,
      to: toInfobipDestination(input.to),
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(notifyUrl() ? { notifyUrl: notifyUrl(), notifyContentType: 'application/json' } : {}),
      ...(input.callbackData ? { callbackData: input.callbackData } : {}),
    },
    text: input.text,
    externalUrl: input.mediaUrls?.[0],
  });

  if (response.status < 200 || response.status >= 300) {
    throw classifyHttpFailure(response.status, response.data);
  }

  const body = response.data as { messages?: Array<Record<string, any>> };
  const result = body?.messages?.[0];

  return {
    providerMessageId: result?.messageId ?? input.messageId ?? null,
    providerBulkId: input.bulkId ?? null,
    status: normalizeStatusGroup(result?.status?.groupName),
    segmentCount: null,
    rawStatusName: result?.status?.name ?? null,
    errorCode: null,
    errorMessage: failureDescription(result?.status),
  };
}

/**
 * Parse an inbound-SMS callback body into our own shape.
 *
 * Infobip posts `{ results: [...], messageCount, pendingMessageCount }`. A
 * single callback can carry many messages, so this always returns an array.
 */
export function parseInboundPayload(body: unknown): InboundMessage[] {
  const results = (body as { results?: unknown[] })?.results;
  if (!Array.isArray(results)) return [];

  return results.flatMap((entry) => {
    const item = entry as Record<string, any>;
    const providerMessageId = String(item?.messageId ?? '').trim();
    const from = String(item?.from ?? '').trim();
    const to = String(item?.to ?? '').trim();
    if (!providerMessageId || !from || !to) return [];

    // MO messages carry text either at the root or under `message.text`
    // depending on channel; `cleanText` strips the matched keyword.
    const text = String(item?.cleanText ?? item?.text ?? item?.message?.text ?? '');

    const mediaUrls: string[] = Array.isArray(item?.message?.media)
      ? item.message.media.map((m: any) => String(m?.url ?? '')).filter(Boolean)
      : [];

    const receivedAtRaw = item?.receivedAt ?? item?.doneAt ?? null;
    const receivedAt = receivedAtRaw ? new Date(receivedAtRaw) : new Date();

    return [
      {
        providerMessageId,
        from,
        to,
        text,
        mediaUrls,
        receivedAt: Number.isNaN(receivedAt.getTime()) ? new Date() : receivedAt,
        keyword: item?.keyword ? String(item.keyword) : null,
        campaignReference: item?.callbackData ? String(item.callbackData) : null,
      },
    ];
  });
}

/**
 * Message ids per `/sms/3/logs` request. Infobip caps the combined length of
 * the messageId values at 2048 characters (SMSAP-103), i.e. ~50 UUIDs, so
 * chunks are cut by length as well as by count.
 */
const LOGS_IDS_PER_REQUEST = Math.max(1, Number(process.env.INFOBIP_LOGS_IDS_PER_REQUEST ?? '50'));
const LOGS_MAX_ID_CHARS = 2000;

export function chunkLogIds(ids: string[], maxCount = LOGS_IDS_PER_REQUEST, maxChars = LOGS_MAX_ID_CHARS): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const id of ids) {
    const len = id.length + 1;
    if (current.length && (current.length >= maxCount || chars + len > maxChars)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(id);
    chars += len;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * Pull the provider's own record for specific messages (GET only).
 *
 * Delivery receipts are fire-and-forget: Infobip posts a DLR once and if the
 * callback is unreachable, misconfigured, or was never registered for the
 * message, the final status simply never arrives and the message sits on
 * "sent" forever. This is the pull-side backstop, used by the reconciler and
 * the backfill script.
 *
 * Uses `/sms/3/logs` (entries carry `messageCount`, `price.pricePerMessage`
 * per segment, `status.groupName`), batched by LOGS_IDS_PER_REQUEST. Infobip
 * keeps logs for a limited window; ids it no longer knows simply do not come back.
 */
export async function fetchMessageLogs(providerMessageIds: string[]): Promise<DeliveryReport[]> {
  const ids = [...new Set(providerMessageIds.filter(Boolean))];
  const out: DeliveryReport[] = [];

  for (const slice of chunkLogIds(ids)) {
    const params = new URLSearchParams();
    // Infobip accepts the parameter repeated, not a comma-joined list.
    for (const id of slice) params.append('messageId', id);
    params.set('limit', String(slice.length));

    const response = await client().get(`/sms/3/logs?${params.toString()}`);
    if (response.status < 200 || response.status >= 300) {
      throw classifyHttpFailure(response.status, response.data);
    }
    out.push(...parseDeliveryReportPayload(response.data));
  }

  return out;
}

export function parseDeliveryReportPayload(body: unknown): DeliveryReport[] {
  const results = (body as { results?: unknown[] })?.results;
  if (!Array.isArray(results)) return [];

  return results.flatMap((entry) => {
    const item = entry as Record<string, any>;
    const providerMessageId = String(item?.messageId ?? '').trim();
    if (!providerMessageId) return [];

    const doneAtRaw = item?.doneAt ?? item?.sentAt ?? null;
    const doneAt = doneAtRaw ? new Date(doneAtRaw) : null;

    const errorGroup = item?.error;
    // Infobip always sends an `error` object; id 0 / NO_ERROR means success.
    const hasError = errorGroup && Number(errorGroup?.id) !== 0 && errorGroup?.name !== 'NO_ERROR';

    return [
      {
        providerMessageId,
        providerBulkId: item?.bulkId ? String(item.bulkId) : null,
        status: normalizeStatusGroup(item?.status?.groupName),
        rawStatusName: item?.status?.name ?? null,
        errorCode: hasError ? String(errorGroup?.id ?? errorGroup?.name ?? '') : null,
        errorMessage: hasError ? String(errorGroup?.description ?? errorGroup?.name ?? '') : null,
        doneAt: doneAt && !Number.isNaN(doneAt.getTime()) ? doneAt : null,
        // v1 logs / DLR webhook say smsCount; v3 logs say messageCount.
        segmentCount:
          typeof item?.smsCount === 'number' ? item.smsCount : typeof item?.messageCount === 'number' ? item.messageCount : null,
        // Per segment — total cost is computed in smsMetrics.messageCost.
        priceAmount: typeof item?.price?.pricePerMessage === 'number' ? item.price.pricePerMessage : null,
        priceCurrency: item?.price?.currency ? String(item.price.currency) : null,
        callbackData: item?.callbackData ? String(item.callbackData) : null,
      },
    ];
  });
}

/**
 * Constant-time check of the shared secret Infobip echoes on callbacks.
 *
 * Infobip does not sign SMS callbacks, so the accepted practice is a secret
 * embedded in the callback URL or a custom header. When no secret is
 * configured we allow the request through — but log loudly, because an
 * unauthenticated inbound endpoint lets anyone forge merchant replies.
 */
export function verifyWebhookSecret(provided: string | undefined): boolean {
  const expected = env('INFOBIP_WEBHOOK_SECRET');
  if (!expected) {
    console.warn(
      '[messaging:infobip] INFOBIP_WEBHOOK_SECRET is not set — inbound webhooks are UNAUTHENTICATED. ' +
        'Set it before exposing this endpoint publicly.',
    );
    return true;
  }

  const candidate = String(provided ?? '');
  if (candidate.length !== expected.length) return false;

  // Length-equal comparison without early exit.
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) {
    mismatch |= expected.charCodeAt(i) ^ candidate.charCodeAt(i);
  }
  return mismatch === 0;
}

/* ============================================================================
 * Voice — Infobip Calls / WebRTC
 * ==========================================================================*/

export interface WebRtcTokenResult {
  token: string;
  expirationTime: string | null;
}

/**
 * Mint a short-lived WebRTC token for a browser dialer session.
 *
 * `identity` must be stable per agent (we pass the Harbor user id) so inbound
 * calls can be routed to the right browser client.
 */
export async function createWebRtcToken(identity: string, displayName?: string): Promise<WebRtcTokenResult> {
  const applicationId = env('INFOBIP_APPLICATION_ID');

  const response = await client().post('/webrtc/1/token', {
    identity,
    ...(displayName ? { displayName } : {}),
    ...(applicationId ? { applicationId } : {}),
    capabilities: { recording: 'ALWAYS' },
  });

  if (response.status < 200 || response.status >= 300) {
    throw classifyHttpFailure(response.status, response.data);
  }

  const body = response.data as { token?: string; expirationTime?: string };
  if (!body?.token) {
    throw new InfobipRequestError('Infobip returned no WebRTC token', response.status, null, false);
  }

  return { token: body.token, expirationTime: body.expirationTime ?? null };
}

/** Place an outbound PSTN call from a configured Infobip number. */
export async function createOutboundCall(input: {
  to: string;
  from?: string;
  callbackData?: string;
}): Promise<{ providerCallId: string | null; status: string }> {
  const applicationId = env('INFOBIP_APPLICATION_ID');
  if (!applicationId) throw new InfobipNotConfiguredError(['INFOBIP_APPLICATION_ID']);

  const response = await client().post('/calls/1/calls', {
    endpoint: { type: 'PHONE', phoneNumber: toInfobipDestination(input.to) },
    from: input.from?.trim() || getDefaultSender(),
    applicationId,
    ...(input.callbackData ? { customData: { callbackData: input.callbackData } } : {}),
  });

  if (response.status < 200 || response.status >= 300) {
    throw classifyHttpFailure(response.status, response.data);
  }

  const body = response.data as { id?: string; state?: string };
  return { providerCallId: body?.id ?? null, status: String(body?.state ?? 'ringing').toLowerCase() };
}

export interface AccountBalance {
  amount: number;
  currency: string;
  monthlyLimit: number | null;
  monthlyBalance: number | null;
}

/**
 * Account balance for the configured API key. Needs the
 * `account-management:manage` scope; a key without it gets a 403.
 */
export async function getAccountBalance(): Promise<AccountBalance> {
  const response = await client().get('/account/1/total-balance');
  if (response.status < 200 || response.status >= 300) {
    throw classifyHttpFailure(response.status, response.data);
  }
  const body = response.data as {
    balance?: number;
    monthlyLimit?: number | null;
    monthlyBalance?: number | null;
    currency?: string | { code?: string };
  };
  if (typeof body?.balance !== 'number') throw new Error('Infobip returned no balance');
  const currency = typeof body.currency === 'string' ? body.currency : body.currency?.code;
  return {
    amount: body.balance,
    currency: currency || 'USD',
    monthlyLimit: typeof body.monthlyLimit === 'number' ? body.monthlyLimit : null,
    monthlyBalance: typeof body.monthlyBalance === 'number' ? body.monthlyBalance : null,
  };
}

/** Network-level failures never reach classifyHttpFailure — normalize them here. */
export function toInfobipError(err: unknown): InfobipRequestError {
  if (err instanceof InfobipRequestError) return err;

  const axiosErr = err as AxiosError;
  if (axiosErr?.isAxiosError) {
    const status = axiosErr.response?.status ?? 0;
    if (status) return classifyHttpFailure(status, axiosErr.response?.data);
    // No response at all: timeout, DNS, socket reset — all worth a retry.
    return new InfobipRequestError(axiosErr.message || 'Infobip network error', 0, axiosErr.code ?? null, true);
  }

  return new InfobipRequestError((err as Error)?.message || 'Unknown Infobip error', 0, null, false);
}
