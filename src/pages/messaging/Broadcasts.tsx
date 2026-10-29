/**
 * Broadcasts — portfolio overview on top, one information-dense card per
 * campaign below.
 *
 *   Overview  how sending is going across every campaign (server totals, so
 *             it is never limited to the page that happens to be loaded)
 *   Attention what needs someone right now: approvals, running, scheduled
 *   Campaigns each card answers what was sent, by whom, to how many, what
 *             came back, and how long it took — click through for who exactly
 *
 * Progress counters are patched in place from the `broadcast_progress` socket
 * event rather than refetched — a running campaign emits these continuously.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'react-toastify';
import {
    ArrowRight,
    Ban,
    CalendarClock,
    Check,
    CheckCheck,
    ChevronLeft,
    ChevronRight,
    Clock,
    CornerDownRight,
    Hourglass,
    Layers,
    Loader2,
    Megaphone,
    MessageSquare,
    Pause,
    Phone,
    Play,
    Plus,
    Radio,
    Search,
    Send,
    ShieldAlert,
    User,
    Users,
    X,
    XCircle,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useSocket } from '@/context/SocketContext';
import { CreateBroadcastModal } from '@/components/messaging/CreateBroadcastModal';
import { isAgentRole } from '@/lib/agentAccess';
import { resolveEffectiveRole } from '@/lib/sessionRole';
import {
    cancelBroadcast,
    fetchBroadcasts,
    pauseBroadcast,
    approveBroadcast,
    rejectBroadcast,
    startBroadcast,
    type BroadcastSummary,
    type BroadcastTotals,
} from '@/services/messaging/messagingApi';

const PAGE_SIZES = [10, 25, 50] as const;

const STATUS_STYLE: Record<string, string> = {
    DRAFT: 'bg-muted text-muted-foreground',
    QUEUED: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300',
    RUNNING: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
    PAUSED: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    COMPLETED: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300',
    CANCELLED: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
    FAILED: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
    PENDING_APPROVAL: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300',
};

const STATUS_LABEL: Record<string, string> = {
    ALL: 'All',
    PENDING_APPROVAL: 'Awaiting approval',
    QUEUED: 'Scheduled',
};
const statusLabel = (s: string) => STATUS_LABEL[s] ?? s.charAt(0) + s.slice(1).toLowerCase();

/** PENDING_APPROVAL first: it is the only status that needs someone to act. */
const STATUS_FILTERS = ['ALL', 'PENDING_APPROVAL', 'RUNNING', 'QUEUED', 'DRAFT', 'PAUSED', 'COMPLETED', 'CANCELLED', 'FAILED'] as const;

const SORTS = [
    { id: 'newest', label: 'Newest' },
    { id: 'replies', label: 'Most replies' },
    { id: 'replyRate', label: 'Best reply rate' },
    { id: 'delivery', label: 'Best delivery' },
    { id: 'optouts', label: 'Most opt-outs' },
] as const;
type SortId = (typeof SORTS)[number]['id'];

const rate = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
const fmtRate = (v: number | null) => (v == null ? '—' : `${v}%`);

function formatPhone(value: string | null | undefined): string {
    const d = String(value ?? '').replace(/\D/g, '');
    if (d.length === 11 && d.startsWith('1')) return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
    return value ?? '—';
}

