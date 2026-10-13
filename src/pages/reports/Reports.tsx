/**
 * Reports: on-screen totals for a date range, and an Excel export with one
 * sheet per area (broadcasts with recipients and reply text, inbox, agent
 * performance, applications). Admin only — it spans every user's data.
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { FileSpreadsheet, FileText, Loader2, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
    REPORT_SECTIONS,
    downloadReport,
    fetchReportSummary,
    type ReportFormat,
    type ReportSectionId,
    type ReportSummary,
} from '@/services/reports/reportsApi';

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

function Tile({ label, value, tone, suffix }: { label: string; value: number | null; tone?: 'good' | 'bad' | 'warn'; suffix?: string }) {
    const toneClass =
        tone === 'good' ? 'text-emerald-600' : tone === 'bad' ? 'text-red-600' : tone === 'warn' ? 'text-amber-600' : 'text-foreground';
    return (
        <div className="rounded-lg border bg-background px-3 py-2.5">
            <p className={cn('text-xl font-semibold leading-none', toneClass)}>
                {value === null ? '—' : `${value.toLocaleString()}${suffix ?? ''}`}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{label}</p>
        </div>
    );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">{children}</div>
        </div>
    );
}

export default function Reports() {
    const [range, setRange] = useState<string>('30');
    const [from, setFrom] = useState<string>(isoDaysAgo(30));
    const [to, setTo] = useState<string>(new Date().toISOString().slice(0, 10));
    const [sections, setSections] = useState<ReportSectionId[]>(REPORT_SECTIONS.map((s) => s.id));
    const [summary, setSummary] = useState<ReportSummary | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [exporting, setExporting] = useState<ReportFormat | null>(null);

    const load = useCallback(async (fromDate: string, toDate: string) => {
        setIsLoading(true);
        try {
            setSummary(await fetchReportSummary({ from: fromDate, to: toDate }));
        } catch (error: any) {
            toast.error(error?.response?.data?.message || 'Failed to load report');
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        if (from && to) void load(from, to);
    }, [from, load, to]);

    const applyRange = (days: string) => {
        setRange(days);
        setFrom(isoDaysAgo(Number(days)));
        setTo(new Date().toISOString().slice(0, 10));
    };

    const toggleSection = (id: ReportSectionId) =>
        setSections((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));

    const exportReport = async (format: ReportFormat) => {
        if (sections.length === 0) {
            toast.error('Pick at least one section to export');
            return;
        }
        setExporting(format);
        try {
            await downloadReport({ from, to, sections, format });
        } catch (error: any) {
            // A blob error body has to be read before its message is usable.
            let message = 'Failed to export report';
            const data = error?.response?.data;
            if (data instanceof Blob) {
                try {
                    message = JSON.parse(await data.text())?.message || message;
                } catch {
                    /* keep the default */
                }
            }
            toast.error(message);
        } finally {
            setExporting(null);
        }
    };

    const b = summary?.broadcasts;

    return (
        <div className="space-y-6 p-4">
            <section className="rounded-xl border bg-background shadow-sm">
                <header className="flex flex-wrap items-start justify-between gap-3 border-b p-4">
                    <div>
                        <h2 className="text-base font-semibold">Reports</h2>
                        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                            Totals for the selected period. Export downloads an Excel workbook with a sheet for
                            each section you pick.
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
                        <Button size="sm" variant="outline" onClick={() => void load(from, to)} disabled={isLoading}>
                            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                        </Button>
                    </div>
                </header>

                <div className="space-y-5 p-4">
                    {isLoading && !summary ? (
                        <p className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Loader2 className="h-4 w-4 animate-spin" /> Loading report…
                        </p>
                    ) : summary && b ? (
                        <>
                            <Group title="Broadcasts">
                                <Tile label="Campaigns" value={b.campaigns} />
                                <Tile label="Recipients" value={b.recipients} />
                                <Tile label="Sent" value={b.sent} />
                                <Tile label="Delivered" value={b.delivered} tone="good" />
                                <Tile label="Failed" value={b.failed} tone="bad" />
                                <Tile label="Replied" value={b.replied} tone="good" />
                                <Tile label="Opted out" value={b.optedOut} tone="warn" />
                                <Tile label="Suppressed" value={b.suppressed} />
                                <Tile label="Delivery rate" value={b.deliveryRate} suffix="%" />
                                <Tile label="Reply rate" value={b.replyRate} suffix="%" />
                            </Group>
                            <Group title="Inbox & leads">
                                <Tile label="Messages sent" value={summary.inbox.messagesSent} />
                                <Tile label="Messages received" value={summary.inbox.messagesReceived} tone="good" />
                                <Tile label="Opt-outs (STOP)" value={summary.inbox.optOuts} tone="warn" />
                                <Tile label="Active conversations" value={summary.inbox.activeConversations} />
                                <Tile label="Leads imported" value={summary.leads.imported} />
                            </Group>
                            <Group title="Applications">
                                <Tile label="Created" value={summary.applications.total} />
                                {summary.applications.byQueue.slice(0, 9).map((q) => (
                                    <Tile key={q.queue} label={q.queue} value={q.count} />
                                ))}
                            </Group>
                        </>
                    ) : null}
                </div>
            </section>

            <section className="rounded-xl border bg-background shadow-sm">
                <header className="border-b p-4">
                    <h2 className="text-base font-semibold">Export</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                        Covers {from} to {to}. The PDF is the formatted report with a full section for every
                        broadcast; Excel has the raw data plus a sheet per broadcast. Owner SSN and date of
                        birth are never included.
                    </p>
                </header>
                <div className="space-y-4 p-4">
                    <div className="grid gap-2 sm:grid-cols-2">
                        {REPORT_SECTIONS.map((s) => (
                            <label
                                key={s.id}
                                className={cn(
                                    'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors',
                                    sections.includes(s.id) ? 'border-primary bg-primary/5' : 'hover:bg-muted/50',
                                )}
                            >
                                <input
                                    type="checkbox"
                                    className="mt-0.5 h-4 w-4"
                                    checked={sections.includes(s.id)}
                                    onChange={() => toggleSection(s.id)}
                                />
                                <span>
                                    <span className="block text-sm font-medium">{s.label}</span>
                                    <span className="block text-xs text-muted-foreground">{s.hint}</span>
                                </span>
                            </label>
                        ))}
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Button onClick={() => void exportReport('pdf')} disabled={exporting !== null || sections.length === 0}>
                            {exporting === 'pdf' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileText className="mr-2 h-4 w-4" />}
                            {exporting === 'pdf' ? 'Building PDF…' : 'Download PDF report'}
                        </Button>
                        <Button
                            variant="outline"
                            onClick={() => void exportReport('xlsx')}
                            disabled={exporting !== null || sections.length === 0}
                        >
                            {exporting === 'xlsx' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileSpreadsheet className="mr-2 h-4 w-4" />}
                            {exporting === 'xlsx' ? 'Building workbook…' : 'Download Excel'}
                        </Button>
                    </div>
                </div>
            </section>
        </div>
    );
}
