/**
 * Messaging API client.
 *
 * Thin wrappers over Harbor's shared axios instance so auth headers, timeouts
 * and the 401 interceptor all behave identically to the rest of the app.
 */
import {
    axiosDelete,
    axiosGet,
    axiosPatch,
    axiosPost,
    axiosPostFormData,
} from '@/redux/axios';
import type { AxiosRequestConfig } from 'axios';

export type MessageDirection = 'INBOUND' | 'OUTBOUND';

export type MessageStatus =
    | 'QUEUED'
    | 'SENDING'
    | 'SENT'
    | 'DELIVERED'
    | 'FAILED'
    | 'UNDELIVERABLE'
    | 'RECEIVED';

export interface Conversation {
    id: string;
    businessNumber: string;
    contactNumber: string;
    contactName: string | null;
    lastMessageText: string | null;
    lastMessageAt: string | null;
    lastMessageDirection: MessageDirection | null;
    unreadCount: number;
    hasBroadcastMessage: boolean;
    isOptedOut: boolean;
    isBlocked: boolean;
}

export interface Message {
    id: string;
    direction: MessageDirection;
    fromNumber: string;
    toNumber: string;
    body: string | null;
    mediaUrls: string[];
    status: MessageStatus;
    errorMessage: string | null;
    broadcastId: string | null;
    isStopKeyword: boolean;
    sentAt: string | null;
    deliveredAt: string | null;
    createdAt: string;
}

export interface Paginated<T> {
    data: T[];
    pagination: { page: number; pageSize: number; total?: number; hasMore: boolean };
}

export interface MessagingPrepaid {
    balance: number;
    pricePerUnit: number;
    currency: string;
    chargeBy: 'messages' | 'segments';
    updatedAt: string | null;
}

export interface MessagingConfig {
    provider: string;
    configured: boolean;
    /** Console-managed prepaid balance; null when billing is not configured. */
    prepaid: MessagingPrepaid | null;
    /** The number THIS user sends from — their assignment, or the server default. */
    defaultSender: string | null;
    /** Label of the assigned sender; null when falling back to the server default. */
    defaultSenderLabel?: string | null;
    /** False when nobody has assigned this user a number yet. */
    senderAssigned?: boolean;
    voiceEnabled: boolean;
}

export interface BroadcastSummary {
    id: string;
    campaignKey: string;
    name: string;
    status: string;
    fromNumber: string;
    totalRecipients: number;
    queuedCount: number;
    sentCount: number;
    deliveredCount: number;
    failedCount: number;
    suppressedCount: number;
    repliedCount: number;
    optOutCount: number;
    startedAt: string | null;
    finishedAt: string | null;
    createdAt: string;
    /** Present on the list endpoint. */
    body?: string;
    scheduledAt?: string | null;
    approvedAt?: string | null;
    throttlePerSecond?: number | null;
    undeliverableCount?: number;
    leadBatchName?: string | null;
    parentName?: string | null;
    createdByName?: string | null;
    approvedByName?: string | null;
}

/** Totals across every campaign the caller can see (not just one page). */
export interface BroadcastTotals {
    campaigns: number;
    byStatus: Record<string, number>;
    recipients: number;
    sent: number;
    delivered: number;
    failed: number;
    suppressed: number;
    replied: number;
    optedOut: number;
    queued: number;
}

export interface MessagingContact {
    id: string;
    phoneNumber: string;
    firstName: string | null;
    lastName: string | null;
    emailAddress: string | null;
    company: string | null;
    city: string | null;
    state: string | null;
    tags: string[];
    status: 'ACTIVE' | 'BLOCKED';
    /** The agent's manual read on this lead. NEW means nobody has judged it. */
    disposition: ContactDisposition;
    dispositionAt: string | null;
    /** The upload this lead arrived in, when it came from one. */
    batch: { id: string; name: string } | null;
    createdAt: string;
}

export type ContactDisposition = 'NEW' | 'INTERESTED' | 'NOT_INTERESTED';

/**
 * The contact card beside a chat. `id` is null when the card was synthesized
 * from a CRM client that has no saved MessagingContact row yet.
 */