function formatWhen(iso: string | null | undefined): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatDuration(from: string | null | undefined, to: string | null | undefined): string | null {
    if (!from || !to) return null;
    const s = Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000));
    if (s < 60) return `${s}s`;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m}m`;
}

/** Rejected / never accepted — not part of sent. Undeliverable is separate. */
const failedOf = (b: BroadcastSummary) => b.failedCount;

export default function Broadcasts() {
    const { socket } = useSocket();
    const navigate = useNavigate();
    // Agents prepare campaigns; releasing one (approve, reject, start) is an admin call.
    const canRelease = !isAgentRole(resolveEffectiveRole(undefined));

    const [broadcasts, setBroadcasts] = useState<BroadcastSummary[]>([]);
    const [totals, setTotals] = useState<BroadcastTotals | null>(null);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState<number>(25);
    /** Campaigns matching the current filters, across all pages. */
    const [matching, setMatching] = useState(0);
    const [isLoading, setIsLoading] = useState(true);
    const [isPaging, setIsPaging] = useState(false);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [statusFilter, setStatusFilter] = useState<string>('ALL');
    const [search, setSearch] = useState('');
    const [sort, setSort] = useState<SortId>('newest');
    const [debouncedSearch, setDebouncedSearch] = useState('');

    useEffect(() => {
        const id = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
        return () => window.clearTimeout(id);
    }, [search]);

    // Status, search and sort are applied by the server, so every page is a
    // page of the filtered list rather than of the whole one.
    const query = useMemo(
        () => ({
            status: statusFilter === 'ALL' ? undefined : statusFilter,
            search: debouncedSearch || undefined,
            sort,
        }),
        [debouncedSearch, sort, statusFilter],
    );

    /** Only the newest request may update the list — older responses are dropped. */
    const latestRequest = useRef(0);

    /** Loads one page of the filtered list (the current one by default). */
    const load = useCallback(
        async (targetPage = page) => {
            const requestId = ++latestRequest.current;
            setIsPaging(true);
            try {
                const response = await fetchBroadcasts({ ...query, page: targetPage, pageSize });
                if (requestId !== latestRequest.current) return;
                const total = response.pagination.total ?? response.data.length;
                const lastPage = Math.max(1, Math.ceil(total / pageSize));
                // A filter change or an action can leave us past the end; step back.
                if (targetPage > lastPage && total > 0) {
                    setPage(lastPage);
                    return;
                }
                setBroadcasts(response.data);
                setTotals(response.totals ?? null);
                setMatching(total);
            } catch (error: any) {
                if (requestId === latestRequest.current) {
                    toast.error(error?.response?.data?.message || 'Failed to load broadcasts');
                }
            } finally {
                if (requestId === latestRequest.current) {
                    setIsLoading(false);
                    setIsPaging(false);
                }
            }
        },
        [page, pageSize, query],
    );

    useEffect(() => {
        void load();
    }, [load]);

    // A new filter, search, sort or page size starts again at page 1.
    useEffect(() => {
        setPage(1);
    }, [query, pageSize]);

    useEffect(() => {
        if (!socket) return;
        const onProgress = (payload: { broadcastId: string; stats: Partial<BroadcastSummary> }) => {
            setBroadcasts((prev) =>
                prev.map((entry) => (entry.id === payload.broadcastId ? { ...entry, ...payload.stats } : entry)),
            );
        };
        socket.on('broadcast_progress', onProgress);
        return () => {
            socket.off('broadcast_progress', onProgress);
        };
    }, [socket]);

    // One action per campaign at a time: a double-clicked Start used to fire
    // two requests. The backend now rejects the second, this just avoids it.
    const inFlight = useRef(new Set<string>());

    const act = useCallback(
        async (id: string, action: 'start' | 'pause' | 'cancel' | 'approve' | 'reject') => {
            if (inFlight.current.has(id)) return;
            inFlight.current.add(id);
            try {
                if (action === 'start') await startBroadcast(id);
                if (action === 'pause') await pauseBroadcast(id);
                if (action === 'cancel') await cancelBroadcast(id);
                // Approving a campaign with no schedule starts it straight
                // away: an approver clicking the tick means "send this".
                if (action === 'approve') await approveBroadcast(id, true);
                if (action === 'reject') await rejectBroadcast(id);
                await load();
            } catch (error: any) {
                toast.error(error?.response?.data?.message || `Failed to ${action} broadcast`);
            } finally {
                inFlight.current.delete(id);
            }
        },
        [load],
    );

    // The server already filtered and sorted; a live progress event can
    // move a campaign out of the chosen status, so drop those here.
    const visible = useMemo(
        () => broadcasts.filter((b) => statusFilter === 'ALL' || b.status === statusFilter),
        [broadcasts, statusFilter],
    );

    const t = totals;
    const byStatus = t?.byStatus ?? {};

    return (
        <div className="space-y-5 p-4">
            {/* Header */}
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="flex items-center gap-2 text-lg font-semibold">
                        <Megaphone className="h-5 w-5" /> Broadcasts
                    </h1>
                    <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground">
                        Bulk SMS campaigns. The overview covers every campaign you can see; open a campaign to see
                        exactly who received it, replied, opted out or failed.
                    </p>
                </div>
                <Button onClick={() => setIsModalOpen(true)}>
                    <Plus className="mr-1 h-4 w-4" /> New broadcast
                </Button>
            </div>

            {/* Overview */}
            <section className="rounded-xl border bg-card">
                <div className="grid grid-cols-2 divide-x divide-y sm:grid-cols-3 lg:grid-cols-6 lg:divide-y-0">
                    <Kpi icon={Megaphone} label="Campaigns" value={t?.campaigns} hint={`${byStatus.COMPLETED ?? 0} completed`} />
                    <Kpi icon={Users} label="Recipients" value={t?.recipients} hint={t ? `${(t.suppressed).toLocaleString()} suppressed` : undefined} />
                    <Kpi icon={Send} label="Sent" value={t?.sent} hint={t && t.queued > 0 ? `${t.queued.toLocaleString()} still queued` : 'accepted by the provider'} />
                    <Kpi icon={CheckCheck} label="Delivered" value={t?.delivered} rateValue={t ? rate(t.delivered, t.sent) : null} rateLabel="delivery rate" tone="text-emerald-600" bar="bg-emerald-500" />
                    <Kpi icon={MessageSquare} label="Replied" value={t?.replied} rateValue={t ? rate(t.replied, t.sent) : null} rateLabel="reply rate" tone="text-sky-600" bar="bg-sky-500" />
                    <Kpi icon={ShieldAlert} label="Opt-outs" value={t?.optedOut} rateValue={t ? rate(t.optedOut, t.sent) : null} rateLabel="opt-out rate" tone="text-rose-600" bar="bg-rose-500" />
                </div>

                {t && t.recipients > 0 && (
                    <div className="border-t px-4 py-3">
                        <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">Overall funnel</span>
                            <span>
                                <span title="Accepted by the provider, but the carrier did not deliver it (includes expired)">
                                    {(t.undeliverable ?? 0).toLocaleString()} undeliverable ({fmtRate(rate(t.undeliverable ?? 0, t.sent))} of sent)
                                </span>
                                {' · '}
                                <span title="Rejected by the provider or never accepted — not counted as sent">
                                    {t.failed.toLocaleString()} failed
                                </span>
                                {(t.pending ?? 0) > 0 && ` · ${(t.pending ?? 0).toLocaleString()} awaiting report`}
                            </span>
                        </div>
                        <FunnelStrip
                            stages={[
                                { label: 'Recipients', value: t.recipients },
                                { label: 'Sent', value: t.sent },
                                { label: 'Delivered', value: t.delivered },
                                { label: 'Replied', value: t.replied },
                            ]}
                        />
                    </div>
                )}
            </section>

            {/* Needs attention */}
            {((byStatus.PENDING_APPROVAL ?? 0) > 0 || (byStatus.RUNNING ?? 0) > 0 || (byStatus.QUEUED ?? 0) > 0 || (byStatus.PAUSED ?? 0) > 0) && (
                <div className="flex flex-wrap gap-2">
                    {(byStatus.PENDING_APPROVAL ?? 0) > 0 && (
                        <AttentionChip
                            icon={Hourglass}
                            tone="border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-300"
                            text={`${byStatus.PENDING_APPROVAL} awaiting approval${canRelease ? ' — review and release' : ''}`}
                            onClick={() => setStatusFilter('PENDING_APPROVAL')}
                        />
                    )}
                    {(byStatus.RUNNING ?? 0) > 0 && (
                        <AttentionChip icon={Radio} tone="border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300" text={`${byStatus.RUNNING} sending now`} onClick={() => setStatusFilter('RUNNING')} pulse />
                    )}
                    {(byStatus.QUEUED ?? 0) > 0 && (
                        <AttentionChip icon={CalendarClock} tone="border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300" text={`${byStatus.QUEUED} scheduled`} onClick={() => setStatusFilter('QUEUED')} />
                    )}
                    {(byStatus.PAUSED ?? 0) > 0 && (
                        <AttentionChip icon={Pause} tone="border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300" text={`${byStatus.PAUSED} paused`} onClick={() => setStatusFilter('PAUSED')} />
                    )}
                </div>
            )}

            {/* Filters */}
            <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="Search name, creator, message…"
                        className="h-9 w-64 pl-8"
                    />
                </div>
                <div className="flex flex-wrap gap-1">
                    {STATUS_FILTERS.filter((s) => s === 'ALL' || (byStatus[s] ?? 0) > 0).map((status) => (
                        <button
                            key={status}
                            type="button"
                            onClick={() => setStatusFilter(status)}
                            className={cn(
                                'rounded-full px-3 py-1 text-xs transition-colors',
                                statusFilter === status ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/70',
                            )}
                        >
                            {statusLabel(status)}
                            <span className="ml-1 opacity-70">{status === 'ALL' ? t?.campaigns ?? '' : byStatus[status]}</span>
                        </button>
                    ))}
                </div>
                <select
                    value={sort}
                    onChange={(e) => setSort(e.target.value as SortId)}
                    className="ml-auto h-9 rounded-md border bg-background px-2 text-xs"
                    aria-label="Sort campaigns"
                >
                    {SORTS.map((s) => (
                        <option key={s.id} value={s.id}>
                            Sort: {s.label}
                        </option>
                    ))}
                </select>
            </div>

            {/* Campaigns */}
            {isLoading ? (
                <div className="space-y-3">
                    {Array.from({ length: 3 }).map((_, i) => (
                        <div key={i} className="h-40 animate-pulse rounded-xl bg-muted" />
                    ))}
                </div>
            ) : visible.length === 0 ? (
                <div className="rounded-xl border p-10 text-center">
                    <Megaphone className="mx-auto h-8 w-8 text-muted-foreground" />
                    <p className="mt-2 text-sm font-medium">{(totals?.campaigns ?? 0) === 0 ? 'No broadcasts yet' : 'No campaigns match those filters'}</p>
                    <p className="text-xs text-muted-foreground">
                        {(totals?.campaigns ?? 0) === 0 ? 'Create one to reach your leads in bulk.' : 'Try another status or search.'}
                    </p>
                </div>
            ) : (
                <div className="space-y-3">
                    {visible.map((b) => (
                        <CampaignCard key={b.id} b={b} canRelease={canRelease} onAction={act} onOpen={() => navigate(`/broadcasts/${b.id}`)} />
                    ))}
                    <PageControls
                        page={page}
                        pageSize={pageSize}
                        total={matching}
                        busy={isPaging}
                        onPage={setPage}
                        onPageSize={setPageSize}
                    />
                </div>
            )}

            <CreateBroadcastModal open={isModalOpen} onOpenChange={setIsModalOpen} onCreated={() => void load()} />
        </div>
    );
}

/** "1–25 of 80", page size, and Previous / numbered pages / Next. */
function PageControls({
    page,
    pageSize,
    total,
    busy,
    onPage,
    onPageSize,
}: {
    page: number;
    pageSize: number;
    total: number;
    busy: boolean;
    onPage: (page: number) => void;
    onPageSize: (size: number) => void;
}) {
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
    const to = Math.min(total, page * pageSize);
    // At most 5 numbered buttons around the current page.
    const start = Math.max(1, Math.min(page - 2, pages - 4));
    const numbers = Array.from({ length: Math.min(5, pages) }, (_, i) => start + i);

    return (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card px-4 py-2.5 text-xs">
            <div className="flex items-center gap-3 text-muted-foreground">
                <span>
                    <span className="font-medium text-foreground">
                        {from.toLocaleString()}–{to.toLocaleString()}
                    </span>{' '}
                    of {total.toLocaleString()} campaigns
                </span>
                <select
                    value={pageSize}
                    onChange={(e) => onPageSize(Number(e.target.value))}
                    className="h-8 rounded-md border bg-background px-2 text-xs"
                    aria-label="Campaigns per page"
                >
                    {PAGE_SIZES.map((n) => (
                        <option key={n} value={n}>
                            {n} per page
                        </option>
                    ))}
                </select>
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            </div>
            <div className="flex items-center gap-1">
                <Button size="sm" variant="outline" className="h-8 px-2" disabled={page <= 1 || busy} onClick={() => onPage(page - 1)}>
                    <ChevronLeft className="h-4 w-4" />
                    <span className="hidden sm:inline">Previous</span>
                </Button>
                {numbers.map((n) => (
                    <Button
                        key={n}
                        size="sm"
                        variant={n === page ? 'default' : 'ghost'}
                        className="h-8 min-w-8 px-2"
                        disabled={busy}
                        onClick={() => onPage(n)}
                    >
                        {n}
                    </Button>
                ))}
                <Button size="sm" variant="outline" className="h-8 px-2" disabled={page >= pages || busy} onClick={() => onPage(page + 1)}>
                    <span className="hidden sm:inline">Next</span>
                    <ChevronRight className="h-4 w-4" />
                </Button>
            </div>
        </div>
    );
}

function Kpi({
    icon: Icon,
    label,
    value,
    hint,
    rateValue,
    rateLabel,
    tone,
    bar,
}: {
    icon: typeof Megaphone;
    label: string;
    value: number | undefined;
    hint?: string;
    rateValue?: number | null;
    rateLabel?: string;
    tone?: string;
    bar?: string;
}) {
    return (
        <div className="p-4">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Icon className={cn('h-3.5 w-3.5', tone)} /> {label}
            </p>
            <p className={cn('mt-1 text-2xl font-semibold tabular-nums', tone)}>{value == null ? '—' : value.toLocaleString()}</p>
            {rateLabel ? (
                <>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                        <span className="font-medium text-foreground">{fmtRate(rateValue ?? null)}</span> {rateLabel}
                    </p>
                    <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                        <div className={cn('h-full rounded-full', bar)} style={{ width: `${Math.min(100, rateValue ?? 0)}%` }} />
                    </div>
                </>
            ) : (
                hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>
            )}
        </div>
    );
}

/** Each stage as a bar relative to the first, with conversion to the next. */
function FunnelStrip({ stages }: { stages: Array<{ label: string; value: number }> }) {
    const max = Math.max(1, stages[0]?.value ?? 1);
    const colors = ['bg-slate-400', 'bg-blue-500', 'bg-emerald-500', 'bg-sky-500'];
    return (
        <div className="grid gap-2 sm:grid-cols-4">
            {stages.map((s, i) => (
                <div key={s.label}>
                    <div className="flex items-baseline justify-between text-xs">
                        <span className="text-muted-foreground">{s.label}</span>
                        <span className="font-semibold tabular-nums">{s.value.toLocaleString()}</span>
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
                        <div className={cn('h-full rounded-full', colors[i])} style={{ width: `${(s.value / max) * 100}%` }} />
                    </div>
                    {i > 0 && (
                        <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                            <ArrowRight className="h-3 w-3" />
                            {fmtRate(rate(s.value, stages[i - 1].value))} of {stages[i - 1].label.toLowerCase()}
                        </p>
                    )}
                </div>
            ))}
        </div>
    );
}

function AttentionChip({
    icon: Icon,
    text,
    tone,
    onClick,
    pulse,
}: {
    icon: typeof Megaphone;
    text: string;
    tone: string;
    onClick: () => void;
    pulse?: boolean;
}) {
    return (
        <button type="button" onClick={onClick} className={cn('flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-opacity hover:opacity-80', tone)}>
            <span className="relative flex">
                <Icon className="h-3.5 w-3.5" />
                {pulse && <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 animate-ping rounded-full bg-current" />}
            </span>
            {text}
        </button>
    );
}

function CampaignCard({
    b,
    canRelease,
    onAction,
    onOpen,
}: {
    b: BroadcastSummary;
    canRelease: boolean;
    onAction: (id: string, action: 'start' | 'pause' | 'cancel' | 'approve' | 'reject') => void;
    onOpen: () => void;
}) {
    const failed = failedOf(b);
    const undeliverable = b.undeliverableCount ?? 0;
    const total = Math.max(1, b.totalRecipients);
    // sent = delivered + undeliverable + pending (accepted, no final report).
    const inFlight = b.pendingCount ?? Math.max(0, b.sentCount - b.deliveredCount - undeliverable);
    const notYet = Math.max(0, b.totalRecipients - b.sentCount - b.suppressedCount - failed);
    const progress = Math.min(100, Math.round(((b.sentCount + b.suppressedCount + failed) / total) * 100));
    const duration = formatDuration(b.startedAt, b.finishedAt);
    // Once a campaign is over, a missing delivery report will not arrive later.
    const isOver = b.status === 'COMPLETED' || b.status === 'CANCELLED' || b.status === 'FAILED';

    const segments: Array<{ value: number; cls: string; label: string }> = [
        { value: b.deliveredCount, cls: 'bg-emerald-500', label: 'Delivered' },
        { value: inFlight, cls: 'bg-blue-400', label: isOver ? 'No delivery report' : 'Awaiting report' },
        { value: undeliverable, cls: 'bg-amber-500', label: 'Undeliverable' },
        { value: failed, cls: 'bg-red-500', label: 'Failed (not sent)' },
        { value: b.suppressedCount, cls: 'bg-zinc-400', label: 'Suppressed' },
        { value: notYet, cls: 'bg-muted-foreground/20', label: isOver ? 'Not sent' : 'Not sent yet' },
    ];

    return (
        <div className="group rounded-xl border bg-card transition-shadow hover:shadow-md">
            <div className="flex flex-wrap items-start gap-3 p-4 pb-3">
                <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-base font-semibold group-hover:underline">{b.name}</span>
                        <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase', STATUS_STYLE[b.status] ?? 'bg-muted text-muted-foreground')}>
                            {b.status === 'RUNNING' && <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current align-middle" />}
                            {statusLabel(b.status)}
                        </span>
                        {b.parentName && (
                            <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                                <CornerDownRight className="h-3 w-3" /> Follow-up of {b.parentName}
                            </span>
                        )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        {b.createdByName && (
                            <span className="flex items-center gap-1">
                                <User className="h-3 w-3" /> {b.createdByName}
                            </span>
                        )}
                        <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" /> {formatWhen(b.createdAt)}
                        </span>
                        <span className="flex items-center gap-1">
                            <Phone className="h-3 w-3" /> {formatPhone(b.fromNumber)}
                        </span>
                        {b.leadBatchName && (
                            <span className="flex items-center gap-1">
                                <Layers className="h-3 w-3" /> {b.leadBatchName}
                            </span>
                        )}
                    </div>
                    {b.body && <p className="mt-2 line-clamp-2 rounded-md bg-muted/50 px-2.5 py-1.5 text-xs text-foreground/80">“{b.body}”</p>}
                </button>

                <div className="flex shrink-0 items-center gap-1">
                    {canRelease && b.status === 'PENDING_APPROVAL' && (
                        <>
                            <Button size="sm" variant="outline" className="h-8 text-emerald-600" onClick={() => onAction(b.id, 'approve')} title="Approve — sends now unless scheduled">
                                <Check className="mr-1 h-4 w-4" /> Approve
                            </Button>
                            <Button size="sm" variant="ghost" className="h-8 text-red-500" onClick={() => onAction(b.id, 'reject')} title="Reject">
                                <X className="mr-1 h-4 w-4" /> Reject
                            </Button>
                        </>
                    )}
                    {canRelease && (b.status === 'DRAFT' || b.status === 'PAUSED' || b.status === 'QUEUED') && (
                        <Button size="sm" variant="outline" className="h-8" onClick={() => onAction(b.id, 'start')} title="Start">
                            <Play className="mr-1 h-4 w-4" /> {b.status === 'PAUSED' ? 'Resume' : 'Start'}
                        </Button>
                    )}
                    {b.status === 'RUNNING' && (
                        <Button size="sm" variant="outline" className="h-8" onClick={() => onAction(b.id, 'pause')} title="Pause">
                            <Pause className="mr-1 h-4 w-4" /> Pause
                        </Button>
                    )}
                    {b.status !== 'COMPLETED' && b.status !== 'CANCELLED' && b.status !== 'FAILED' && (
                        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => onAction(b.id, 'cancel')} title="Cancel">
                            <Ban className="h-4 w-4" />
                        </Button>
                    )}
                    <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onOpen} title="Open campaign">
                        <ChevronRight className="h-4 w-4" />
                    </Button>
                </div>
            </div>

            {/* Outcome bar */}
            <div className="px-4">
                <div className="flex h-2.5 overflow-hidden rounded-full bg-muted">
                    {segments.map((s) =>
                        s.value > 0 ? <div key={s.label} className={s.cls} style={{ width: `${(s.value / total) * 100}%` }} title={`${s.label}: ${s.value.toLocaleString()}`} /> : null,
                    )}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    {segments
                        .filter((s) => s.value > 0)
                        .map((s) => (
                            <span key={s.label} className="flex items-center gap-1">
                                <span className={cn('h-2 w-2 rounded-sm', s.cls)} /> {s.label} {s.value.toLocaleString()}
                            </span>
                        ))}
                    {(b.status === 'RUNNING' || b.status === 'PAUSED') && <span className="ml-auto font-medium text-foreground">{progress}% processed</span>}
                </div>
            </div>

            {/* Metrics */}
            <div className="mt-3 grid grid-cols-3 divide-x border-t sm:grid-cols-6">
                <Metric label="Recipients" value={b.totalRecipients} />
                <Metric label="Sent" value={b.sentCount} sub={b.queuedCount > 0 ? `${b.queuedCount.toLocaleString()} queued` : undefined} />
                <Metric label="Delivered" value={b.deliveredCount} sub={`${fmtRate(rate(b.deliveredCount, b.sentCount))} delivery`} tone="text-emerald-600" />
                <Metric label="Replied" value={b.repliedCount} sub={`${fmtRate(rate(b.repliedCount, b.deliveredCount))} of delivered`} tone="text-sky-600" />
                <Metric label="Opt-outs" value={b.optOutCount} sub={`${fmtRate(rate(b.optOutCount, b.sentCount))} of sent`} tone="text-rose-600" />
                <Metric
                    label="Undeliverable"
                    value={undeliverable}
                    sub={`${fmtRate(rate(undeliverable, b.sentCount))} of sent${failed ? ` · ${failed.toLocaleString()} failed` : ''}`}
                    tone={undeliverable || failed ? 'text-red-600' : undefined}
                />
            </div>

            {/* Timeline */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t bg-muted/20 px-4 py-2 text-[11px] text-muted-foreground">
                {b.approvedAt && (
                    <span className="flex items-center gap-1">
                        <Check className="h-3 w-3" /> Approved {formatWhen(b.approvedAt)}
                        {b.approvedByName && ` by ${b.approvedByName}`}
                    </span>
                )}
                {b.scheduledAt && (
                    <span className="flex items-center gap-1">
                        <CalendarClock className="h-3 w-3" /> Scheduled {formatWhen(b.scheduledAt)}
                    </span>
                )}
                <span className="flex items-center gap-1">
                    <Play className="h-3 w-3" /> Started {formatWhen(b.startedAt)}
                </span>
                <span className="flex items-center gap-1">
                    {b.finishedAt ? <CheckCheck className="h-3 w-3" /> : <XCircle className="h-3 w-3" />} Finished {formatWhen(b.finishedAt)}
                </span>
                {duration && <span>Took {duration}</span>}
                {b.throttlePerSecond ? <span>Throttle {b.throttlePerSecond}/sec</span> : null}
            </div>
        </div>
    );
}

function Metric({ label, value, sub, tone }: { label: string; value: number; sub?: string; tone?: string }) {
    return (
        <div className="px-4 py-2.5">
            <p className="text-[11px] text-muted-foreground">{label}</p>
            <p className={cn('text-lg font-semibold tabular-nums leading-tight', tone)}>{value.toLocaleString()}</p>
            {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
        </div>
    );
}

export { Broadcasts };
