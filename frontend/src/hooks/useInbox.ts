/**
 * The inbox data hook — cache layers, realtime updates, and fallback polling.
 *
 * Ported from Fivra's `useInbox`, restructured to reuse Harbor's existing
 * SocketProvider instead of opening a second websocket.
 *
 * Read path is stale-while-revalidate at every layer:
 *   memory (instant, survives navigation) → IndexedDB (survives refresh)
 *   → API, which is ALWAYS consulted in the background.
 *
 * An earlier version treated a cache hit as authoritative — an IndexedDB entry
 * younger than five minutes skipped the network entirely, and with the socket
 * connected nothing polled. Any socket event that did not arrive (a different
 * backend instance, a reconnect gap) therefore left the list frozen until that
 * entry aged out: the "new messages take 4–5 minutes" bug. Caches now only
 * decide what to paint first, never whether to fetch.
 *
 * Freshness:
 *   - socket events patch the list/thread in place immediately, then a
 *     debounced refetch makes the server the final word on ordering/counts;
 *   - every (re)connect, tab focus and network `online` revalidates — the
 *     catch-up for anything missed while disconnected;
 *   - a slow poll keeps running even while connected (10s when disconnected).
 *
 * Socket events are batched on a 50ms flush. A running broadcast can emit
 * hundreds of events per second, and applying each one synchronously would
 * re-render the conversation list hundreds of times per second.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSocket } from '@/context/SocketContext';
import {
    conversationCacheKey,
    messagesCacheKey,
    readCachedConversations,
    readCachedMessages,
    writeCachedConversations,
    writeCachedMessages,
} from '@/utils/inboxIdb';
import { memoryGet, memoryKeys, memorySet } from '@/utils/messagingMemoryCache';
import {
    fetchConversations,
    fetchMessages,
    markConversationRead as markReadRequest,
    markConversationUnread as markUnreadRequest,
    type Conversation,
    type Message,
    type MessageStatus,
} from '@/services/messaging/messagingApi';

/** Poll interval while the socket is DOWN. */
const FALLBACK_POLL_MS = 10_000;
/** Safety-net poll while the socket is UP — catches anything an event missed. */
const CONNECTED_POLL_MS = 60_000;
/** Socket event coalescing window. */
const EVENT_FLUSH_MS = 50;
/** Debounce for the authoritative list refetch after socket events. */
const LIST_REVALIDATE_DEBOUNCE_MS = 400;
/** Messages per page on the server (MESSAGE_PAGE_SIZE in harbor-be). */
const MESSAGE_PAGE_SIZE = 50;
/** How long the in-memory snapshot lives. It is always revalidated, so long is fine. */
const SNAPSHOT_TTL_MS = 30 * 60_000;
/** Messages persisted per thread in IndexedDB (bounded size). */
const IDB_MESSAGES_PER_THREAD = 100;
/** Threads warmed in the background after the list loads. */
const PREFETCH_TOP_THREADS = 5;

/** Ids of optimistic rows that have not been confirmed by the server yet. */
export const PENDING_PREFIX = 'pending-';
const isPending = (m: Message): boolean => m.id.startsWith(PENDING_PREFIX);
/** A confirmed outbound this close in time with the same body is a pending row's echo. */
const ECHO_WINDOW_MS = 2 * 60_000;

interface ListSnapshot {
    items: Conversation[];
    hasMore: boolean;
}

interface ThreadSnapshot {
    messages: Message[];
    hasOlder: boolean;
}

const threadKey = (conversationId: string): string => memoryKeys.messages(conversationId, 0);

/**
 * Merges two message lists into one oldest-first list, dropping duplicate ids
 * (pages can overlap when new messages arrive between requests). `incoming`
 * wins. A pending bubble is dropped once a confirmed outbound with the same
 * body exists, so the server echo never shows next to its optimistic twin.
 */