export interface ContactProfile extends Omit<MessagingContact, 'id' | 'createdAt'> {
    id: string | null;
    createdAt: string | null;
    source: 'contact' | 'crm-client';
    client: {
        id: string;
        clientNumber: number;
        businessName: string;
        status: string;
    } | null;
}

/** Contact card for a number, falling back to the CRM client that owns it. */
export async function fetchContactProfile(phoneNumber: string): Promise<ContactProfile | null> {
    const response = await axiosGet(`${BASE}/contacts/profile`, { params: { phoneNumber } });
    return response.data.data ?? null;
}

export interface ImportSummary {
    totalRows: number;
    imported: number;
    updated: number;
    skippedInvalid: number;
    skippedDuplicate: number;
    columnMapping: Record<string, string>;
    sampleErrors: Array<{ row: number; reason: string }>;
    /** How many leads each user received, when the sheet was distributed. */
    assigned?: Array<{ userId: string; count: number }>;
    /** The batch the rows were filed under, selectable as a broadcast audience. */
    batch?: { id: string; name: string } | null;
}

/** One of the clickable stat tiles on a broadcast's detail page. */
export type AudienceBucket =
    | 'all'
    | 'queued'
    | 'sending'
    | 'sent'
    | 'delivered'
    | 'failed'
    | 'undeliverable'
    | 'suppressed'
    | 'replied'
    | 'opted-out';

export interface AudienceRow {
    phoneNumber: string;
    contactName: string | null;
    company: string | null;
    city: string | null;
    state: string | null;
    status: string;
    errorCode: string | null;
    errorMessage: string | null;
    suppressedReason: string | null;
    sentAt: string | null;
    replyText?: string | null;
    replyAt?: string | null;
}

export interface ErrorBreakdownRow {
    errorCode: string | null;
    errorMessage: string | null;
    count: number;
}

/** A CRM client offered as a messaging recipient. */
export interface ClientRecipient {
    clientId: string;
    clientNumber: number;
    businessName: string;
    ownerName: string;
    phoneNumber: string | null;
    phoneSource: 'owner' | 'business' | null;
    email: string | null;
    city: string | null;
    state: string | null;
    status: string;
    suppressed: boolean;
    suppressionReason: string | null;
}

export interface DncResult {
    phoneNumber: string;
    status: 'listed' | 'clear' | 'unknown';
    carrier: string | null;
    numberType: string | null;
    checkedAt: string;
    cached: boolean;
}

const BASE = '/messaging';

/* -------------------------------------------------------------------- */
/* Config                                                                */
/* -------------------------------------------------------------------- */

export async function fetchMessagingConfig(): Promise<MessagingConfig> {
    const response = await axiosGet(`${BASE}/config`);
    return response.data.data;
}

/* -------------------------------------------------------------------- */
/* Inbox                                                                 */
/* -------------------------------------------------------------------- */

export async function fetchConversations(params: {
    page?: number;
    search?: string;
    filter?: string;
}): Promise<Paginated<Conversation>> {
    const response = await axiosGet(`${BASE}/conversations`, {
        params: {
            page: params.page ?? 1,
            ...(params.search ? { search: params.search } : {}),
            filter: params.filter ?? 'regular',
        },
    });
    return response.data;
}

export async function fetchMessages(conversationId: string, page = 1): Promise<Paginated<Message>> {
    const response = await axiosGet(`${BASE}/conversations/${conversationId}/messages`, {
        params: { page },
    });
    return response.data;
}

export async function openConversation(phoneNumber: string, fromNumber?: string) {
    const response = await axiosPost(`${BASE}/conversations`, { phoneNumber, fromNumber });
    return response.data.data as { id: string; isOptedOut: boolean };
}

export async function sendMessage(input: {
    toNumber: string;
    body: string;
    fromNumber?: string;
    mediaUrls?: string[];
    /** Set when the chat was started from the CRM client picker. */
    clientId?: string;
}) {
    const response = await axiosPost(`${BASE}/send`, input);
    return response.data.data;
}

/** Flag a conversation unread again ("come back to this"). */
export async function markConversationUnread(conversationId: string): Promise<{ id: string; unreadCount: number }> {
    const response = await axiosPatch(`${BASE}/conversations/${conversationId}/unread`);
    return response.data.data;
}

