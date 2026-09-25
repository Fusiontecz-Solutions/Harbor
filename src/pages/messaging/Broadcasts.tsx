/**
 * Broadcast list — summary tiles across the top, campaigns as a table below.
 *
 * Structured after Fivra's broadcasts screen: the tiles answer "how is sending
 * going overall", the table answers "which campaign", and clicking through
 * answers "who exactly, and what happened to them".
 *
 * Progress counters are patched in place from the `broadcast_progress` socket
 * event rather than refetched — a running campaign emits these continuously.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'react-toastify';
import {
    Check,
    CheckCheck,
    ChevronRight,
    MessageSquare,
    Megaphone,
    Pause,
    Play,
    Plus,
    Radio,
    Users,
    X,
    XCircle,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useSocket } from '@/context/SocketContext';
import { CreateBroadcastModal } from '@/components/messaging/CreateBroadcastModal';
import {
    cancelBroadcast,
    fetchBroadcasts,
    pauseBroadcast,
    approveBroadcast,
    rejectBroadcast,
    startBroadcast,
    type BroadcastSummary,
} from '@/services/messaging/messagingApi';

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

/** PENDING_APPROVAL is first: it is the only status that needs someone to act. */
const STATUS_FILTERS = [
    'ALL',
    'PENDING_APPROVAL',
    'RUNNING',
    'DRAFT',
    'COMPLETED',
    'PAUSED',
    'CANCELLED',
] as const;

/** "PENDING_APPROVAL" reads badly as a button; give it a real label. */
const STATUS_FILTER_LABELS: Record<string, string> = {
    ALL: 'All',
    PENDING_APPROVAL: 'Awaiting approval',
};

