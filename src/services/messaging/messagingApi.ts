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

export interface MessagingConfig {
    provider: string;
    configured: boolean;
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
    createdAt: string;
}

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
            ...(params.filter && params.filter !== 'all' ? { filter: params.filter } : {}),
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
): Promise<ImportSummary> {
    const formData = new FormData();
    formData.append('file', file);
    if (tags?.length) formData.append('tags', tags.join(','));
    if (assigneeUserIds?.length) formData.append('assigneeUserIds', assigneeUserIds.join(','));

    const response = await axiosPostFormData(`${BASE}/contacts/import`, formData);
    return response.data.data;
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

export async function fetchBroadcasts(params: { page?: number; status?: string }): Promise<Paginated<BroadcastSummary>> {
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

export interface CreateBroadcastResult {
    id: string;
    campaignKey: string;
    totalRecipients: number;
    queuedCount: number;
    suppressedCount: number;
    duplicatesDropped: number;
    invalidDropped: number;
    skippedClients?: Array<{ clientId: string; businessName: string; reason: string }>;
}

/** Create from CRM clients, saved contacts, and/or an explicit number list. */
export async function createBroadcastFromList(input: {
    name: string;
    body: string;
    recipients?: Array<{ phoneNumber: string; mergeData?: Record<string, unknown> }>;
    clientIds?: string[];
    contactIds?: string[];
    fromNumber?: string;
    throttlePerSecond?: number;
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

export async function fetchSenderAssignments(): Promise<SenderAssignment[]> {
    const response = await axiosGet(`${BASE}/senders/assignments`);
    return response.data.data ?? [];
}

/** Pass null to clear the assignment, returning the user to the env default. */
export async function assignSender(userId: string, senderId: string | null): Promise<SenderAssignment> {
    const response = await axiosPatch(`${BASE}/senders/assignments/${userId}`, { senderId });
    return response.data.data;
}
