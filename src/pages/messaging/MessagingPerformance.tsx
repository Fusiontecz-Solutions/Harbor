/**
 * Admin view of per-user messaging activity.
 *
 * Reads as a leaderboard: who sent how much, how many campaigns they ran, and
 * what came back — replies and opt-outs.
 *
 * Two attribution rules are worth knowing while reading the numbers, and the
 * screen states both rather than leaving them implicit:
 *
 *   Sent counts include campaign messages, attributed to whoever created the
 *   campaign — otherwise a rep who works mainly through broadcasts looks idle.
 *
 *   Replies and opt-outs carry no user of their own, so they are attributed
 *   through the number they arrived on. Traffic on the shared default number
 *   belongs to nobody and is shown separately instead of being spread across
 *   users, which would invent numbers.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import { Loader2, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
    fetchMessagingPerformance,
    type PerformanceResult,
} from '@/services/messaging/messagingApi';

const RANGES = [
    { id: '1', label: 'Today' },
    { id: '7', label: '7 days' },
    { id: '30', label: '30 days' },
    { id: '90', label: '90 days' },
] as const;

function isoDaysAgo(days: number): string {
    const date = new Date();
    date.setDate(date.getDate() - (days - 1));
    return date.toISOString().slice(0, 10);
}

function formatPhone(value: string | null): string {
    if (!value) return '—';
    const digits = value.replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) {
        return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
    }
    if (digits.length === 10) {
        return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    }
    return value;
}

function Tile({
    label,
    value,
    tone,
    hint,
}: {
    label: string;
    value: number;
    tone?: 'good' | 'bad' | 'warn';
    hint?: string;
}) {
    const toneClass =
        tone === 'good'
            ? 'text-emerald-600'
            : tone === 'bad'
              ? 'text-red-600'
              : tone === 'warn'
                ? 'text-amber-600'
                : 'text-foreground';
    return (
        <div className="rounded-lg border bg-background px-3 py-2.5" title={hint}>
            <p className={cn('text-xl font-semibold leading-none', toneClass)}>
                {value.toLocaleString()}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{label}</p>
        </div>
    );
}

export default function MessagingPerformance() {
    const [range, setRange] = useState<string>('30');
    const [from, setFrom] = useState<string>(isoDaysAgo(30));
    const [to, setTo] = useState<string>(new Date().toISOString().slice(0, 10));
    const [data, setData] = useState<PerformanceResult | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    const load = useCallback(async (fromDate: string, toDate: string) => {
        setIsLoading(true);
        try {
            setData(await fetchMessagingPerformance({ from: fromDate, to: toDate }));
        } catch (error: any) {
            toast.error(error?.response?.data?.message || 'Failed to load performance');
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        void load(from, to);
    }, [from, load, to]);

    const applyRange = useCallback((days: string) => {
        setRange(days);
        setFrom(isoDaysAgo(Number(days)));
        setTo(new Date().toISOString().slice(0, 10));
    }, []);

    const totals = data?.totals;

    /** Reply rate is the number an admin actually judges a rep on. */
    const replyRate = useCallback(
        (sent: number, replies: number) => (sent > 0 ? Math.round((replies / sent) * 1000) / 10 : 0),
        [],
    );

    const hasUnattributed = useMemo(
        () => Boolean(data && (data.unattributedReplies > 0 || data.unattributedOptOuts > 0)),
        [data],
    );

    return (
        <div className="space-y-6 p-4">
            <section className="rounded-xl border bg-background shadow-sm">
                <header className="flex flex-wrap items-start justify-between gap-3 border-b p-4">
                    <div>
                        <h2 className="text-base font-semibold">Messaging performance</h2>
                        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                            Activity per user over the selected range. Campaign messages count
                            towards whoever created the campaign.
                        </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                        {RANGES.map((entry) => (
                            <button
                                key={entry.id}
                                type="button"
                                onClick={() => applyRange(entry.id)}
                                className={cn(
                                    'rounded-full px-3 py-1.5 text-xs transition-colors',
                                    range === entry.id
                                        ? 'bg-primary text-primary-foreground'
                                        : 'bg-muted text-muted-foreground hover:bg-muted/70',
                                )}
                            >
                                {entry.label}
                            </button>
                        ))}
                        <Input
                            type="date"
                            value={from}
                            max={to}
                            onChange={(event) => {
                                setRange('');
                                setFrom(event.target.value);
                            }}
                            className="h-8 w-[9.5rem] text-xs"
                        />
                        <Input
                            type="date"
                            value={to}
                            min={from}
                            onChange={(event) => {
                                setRange('');
                                setTo(event.target.value);
                            }}
                            className="h-8 w-[9.5rem] text-xs"
                        />
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void load(from, to)}
                            disabled={isLoading}
                        >
                            {isLoading ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <RefreshCw className="h-4 w-4" />
                            )}
                        </Button>
                    </div>
                </header>

                {totals && (
                    <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-3 lg:grid-cols-6">
                        <Tile label="Messages sent" value={totals.messagesSent} />
                        <Tile label="Delivered" value={totals.delivered} tone="good" />
                        <Tile
                            label="Failed"
                            value={totals.failed}
                            tone="bad"
                            hint="Rejected by the provider or never delivered"
                        />
                        <Tile label="Campaigns" value={totals.campaigns} />
                        <Tile label="Replies" value={totals.replies} tone="good" />
                        <Tile
                            label="Opt-outs"
                            value={totals.optOuts}
                            tone="warn"
                            hint="Inbound STOP / unsubscribe keywords"
                        />
                    </div>
                )}
            </section>

            <section className="rounded-xl border bg-background shadow-sm">
                <header className="border-b p-4">
                    <h2 className="text-base font-semibold">By user</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                        Replies and opt-outs are attributed through each user&apos;s sending
                        number, so they match what that user sees in their inbox.
                    </p>
                </header>

                <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                        <thead className="bg-muted/60 text-xs uppercase tracking-wide text-muted-foreground">
                            <tr>
                                <th className="px-4 py-2 text-left">User</th>
                                <th className="px-4 py-2 text-left">Sends from</th>
                                <th className="px-4 py-2 text-right">Sent</th>
                                <th className="px-4 py-2 text-right">Delivered</th>
                                <th className="px-4 py-2 text-right">Failed</th>
                                <th className="px-4 py-2 text-right">Campaigns</th>
                                <th className="px-4 py-2 text-right">Replies</th>
                                <th className="px-4 py-2 text-right">Reply rate</th>
                                <th className="px-4 py-2 text-right">Opt-outs</th>
                            </tr>
                        </thead>
                        <tbody>
                            {isLoading && !data ? (
                                <tr>
                                    <td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">
                                        Loading…
                                    </td>
                                </tr>
                            ) : !data?.users.length ? (
                                <tr>
                                    <td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">
                                        No messaging activity in this range.
                                    </td>
                                </tr>
                            ) : (
                                data.users.map((user) => (
                                    <tr key={user.userId ?? 'none'} className="border-t">
                                        <td className="px-4 py-2">
                                            <p className="font-medium">{user.name ?? '—'}</p>
                                            <p className="text-xs text-muted-foreground">{user.email ?? ''}</p>
                                        </td>
                                        <td className="px-4 py-2 text-xs text-muted-foreground">
                                            {user.senderNumber ? formatPhone(user.senderNumber) : 'Server default'}
                                        </td>
                                        <td className="px-4 py-2 text-right font-medium">
                                            {user.messagesSent.toLocaleString()}
                                        </td>
                                        <td className="px-4 py-2 text-right text-emerald-600">
                                            {user.delivered.toLocaleString()}
                                        </td>
                                        <td
                                            className={cn(
                                                'px-4 py-2 text-right',
                                                user.failed > 0 ? 'text-red-600' : 'text-muted-foreground',
                                            )}
                                        >
                                            {user.failed.toLocaleString()}
                                        </td>
                                        <td className="px-4 py-2 text-right">{user.campaigns.toLocaleString()}</td>
                                        <td className="px-4 py-2 text-right">{user.replies.toLocaleString()}</td>
                                        <td className="px-4 py-2 text-right text-muted-foreground">
                                            {replyRate(user.messagesSent, user.replies)}%
                                        </td>
                                        <td
                                            className={cn(
                                                'px-4 py-2 text-right',
                                                user.optOuts > 0 ? 'text-amber-600' : 'text-muted-foreground',
                                            )}
                                        >
                                            {user.optOuts.toLocaleString()}
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>

                {hasUnattributed && data && (
                    <p className="border-t px-4 py-2.5 text-xs text-muted-foreground">
                        {data.unattributedReplies} repl
                        {data.unattributedReplies === 1 ? 'y' : 'ies'} and {data.unattributedOptOuts}{' '}
                        opt-out{data.unattributedOptOuts === 1 ? '' : 's'} arrived on a number no user
                        is assigned to, so they are not counted against anyone above. Assign that
                        number on Sending Numbers to attribute them.
                    </p>
                )}
            </section>
        </div>
    );
}
