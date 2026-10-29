/**
 * Step 2 of the create flow: who is in the audience, who is left out and why,
 * and how many will actually receive the broadcast. Computed by the server
 * with the same rules create uses, so the number here is the number that sends.
 */
import { useState } from 'react';
import { AlertTriangle, Ban, CheckCircle2, ChevronDown, Copy, Loader2, PhoneOff, ThumbsDown, ThumbsUp, UserX, Users } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { AudiencePreview } from '@/services/messaging/messagingApi';

function formatPhone(value: string): string {
    const d = value.replace(/\D/g, '');
    if (d.length === 11 && d.startsWith('1')) return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
    return value;
}

function Row({
    icon: Icon,
    label,
    hint,
    value,
    total,
    tone,
}: {
    icon: typeof Users;
    label: string;
    hint: string;
    value: number;
    total: number;
    tone: string;
}) {
    if (value === 0) return null;
    const share = total > 0 ? (value / total) * 100 : 0;
    return (
        <div className="flex items-center gap-3 py-1.5">
            <Icon className={cn('h-4 w-4 shrink-0', tone)} />
            <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm">{label}</span>
                    <span className="text-sm font-semibold tabular-nums">−{value.toLocaleString()}</span>
                </div>
                <div className="mt-0.5 flex items-center gap-2">
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                        <div className={cn('h-full rounded-full', tone.replace('text-', 'bg-'))} style={{ width: `${Math.max(1.5, share)}%` }} />
                    </div>
                    <span className="w-24 text-right text-[11px] text-muted-foreground">{hint}</span>
                </div>
            </div>
        </div>
    );
}

export function AudienceBreakdown({
    preview,
    isLoading,
    error,
}: {
    preview: AudiencePreview | null;
    isLoading: boolean;
    error: string | null;
}) {
    const [showOptedOut, setShowOptedOut] = useState(false);

    if (error) {
        return (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
            </div>
        );
    }
    if (!preview) {
        return isLoading ? (
            <div className="flex items-center gap-2 rounded-lg border p-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Checking these leads against opt-outs and blocks…
            </div>
        ) : null;
    }

    const e = preview.excluded;
    const total = preview.totalLeads;
    const excludedTotal = total - preview.willSend;
    const sendShare = total > 0 ? Math.round((preview.willSend / total) * 1000) / 10 : 0;

    return (
        <div className={cn('rounded-xl border bg-muted/20 transition-opacity', isLoading && 'opacity-60')}>
            <div className="grid grid-cols-3 divide-x border-b">
                <div className="p-3">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Total leads</p>
                    <p className="mt-0.5 text-2xl font-semibold tabular-nums">{total.toLocaleString()}</p>
                </div>
                <div className="p-3">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Left out</p>
                    <p className={cn('mt-0.5 text-2xl font-semibold tabular-nums', excludedTotal > 0 ? 'text-amber-600' : '')}>
                        {excludedTotal.toLocaleString()}
                    </p>
                </div>
                <div className="bg-emerald-50/70 p-3 dark:bg-emerald-950/30">
                    <p className="text-[11px] uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Will receive</p>
                    <p className="mt-0.5 flex items-baseline gap-1.5 text-2xl font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">
                        {preview.willSend.toLocaleString()}
                        <span className="text-xs font-normal">{sendShare}%</span>
                    </p>
                </div>
            </div>

            {/* Stacked bar: who sends vs every reason someone is left out. */}
            <div className="flex h-2 overflow-hidden">
                {[
                    [preview.willSend, 'bg-emerald-500'],
                    [e.optedOut, 'bg-red-500'],
                    [e.dnc + e.blocked + e.otherSuppressed, 'bg-zinc-500'],
                    [e.interested + e.notInterested, 'bg-blue-500'],
                    [e.invalid + e.duplicates + (e.missingOwnerName ?? 0), 'bg-amber-400'],
                ].map(([v, c], i) =>
                    (v as number) > 0 ? <div key={i} className={c as string} style={{ width: `${((v as number) / Math.max(1, total)) * 100}%` }} /> : null,
                )}
            </div>

            <div className="px-3 py-2">
                {excludedTotal === 0 ? (
                    <p className="flex items-center gap-2 py-1.5 text-sm text-emerald-700 dark:text-emerald-300">
                        <CheckCircle2 className="h-4 w-4" /> Nobody is left out — every lead can be messaged.
                    </p>
                ) : (
                    <>
                        <Row icon={PhoneOff} label="Opted out (replied STOP)" hint="never messaged" value={e.optedOut} total={total} tone="text-red-500" />
                        <Row icon={Ban} label="On Do-Not-Contact list" hint="DNC" value={e.dnc} total={total} tone="text-zinc-500" />
                        <Row icon={Ban} label="Blocked" hint="blocked contact" value={e.blocked} total={total} tone="text-zinc-500" />
                        <Row icon={Ban} label="Other suppression" hint="carrier / bounce" value={e.otherSuppressed} total={total} tone="text-zinc-500" />
                        <Row icon={UserX} label="Missing owner name" hint="not in the sheet" value={e.missingOwnerName ?? 0} total={total} tone="text-amber-500" />
                        <Row icon={ThumbsUp} label="Already marked Interested" hint="being worked" value={e.interested} total={total} tone="text-blue-500" />
                        <Row icon={ThumbsDown} label="Already marked Not Interested" hint="closed" value={e.notInterested} total={total} tone="text-blue-500" />
                        <Row icon={AlertTriangle} label="Invalid phone numbers" hint="can't be parsed" value={e.invalid} total={total} tone="text-amber-500" />
                        <Row icon={Copy} label="Duplicates" hint="sent once" value={e.duplicates} total={total} tone="text-amber-500" />
                    </>
                )}
            </div>

            {e.optedOut > 0 && (
                <div className="border-t px-3 py-2">
                    <button
                        type="button"
                        onClick={() => setShowOptedOut((v) => !v)}
                        className="flex w-full items-center justify-between text-xs font-medium text-muted-foreground hover:text-foreground"
                    >
                        Who opted out ({e.optedOut.toLocaleString()})
                        <ChevronDown className={cn('h-4 w-4 transition-transform', showOptedOut && 'rotate-180')} />
                    </button>
                    {showOptedOut && (
                        <div className="mt-2 max-h-40 space-y-1 overflow-y-auto pr-1">
                            {preview.optedOut.map((o) => (
                                <div key={o.phoneNumber} className="flex items-center justify-between gap-2 text-xs">
                                    <span className="truncate">
                                        <span className="font-mono">{formatPhone(o.phoneNumber)}</span>
                                        {o.name && <span className="text-muted-foreground"> · {o.name}</span>}
                                    </span>
                                    {o.optedOutAt && (
                                        <span className="shrink-0 text-muted-foreground">
                                            since {new Date(o.optedOutAt).toLocaleDateString()}
                                        </span>
                                    )}
                                </div>
                            ))}
                            {preview.optedOutMore > 0 && (
                                <p className="text-xs text-muted-foreground">…and {preview.optedOutMore.toLocaleString()} more</p>
                            )}
                        </div>
                    )}
                </div>
            )}

            {preview.previouslyMessaged > 0 && (
                <p className="flex items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
                    <Users className="h-3.5 w-3.5" />
                    {preview.previouslyMessaged.toLocaleString()} of these numbers have received a broadcast before.
                </p>
            )}
            {(preview.skippedClients?.length ?? 0) > 0 && (
                <p className="border-t px-3 py-2 text-xs text-amber-700">
                    {preview.skippedClients!.length} CRM client(s) have no usable mobile number and are skipped.
                </p>
            )}
        </div>
    );
}
