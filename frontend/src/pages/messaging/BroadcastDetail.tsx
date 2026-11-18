/**
 * Broadcast detail — the "what actually happened" view.
 *
 * Modelled on Fivra's `broadcast-stats` page: every stat tile is clickable and
 * resolves to the people behind the number. The important one is Failed, which
 * also shows a grouped breakdown of *why* — "1,204 × Absent Subscriber" tells
 * an operator something actionable, where 1,204 identical rows does not.
 *
 * Buckets available: delivered, sent, pending, queued, failed, undeliverable,
 * suppressed, replied, opted-out.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'react-toastify';
import {
    ArrowLeft,
    Ban,
    CheckCheck,
    Clock,
    Download,
    Loader2,
    MessageSquare,
    Pause,
    Play,
    Repeat2,
    Send,
    ShieldOff,
    X,
    XCircle,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import FollowUpModal from '@/components/messaging/FollowUpModal';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { COUNT_DEFINITIONS } from '@/services/reports/reportsApi';
import { isAgentRole } from '@/lib/agentAccess';
import { resolveEffectiveRole } from '@/lib/sessionRole';
import { useSocket } from '@/context/SocketContext';
import {
    cancelBroadcast,
    downloadBroadcastCsv,
    fetchBroadcast,
    fetchBroadcastErrorBreakdown,
    fetchBroadcastRecipients,
    pauseBroadcast,
    startBroadcast,
    type AudienceBucket,
    type AudienceRow,
    type BroadcastSummary,
    type ErrorBreakdownRow,
} from '@/services/messaging/messagingApi';

interface Tile {
    bucket: AudienceBucket;
    label: string;
    value: (b: BroadcastSummary) => number;
    icon: typeof Send;
    tone: string;
    /** Definition shown on hover — same wording as Reports. */
    hint: string;
}

const TILES: Tile[] = [
    { bucket: 'queued', label: 'Queued', value: (b) => b.queuedCount, icon: Clock, tone: 'text-sky-600', hint: 'Not handed to the provider yet' },
    { bucket: 'sent', label: 'Sent', value: (b) => b.sentCount, icon: Send, tone: 'text-indigo-600', hint: COUNT_DEFINITIONS.sent },
    { bucket: 'delivered', label: 'Delivered', value: (b) => b.deliveredCount, icon: CheckCheck, tone: 'text-emerald-600', hint: COUNT_DEFINITIONS.delivered },
    {
        bucket: 'pending',
        label: 'Awaiting report',
        value: (b) => b.pendingCount ?? Math.max(0, b.sentCount - b.deliveredCount - (b.undeliverableCount ?? 0)),
        icon: Clock,
        tone: 'text-slate-500',
        hint: COUNT_DEFINITIONS.pending,
    },
    { bucket: 'undeliverable', label: 'Undeliverable', value: (b) => b.undeliverableCount ?? 0, icon: XCircle, tone: 'text-amber-600', hint: COUNT_DEFINITIONS.undeliverable },
    { bucket: 'failed', label: 'Failed', value: (b) => b.failedCount, icon: XCircle, tone: 'text-red-600', hint: COUNT_DEFINITIONS.failed },
    { bucket: 'suppressed', label: 'Suppressed', value: (b) => b.suppressedCount, icon: ShieldOff, tone: 'text-amber-600', hint: 'Skipped before sending (opt-out, DNC or block)' },
    { bucket: 'replied', label: 'Replied', value: (b) => b.repliedCount, icon: MessageSquare, tone: 'text-emerald-700', hint: COUNT_DEFINITIONS.repliers },
    { bucket: 'opted-out', label: 'Opted out', value: (b) => b.optOutCount, icon: Ban, tone: 'text-rose-600', hint: 'Distinct contacts who replied STOP' },
];

const BUCKET_LABEL: Record<string, string> = {
    all: 'All recipients',
    queued: 'Queued',
    sent: 'Sent',
    pending: 'Awaiting delivery report',
    delivered: 'Delivered',
    failed: 'Failed',
    undeliverable: 'Undeliverable',
    suppressed: 'Suppressed',
    replied: 'Replied',
    'opted-out': 'Opted out',
};