function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
    const byId = new Map<string, Message>();
    for (const m of existing) byId.set(m.id, m);
    for (const m of incoming) byId.set(m.id, m);
    const all = [...byId.values()];
    const confirmedOutbound = all.filter((m) => !isPending(m) && m.direction === 'OUTBOUND');
    const isEchoed = (pending: Message): boolean => {
        const at = new Date(pending.createdAt).getTime();
        return confirmedOutbound.some(
            (m) => m.body === pending.body && Math.abs(new Date(m.createdAt).getTime() - at) < ECHO_WINDOW_MS,
        );
    };
    return all
        .filter((m) => !(isPending(m) && m.status !== 'FAILED' && isEchoed(m)))
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

/** Append a page without duplicating rows already present. */
function appendUnique(prev: Conversation[], next: Conversation[]): Conversation[] {
    const seen = new Set(prev.map((c) => c.id));
    return [...prev, ...next.filter((c) => !seen.has(c.id))];
}

/**
 * Replace page 1 with fresh server data while keeping rows from deeper pages
 * the user already scrolled to (minus anything page 1 now contains).
 */
function replaceFirstPage(prev: Conversation[], fresh: Conversation[], pagesLoaded: number): Conversation[] {
    if (pagesLoaded <= 1) return fresh;
    const freshIds = new Set(fresh.map((c) => c.id));
    const tail = prev.slice(fresh.length).filter((c) => !freshIds.has(c.id));
    return [...fresh, ...tail];
}

interface UseInboxOptions {
    /** Scopes cache keys so two agents on one browser cannot see each other's data. */
    userScope: string | null;
    search?: string;
    filter?: string;
}