export default function Broadcasts() {
    const { socket } = useSocket();
    const navigate = useNavigate();

    const [broadcasts, setBroadcasts] = useState<BroadcastSummary[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [statusFilter, setStatusFilter] = useState<string>('ALL');
    const [search, setSearch] = useState('');

    const load = useCallback(async () => {
        try {
            const response = await fetchBroadcasts({ page: 1 });
            setBroadcasts(response.data);
        } catch (error: any) {
            toast.error(error?.response?.data?.message || 'Failed to load broadcasts');
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

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

    const act = useCallback(
        async (id: string, action: 'start' | 'pause' | 'cancel' | 'approve' | 'reject') => {
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
            }
        },
        [load],
    );

    const totals = useMemo(
        () =>
            broadcasts.reduce(
                (acc, b) => ({
                    campaigns: acc.campaigns + 1,
                    running: acc.running + (b.status === 'RUNNING' ? 1 : 0),
                    recipients: acc.recipients + b.totalRecipients,
                    delivered: acc.delivered + b.deliveredCount,
                    failed: acc.failed + b.failedCount,
                    replied: acc.replied + b.repliedCount,
                }),
                { campaigns: 0, running: 0, recipients: 0, delivered: 0, failed: 0, replied: 0 },
            ),
        [broadcasts],
    );

    const visible = useMemo(
        () =>
            broadcasts.filter((b) => {
                if (statusFilter !== 'ALL' && b.status !== statusFilter) return false;
                if (search && !b.name.toLowerCase().includes(search.toLowerCase())) return false;
                return true;
            }),
        [broadcasts, search, statusFilter],
    );

    return (
        <div className="space-y-4 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h1 className="flex items-center gap-2 text-lg font-semibold">
                        <Megaphone className="h-5 w-5" /> Broadcasts
                    </h1>
                    <p className="text-xs text-muted-foreground">
                        Bulk SMS campaigns — click a campaign to see exactly who received, replied or failed.
                    </p>
                </div>
                <Button onClick={() => setIsModalOpen(true)}>
                    <Plus className="mr-1 h-4 w-4" /> New broadcast
                </Button>
            </div>

            {/* Summary tiles */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                <SummaryTile icon={Megaphone} label="Campaigns" value={totals.campaigns} />
                <SummaryTile icon={Radio} label="Running" value={totals.running} tone="text-emerald-600" />
                <SummaryTile icon={Users} label="Recipients" value={totals.recipients} />
                <SummaryTile icon={CheckCheck} label="Delivered" value={totals.delivered} tone="text-emerald-600" />
                <SummaryTile icon={MessageSquare} label="Replies" value={totals.replied} tone="text-sky-600" />
                <SummaryTile icon={XCircle} label="Failed" value={totals.failed} tone="text-red-600" />
            </div>

            {/* Filters */}
            <div className="flex flex-wrap items-center gap-2">
                <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search campaigns"
                    className="h-9 w-56"
                />
                <div className="flex flex-wrap gap-1">
                    {STATUS_FILTERS.map((status) => (
                        <button
                            key={status}
                            type="button"
                            onClick={() => setStatusFilter(status)}
                            className={cn(
                                'rounded-full px-3 py-1 text-xs transition-colors',
                                statusFilter === status
                                    ? 'bg-primary text-primary-foreground'
                                    : 'bg-muted text-muted-foreground hover:bg-muted/70',
                            )}
                        >
                            {STATUS_FILTER_LABELS[status] ??
                                status.charAt(0) + status.slice(1).toLowerCase()}
                        </button>
                    ))}
                </div>
            </div>

            {/* Campaign list */}
            <Card>
                <CardContent className="p-0">
                    {isLoading ? (
                        <div className="space-y-2 p-4">
                            {Array.from({ length: 3 }).map((_, index) => (
                                <div key={index} className="h-16 animate-pulse rounded bg-muted" />
                            ))}
                        </div>
                    ) : visible.length === 0 ? (
                        <p className="p-8 text-center text-sm text-muted-foreground">
                            {broadcasts.length === 0
                                ? 'No broadcasts yet — create one to get started.'
                                : 'No campaigns match those filters.'}
                        </p>
                    ) : (
                        <div className="divide-y">
                            {visible.map((broadcast) => (
                                <BroadcastRow
                                    key={broadcast.id}
                                    broadcast={broadcast}
                                    onAction={act}
                                    onOpen={() => navigate(`/broadcasts/${broadcast.id}`)}
                                />
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>

            <CreateBroadcastModal open={isModalOpen} onOpenChange={setIsModalOpen} onCreated={load} />
        </div>
    );
}

function SummaryTile({
    icon: Icon,
    label,
    value,
    tone,
}: {
    icon: typeof Megaphone;
    label: string;
    value: number;
    tone?: string;
}) {
    return (
        <div className="rounded-lg border bg-card p-3">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Icon className={cn('h-3.5 w-3.5', tone)} />
                {label}
            </span>
            <span className="mt-1 block text-xl font-semibold">{value.toLocaleString()}</span>
        </div>
    );
}

function BroadcastRow({
    broadcast,
    onAction,
    onOpen,
}: {
    broadcast: BroadcastSummary;
    onAction: (id: string, action: 'start' | 'pause' | 'cancel' | 'approve' | 'reject') => void;
    onOpen: () => void;
}) {
    const attempted = broadcast.sentCount + broadcast.failedCount + broadcast.suppressedCount;
    const progress =
        broadcast.totalRecipients > 0 ? Math.min(100, Math.round((attempted / broadcast.totalRecipients) * 100)) : 0;

    // Rates are only meaningful once something has actually been sent.
    const deliveryRate =
        broadcast.sentCount > 0 ? Math.round((broadcast.deliveredCount / broadcast.sentCount) * 100) : null;
    const replyRate =
        broadcast.deliveredCount > 0 ? Math.round((broadcast.repliedCount / broadcast.deliveredCount) * 100) : null;

    return (
        <div className="group flex flex-wrap items-center gap-3 p-3 transition-colors hover:bg-muted/40">
            <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{broadcast.name}</span>
                        <span
                            className={cn(
                                'rounded-full px-2 py-0.5 text-[10px] font-medium uppercase',
                                STATUS_STYLE[broadcast.status] ?? 'bg-muted text-muted-foreground',
                            )}
                        >
                            {broadcast.status}
                        </span>
                    </div>

                    <p className="mt-0.5 text-xs text-muted-foreground">
                        {broadcast.totalRecipients.toLocaleString()} recipients · from {broadcast.fromNumber}
                        {broadcast.startedAt && ` · ${new Date(broadcast.startedAt).toLocaleDateString()}`}
                    </p>

                    <div className="mt-2 flex items-center gap-2">
                        <div className="h-1.5 w-40 overflow-hidden rounded-full bg-muted">
                            <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
                        </div>
                        <span className="text-[11px] text-muted-foreground">{progress}%</span>
                    </div>
                </div>

                <div className="hidden shrink-0 gap-6 text-xs md:flex">
                    <Metric label="Delivered" value={broadcast.deliveredCount} suffix={deliveryRate !== null ? `${deliveryRate}%` : undefined} tone="text-emerald-600" />
                    <Metric label="Replied" value={broadcast.repliedCount} suffix={replyRate !== null ? `${replyRate}%` : undefined} tone="text-sky-600" />
                    <Metric label="Failed" value={broadcast.failedCount} tone="text-red-500" />
                    <Metric label="Opt-outs" value={broadcast.optOutCount} tone="text-rose-500" />
                </div>

                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
            </button>

            <div className="flex shrink-0 items-center gap-1">
                {/* An agent built this and it will not send until someone releases it. */}
                {broadcast.status === 'PENDING_APPROVAL' && (
                    <>
                        <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 text-emerald-600"
                            onClick={() => onAction(broadcast.id, 'approve')}
                            title="Approve and send"
                        >
                            <Check className="h-4 w-4" />
                        </Button>
                        <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 text-red-500"
                            onClick={() => onAction(broadcast.id, 'reject')}
                            title="Reject"
                        >
                            <X className="h-4 w-4" />
                        </Button>
                    </>
                )}
                {(broadcast.status === 'DRAFT' || broadcast.status === 'PAUSED' || broadcast.status === 'QUEUED') && (
                    <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => onAction(broadcast.id, 'start')} title="Start">
                        <Play className="h-4 w-4" />
                    </Button>
                )}
                {broadcast.status === 'RUNNING' && (
                    <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => onAction(broadcast.id, 'pause')} title="Pause">
                        <Pause className="h-4 w-4" />
                    </Button>
                )}
                {broadcast.status !== 'COMPLETED' && broadcast.status !== 'CANCELLED' && (
                    <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => onAction(broadcast.id, 'cancel')} title="Cancel">
                        <X className="h-4 w-4" />
                    </Button>
                )}
            </div>
        </div>
    );
}

function Metric({
    label,
    value,
    suffix,
    tone,
}: {
    label: string;
    value: number;
    suffix?: string;
    tone?: string;
}) {
    return (
        <div className="text-right">
            <p className="text-[11px] text-muted-foreground">{label}</p>
            <p className={cn('font-semibold', tone)}>
                {value.toLocaleString()}
                {suffix && <span className="ml-1 text-[11px] font-normal text-muted-foreground">{suffix}</span>}
            </p>
        </div>
    );
}

export { Broadcasts };