export async function fetchPushConfig(): Promise<{ enabled: boolean; publicKey: string | null }> {
    const response = await axiosGet(`${BASE}/push/config`);
    return response.data.data;
}

export async function savePushSubscription(subscription: PushSubscriptionJSON) {
    await axiosPost(`${BASE}/push/subscribe`, { subscription });
}

export async function deletePushSubscription(endpoint: string) {
    await axiosPost(`${BASE}/push/unsubscribe`, { endpoint });
}

export async function sendTestPush(): Promise<{ delivered: number }> {
    const response = await axiosPost(`${BASE}/push/test`);
    return response.data.data;
}

export async function markConversationRead(conversationId: string) {
    const response = await axiosPatch(`${BASE}/conversations/${conversationId}/read`);
    return response.data.data;
}

/**
 * Permanently delete a thread and its message history. The contact record and
 * any block/opt-out state are kept server-side on purpose.
 */
export async function deleteConversation(conversationId: string) {
    const response = await axiosDelete(`${BASE}/conversations/${conversationId}`);
    return response.data.data as { id: string };
}

export async function setConversationArchived(conversationId: string, isArchived: boolean) {
    const response = await axiosPatch(`${BASE}/conversations/${conversationId}/archive`, { isArchived });
    return response.data.data;
}

export async function fetchUnreadCount(): Promise<number> {
    const response = await axiosGet(`${BASE}/unread-count`);
    return response.data.data.unreadCount;
}

/* -------------------------------------------------------------------- */
/* Contacts + block                                                      */
/* -------------------------------------------------------------------- */

export async function fetchContacts(params: {
    page?: number;
    pageSize?: number;
    search?: string;
    status?: 'ACTIVE' | 'BLOCKED';
    disposition?: ContactDisposition;
    batchId?: string;
    /** Blocked or opted-out only. */
    suppressed?: boolean;
}): Promise<Paginated<MessagingContact>> {
    const response = await axiosGet(`${BASE}/contacts`, { params });
    return response.data;
}

export async function createContact(payload: Partial<MessagingContact> & { phoneNumber: string }) {
    const response = await axiosPost(`${BASE}/contacts`, payload);
    return response.data.data as MessagingContact;
}

/**
 * Upload a spreadsheet. Sent as multipart rather than parsed in the browser so
 * a 50k-row sheet does not become a multi-megabyte JSON body.
 */
/**
 * Upload a lead sheet.
 *
 * `assigneeUserIds` deals the rows out across those users round-robin; admins
 * only. Omit it and the whole sheet stays with the importer, as before.
 */
export async function importContacts(
    file: File,
    tags?: string[],
    assigneeUserIds?: string[],
    batchName?: string,
): Promise<ImportSummary> {
    const formData = new FormData();
    formData.append('file', file);
    if (tags?.length) formData.append('tags', tags.join(','));
    if (assigneeUserIds?.length) formData.append('assigneeUserIds', assigneeUserIds.join(','));
    if (batchName?.trim()) formData.append('batchName', batchName.trim());

    const response = await axiosPostFormData(`${BASE}/contacts/import`, formData, {
        // Large sheets can run 1–2 minutes server-side; stay above typical proxy limits.
        timeout: 300_000,
    });
    const summary = (response.data?.data ?? response.data) as ImportSummary | undefined;
    if (!summary || typeof summary.totalRows !== 'number') {
        throw new Error('Unexpected import response from server');
    }
    return summary;
}

/** Lead counts per owner, for the distribution screen. */
export interface LeadDistributionRow {
    userId: string | null;
    user: {
        id: string;
        firstName: string | null;
        lastName: string | null;
        email: string;
        role: string;
    } | null;
    count: number;
}

export async function fetchLeadDistribution(): Promise<LeadDistributionRow[]> {
    const response = await axiosGet(`${BASE}/contacts/distribution`);
    return response.data.data ?? [];
}

