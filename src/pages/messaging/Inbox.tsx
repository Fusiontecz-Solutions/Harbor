/**
 * SMS Inbox — three-panel layout, modelled on Fivra's inbox.
 *
 *   left    thread list: search, filter chips, colour-coded avatars, unread bold
 *   centre  chat: sticky header, day separators, bubbles with delivery ticks
 *   right   contact details, collapsible
 *
 * The thread list is virtualized so an agent with 20k conversations renders ~20
 * DOM rows. The message pane is not — a thread page is capped at 50 messages
 * server-side, and virtualizing it would fight the scroll-to-bottom behaviour.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { toast } from 'react-toastify';
import {
    Ban,
    Check,
    CheckCheck,
    ChevronRight,
    Loader2,
    Megaphone,
    MessageSquarePlus,
    Paperclip,
    Phone,
    Search,
    Send,
    ShieldOff,
    Users,
    Wifi,
    WifiOff,
    X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useInbox } from '@/hooks/useInbox';
import { ClientPicker } from '@/components/messaging/ClientPicker';
import { MessagingAvatar } from '@/components/messaging/MessagingAvatar';
import {
    blockContact,
    fetchContacts,
    fetchMessagingConfig,
    openConversation as openConversationRequest,
    sendMessage,
    unblockContact,
    type ClientRecipient,
    type Conversation,
    type Message,
    type MessagingConfig,
    type MessagingContact,
} from '@/services/messaging/messagingApi';

const FILTERS = [
    { id: 'all', label: 'All' },
    { id: 'unread', label: 'Unread' },
    { id: 'broadcast', label: 'Broadcast' },
    { id: 'opted-out', label: 'Opted out' },
] as const;

function useDebounced<T>(value: T, delayMs = 300): T {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const timer = setTimeout(() => setDebounced(value), delayMs);
        return () => clearTimeout(timer);
    }, [delayMs, value]);
    return debounced;
}

function formatPhone(value: string): string {
    const digits = String(value || '').replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) {
        return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
    }
    if (digits.length === 10) {
        return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    }
    return value;
}

/** Relative-ish timestamp: time for today, weekday this week, date beyond. */
function formatListTime(value: string | null): string {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';

    const now = new Date();
    if (now.toDateString() === date.toDateString()) {
        return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    if (now.getTime() - date.getTime() < 7 * 24 * 60 * 60 * 1000) {
        return date.toLocaleDateString([], { weekday: 'short' });
    }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function dayLabel(value: string): string {
    const date = new Date(value);
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86_400_000);

    if (date.toDateString() === today.toDateString()) return 'Today';
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return date.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
}

function StatusTick({ status }: { status: Message['status'] }) {
    if (status === 'DELIVERED') return <CheckCheck className="h-3.5 w-3.5 text-sky-400" />;
    if (status === 'SENT') return <Check className="h-3.5 w-3.5 opacity-70" />;
    if (status === 'FAILED' || status === 'UNDELIVERABLE') return <ShieldOff className="h-3.5 w-3.5 text-red-400" />;
    return <Loader2 className="h-3.5 w-3.5 animate-spin opacity-60" />;
}

export default function Inbox() {
    const userScope = useMemo(
        () => localStorage.getItem('userId') || sessionStorage.getItem('userId') || null,
        [],
    );

    const [searchInput, setSearchInput] = useState('');
    const [filter, setFilter] = useState<string>('all');
    const search = useDebounced(searchInput);

    const [config, setConfig] = useState<MessagingConfig | null>(null);
    const [draft, setDraft] = useState('');
    const [isSending, setIsSending] = useState(false);
    const [newNumber, setNewNumber] = useState('');
    const [isClientPickerOpen, setIsClientPickerOpen] = useState(false);
    const [showDetails, setShowDetails] = useState(true);
    const [contactDetail, setContactDetail] = useState<MessagingContact | null>(null);

    const messagesEndRef = useRef<HTMLDivElement | null>(null);

    const {
        conversations,
        isLoadingConversations,
        conversationsError,
        hasMore,
        loadMore,
        reloadConversations,
        activeConversationId,
        activeConversation,
        openConversation,
        messages,
        isLoadingMessages,
        refreshAfterSend,
        isRealtime,
    } = useInbox({ userScope, search, filter });

    useEffect(() => {
        fetchMessagingConfig().then(setConfig).catch(() => setConfig(null));
    }, []);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages.length]);

    /** Load the saved contact record backing the open thread, for the details panel. */
    useEffect(() => {
        if (!activeConversation) {
            setContactDetail(null);
            return;
        }

        let cancelled = false;
        fetchContacts({ search: activeConversation.contactNumber, page: 1, pageSize: 1 })
            .then((response) => {
                if (!cancelled) setContactDetail(response.data[0] ?? null);
            })
            .catch(() => {
                if (!cancelled) setContactDetail(null);
            });

        return () => {
            cancelled = true;
        };
    }, [activeConversation]);

    const handleSend = useCallback(async () => {
        const body = draft.trim();
        if (!body || !activeConversation || isSending) return;

        setIsSending(true);
        try {
            await sendMessage({
                toNumber: activeConversation.contactNumber,
                fromNumber: activeConversation.businessNumber,
                body,
            });
            setDraft('');
            refreshAfterSend();
        } catch (error: any) {
            toast.error(error?.response?.data?.message || 'Failed to send message');
        } finally {
            setIsSending(false);
        }
    }, [activeConversation, draft, isSending, refreshAfterSend]);

    const handleStartConversation = useCallback(async () => {
        const phoneNumber = newNumber.trim();
        if (!phoneNumber) return;

        try {
            const conversation = await openConversationRequest(phoneNumber);
            setNewNumber('');
            await reloadConversations();
            openConversation(conversation.id);
        } catch (error: any) {
            toast.error(error?.response?.data?.message || 'Could not open that conversation');
        }
    }, [newNumber, openConversation, reloadConversations]);

    const handlePickClient = useCallback(
        async (client: ClientRecipient) => {
            if (!client.phoneNumber) return;
            try {
                const conversation = await openConversationRequest(client.phoneNumber);
                setIsClientPickerOpen(false);
                await reloadConversations();
                openConversation(conversation.id);
            } catch (error: any) {
                toast.error(error?.response?.data?.message || 'Could not open that conversation');
            }
        },
        [openConversation, reloadConversations],
    );

    const handleToggleBlock = useCallback(async () => {
        if (!activeConversation) return;
        try {
            if (activeConversation.isBlocked) {
                await unblockContact(activeConversation.contactNumber);
                toast.success('Contact unblocked');
            } else {
                await blockContact(activeConversation.contactNumber);
                toast.success('Contact blocked — no further messages will be sent');
            }
            await reloadConversations();
        } catch (error: any) {
            toast.error(error?.response?.data?.message || 'Failed to update block status');
        }
    }, [activeConversation, reloadConversations]);

    const canSend = Boolean(
        activeConversation && !activeConversation.isBlocked && !activeConversation.isOptedOut && config?.configured,
    );

    const unreadTotal = useMemo(
        () => conversations.reduce((sum, conv) => sum + conv.unreadCount, 0),
        [conversations],
    );

    /** Group messages by day so the thread gets date separators. */
    const grouped = useMemo(() => {
        const groups: Array<{ day: string; items: Message[] }> = [];
        for (const message of messages) {
            const label = dayLabel(message.createdAt);
            const last = groups[groups.length - 1];
            if (last && last.day === label) last.items.push(message);
            else groups.push({ day: label, items: [message] });
        }
        return groups;
    }, [messages]);

    return (
        <div className="flex h-[calc(100vh-5rem)] overflow-hidden rounded-xl border bg-background shadow-sm">
            {/* ─────────────── Left: thread list ─────────────── */}
            <aside className="flex w-full max-w-[22rem] flex-col border-r">
                <div className="space-y-3 border-b p-3">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <h2 className="text-base font-semibold">Inbox</h2>
                            {unreadTotal > 0 && (
                                <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground">
                                    {unreadTotal}
                                </span>
                            )}
                        </div>
                        <span
                            className="flex items-center gap-1 text-[11px] text-muted-foreground"
                            title={isRealtime ? 'Live updates active' : 'Socket offline — polling'}
                        >
                            {isRealtime ? (
                                <Wifi className="h-3.5 w-3.5 text-emerald-500" />
                            ) : (
                                <WifiOff className="h-3.5 w-3.5 text-amber-500" />
                            )}
                            {isRealtime ? 'Live' : 'Polling'}
                        </span>
                    </div>

                    <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            value={searchInput}
                            onChange={(event) => setSearchInput(event.target.value)}
                            placeholder="Search conversations"
                            className="h-9 pl-8"
                        />
                    </div>

                    <div className="flex flex-wrap gap-1">
                        {FILTERS.map((entry) => (
                            <button
                                key={entry.id}
                                type="button"
                                onClick={() => setFilter(entry.id)}
                                className={cn(
                                    'rounded-full px-2.5 py-1 text-xs transition-colors',
                                    filter === entry.id
                                        ? 'bg-primary text-primary-foreground'
                                        : 'bg-muted text-muted-foreground hover:bg-muted/70',
                                )}
                            >
                                {entry.label}
                            </button>
                        ))}
                    </div>

                    <div className="flex gap-1.5">
                        <Input
                            value={newNumber}
                            onChange={(event) => setNewNumber(event.target.value)}
                            onKeyDown={(event) => event.key === 'Enter' && handleStartConversation()}
                            placeholder="New number…"
                            className="h-8 text-xs"
                        />
                        <Button size="sm" variant="secondary" className="h-8 px-2" onClick={handleStartConversation}>
                            <MessageSquarePlus className="h-4 w-4" />
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            className="h-8 px-2"
                            onClick={() => setIsClientPickerOpen(true)}
                            title="Message a CRM client"
                        >
                            <Users className="h-4 w-4" />
                        </Button>
                    </div>
                </div>

                <div className="min-h-0 flex-1">
                    {conversationsError && conversations.length === 0 ? (
                        <p className="p-4 text-sm text-red-500">{conversationsError}</p>
                    ) : isLoadingConversations && conversations.length === 0 ? (
                        <div className="space-y-2 p-3">
                            {Array.from({ length: 6 }).map((_, index) => (
                                <div key={index} className="flex animate-pulse items-center gap-3">
                                    <div className="h-9 w-9 rounded-full bg-muted" />
                                    <div className="flex-1 space-y-1.5">
                                        <div className="h-3 w-2/3 rounded bg-muted" />
                                        <div className="h-2.5 w-full rounded bg-muted" />
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : conversations.length === 0 ? (
                        <p className="p-4 text-sm text-muted-foreground">No conversations yet.</p>
                    ) : (
                        <Virtuoso
                            data={conversations}
                            endReached={() => hasMore && loadMore()}
                            itemContent={(_index: number, conversation: Conversation) => (
                                <ConversationRow
                                    conversation={conversation}
                                    isActive={conversation.id === activeConversationId}
                                    onSelect={() => openConversation(conversation.id)}
                                />
                            )}
                            className="h-full"
                        />
                    )}
                </div>
            </aside>

            {/* ─────────────── Centre: chat ─────────────── */}
            <section className="flex min-w-0 flex-1 flex-col bg-muted/20">
                {!activeConversation ? (
                    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                        <MessagingAvatar name={null} size="lg" />
                        Select a conversation to start messaging.
                    </div>
                ) : (
                    <>
                        <header className="flex items-center justify-between gap-3 border-b bg-background px-4 py-2.5">
                            <div className="flex min-w-0 items-center gap-3">
                                <MessagingAvatar name={activeConversation.contactName} />
                                <div className="min-w-0">
                                    <p className="truncate text-sm font-medium">
                                        {activeConversation.contactName || formatPhone(activeConversation.contactNumber)}
                                    </p>
                                    <p className="truncate text-xs text-muted-foreground">
                                        {formatPhone(activeConversation.contactNumber)} · via{' '}
                                        {formatPhone(activeConversation.businessNumber)}
                                    </p>
                                </div>
                            </div>

                            <div className="flex shrink-0 items-center gap-1.5">
                                {activeConversation.hasBroadcastMessage && (
                                    <Badge variant="secondary" className="gap-1">
                                        <Megaphone className="h-3 w-3" /> Broadcast
                                    </Badge>
                                )}
                                {activeConversation.isOptedOut && <Badge variant="destructive">Opted out</Badge>}
                                {config?.voiceEnabled && (
                                    <Button size="icon" variant="ghost" className="h-8 w-8" title="Call this contact">
                                        <Phone className="h-4 w-4" />
                                    </Button>
                                )}
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    className={cn('h-8 w-8', activeConversation.isBlocked && 'text-red-500')}
                                    onClick={handleToggleBlock}
                                    title={activeConversation.isBlocked ? 'Unblock contact' : 'Block contact'}
                                >
                                    <Ban className="h-4 w-4" />
                                </Button>
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-8 w-8"
                                    onClick={() => setShowDetails((value) => !value)}
                                    title={showDetails ? 'Hide details' : 'Show details'}
                                >
                                    <ChevronRight className={cn('h-4 w-4 transition-transform', showDetails && 'rotate-180')} />
                                </Button>
                            </div>
                        </header>

                        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
                            {isLoadingMessages && messages.length === 0 ? (
                                <p className="text-sm text-muted-foreground">Loading messages…</p>
                            ) : (
                                grouped.map((group) => (
                                    <div key={group.day} className="space-y-2">
                                        <div className="flex justify-center">
                                            <span className="rounded-full bg-background px-3 py-0.5 text-[11px] text-muted-foreground shadow-sm">
                                                {group.day}
                                            </span>
                                        </div>
                                        {group.items.map((message) => (
                                            <MessageBubble key={message.id} message={message} />
                                        ))}
                                    </div>
                                ))
                            )}
                            <div ref={messagesEndRef} />
                        </div>

                        <footer className="border-t bg-background p-3">
                            {!config?.configured && (
                                <p className="mb-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-700 dark:bg-amber-900/20 dark:text-amber-400">
                                    Messaging is not configured — set INFOBIP_BASE_URL, INFOBIP_API_KEY and
                                    INFOBIP_SENDER on the backend.
                                </p>
                            )}
                            {activeConversation.isOptedOut && (
                                <p className="mb-2 rounded bg-red-50 px-2 py-1 text-xs text-red-600 dark:bg-red-900/20">
                                    This contact replied STOP. Sending is disabled until they text START.
                                </p>
                            )}
                            {activeConversation.isBlocked && (
                                <p className="mb-2 rounded bg-red-50 px-2 py-1 text-xs text-red-600 dark:bg-red-900/20">
                                    This contact is blocked.
                                </p>
                            )}

                            <div className="flex items-end gap-2 rounded-lg border bg-background p-1.5 focus-within:ring-1 focus-within:ring-ring">
                                <Textarea
                                    value={draft}
                                    onChange={(event) => setDraft(event.target.value)}
                                    onKeyDown={(event) => {
                                        if (event.key === 'Enter' && !event.shiftKey) {
                                            event.preventDefault();
                                            void handleSend();
                                        }
                                    }}
                                    placeholder={canSend ? 'Type a message…' : 'Sending disabled'}
                                    disabled={!canSend}
                                    rows={1}
                                    className="max-h-32 min-h-[2.25rem] resize-none border-0 shadow-none focus-visible:ring-0"
                                />
                                <Button
                                    size="icon"
                                    className="h-9 w-9 shrink-0"
                                    onClick={handleSend}
                                    disabled={!canSend || !draft.trim() || isSending}
                                >
                                    {isSending ? (
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                    ) : (
                                        <Send className="h-4 w-4" />
                                    )}
                                </Button>
                            </div>
                            <p className="mt-1 text-[11px] text-muted-foreground">
                                Enter to send · Shift+Enter for a new line
                                {draft.length > 0 && ` · ${draft.length} chars`}
                            </p>
                        </footer>
                    </>
                )}
            </section>

            {/* ─────────────── Right: contact details ─────────────── */}
            {activeConversation && showDetails && (
                <aside className="hidden w-72 shrink-0 flex-col border-l bg-background xl:flex">
                    <div className="flex items-center justify-between border-b px-3 py-2.5">
                        <h3 className="text-sm font-medium">Contact</h3>
                        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setShowDetails(false)}>
                            <X className="h-4 w-4" />
                        </Button>
                    </div>

                    <div className="flex flex-col items-center gap-2 border-b px-3 py-4">
                        <MessagingAvatar name={activeConversation.contactName} size="lg" />
                        <p className="text-sm font-medium">
                            {activeConversation.contactName || formatPhone(activeConversation.contactNumber)}
                        </p>
                        <p className="text-xs text-muted-foreground">{formatPhone(activeConversation.contactNumber)}</p>
                        <div className="flex flex-wrap justify-center gap-1">
                            {activeConversation.isBlocked && <Badge variant="destructive">Blocked</Badge>}
                            {activeConversation.isOptedOut && <Badge variant="destructive">Opted out</Badge>}
                            {activeConversation.hasBroadcastMessage && <Badge variant="secondary">Broadcast</Badge>}
                        </div>
                    </div>

                    <div className="flex-1 space-y-2 overflow-y-auto p-3 text-sm">
                        <DetailField label="Company" value={contactDetail?.company} />
                        <DetailField label="Email" value={contactDetail?.emailAddress} />
                        <DetailField
                            label="Location"
                            value={[contactDetail?.city, contactDetail?.state].filter(Boolean).join(', ')}
                        />
                        <DetailField label="Tags" value={contactDetail?.tags?.join(', ')} />
                        <DetailField label="Sender" value={formatPhone(activeConversation.businessNumber)} />
                        <DetailField label="Messages" value={String(messages.length)} />

                        {!contactDetail && (
                            <p className="pt-2 text-xs text-muted-foreground">
                                This number has no saved contact record yet.
                            </p>
                        )}
                    </div>
                </aside>
            )}

            <Dialog open={isClientPickerOpen} onOpenChange={setIsClientPickerOpen}>
                <DialogContent className="max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>Message a client</DialogTitle>
                        <DialogDescription>
                            Opens a conversation using the client's owner mobile, falling back to their business
                            number. Blocked and opted-out clients cannot be selected.
                        </DialogDescription>
                    </DialogHeader>

                    <ClientPicker selectedIds={[]} onChange={() => undefined} mode="single" onPick={handlePickClient} />
                </DialogContent>
            </Dialog>
        </div>
    );
}

function DetailField({ label, value }: { label: string; value?: string | null }) {
    return (
        <div className="flex items-start justify-between gap-3 border-b pb-2 last:border-b-0">
            <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
            <span className="max-w-[60%] break-words text-right text-xs">{value || '—'}</span>
        </div>
    );
}

function ConversationRow({
    conversation,
    isActive,
    onSelect,
}: {
    conversation: Conversation;
    isActive: boolean;
    onSelect: () => void;
}) {
    const isUnread = conversation.unreadCount > 0;

    return (
        <button
            type="button"
            onClick={onSelect}
            className={cn(
                'flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/60',
                isActive && 'bg-muted',
            )}
        >
            <MessagingAvatar name={conversation.contactName || conversation.contactNumber} />

            <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                    <span className={cn('truncate text-sm', isUnread ? 'font-semibold' : 'font-medium')}>
                        {conversation.contactName || formatPhone(conversation.contactNumber)}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                        {formatListTime(conversation.lastMessageAt)}
                    </span>
                </div>

                <div className="mt-0.5 flex items-center justify-between gap-2">
                    <span
                        className={cn(
                            'truncate text-xs',
                            isUnread ? 'font-medium text-foreground' : 'text-muted-foreground',
                        )}
                    >
                        {conversation.lastMessageDirection === 'OUTBOUND' && (
                            <span className="text-muted-foreground">You: </span>
                        )}
                        {conversation.lastMessageText || 'No messages yet'}
                    </span>

                    <span className="flex shrink-0 items-center gap-1">
                        {conversation.hasBroadcastMessage && (
                            <Megaphone className="h-3 w-3 text-muted-foreground" />
                        )}
                        {conversation.isOptedOut && (
                            <ShieldOff className="h-3 w-3 text-rose-500" aria-label="Opted out" />
                        )}
                        {conversation.isBlocked && <Ban className="h-3 w-3 text-red-500" aria-label="Blocked" />}
                        {isUnread && (
                            <span className="min-w-[1.25rem] rounded-full bg-primary px-1.5 py-0.5 text-center text-[10px] font-semibold text-primary-foreground">
                                {conversation.unreadCount}
                            </span>
                        )}
                    </span>
                </div>
            </div>
        </button>
    );
}

function MessageBubble({ message }: { message: Message }) {
    const isOutbound = message.direction === 'OUTBOUND';
    const time = new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

    return (
        <div className={cn('flex', isOutbound ? 'justify-end' : 'justify-start')}>
            <div
                className={cn(
                    'max-w-[70%] rounded-2xl px-3 py-2 text-sm shadow-sm',
                    isOutbound
                        ? 'rounded-br-sm bg-primary text-primary-foreground'
                        : 'rounded-bl-sm bg-background',
                    message.isStopKeyword && 'ring-1 ring-red-400',
                )}
            >
                {message.broadcastId && (
                    <span className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wide opacity-70">
                        <Megaphone className="h-3 w-3" /> Broadcast
                    </span>
                )}

                <p className="whitespace-pre-wrap break-words">{message.body}</p>

                {message.mediaUrls?.map((url) => (
                    <a
                        key={url}
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 flex items-center gap-1 text-xs underline opacity-80"
                    >
                        <Paperclip className="h-3 w-3" /> Attachment
                    </a>
                ))}

                <span className="mt-1 flex items-center justify-end gap-1 text-[10px] opacity-70">
                    {time}
                    {isOutbound && <StatusTick status={message.status} />}
                </span>

                {message.errorMessage && (
                    <p className="mt-1 text-[10px] text-red-400">{message.errorMessage}</p>
                )}
            </div>
        </div>
    );
}
