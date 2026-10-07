/**
 * The inbox data hook — cache layers, realtime updates, and polling fallback.
 *
 * Ported from Fivra's `useInbox`, restructured to reuse Harbor's existing
 * SocketProvider instead of opening a second websocket.
 *
 * Read path (fastest first):
 *   memory (5s/2s TTL) → IndexedDB (instant, possibly stale) → API
 *
 * Freshness comes from sockets, not from short TTLs. When the socket is
 * connected we do not poll at all; when it drops we fall back to *smart*
 * polling — a refetch only when the memory cache has actually expired, rather
 * than a fixed interval hammering the API.
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
import {
    CONVERSATIONS_TTL_MS,
    MESSAGES_TTL_MS,
    memoryGet,
    memoryInvalidate,
    memoryKeys,
    memorySet,
} from '@/utils/messagingMemoryCache';
import {
    fetchConversations,
    fetchMessages,
    markConversationRead as markReadRequest,
    type Conversation,
    type Message,
} from '@/services/messaging/messagingApi';

/** How often to poll when the socket is DOWN. Never used while connected. */
const FALLBACK_POLL_MS = 10_000;
/** Socket event coalescing window. */
const EVENT_FLUSH_MS = 50;

interface UseInboxOptions {
    /** Scopes cache keys so two agents on one browser cannot see each other's data. */
    userScope: string | null;
    search?: string;
    filter?: string;
}