/** Re-deal existing leads across users, round-robin. */
export async function distributeLeads(input: {
    contactIds: string[];
    assigneeUserIds: string[];
}): Promise<{ moved: number; skipped: number }> {
    const response = await axiosPost(`${BASE}/contacts/distribute`, input);
    return response.data.data;
}

export async function blockContact(phoneNumber: string) {
    const response = await axiosPost(`${BASE}/contacts/block`, { phoneNumber });
    return response.data.data;
}

export async function unblockContact(phoneNumber: string) {
    const response = await axiosPost(`${BASE}/contacts/unblock`, { phoneNumber });
    return response.data.data;
}

export async function fetchContactStatus(phoneNumber: string) {
    const response = await axiosGet(`${BASE}/contacts/status`, { params: { phoneNumber } });
    return response.data.data as { phoneNumber: string; suppressed: boolean; reason: string | null; source: string | null };
}

/* -------------------------------------------------------------------- */
/* Broadcasts                                                            */
/* -------------------------------------------------------------------- */

export async function fetchBroadcasts(params: {
    page?: number;
    pageSize?: number;
    status?: string;
}): Promise<Paginated<BroadcastSummary> & { totals?: BroadcastTotals }> {
    const response = await axiosGet(`${BASE}/broadcasts`, { params });
    return response.data;
}

export async function fetchBroadcast(id: string): Promise<BroadcastSummary> {
    const response = await axiosGet(`${BASE}/broadcasts/${id}`);
    return response.data.data;
}

export async function fetchBroadcastRecipients(
    id: string,
    params: { bucket?: AudienceBucket; page?: number; pageSize?: number },
): Promise<Paginated<AudienceRow> & { bucket: AudienceBucket }> {
    const response = await axiosGet(`${BASE}/broadcasts/${id}/recipients`, { params });
    return response.data;
}

export async function fetchBroadcastErrorBreakdown(id: string): Promise<ErrorBreakdownRow[]> {
    const response = await axiosGet(`${BASE}/broadcasts/${id}/error-breakdown`);
    return response.data.data;
}

/**
 * Download one bucket as CSV. Fetched as a blob through the same axios instance
 * so the Authorization header is applied — a plain <a href> would hit the
 * endpoint unauthenticated and 401.
 */