export function useInbox({ userScope, search = '', filter = 'regular' }: UseInboxOptions) {
    const { socket, isConnected } = useSocket();

    const listMemKey = `${userScope ?? 'anon'}:${memoryKeys.conversations(1, search, filter)}`;
    const initialList = memoryGet<ListSnapshot>(listMemKey);

    const [conversations, setConversations] = useState<Conversation[]>(initialList?.items ?? []);
    const [isLoadingConversations, setIsLoadingConversations] = useState(!initialList);
    const [conversationsError, setConversationsError] = useState<string | null>(null);
    const [hasMore, setHasMore] = useState(initialList?.hasMore ?? false);
    const pagesLoaded = useRef(1);

    const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [isLoadingMessages, setIsLoadingMessages] = useState(false);
    const [hasOlderMessages, setHasOlderMessages] = useState(false);
    const [isLoadingOlderMessages, setIsLoadingOlderMessages] = useState(false);
    /** Deepest message page loaded from the server for the open thread. */
    const messagePagesLoaded = useRef(1);

    /** Pending socket events, drained on a timer. A ref, so queueing never renders. */
    const pendingEvents = useRef<Array<{ type: string; payload: any }>>([]);
    const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const listRevalidateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** Guards against a slow list response overwriting a newer one. */
    const requestSeq = useRef(0);
    const activeConversationRef = useRef<string | null>(null);
    activeConversationRef.current = activeConversationId;
    const prefetched = useRef(new Set<string>());

    const memKey = useCallback((key: string) => `${userScope ?? 'anon'}:${key}`, [userScope]);

    /* ------------------------------------------------------------------ */
    /* Thread snapshots (memory + IndexedDB)                               */
    /* ------------------------------------------------------------------ */

    const readThreadMemory = useCallback(
        (conversationId: string) => memoryGet<ThreadSnapshot>(memKey(threadKey(conversationId))),
        [memKey],
    );

    const writeThread = useCallback(
        (conversationId: string, snapshot: ThreadSnapshot, persist = true) => {
            memorySet(memKey(threadKey(conversationId)), snapshot, SNAPSHOT_TTL_MS);
            if (persist) {
                const confirmed = snapshot.messages.filter((m) => !isPending(m)).slice(-IDB_MESSAGES_PER_THREAD);
                void writeCachedMessages(messagesCacheKey(userScope, conversationId), confirmed);
            }
        },
        [memKey, userScope],
    );

    /** Apply `update` to a thread's snapshot, and to the visible thread if it is open. */
    const patchThread = useCallback(
        (conversationId: string, update: (prev: Message[]) => Message[]) => {
            const snap = readThreadMemory(conversationId);
            if (snap) writeThread(conversationId, { ...snap, messages: update(snap.messages) }, false);
            if (activeConversationRef.current === conversationId) setMessages(update);
        },
        [readThreadMemory, writeThread],
    );

    /* ------------------------------------------------------------------ */
    /* Conversations                                                       */
    /* ------------------------------------------------------------------ */

    const fetchListPage = useCallback(
        async (targetPage: number, append: boolean) => {
            const seq = append ? requestSeq.current : ++requestSeq.current;
            try {
                const response = await fetchConversations({ page: targetPage, search, filter });
                if (!append && seq !== requestSeq.current) return; // superseded

                const payload: ListSnapshot = { items: response.data, hasMore: response.pagination.hasMore };
                if (append) {
                    pagesLoaded.current = targetPage;
                    setConversations((prev) => appendUnique(prev, payload.items));
                    setHasMore(payload.hasMore);
                } else {
                    setConversations((prev) => replaceFirstPage(prev, payload.items, pagesLoaded.current));
                    if (pagesLoaded.current <= 1) setHasMore(payload.hasMore);
                    void writeCachedConversations(conversationCacheKey(userScope, 1, search, filter), payload);
                }
                setConversationsError(null);
            } catch (error: any) {
                if (!append && seq !== requestSeq.current) return;
                // A cached render is better than an error screen.
                setConversationsError(error?.response?.data?.message || error?.message || 'Failed to load conversations');
            } finally {
                if (append || seq === requestSeq.current) setIsLoadingConversations(false);
            }
        },
        [filter, search, userScope],
    );

    /** Paint from cache instantly, then always revalidate page 1 from the API. */
    const loadConversations = useCallback(async () => {
        pagesLoaded.current = 1;
        const hit = memoryGet<ListSnapshot>(listMemKey);
        if (hit) {
            setConversations(hit.items);
            setHasMore(hit.hasMore);
            setIsLoadingConversations(false);
        } else {
            const cached = await readCachedConversations<ListSnapshot>(conversationCacheKey(userScope, 1, search, filter));
            if (cached) {
                setConversations(cached.data.items);
                setHasMore(cached.data.hasMore);
                setIsLoadingConversations(false);
            } else {
                setConversations([]);
                setIsLoadingConversations(true);
            }
        }
        await fetchListPage(1, false);
    }, [fetchListPage, filter, listMemKey, search, userScope]);

    const revalidateConversations = useCallback(() => fetchListPage(1, false), [fetchListPage]);

    const scheduleListRevalidate = useCallback(() => {
        if (listRevalidateTimer.current) clearTimeout(listRevalidateTimer.current);
        listRevalidateTimer.current = setTimeout(() => {
            listRevalidateTimer.current = null;
            void revalidateConversations();
        }, LIST_REVALIDATE_DEBOUNCE_MS);
    }, [revalidateConversations]);

    const loadMore = useCallback(() => {
        if (!hasMore || isLoadingConversations) return;
        void fetchListPage(pagesLoaded.current + 1, true);
    }, [fetchListPage, hasMore, isLoadingConversations]);

    // Write-through: whatever the list currently shows is the next instant paint.
    useEffect(() => {
        if (isLoadingConversations && conversations.length === 0) return;
        memorySet(listMemKey, { items: conversations, hasMore }, SNAPSHOT_TTL_MS);
    }, [conversations, hasMore, isLoadingConversations, listMemKey]);

    // Write-through for the open thread, so switching away and back is instant
    // and keeps pending/failed bubbles.
    useEffect(() => {
        if (!activeConversationId || isLoadingMessages) return;
        memorySet(memKey(threadKey(activeConversationId)), { messages, hasOlder: hasOlderMessages }, SNAPSHOT_TTL_MS);
    }, [activeConversationId, hasOlderMessages, isLoadingMessages, memKey, messages]);

    /* ------------------------------------------------------------------ */
    /* Messages                                                            */
    /* ------------------------------------------------------------------ */

    /** Fetch page 1 of a thread and merge it into the snapshot (and view, if open). */
    const revalidateThread = useCallback(
        async (conversationId: string) => {
            try {
                const response = await fetchMessages(conversationId, 1);
                const base = readThreadMemory(conversationId);
                const isActive = activeConversationRef.current === conversationId;
                const prev = isActive ? null : base?.messages ?? [];

                const apply = (current: Message[]): Message[] => {
                    // Keep pending rows and older pages the user scrolled back
                    // to; replace everything page 1 covers with server truth.
                    const oldest = response.data[0]?.createdAt;
                    const keep = current.filter(
                        (m) => isPending(m) || (oldest ? new Date(m.createdAt) < new Date(oldest) : false),
                    );
                    return mergeMessages(keep, response.data);
                };

                const hasOlder = (base?.hasOlder && messagePagesLoaded.current > 1) || response.pagination.hasMore;
                if (isActive) {
                    setMessages((current) => {
                        const next = apply(current);
                        writeThread(conversationId, { messages: next, hasOlder });
                        return next;
                    });
                    if (messagePagesLoaded.current <= 1) setHasOlderMessages(response.pagination.hasMore);
                } else {
                    writeThread(conversationId, { messages: apply(prev ?? []), hasOlder: response.pagination.hasMore });
                }
            } catch (error) {
                console.error('[useInbox] failed to load messages:', error);
            } finally {
                if (activeConversationRef.current === conversationId) setIsLoadingMessages(false);
            }
        },
        [readThreadMemory, writeThread],
    );

    /** Paint a thread from memory or IndexedDB without waiting, then revalidate. */
    const loadMessages = useCallback(
        async (conversationId: string) => {
            const hit = readThreadMemory(conversationId);
            if (hit) {
                setMessages(hit.messages);
                setHasOlderMessages(hit.hasOlder);
                setIsLoadingMessages(false);
            } else {
                const cached = await readCachedMessages<Message[]>(messagesCacheKey(userScope, conversationId));
                if (activeConversationRef.current !== conversationId) return;
                if (cached) {
                    const hasOlder = cached.data.length >= MESSAGE_PAGE_SIZE;
                    setMessages((current) => mergeMessages(cached.data, current));
                    setHasOlderMessages(hasOlder);
                    setIsLoadingMessages(false);
                    memorySet(memKey(threadKey(conversationId)), { messages: cached.data, hasOlder }, SNAPSHOT_TTL_MS);
                } else {
                    setIsLoadingMessages(true);
                }
            }
            await revalidateThread(conversationId);
        },
        [memKey, readThreadMemory, revalidateThread, userScope],
    );

    /** Fetch the next page back in the open thread and prepend it. */
    const loadOlderMessages = useCallback(async () => {
        const conversationId = activeConversationRef.current;
        if (!conversationId || !hasOlderMessages || isLoadingOlderMessages) return;
        // The snapshot may already hold more than one server page (e.g. from a
        // previous visit), so derive the next page from what is on screen.
        const confirmedCount = messages.filter((m) => !isPending(m)).length;
        const nextPage = Math.max(messagePagesLoaded.current, Math.floor(confirmedCount / MESSAGE_PAGE_SIZE)) + 1;
        setIsLoadingOlderMessages(true);
        try {
            const response = await fetchMessages(conversationId, nextPage);
            if (activeConversationRef.current !== conversationId) return;
            messagePagesLoaded.current = nextPage;
            setMessages((prev) => {
                const next = mergeMessages(response.data, prev);
                writeThread(conversationId, { messages: next, hasOlder: response.pagination.hasMore }, false);
                return next;
            });
            setHasOlderMessages(response.pagination.hasMore);
        } catch (error) {
            console.error('[useInbox] failed to load older messages:', error);
        } finally {
            if (activeConversationRef.current === conversationId) setIsLoadingOlderMessages(false);
        }
    }, [hasOlderMessages, isLoadingOlderMessages, messages, writeThread]);

    const openConversation = useCallback(
        (conversationId: string | null) => {
            setActiveConversationId(conversationId);
            activeConversationRef.current = conversationId;
            setIsLoadingOlderMessages(false);
            messagePagesLoaded.current = 1;

            if (!conversationId) {
                setMessages([]);
                setHasOlderMessages(false);
                return;
            }

            // Synchronous paint from memory — no empty frame between threads.
            const hit = readThreadMemory(conversationId);
            setMessages(hit?.messages ?? []);
            setHasOlderMessages(hit?.hasOlder ?? false);
            setIsLoadingMessages(!hit);

            void loadMessages(conversationId);

            // Clear unread optimistically — the badge disappears on click.
            setConversations((prev) =>
                prev.map((conv) => (conv.id === conversationId ? { ...conv, unreadCount: 0 } : conv)),
            );
            void markReadRequest(conversationId).catch(() => undefined);
        },
        [loadMessages, readThreadMemory],
    );

    /**
     * Flag a thread unread again. If it is the open thread it is closed too —
     * otherwise opening logic would immediately mark it read again.
     */
    const markUnread = useCallback(async (conversationId: string) => {
        if (activeConversationRef.current === conversationId) {
            setActiveConversationId(null);
            activeConversationRef.current = null;
            setMessages([]);
        }
        setConversations((prev) =>
            prev.map((conv) => (conv.id === conversationId ? { ...conv, unreadCount: Math.max(1, conv.unreadCount) } : conv)),
        );
        await markUnreadRequest(conversationId);
    }, []);

    /** Clear the unread badge without opening the thread. */
    const markRead = useCallback(async (conversationId: string) => {
        setConversations((prev) => prev.map((conv) => (conv.id === conversationId ? { ...conv, unreadCount: 0 } : conv)));
        await markReadRequest(conversationId);
    }, []);

    /* ------------------------------------------------------------------ */
    /* Socket events (batched)                                             */
    /* ------------------------------------------------------------------ */

    const flushEvents = useCallback(() => {
        flushTimer.current = null;
        const events = pendingEvents.current;
        pendingEvents.current = [];
        if (events.length === 0) return;

        let listTouched = false;

        for (const event of events) {
            if (event.type === 'new_message') {
                const { conversationId, message } = event.payload ?? {};
                // Team-chat `new_message` frames share the event name but carry
                // no conversationId at the top level — not ours.
                if (!conversationId || !message?.id) continue;
                listTouched = true;

                const incoming: Message = {
                    errorMessage: null,
                    broadcastId: null,
                    isStopKeyword: false,
                    sentAt: message.createdAt ?? null,
                    deliveredAt: null,
                    mediaUrls: [],
                    ...message,
                };
                patchThread(conversationId, (prev) => mergeMessages(prev, [incoming]));

                // Patch the row in place and float it to the top right away;
                // the debounced refetch then reconciles with the server.
                setConversations((prev) => {
                    const idx = prev.findIndex((c) => c.id === conversationId);
                    if (idx < 0) return prev; // a new thread — the refetch brings it in
                    const current = prev[idx];
                    const isInbound = incoming.direction === 'INBOUND';
                    const updated: Conversation = {
                        ...current,
                        lastMessageText: incoming.body ?? current.lastMessageText,
                        lastMessageAt: incoming.createdAt ?? current.lastMessageAt,
                        lastMessageDirection: incoming.direction,
                        unreadCount:
                            isInbound && activeConversationRef.current !== conversationId
                                ? current.unreadCount + 1
                                : current.unreadCount,
                    };
                    return [updated, ...prev.slice(0, idx), ...prev.slice(idx + 1)];
                });

                if (incoming.direction === 'INBOUND' && activeConversationRef.current === conversationId) {
                    // Reading it now — keep the server's unread count at zero.
                    void markReadRequest(conversationId).catch(() => undefined);
                }
            }

            if (event.type === 'message_status_update') {
                const { conversationId, messageId, providerMessageId, status, errorMessage } = event.payload ?? {};
                if (!conversationId) continue;
                // Match on either id: our own uuid is usually echoed back by the
                // provider, but not always.
                patchThread(conversationId, (prev) =>
                    prev.map((m) =>
                        m.id === messageId || m.id === providerMessageId
                            ? { ...m, status, ...(errorMessage ? { errorMessage } : {}) }
                            : m,
                    ),
                );
            }

            if (event.type === 'conversation_update') {
                const conv = event.payload?.conversation;
                if (!conv?.id) continue;
                listTouched = true;
                setConversations((prev) => {
                    if (conv.deleted) return prev.filter((c) => c.id !== conv.id);
                    const fields: Partial<Conversation> = { ...conv };
                    delete (fields as Record<string, unknown>).deleted;
                    delete fields.businessNumber;
                    // An archived thread leaves the regular tab; the refetch settles it.
                    return prev.map((c) => (c.id === conv.id ? { ...c, ...fields } : c));
                });
            }
        }

        if (listTouched) scheduleListRevalidate();
    }, [patchThread, scheduleListRevalidate]);

    const queueEvent = useCallback(
        (type: string, payload: unknown) => {
            pendingEvents.current.push({ type, payload });
            if (!flushTimer.current) {
                flushTimer.current = setTimeout(flushEvents, EVENT_FLUSH_MS);
            }
        },
        [flushEvents],
    );

    /** Catch-up: anything that happened while we were not listening. */
    const catchUp = useCallback(() => {
        void revalidateConversations();
        if (activeConversationRef.current) void revalidateThread(activeConversationRef.current);
    }, [revalidateConversations, revalidateThread]);

    useEffect(() => {
        if (!socket) return;

        const onNewMessage = (payload: unknown) => queueEvent('new_message', payload);
        const onStatus = (payload: unknown) => queueEvent('message_status_update', payload);
        const onConversation = (payload: unknown) => queueEvent('conversation_update', payload);
        const onConnect = () => {
            // Server re-scopes this socket's rooms (sender assignment may have
            // changed) and re-joins the open thread, then we fetch what we missed.
            socket.emit('messaging:subscribe');
            if (activeConversationRef.current) {
                socket.emit('messaging:join_conversation', { conversationId: activeConversationRef.current });
            }
            catchUp();
        };

        socket.on('new_message', onNewMessage);
        socket.on('message_status_update', onStatus);
        socket.on('conversation_update', onConversation);
        socket.on('connect', onConnect);
        if (socket.connected) socket.emit('messaging:subscribe');

        return () => {
            socket.off('new_message', onNewMessage);
            socket.off('message_status_update', onStatus);
            socket.off('conversation_update', onConversation);
            socket.off('connect', onConnect);
            if (flushTimer.current) {
                clearTimeout(flushTimer.current);
                flushTimer.current = null;
            }
        };
    }, [catchUp, queueEvent, socket]);

    /** Join/leave the per-thread room so status ticks arrive for the open thread. */
    useEffect(() => {
        if (!socket || !activeConversationId) return;

        socket.emit('messaging:join_conversation', { conversationId: activeConversationId });
        return () => {
            socket.emit('messaging:leave_conversation', { conversationId: activeConversationId });
        };
    }, [activeConversationId, socket]);

    /* ------------------------------------------------------------------ */
    /* Revalidation triggers: poll, focus, network                         */
    /* ------------------------------------------------------------------ */

    useEffect(() => {
        const interval = setInterval(
            () => {
                if (typeof document !== 'undefined' && document.hidden) return;
                catchUp();
            },
            isConnected ? CONNECTED_POLL_MS : FALLBACK_POLL_MS,
        );
        return () => clearInterval(interval);
    }, [catchUp, isConnected]);

    useEffect(() => {
        const onVisible = () => {
            if (!document.hidden) catchUp();
        };
        document.addEventListener('visibilitychange', onVisible);
        window.addEventListener('online', catchUp);
        return () => {
            document.removeEventListener('visibilitychange', onVisible);
            window.removeEventListener('online', catchUp);
        };
    }, [catchUp]);

    /* Initial load + reload when the query changes. */
    useEffect(() => {
        void loadConversations();
    }, [loadConversations]);

    useEffect(
        () => () => {
            if (listRevalidateTimer.current) clearTimeout(listRevalidateTimer.current);
        },
        [],
    );

    /* Warm the top threads so opening them is instant. */
    useEffect(() => {
        if (isLoadingConversations) return;
        const targets = conversations
            .slice(0, PREFETCH_TOP_THREADS)
            .map((c) => c.id)
            .filter((id) => !prefetched.current.has(id) && !readThreadMemory(id));
        if (targets.length === 0) return;

        const timer = setTimeout(() => {
            targets.forEach((id, i) => {
                prefetched.current.add(id);
                // Staggered so the warm-up never competes with what the user is doing.
                setTimeout(() => {
                    if (activeConversationRef.current !== id && !readThreadMemory(id)) void revalidateThread(id);
                }, i * 250);
            });
        }, 800);
        return () => clearTimeout(timer);
    }, [conversations, isLoadingConversations, readThreadMemory, revalidateThread]);

    const activeConversation = useMemo(
        () => conversations.find((conv) => conv.id === activeConversationId) ?? null,
        [activeConversationId, conversations],
    );

    /** Called after a successful send so the thread updates even if the socket echo is lost. */
    const refreshAfterSend = useCallback(() => {
        if (activeConversationRef.current) void revalidateThread(activeConversationRef.current);
        scheduleListRevalidate();
    }, [revalidateThread, scheduleListRevalidate]);

    /** Show an outbound bubble immediately (spinner tick); reconcile when the send API returns. */
    const pushOptimisticOutbound = useCallback(
        (input: { body: string; fromNumber: string; toNumber: string }): string => {
            const tempId = `${PENDING_PREFIX}${globalThis.crypto?.randomUUID?.() ?? String(Date.now())}`;
            const now = new Date().toISOString();
            const optimistic: Message = {
                id: tempId,
                direction: 'OUTBOUND',
                fromNumber: input.fromNumber,
                toNumber: input.toNumber,
                body: input.body,
                mediaUrls: [],
                status: 'SENDING',
                errorMessage: null,
                broadcastId: null,
                isStopKeyword: false,
                sentAt: now,
                deliveredAt: null,
                createdAt: now,
            };

            const conversationId = activeConversationRef.current;
            if (conversationId) {
                patchThread(conversationId, (prev) => [...prev, optimistic]);
                setConversations((prev) => {
                    const idx = prev.findIndex((c) => c.id === conversationId);
                    if (idx < 0) return prev;
                    const updated: Conversation = {
                        ...prev[idx],
                        lastMessageText: input.body.slice(0, 500),
                        lastMessageAt: now,
                        lastMessageDirection: 'OUTBOUND',
                    };
                    return [updated, ...prev.slice(0, idx), ...prev.slice(idx + 1)];
                });
            } else {
                setMessages((prev) => [...prev, optimistic]);
            }
            return tempId;
        },
        [patchThread],
    );

    /**
     * Resolve an optimistic bubble: on success it takes the server id (and is
     * dropped if the socket echo already delivered that id); on failure it
     * stays, marked FAILED, so the agent can retry.
     */
    const reconcileOptimisticOutbound = useCallback(
        (
            tempId: string,
            result: { messageId?: string | null; status?: MessageStatus } | null,
            errorMessage?: string | null,
        ) => {
            const update = (prev: Message[]): Message[] => {
                const nextId = result?.messageId?.trim();
                if (!errorMessage && nextId && prev.some((m) => m.id === nextId)) {
                    return prev.filter((m) => m.id !== tempId); // echo won the race
                }
                return prev.map((message) => {
                    if (message.id !== tempId) return message;
                    if (errorMessage) return { ...message, status: 'FAILED', errorMessage };
                    const nextStatus: MessageStatus =
                        result?.status && result.status !== 'QUEUED' ? result.status : 'SENT';
                    return { ...message, id: nextId || message.id, status: nextStatus };
                });
            };
            const conversationId = activeConversationRef.current;
            if (conversationId) patchThread(conversationId, update);
            else setMessages(update);
        },
        [patchThread],
    );

    /** Remove an optimistic bubble (used before retrying a failed send). */
    const discardOptimistic = useCallback(
        (tempId: string) => {
            const update = (prev: Message[]) => prev.filter((m) => m.id !== tempId);
            const conversationId = activeConversationRef.current;
            if (conversationId) patchThread(conversationId, update);
            else setMessages(update);
        },
        [patchThread],
    );

    return {
        conversations,
        isLoadingConversations,
        conversationsError,
        hasMore,
        loadMore,
        reloadConversations: revalidateConversations,

        activeConversationId,
        activeConversation,
        openConversation,
        markUnread,
        markRead,
        messages,
        isLoadingMessages,
        hasOlderMessages,
        isLoadingOlderMessages,
        loadOlderMessages,
        refreshAfterSend,
        pushOptimisticOutbound,
        reconcileOptimisticOutbound,
        discardOptimistic,

        isRealtime: isConnected,
    };
}