export default function BroadcastDetail() {
    const { broadcastId = '' } = useParams();
    const navigate = useNavigate();
    const { socket } = useSocket();
    // Starting is sending; agents prepare and an admin releases.
    const canRelease = !isAgentRole(resolveEffectiveRole(undefined));

    const [broadcast, setBroadcast] = useState<BroadcastSummary | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    const [bucket, setBucket] = useState<AudienceBucket>('delivered');
    const [rows, setRows] = useState<AudienceRow[]>([]);
    const [rowTotal, setRowTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [isLoadingRows, setIsLoadingRows] = useState(false);

    const [errorBreakdown, setErrorBreakdown] = useState<ErrorBreakdownRow[]>([]);
    const [isExporting, setIsExporting] = useState(false);
    const [showFollowUp, setShowFollowUp] = useState(false);

    const loadBroadcast = useCallback(async () => {
        try {
            setBroadcast(await fetchBroadcast(broadcastId));
        } catch (err: any) {
            toast.error(err?.response?.data?.message || 'Failed to load broadcast');
        } finally {
            setIsLoading(false);
        }
    }, [broadcastId]);

    useEffect(() => {
        void loadBroadcast();
    }, [loadBroadcast]);

    // Live counters while a campaign runs — same debounced event the list uses.
    useEffect(() => {
        if (!socket) return;

        const onProgress = (payload: { broadcastId: string; stats: Partial<BroadcastSummary> }) => {
            if (payload.broadcastId !== broadcastId) return;
            setBroadcast((prev) => (prev ? { ...prev, ...payload.stats } : prev));
        };

        socket.on('broadcast_progress', onProgress);
        return () => {
            socket.off('broadcast_progress', onProgress);
        };
    }, [broadcastId, socket]);

    const loadRows = useCallback(
        async (targetBucket: AudienceBucket, targetPage: number) => {
            setIsLoadingRows(true);
            try {
                const response = await fetchBroadcastRecipients(broadcastId, {
                    bucket: targetBucket,
                    page: targetPage,
                    pageSize: 100,
                });
                setRows(response.data);
                setRowTotal(response.pagination.total ?? response.data.length);
            } catch (err: any) {
                toast.error(err?.response?.data?.message || 'Failed to load recipients');
            } finally {
                setIsLoadingRows(false);
            }
        },
        [broadcastId],
    );

    useEffect(() => {
        void loadRows(bucket, page);
    }, [bucket, loadRows, page]);

    // The failure breakdown is only meaningful for the failure buckets.
    useEffect(() => {
        if (bucket !== 'failed' && bucket !== 'undeliverable') {
            setErrorBreakdown([]);
            return;
        }
        fetchBroadcastErrorBreakdown(broadcastId).then(setErrorBreakdown).catch(() => setErrorBreakdown([]));
    }, [broadcastId, bucket]);

    const selectBucket = useCallback((next: AudienceBucket) => {
        setBucket(next);
        setPage(1);
    }, []);

    // Ignore repeat clicks while an action is in flight (double Start).
    const actionInFlight = useRef(false);

    const act = useCallback(
        async (action: 'start' | 'pause' | 'cancel') => {
            if (actionInFlight.current) return;
            actionInFlight.current = true;
            try {
                if (action === 'start') await startBroadcast(broadcastId);
                if (action === 'pause') await pauseBroadcast(broadcastId);
                if (action === 'cancel') await cancelBroadcast(broadcastId);
                await loadBroadcast();
            } catch (err: any) {
                toast.error(err?.response?.data?.message || `Failed to ${action}`);
            } finally {
                actionInFlight.current = false;
            }
        },
        [broadcastId, loadBroadcast],
    );

    const exportCsv = useCallback(async () => {
        setIsExporting(true);
        try {
            await downloadBroadcastCsv(
                broadcastId,
                bucket,
                `${broadcast?.campaignKey ?? 'broadcast'}-${bucket}.csv`,
            );
        } catch {
            toast.error('Export failed');
        } finally {
            setIsExporting(false);
        }
    }, [broadcast?.campaignKey, broadcastId, bucket]);

    const progress = useMemo(() => {
        if (!broadcast || broadcast.totalRecipients === 0) return 0;
        const attempted = broadcast.sentCount + broadcast.failedCount + broadcast.suppressedCount;
        return Math.min(100, Math.round((attempted / broadcast.totalRecipients) * 100));
    }, [broadcast]);

    if (isLoading) {
        return <p className="p-6 text-sm text-muted-foreground">Loading broadcast…</p>;
    }

    if (!broadcast) {
        return <p className="p-6 text-sm text-red-500">Broadcast not found.</p>;
    }

    const showsError = bucket === 'failed' || bucket === 'undeliverable' || bucket === 'suppressed';
    const showsReply = bucket === 'replied' || bucket === 'opted-out';

    return (
        <div className="space-y-5 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                    <Button size="sm" variant="ghost" onClick={() => navigate('/broadcasts')}>
                        <ArrowLeft className="h-4 w-4" />
                    </Button>
                    <div>
                        <h1 className="text-lg font-semibold">{broadcast.name}</h1>
                        <p className="text-xs text-muted-foreground">
                            {broadcast.campaignKey} · from {broadcast.fromNumber} ·{' '}
                            {broadcast.totalRecipients.toLocaleString()} recipients
                            {broadcast.startedAt && ` · started ${new Date(broadcast.startedAt).toLocaleString()}`}
                        </p>
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    <Badge>{broadcast.status}</Badge>
                    {canRelease && (broadcast.status === 'DRAFT' || broadcast.status === 'PAUSED' || broadcast.status === 'QUEUED') && (
                        <Button size="sm" onClick={() => act('start')}>
                            <Play className="mr-1 h-4 w-4" /> Start
                        </Button>
                    )}
                    {broadcast.status === 'RUNNING' && (
                        <Button size="sm" variant="secondary" onClick={() => act('pause')}>
                            <Pause className="mr-1 h-4 w-4" /> Pause
                        </Button>
                    )}
                    {broadcast.status !== 'COMPLETED' && broadcast.status !== 'CANCELLED' && broadcast.status !== 'FAILED' && (
                        <Button size="sm" variant="ghost" onClick={() => act('cancel')}>
                            <X className="mr-1 h-4 w-4" /> Cancel
                        </Button>
                    )}
                    {/* Only worth offering once the campaign has finished: until
                        then "never replied" is just "has not replied yet". */}
                    {broadcast.status === 'COMPLETED' && (
                        <Button size="sm" variant="secondary" onClick={() => setShowFollowUp(true)}>
                            <Repeat2 className="mr-1 h-4 w-4" /> Follow up
                        </Button>
                    )}
                </div>
            </div>

            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
            </div>

            {/* Clickable stat tiles */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5 xl:grid-cols-9">
                {TILES.map((tile) => {
                    const Icon = tile.icon;
                    const isActive = bucket === tile.bucket;
                    return (
                        <button
                            key={tile.bucket}
                            type="button"
                            title={tile.hint}
                            onClick={() => selectBucket(tile.bucket)}
                            className={cn(
                                'rounded-lg border p-3 text-left transition-colors hover:bg-muted/60',
                                isActive && 'border-primary bg-muted',
                            )}
                        >
                            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                <Icon className={cn('h-3.5 w-3.5', tile.tone)} />
                                {tile.label}
                            </span>
                            <span className="mt-1 block text-xl font-semibold">
                                {tile.value(broadcast).toLocaleString()}
                            </span>
                        </button>
                    );
                })}
            </div>

            {/* Failure reasons, grouped */}
            {errorBreakdown.length > 0 && (
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm">Why these failed</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-1">
                        {errorBreakdown.map((row, index) => (
                            <div
                                key={`${row.errorCode}-${index}`}
                                className="flex items-center justify-between gap-3 rounded border px-3 py-1.5 text-sm"
                            >
                                <span className="min-w-0 truncate">
                                    {row.errorMessage || row.errorCode || 'Unknown reason'}
                                    {row.errorCode && row.errorMessage && (
                                        <span className="ml-2 font-mono text-xs text-muted-foreground">
                                            {row.errorCode}
                                        </span>
                                    )}
                                </span>
                                <span className="shrink-0 font-semibold">{row.count.toLocaleString()}</span>
                            </div>
                        ))}
                    </CardContent>
                </Card>
            )}

            {/* Drill-down table */}
            <Card>
                <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 pb-2">
                    <CardTitle className="text-sm">
                        {BUCKET_LABEL[bucket]} — {rowTotal.toLocaleString()}
                    </CardTitle>
                    <Button size="sm" variant="secondary" onClick={exportCsv} disabled={isExporting || rowTotal === 0}>
                        {isExporting ? (
                            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                        ) : (
                            <Download className="mr-1 h-4 w-4" />
                        )}
                        Export CSV
                    </Button>
                </CardHeader>

                <CardContent>
                    {isLoadingRows ? (
                        <p className="text-sm text-muted-foreground">Loading…</p>
                    ) : rows.length === 0 ? (
                        <p className="text-sm text-muted-foreground">Nothing in this bucket.</p>
                    ) : (
                        <>
                            <div className="overflow-x-auto">
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>Name</TableHead>
                                            <TableHead>Phone</TableHead>
                                            <TableHead>Company</TableHead>
                                            <TableHead>Location</TableHead>
                                            <TableHead>Status</TableHead>
                                            {showsError && <TableHead>Reason</TableHead>}
                                            {showsReply && <TableHead>Reply</TableHead>}
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {rows.map((row) => (
                                            <TableRow key={`${row.phoneNumber}-${row.sentAt ?? ''}`}>
                                                <TableCell>{row.contactName || '—'}</TableCell>
                                                <TableCell className="font-mono text-xs">{row.phoneNumber}</TableCell>
                                                <TableCell>{row.company || '—'}</TableCell>
                                                <TableCell className="text-xs text-muted-foreground">
                                                    {[row.city, row.state].filter(Boolean).join(', ') || '—'}
                                                </TableCell>
                                                <TableCell>
                                                    <Badge
                                                        variant={
                                                            row.status === 'DELIVERED'
                                                                ? 'secondary'
                                                                : row.status === 'FAILED' || row.status === 'UNDELIVERABLE'
                                                                  ? 'destructive'
                                                                  : 'outline'
                                                        }
                                                    >
                                                        {row.status}
                                                    </Badge>
                                                </TableCell>
                                                {showsError && (
                                                    <TableCell className="max-w-xs text-xs">
                                                        {row.suppressedReason ? (
                                                            <span className="text-amber-600">{row.suppressedReason}</span>
                                                        ) : (
                                                            <span className="text-red-500">
                                                                {row.errorMessage || '—'}
                                                                {row.errorCode && (
                                                                    <span className="ml-1 font-mono text-muted-foreground">
                                                                        ({row.errorCode})
                                                                    </span>
                                                                )}
                                                            </span>
                                                        )}
                                                    </TableCell>
                                                )}
                                                {showsReply && (
                                                    <TableCell className="max-w-sm text-xs">
                                                        <span className="block truncate">{row.replyText || '—'}</span>
                                                        {row.replyAt && (
                                                            <span className="text-muted-foreground">
                                                                {new Date(row.replyAt).toLocaleString()}
                                                            </span>
                                                        )}
                                                    </TableCell>
                                                )}
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </div>

                            {rowTotal > 100 && (
                                <div className="mt-3 flex items-center justify-between text-sm">
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => setPage((value) => Math.max(1, value - 1))}
                                        disabled={page === 1}
                                    >
                                        Previous
                                    </Button>
                                    <span className="text-xs text-muted-foreground">
                                        Page {page} of {Math.ceil(rowTotal / 100)}
                                    </span>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => setPage((value) => value + 1)}
                                        disabled={page * 100 >= rowTotal}
                                    >
                                        Next
                                    </Button>
                                </div>
                            )}
                        </>
                    )}
                </CardContent>
            </Card>

            <FollowUpModal
                broadcastId={broadcast.id}
                open={showFollowUp}
                onOpenChange={setShowFollowUp}
                onCreated={() => navigate('/broadcasts')}
            />
        </div>
    );
}