export async function downloadBroadcastCsv(id: string, bucket: AudienceBucket, filename: string): Promise<void> {
    const response = await axiosGet(`${BASE}/broadcasts/${id}/export`, {
        params: { bucket },
        responseType: 'blob',
    });

    const url = URL.createObjectURL(new Blob([response.data], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

/* -------------------------------------------------------------------- */
/* CRM clients as recipients                                             */
/* -------------------------------------------------------------------- */

export async function fetchClientRecipients(params: {
    search?: string;
    page?: number;
    pageSize?: number;
    excludeSuppressed?: boolean;
}): Promise<Paginated<ClientRecipient>> {
    const response = await axiosGet(`${BASE}/clients`, { params });
    return response.data;
}

/** Create from an uploaded sheet — every non-phone column becomes a merge field. */
export async function createBroadcastFromFile(input: {
    name: string;
    body: string;
    file: File;
    fromNumber?: string;
    throttlePerSecond?: number;
    startNow?: boolean;
}) {
    const formData = new FormData();
    formData.append('file', input.file);
    formData.append('name', input.name);
    formData.append('body', input.body);
    if (input.fromNumber) formData.append('fromNumber', input.fromNumber);
    if (input.throttlePerSecond) formData.append('throttlePerSecond', String(input.throttlePerSecond));
    if (input.startNow) formData.append('startNow', 'true');

    const response = await axiosPostFormData(`${BASE}/broadcasts`, formData);
    return response.data.data;
}

export interface AudiencePreview {
    /** Every lead / row supplied, before anything is left out. */
    totalLeads: number;
    excluded: {
        blocked: number;
        interested: number;
        notInterested: number;
        /** Replied STOP earlier — kept out even when the lead is re-uploaded. */
        optedOut: number;
        dnc: number;
        otherSuppressed: number;
        invalid: number;
        duplicates: number;
    };
    /** Who the broadcast will actually go to. */
    willSend: number;
    /** Of those numbers, how many a campaign has messaged before. */
    previouslyMessaged: number;
    optedOut: Array<{ phoneNumber: string; name: string | null; optedOutAt: string | null }>;
    optedOutMore: number;
    skippedClients?: Array<{ clientId: string; businessName: string; reason: string }>;
}

/** Step-2 breakdown: exactly what create would send, without creating anything. */
export async function previewBroadcastAudience(input: {
    leadBatchId?: string;
    clientIds?: string[];
    recipients?: Array<{ phoneNumber: string }>;
    file?: File | null;
}): Promise<AudiencePreview> {
    if (input.file) {
        const formData = new FormData();
        formData.append('file', input.file);
        const response = await axiosPostFormData(`${BASE}/broadcasts/audience-preview`, formData);
        return response.data.data;
    }
    const { file: _file, ...json } = input;
    const response = await axiosPost(`${BASE}/broadcasts/audience-preview`, json);
    return response.data.data;
}

export interface CreateBroadcastResult {
    id: string;
    campaignKey: string;
    totalRecipients: number;
    queuedCount: number;
    suppressedCount: number;
    duplicatesDropped: number;
    invalidDropped: number;
    skippedClients?: Array<{ clientId: string; businessName: string; reason: string }>;
    /** Leads left out of a batch audience, and why. */
    batchExcluded?: { total?: number; blocked: number; disposed: number; interested?: number; notInterested?: number } | null;
    scheduledAt?: string | null;
    /** True when the creator was an agent, so a Super Admin must release it. */
    awaitingApproval?: boolean;
}

/** Create from CRM clients, saved contacts, and/or an explicit number list. */
export async function createBroadcastFromList(input: {
    name: string;
    body: string;
    recipients?: Array<{ phoneNumber: string; mergeData?: Record<string, unknown> }>;
    clientIds?: string[];
    contactIds?: string[];
    /** A lead upload as the audience — the caller's own share of it. */
    leadBatchId?: string;
    fromNumber?: string;
    throttlePerSecond?: number;
    /** One of the configured daily windows. Preferred over `scheduledAt`. */
    sendWindowId?: string;
    scheduledAt?: string | null;
    startNow?: boolean;
}): Promise<CreateBroadcastResult> {
    const response = await axiosPost(`${BASE}/broadcasts`, input);
    return response.data.data;
}

export async function startBroadcast(id: string) {
    const response = await axiosPost(`${BASE}/broadcasts/${id}/start`);
    return response.data.data;
}

export async function pauseBroadcast(id: string) {
    const response = await axiosPost(`${BASE}/broadcasts/${id}/pause`);
    return response.data.data;
}

export async function cancelBroadcast(id: string) {
    const response = await axiosPost(`${BASE}/broadcasts/${id}/cancel`);
    return response.data.data;
}

/* -------------------------------------------------------------------- */
/* DNC                                                                   */
/* -------------------------------------------------------------------- */

export async function checkDnc(phoneNumber: string, force = false): Promise<DncResult> {
    const response = await axiosGet(`${BASE}/dnc/check`, { params: { phoneNumber, force } });
    return response.data.data;
}

export async function checkDncBulk(phoneNumbers: string[]) {
    const response = await axiosPost(`${BASE}/dnc/check-bulk`, { phoneNumbers });
    return response.data as {
        data: DncResult[];
        summary: { checked: number; listed: number; clear: number; unknown: number };
    };
}

export async function fetchDncHistory(page = 1) {
    const response = await axiosGet(`${BASE}/dnc/history`, { params: { page } });
    return response.data;
}

/* -------------------------------------------------------------------- */
/* Voice                                                                 */
/* -------------------------------------------------------------------- */

export async function fetchVoiceToken(): Promise<{ token: string; expirationTime: string | null }> {
    const response = await axiosPost(`${BASE}/voice/token`);
    return response.data.data;
}

export async function placeServerCall(toNumber: string, fromNumber?: string) {
    const response = await axiosPost(`${BASE}/voice/call`, { toNumber, fromNumber });
    return response.data.data;
}

export async function logCall(payload: {
    toNumber: string;
    fromNumber?: string;
    direction?: MessageDirection;
    status?: string;
    durationSeconds?: number;
    providerCallId?: string;
    startedAt?: string;
}) {
    const response = await axiosPost(`${BASE}/voice/log`, payload);
    return response.data.data;
}

export async function fetchCallHistory(params: { page?: number; phoneNumber?: string }) {
    const response = await axiosGet(`${BASE}/voice/history`, { params });
    return response.data;
}

export { axiosDelete };

/* -------------------------------------------------------------------- */
/* Sender registry (admin)                                               */
/* -------------------------------------------------------------------- */

/**
 * A number messages go out from. Admins curate these and assign one per user;
 * an unassigned user falls back to the server's INFOBIP_SENDER.
 */
export interface MessagingSender {
    id: string;
    phoneNumber: string;
    label: string | null;
    isActive: boolean;
    createdAt: string;
    /** How many users currently send from this number. */
    _count?: { users: number };
}

export interface SenderAssignment {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    role: string;
    messagingSender: Pick<MessagingSender, 'id' | 'phoneNumber' | 'label' | 'isActive'> | null;
}

export async function fetchSenders(): Promise<MessagingSender[]> {
    const response = await axiosGet(`${BASE}/senders`);
    return response.data.data ?? [];
}

export async function createSender(input: {
    phoneNumber: string;
    label?: string | null;
    isActive?: boolean;
}): Promise<MessagingSender> {
    const response = await axiosPost(`${BASE}/senders`, input);
    return response.data.data;
}

export async function updateSender(
    id: string,
    input: { phoneNumber: string; label?: string | null; isActive?: boolean },
): Promise<MessagingSender> {
    const response = await axiosPatch(`${BASE}/senders/${id}`, input);
    return response.data.data;
}

export async function deleteSender(id: string): Promise<void> {
    await axiosDelete(`${BASE}/senders/${id}`);
}

export async function fetchSenderAssignments(config?: AxiosRequestConfig): Promise<SenderAssignment[]> {
    const response = await axiosGet(`${BASE}/senders/assignments`, config);
    return response.data.data ?? [];
}

/** Pass null to clear the assignment, returning the user to the env default. */
export async function assignSender(userId: string, senderId: string | null): Promise<SenderAssignment> {
    const response = await axiosPatch(`${BASE}/senders/assignments/${userId}`, { senderId });
    return response.data.data;
}

/* -------------------------------------------------------------------- */
/* Performance (admin)                                                   */
/* -------------------------------------------------------------------- */

export interface PerformanceUserRow {
    userId: string | null;
    name: string | null;
    email: string | null;
    role: string | null;
    /** The number this user's inbound traffic is attributed through. */
    senderNumber: string | null;
    messagesSent: number;
    delivered: number;
    failed: number;
    campaigns: number;
    replies: number;
    optOuts: number;
}

export interface PerformanceDayRow {
    day: string;
    userId: string | null;
    messagesSent: number;
    replies: number;
    optOuts: number;
}

export interface PerformanceResult {
    from: string;
    to: string;
    totals: {
        messagesSent: number;
        delivered: number;
        failed: number;
        campaigns: number;
        replies: number;
        optOuts: number;
    };
    users: PerformanceUserRow[];
    daily: PerformanceDayRow[];
    /** Inbound on numbers no user owns — usually the shared default. */
    unattributedReplies: number;
    unattributedOptOuts: number;
}

export async function fetchMessagingPerformance(params: {
    from?: string;
    to?: string;
}): Promise<PerformanceResult> {
    const response = await axiosGet(`${BASE}/stats/performance`, { params });
    return response.data.data;
}

/* -------------------------------------------------------------------- */
/* Disposition — Interested / Not Interested                             */
/* -------------------------------------------------------------------- */

/**
 * Mark how an agent has qualified a lead.
 *
 * Takes a phone number rather than a contact id because this is set from the
 * inbox, where the thread knows the number and not the contact row. Anything
 * other than NEW drops the lead out of future follow-up broadcasts.
 */
export async function setContactDisposition(input: {
    phoneNumber?: string;
    contactId?: string;
    disposition: ContactDisposition;
}): Promise<{ updated: number; disposition: ContactDisposition }> {
    const response = await axiosPatch(`${BASE}/contacts/disposition`, input);
    return response.data.data;
}

/* -------------------------------------------------------------------- */
/* Lead batches                                                          */
/* -------------------------------------------------------------------- */

export interface LeadBatch {
    id: string;
    name: string;
    fileName: string | null;
    totalRows: number;
    importedCount: number;
    createdAt: string;
    createdBy: { id: string; firstName: string | null; lastName: string | null; email: string } | null;
    /** How many of this batch's leads the signed-in user owns. */
    myLeadCount: number;
}

/**
 * Lead uploads available to the caller.
 *
 * Scoped server-side: an admin sees every upload, an agent sees only the ones
 * they were dealt leads from — so the broadcast picker never offers an
 * audience that would resolve to nobody.
 */
export async function fetchLeadBatches(): Promise<LeadBatch[]> {
    const response = await axiosGet(`${BASE}/contacts/batches`);
    return response.data.data ?? [];
}

/* -------------------------------------------------------------------- */
/* Send windows — the configurable daily send times                      */
/* -------------------------------------------------------------------- */

export interface SendWindow {
    id: string;
    label: string | null;
    /** 24-hour local time in `timezone`, "HH:MM". */
    timeOfDay: string;
    timezone: string;
    isActive: boolean;
    sortOrder: number;
}

/** A window with the next instant it comes round, for the scheduling picker. */
export interface UpcomingSendWindow {
    id: string;
    label: string | null;
    timeOfDay: string;
    timezone: string;
    nextOccurrence: string;
}

export async function fetchSendWindows(): Promise<SendWindow[]> {
    const response = await axiosGet(`${BASE}/send-windows`);
    return response.data.data ?? [];
}

export async function fetchUpcomingSendWindows(): Promise<UpcomingSendWindow[]> {
    const response = await axiosGet(`${BASE}/send-windows/upcoming`);
    return response.data.data ?? [];
}

export async function saveSendWindow(input: {
    id?: string;
    label?: string | null;
    timeOfDay: string;
    timezone?: string;
    isActive?: boolean;
    sortOrder?: number;
}): Promise<SendWindow> {
    const response = input.id
        ? await axiosPatch(`${BASE}/send-windows/${input.id}`, input)
        : await axiosPost(`${BASE}/send-windows`, input);
    return response.data.data;
}

export async function deleteSendWindow(id: string): Promise<void> {
    await axiosDelete(`${BASE}/send-windows/${id}`);
}

/* -------------------------------------------------------------------- */
/* Approval + follow-up                                                  */
/* -------------------------------------------------------------------- */

export async function approveBroadcast(id: string, startNow = false) {
    const response = await axiosPost(`${BASE}/broadcasts/${id}/approve`, { startNow });
    return response.data.data;
}

export async function rejectBroadcast(id: string) {
    const response = await axiosPost(`${BASE}/broadcasts/${id}/reject`);
    return response.data.data;
}

export type FollowUpAudience = 'unreplied' | 'failed' | 'all';

export interface FollowUpPreview {
    parentId: string;
    parentName: string;
    audience: FollowUpAudience;
    /** Earliest instant a follow-up may be scheduled for — an hour after the original. */
    earliestSendAt: string;
    eligibleCount: number;
    excluded: { replied: number; disposed: number; notDelivered: number };
}

/** Who a follow-up would reach, without creating anything. */
export async function fetchFollowUpPreview(
    id: string,
    audience: FollowUpAudience = 'all',
): Promise<FollowUpPreview> {
    const response = await axiosGet(`${BASE}/broadcasts/${id}/follow-up`, {
        params: { audience },
    });
    return response.data.data;
}

/** Chase a campaign's non-responders. Needs a window or a time — never immediate. */
export async function createFollowUp(
    id: string,
    input: {
        body: string;
        name?: string;
        sendWindowId?: string;
        scheduledAt?: string;
        audience?: FollowUpAudience;
    },
): Promise<CreateBroadcastResult & { awaitingApproval: boolean; scheduledAt: string }> {
    const response = await axiosPost(`${BASE}/broadcasts/${id}/follow-up`, input);
    return response.data.data;
}