export function useInbox({ userScope, search = '', filter = 'all' }: UseInboxOptions) {
    const { socket, isConnected } = useSocket();

    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [isLoadingConversations, setIsLoadingConversations] = useState(true);
    const [conversationsError, setConversationsError] = useState<string | null>(null);
    const [hasMore, setHasMore] = useState(false);
    const [page, setPage] = useState(1);

    const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [isLoadingMessages, setIsLoadingMessages] = useState(false);

    /**
     * Pending socket events, drained on a timer. Held in a ref so queueing an
     * event never itself causes a render.
     */
    const pendingEvents = useRef<Array<{ type: string; payload: any }>>([]);
    const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** Guards against a slow response overwriting a newer one. */
    const requestSeq = useRef(0);
    const activeConversationRef = useRef<string | null>(null);

    activeConversationRef.current = activeConversationId;

    /* ------------------------------------------------------------------ */
    /* Conversations                                                       */
    /* ------------------------------------------------------------------ */

    const loadConversations = useCallback(
        async (targetPage = 1, options?: { force?: boolean; append?: boolean }) => {
            const memKey = memoryKeys.conversations(targetPage, search, filter);
            const idbKey = conversationCacheKey(userScope, targetPage, search, filter);
            const seq = ++requestSeq.current;

            // Layer 1 — memory. Instant, no await, no loading state.
            if (!options?.force) {
                const hit = memoryGet<{ items: Conversation[]; hasMore: boolean }>(memKey);
                if (hit) {
                    setConversations((prev) => (options?.append ? [...prev, ...hit.items] : hit.items));
                    setHasMore(hit.hasMore);
                    setIsLoadingConversations(false);
                    return;
                }

                // Layer 2 — IndexedDB. Render immediately even if stale, then
                // fall through to the network to reconcile.
                const cached = await readCachedConversations<{ items: Conversation[]; hasMore: boolean }>(idbKey);
                if (cached) {
                    setConversations((prev) => (options?.append ? [...prev, ...cached.data.items] : cached.data.items));
                    setHasMore(cached.data.hasMore);
                    setIsLoadingConversations(false);
                    if (!cached.isStale) {
                        memorySet(memKey, cached.data, CONVERSATIONS_TTL_MS);
                        return;
                    }
                } else {
                    setIsLoadingConversations(true);
                }
            }

            // Layer 3 — network.
            try {
                const response = await fetchConversations({ page: targetPage, search, filter });
                if (seq !== requestSeq.current) return; // superseded

                const payload = { items: response.data, hasMore: response.pagination.hasMore };
                setConversations((prev) => (options?.append ? [...prev, ...payload.items] : payload.items));
                setHasMore(payload.hasMore);
                setConversationsError(null);

                memorySet(memKey, payload, CONVERSATIONS_TTL_MS);
                void writeCachedConversations(idbKey, payload);
            } catch (error: any) {
                if (seq !== requestSeq.current) return;
                // A cached render is better than an error screen — only surface
                // the failure when we have nothing to show.
                setConversationsError(error?.response?.data?.message || error?.message || 'Failed to load conversations');
            } finally {
                if (seq === requestSeq.current) setIsLoadingConversations(false);
            }
        },
        [filter, search, userScope],
    );

    const loadMore = useCallback(() => {
        if (!hasMore || isLoadingConversations) return;
        const next = page + 1;
        setPage(next);
        void loadConversations(next, { append: true });
    }, [hasMore, isLoadingConversations, loadConversations, page]);

    /* ------------------------------------------------------------------ */
    /* Messages                                                            */
    /* ------------------------------------------------------------------ */

    const loadMessages = useCallback(
        async (conversationId: string, options?: { force?: boolean }) => {
            const memKey = memoryKeys.messages(conversationId, 1);
            const idbKey = messagesCacheKey(userScope, conversationId);

            if (!options?.force) {
                const hit = memoryGet<Message[]>(memKey);
                if (hit) {
                    setMessages(hit);
                    setIsLoadingMessages(false);
                    return;
                }

                const cached = await readCachedMessages<Message[]>(idbKey);
                if (cached) {
                    setMessages(cached.data);
                    setIsLoadingMessages(false);
                    if (!cached.isStale) {
                        memorySet(memKey, cached.data, MESSAGES_TTL_MS);
                        return;
                    }
                } else {
                    setIsLoadingMessages(true);
                }
            }

            try {
                const response = await fetchMessages(conversationId, 1);
                // Ignore a response for a thread the user has already left.
                if (activeConversationRef.current !== conversationId) return;

                setMessages(response.data);
                memorySet(memKey, response.data, MESSAGES_TTL_MS);
                void writeCachedMessages(idbKey, response.data);
            } catch (error) {
                console.error('[useInbox] failed to load messages:', error);
            } finally {
                if (activeConversationRef.current === conversationId) setIsLoadingMessages(false);
            }
        },
        [userScope],
    );

    const openConversation = useCallback(
        (conversationId: string | null) => {
            setActiveConversationId(conversationId);
            setMessages([]);

            if (!conversationId) return;

            void loadMessages(conversationId);

            // Clear unread optimistically — the badge should disappear on click,
            // not after a round-trip.
            setConversations((prev) =>
                prev.map((conv) => (conv.id === conversationId ? { ...conv, unreadCount: 0 } : conv)),
            );
            void markReadRequest(conversationId).catch(() => undefined);
        },
        [loadMessages],
    );

    /* ------------------------------------------------------------------ */
    /* Socket events (batched)                                             */
    /* ------------------------------------------------------------------ */

    const flushEvents = useCallback(() => {
        flushTimer.current = null;
        const events = pendingEvents.current;
        pendingEvents.current = [];
        if (events.length === 0) return;

        let conversationsTouched = false;

        for (const event of events) {
            if (event.type === 'new_message') {
                const { conversationId, message } = event.payload;
                conversationsTouched = true;

                if (conversationId === activeConversationRef.current) {
                    setMessages((prev) => {
                        // The optimistic copy of our own send is already in the
                        // list — replace rather than duplicate.
                        if (prev.some((m) => m.id === message.id)) return prev;
                        return [...prev, message];
                    });
                    memoryInvalidate(memoryKeys.messagesPrefix(conversationId));
                }
            }

            if (event.type === 'message_status_update') {
                const { conversationId, messageId, providerMessageId, status, errorMessage } = event.payload;
                if (conversationId === activeConversationRef.current) {
                    // Match on either id: our own uuid is usually echoed back by
                    // the provider, but not always, and a status that fails to
                    // land leaves a failed message rendering as a plain tick.
                    setMessages((prev) =>
                        prev.map((m) =>
                            m.id === messageId || m.id === providerMessageId
                                ? { ...m, status, ...(errorMessage ? { errorMessage } : {}) }
                                : m,
                        ),
                    );
                }
            }

            if (event.type === 'conversation_update') {
                conversationsTouched = true;
            }
        }

        if (conversationsTouched) {
            // The summary fields the list renders live server-side, so refetch
            // page 1 rather than trying to reconstruct ordering locally.
            memoryInvalidate(memoryKeys.conversationsPrefix);
            void loadConversations(1, { force: true });
        }
    }, [loadConversations]);

    const queueEvent = useCallback(
        (type: string, payload: unknown) => {
            pendingEvents.current.push({ type, payload });
            if (!flushTimer.current) {
                flushTimer.current = setTimeout(flushEvents, EVENT_FLUSH_MS);
            }
        },
        [flushEvents],
    );

    useEffect(() => {
        if (!socket) return;

        const onNewMessage = (payload: unknown) => queueEvent('new_message', payload);
        const onStatus = (payload: unknown) => queueEvent('message_status_update', payload);
        const onConversation = (payload: unknown) => queueEvent('conversation_update', payload);

        socket.on('new_message', onNewMessage);
        socket.on('message_status_update', onStatus);
        socket.on('conversation_update', onConversation);

        return () => {
            socket.off('new_message', onNewMessage);
            socket.off('message_status_update', onStatus);
            socket.off('conversation_update', onConversation);
            if (flushTimer.current) {
                clearTimeout(flushTimer.current);
                flushTimer.current = null;
            }
        };
    }, [queueEvent, socket]);

    /** Join/leave the per-thread room so we only receive events we render. */
    useEffect(() => {
        if (!socket || !activeConversationId) return;

        socket.emit('messaging:join_conversation', { conversationId: activeConversationId });
        return () => {
            socket.emit('messaging:leave_conversation', { conversationId: activeConversationId });
        };
    }, [activeConversationId, socket]);

    /* ------------------------------------------------------------------ */
    /* Polling fallback — only while the socket is down                    */
    /* ------------------------------------------------------------------ */

    useEffect(() => {
        if (isConnected) return;

        const interval = setInterval(() => {
            // "Smart": if the memory cache is still warm, nothing has aged out
            // and there is no reason to hit the API.
            const memKey = memoryKeys.conversations(1, search, filter);
            if (memoryGet(memKey)) return;

            void loadConversations(1, { force: true });
            if (activeConversationRef.current) {
                void loadMessages(activeConversationRef.current, { force: true });
            }
        }, FALLBACK_POLL_MS);

        return () => clearInterval(interval);
    }, [filter, isConnected, loadConversations, loadMessages, search]);

    /* Initial load + reload when the query changes. */
    useEffect(() => {
        setPage(1);
        void loadConversations(1);
    }, [loadConversations]);

    const activeConversation = useMemo(
        () => conversations.find((conv) => conv.id === activeConversationId) ?? null,
        [activeConversationId, conversations],
    );

    /** Called after a successful send so the thread updates without waiting for the socket. */
    const refreshAfterSend = useCallback(() => {
        memoryInvalidate(memoryKeys.conversationsPrefix);
        if (activeConversationRef.current) {
            memoryInvalidate(memoryKeys.messagesPrefix(activeConversationRef.current));
            void loadMessages(activeConversationRef.current, { force: true });
        }
        void loadConversations(1, { force: true });
    }, [loadConversations, loadMessages]);

    return {
        conversations,
        isLoadingConversations,
        conversationsError,
        hasMore,
        loadMore,
        reloadConversations: () => loadConversations(1, { force: true }),

        activeConversationId,
        activeConversation,
        openConversation,
        messages,
        isLoadingMessages,
        refreshAfterSend,

        isRealtime: isConnected,
    };
}
