/**
 * Reports — the platform at a glance for a date range, then the detail behind
 * each number, then downloads.
 *
 *   Headline     KPIs with change against the previous period of equal length
 *   Trend        what was sent, delivered and answered, day by day
 *   Funnel/Spend where messages drop off and what they cost
 *   Campaigns    every broadcast side by side (sortable, click to open)
 *   Agents       who is producing replies
 *   Leads/Apps   pipeline health and deals created
 *   Export       PDF report with a full section per broadcast, or Excel
 *
 * Admin only — it spans every user's data.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'react-toastify';
import {
    ArrowDownRight,
    ArrowUpRight,
    Banknote,
    BarChart3,
    CheckCheck,
    ChevronRight,
    FileSpreadsheet,
    FileText,
    Inbox,
    Layers,
    Loader2,
    Megaphone,
    MessageSquare,
    Minus,
    RefreshCw,
    Send,
    ShieldAlert,
    Trophy,
    Users,
} from 'lucide-react';
import {
    Area,
    Bar,
    CartesianGrid,
    ComposedChart,
    Legend,
    Line,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from 'recharts';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
    REPORT_SECTIONS,
    downloadReport,
    fetchReportDashboard,
    type ReportDashboard,
    type ReportFormat,
    type ReportSectionId,
} from '@/services/reports/reportsApi';

const RANGES = [
    { id: '1', label: 'Today' },
    { id: '7', label: '7 days' },
    { id: '30', label: '30 days' },
    { id: '90', label: '90 days' },
] as const;

const STATUS_STYLE: Record<string, string> = {
    COMPLETED: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300',
    RUNNING: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
    QUEUED: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300',
    PAUSED: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    CANCELLED: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
    FAILED: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
    PENDING_APPROVAL: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300',
    DRAFT: 'bg-muted text-muted-foreground',
};

function isoDaysAgo(days: number): string {
    const date = new Date();
    date.setDate(date.getDate() - (days - 1));
    return date.toISOString().slice(0, 10);
}

const fmt = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString());
const fmtRate = (v: number | null | undefined) => (v == null ? '—' : `${v}%`);
const fmtMoney = (v: number | null | undefined, currency?: string | null) =>
    v == null ? '—' : `${currency ? `${currency} ` : '$'}${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const fmtUsd = (v: number) => `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const shortDay = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** Change against the previous period: up/down arrow, % and whether that is good. */
function Delta({ now, before, invert = false, unit = '%' }: { now: number | null; before: number | null; invert?: boolean; unit?: string }) {
    if (now == null || before == null) return null;
    if (before === 0) {
        return now > 0 ? <span className="text-[11px] font-medium text-muted-foreground">new this period</span> : null;
    }
    const change = unit === 'pt' ? Math.round((now - before) * 10) / 10 : Math.round(((now - before) / before) * 1000) / 10;
    const up = change > 0;
    const good = change === 0 ? null : invert ? !up : up;
    const Icon = change === 0 ? Minus : up ? ArrowUpRight : ArrowDownRight;
    return (
        <span className={cn('inline-flex items-center gap-0.5 text-[11px] font-medium', good === null ? 'text-muted-foreground' : good ? 'text-emerald-600' : 'text-red-600')}>
            <Icon className="h-3 w-3" />
            {Math.abs(change)}
            {unit === 'pt' ? ' pts' : '%'}
        </span>
    );
}

function Kpi({
    icon: Icon,
    label,
    value,
    sub,
    delta,
    tone,
}: {
    icon: typeof Send;
    label: string;
    value: string;
    sub?: string;
    delta?: React.ReactNode;
    tone?: string;
}) {
    return (
        <div className="rounded-xl border bg-card p-4">
            <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Icon className={cn('h-3.5 w-3.5', tone)} /> {label}
                </span>
                {delta}
            </div>
            <p className={cn('mt-1.5 text-2xl font-semibold tabular-nums', tone)}>{value}</p>
            {sub && <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>}
        </div>
    );
}

function Panel({ title, icon: Icon, hint, children, className, action }: { title: string; icon: typeof Send; hint?: string; children: React.ReactNode; className?: string; action?: React.ReactNode }) {
    return (
        <section className={cn('rounded-xl border bg-card', className)}>
            <header className="flex items-start justify-between gap-3 border-b px-4 py-3">
                <div>
                    <h2 className="flex items-center gap-2 text-sm font-semibold">
                        <Icon className="h-4 w-4 text-muted-foreground" /> {title}
                    </h2>
                    {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
                </div>
                {action}
            </header>
            <div className="p-4">{children}</div>
        </section>
    );
}

/** A labelled horizontal bar, value relative to `max`. */
function BarRow({ label, value, max, color, right }: { label: string; value: number; max: number; color: string; right?: string }) {
    return (
        <div className="py-1">
            <div className="flex items-baseline justify-between text-xs">
                <span className="truncate">{label}</span>
                <span className="ml-2 shrink-0 font-semibold tabular-nums">{right ?? value.toLocaleString()}</span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
                <div className={cn('h-full rounded-full', color)} style={{ width: `${max > 0 ? Math.max(1, (value / max) * 100) : 0}%` }} />
            </div>
        </div>
    );
}

type CampaignSort = 'createdAt' | 'recipients' | 'deliveryRate' | 'replied' | 'replyRate' | 'optOutRate' | 'cost';

export default function Reports() {
    const navigate = useNavigate();
    const [range, setRange] = useState<string>('30');
    const [from, setFrom] = useState<string>(isoDaysAgo(30));
    const [to, setTo] = useState<string>(new Date().toISOString().slice(0, 10));
    const [data, setData] = useState<ReportDashboard | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [sections, setSections] = useState<ReportSectionId[]>(REPORT_SECTIONS.map((s) => s.id));
    const [exporting, setExporting] = useState<ReportFormat | null>(null);
    const [campaignSort, setCampaignSort] = useState<CampaignSort>('createdAt');
    const [trendView, setTrendView] = useState<'messages' | 'outcomes'>('messages');

    const load = useCallback(async (fromDate: string, toDate: string) => {
        setIsLoading(true);
        try {
            setData(await fetchReportDashboard({ from: fromDate, to: toDate }));
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

    const exportReport = async (format: ReportFormat) => {
        if (sections.length === 0) {
            toast.error('Pick at least one section to export');
            return;
        }
        setExporting(format);
        try {
            await downloadReport({ from, to, sections, format });
        } catch (error: any) {
            let message = 'Failed to export report';
            const body = error?.response?.data;
            if (body instanceof Blob) {
                try {
                    message = JSON.parse(await body.text())?.message || message;
                } catch {
                    /* keep the default */
                }
            }
            toast.error(message);
        } finally {
            setExporting(null);
        }
    };

    const campaigns = useMemo(() => {
        if (!data) return [];
        const key = (c: ReportDashboard['campaigns'][number]): number =>
            campaignSort === 'createdAt' ? new Date(c.createdAt).getTime() : (c[campaignSort] as number | null) ?? -1;
        return [...data.campaigns].sort((a, b) => key(b) - key(a));
    }, [campaignSort, data]);

    const trend = useMemo(() => (data?.daily ?? []).map((d) => ({ ...d, label: shortDay(d.day) })), [data]);
    const busiest = useMemo(() => (data ? [...data.daily].sort((a, b) => b.sent - a.sent)[0] : null), [data]);

    const k = data?.kpis;
    const p = data?.previous;
    const r = data?.rates;

    const SortHead = ({ id, children, className }: { id: CampaignSort; children: React.ReactNode; className?: string }) => (
        <th className={cn('px-3 py-2 font-medium', className)}>
            <button
                type="button"
                onClick={() => setCampaignSort(id)}
                className={cn('inline-flex items-center gap-1 hover:text-foreground', campaignSort === id && 'text-foreground')}
            >
                {children}
                {campaignSort === id && <ArrowDownRight className="h-3 w-3" />}
            </button>
        </th>
    );

    return (
        <div className="space-y-5 p-4">
            {/* Header and range */}
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="flex items-center gap-2 text-lg font-semibold">
                        <BarChart3 className="h-5 w-5" /> Reports
                    </h1>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                        {data
                            ? `${shortDay(from)} – ${shortDay(to)}, compared with the ${Math.round(
                                  (new Date(data.range.to).getTime() - new Date(data.range.from).getTime()) / 86_400_000,
                              )} days before`
                            : 'Messaging, campaigns, agents, leads and applications for the selected period.'}
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
                                range === entry.id ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/70',
                            )}
                        >
                            {entry.label}
                        </button>
                    ))}
                    <Input type="date" value={from} max={to} onChange={(e) => { setRange(''); setFrom(e.target.value); }} className="h-8 w-[9.5rem] text-xs" />
                    <Input type="date" value={to} min={from} onChange={(e) => { setRange(''); setTo(e.target.value); }} className="h-8 w-[9.5rem] text-xs" />
                    <Button size="sm" variant="outline" onClick={() => void load(from, to)} disabled={isLoading} title="Refresh">
                        {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    </Button>
                </div>
            </div>

            {/* Export */}
            <section className="rounded-xl border bg-card">
                <header className="border-b px-4 py-3">
                    <h2 className="flex items-center gap-2 text-sm font-semibold"><FileText className="h-4 w-4 text-muted-foreground" /> Download</h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                        Covers {from} to {to}. The PDF is the formatted report with a full section for every broadcast; Excel has the raw data plus a sheet per
                        broadcast. Owner SSN and date of birth are never included.
                    </p>
                </header>
                <div className="space-y-4 p-4">
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                        {REPORT_SECTIONS.map((s) => (
                            <label
                                key={s.id}
                                className={cn('flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors', sections.includes(s.id) ? 'border-primary bg-primary/5' : 'hover:bg-muted/50')}
                            >
                                <input
                                    type="checkbox"
                                    className="mt-0.5 h-4 w-4"
                                    checked={sections.includes(s.id)}
                                    onChange={() => setSections((prev) => (prev.includes(s.id) ? prev.filter((x) => x !== s.id) : [...prev, s.id]))}
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
                        <Button variant="outline" onClick={() => void exportReport('xlsx')} disabled={exporting !== null || sections.length === 0}>
                            {exporting === 'xlsx' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileSpreadsheet className="mr-2 h-4 w-4" />}
                            {exporting === 'xlsx' ? 'Building workbook…' : 'Download Excel'}
                        </Button>
                    </div>
                </div>
            </section>

            {!data ? (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {Array.from({ length: 8 }).map((_, i) => (
                        <div key={i} className="h-28 animate-pulse rounded-xl bg-muted" />
                    ))}
                </div>
            ) : (
                <div className={cn('space-y-5 transition-opacity', isLoading && 'opacity-60')}>
                    {/* Headline KPIs */}
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        <Kpi icon={Send} label="Messages sent" value={fmt(k!.sent)} sub={`${fmt(k!.sent - k!.directSent)} campaign · ${fmt(k!.directSent)} 1:1`} delta={<Delta now={k!.sent} before={p!.sent} />} />
                        <Kpi icon={CheckCheck} label="Delivered" value={fmt(k!.delivered)} sub={`${fmtRate(r!.delivery)} delivery rate`} tone="text-emerald-600" delta={<Delta now={r!.delivery} before={r!.previousDelivery} unit="pt" />} />
                        <Kpi icon={MessageSquare} label="Replies" value={fmt(k!.replies)} sub={`${fmt(k!.repliers)} people · ${fmtRate(r!.reply)} reply rate`} tone="text-sky-600" delta={<Delta now={k!.replies} before={p!.replies} />} />
                        <Kpi icon={ShieldAlert} label="Opt-outs" value={fmt(k!.optOuts)} sub={`${fmtRate(r!.optOut)} of sent`} tone="text-rose-600" delta={<Delta now={r!.optOut} before={r!.previousOptOut} unit="pt" invert />} />
                        <Kpi icon={Megaphone} label="Campaigns" value={fmt(k!.campaigns)} sub={`${fmt(k!.recipients)} recipients`} delta={<Delta now={k!.campaigns} before={p!.campaigns} />} />
                        <Kpi icon={Layers} label="Leads imported" value={fmt(k!.leadsImported)} sub={`${fmt(data.leads.batchesInPeriod)} uploads`} delta={<Delta now={k!.leadsImported} before={p!.leadsImported} />} />
                        <Kpi icon={Inbox} label="Applications" value={fmt(k!.applications)} sub={`${fmtUsd(data.applications.requestedAmount)} requested`} delta={<Delta now={k!.applications} before={p!.applications} />} />
                        <Kpi icon={Banknote} label="Messaging spend" value={fmtMoney(data.spend.total, data.spend.currency)} sub={`${fmtMoney(data.spend.perReplier, data.spend.currency)} per replier`} delta={<Delta now={k!.spend} before={p!.spend} invert />} />
                    </div>

                    {/* Trend */}
                    <Panel
                        title="Daily activity"
                        icon={BarChart3}
                        hint={busiest && busiest.sent > 0 ? `Busiest day ${shortDay(busiest.day)}: ${busiest.sent.toLocaleString()} sent, ${busiest.replies.toLocaleString()} replies` : 'Eastern time'}
                        action={
                            <div className="flex rounded-md bg-muted p-0.5 text-xs">
                                {(['messages', 'outcomes'] as const).map((v) => (
                                    <button key={v} type="button" onClick={() => setTrendView(v)} className={cn('rounded px-2.5 py-1', trendView === v ? 'bg-background shadow-sm' : 'text-muted-foreground')}>
                                        {v === 'messages' ? 'Sent & delivered' : 'Replies & opt-outs'}
                                    </button>
                                ))}
                            </div>
                        }
                    >
                        <div className="h-72">
                            <ResponsiveContainer width="100%" height="100%">
                                <ComposedChart data={trend} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                                    <defs>
                                        <linearGradient id="sentFill" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="0%" stopColor="#3b6fd8" stopOpacity={0.35} />
                                            <stop offset="100%" stopColor="#3b6fd8" stopOpacity={0.02} />
                                        </linearGradient>
                                    </defs>
                                    <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border" vertical={false} />
                                    <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={16} />
                                    <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} />
                                    <Tooltip contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                                    <Legend wrapperStyle={{ fontSize: 12 }} />
                                    {trendView === 'messages' ? (
                                        <>
                                            <Area type="monotone" dataKey="sent" name="Sent" stroke="#3b6fd8" fill="url(#sentFill)" strokeWidth={2} />
                                            <Line type="monotone" dataKey="delivered" name="Delivered" stroke="#13a06f" strokeWidth={2} dot={false} />
                                            <Bar dataKey="failed" name="Failed" fill="#e5484d" radius={[3, 3, 0, 0]} maxBarSize={14} />
                                        </>
                                    ) : (
                                        <>
                                            <Bar dataKey="replies" name="Replies" fill="#0ea5e9" radius={[3, 3, 0, 0]} maxBarSize={18} />
                                            <Bar dataKey="optOuts" name="Opt-outs" fill="#f43f5e" radius={[3, 3, 0, 0]} maxBarSize={18} />
                                            <Line type="monotone" dataKey="applications" name="Applications" stroke="#8b5cf6" strokeWidth={2} dot={false} />
                                        </>
                                    )}
                                </ComposedChart>
                            </ResponsiveContainer>
                        </div>
                    </Panel>

                    {/* Funnel · spend · lead health */}
                    <div className="grid gap-5 lg:grid-cols-3">
                        <Panel title="Message funnel" icon={Send} hint="Where messages drop off in this period">
                            {(() => {
                                const stages = [
                                    { label: 'Sent', value: k!.sent, color: 'bg-blue-500' },
                                    { label: 'Delivered', value: k!.delivered, color: 'bg-emerald-500' },
                                    { label: 'Replied (people)', value: k!.repliers, color: 'bg-sky-500' },
                                    { label: 'Opted out', value: k!.optOuts, color: 'bg-rose-500' },
                                ];
                                return stages.map((s, i) => (
                                    <BarRow
                                        key={s.label}
                                        label={s.label}
                                        value={s.value}
                                        max={Math.max(1, k!.sent)}
                                        color={s.color}
                                        right={i === 0 ? fmt(s.value) : `${fmt(s.value)} · ${fmtRate(k!.sent ? Math.round((s.value / k!.sent) * 1000) / 10 : null)}`}
                                    />
                                ));
                            })()}
                            <p className="mt-2 text-[11px] text-muted-foreground">
                                {fmt(k!.failed)} failed ({fmtRate(r!.failure)} of sent).
                            </p>
                        </Panel>

                        <Panel title="Spend" icon={Banknote} hint="As billed by the SMS provider">
                            <p className="text-3xl font-semibold tabular-nums">{fmtMoney(data.spend.total, data.spend.currency)}</p>
                            <dl className="mt-3 space-y-2 text-sm">
                                <div className="flex justify-between"><dt className="text-muted-foreground">Per delivered message</dt><dd className="font-medium">{fmtMoney(data.spend.perDelivered, data.spend.currency)}</dd></div>
                                <div className="flex justify-between"><dt className="text-muted-foreground">Per person who replied</dt><dd className="font-medium">{fmtMoney(data.spend.perReplier, data.spend.currency)}</dd></div>
                                <div className="flex justify-between"><dt className="text-muted-foreground">Previous period</dt><dd className="font-medium">{fmtMoney(p!.spend, data.spend.currency)}</dd></div>
                            </dl>
                        </Panel>

                        <Panel title="Lead pipeline" icon={Users} hint={`${fmt(data.leads.total)} leads on file`}>
                            {(() => {
                                const l = data.leads;
                                const parts = [
                                    { label: 'New (not worked yet)', value: l.new, color: 'bg-slate-400' },
                                    { label: 'Interested', value: l.interested, color: 'bg-emerald-500' },
                                    { label: 'Not interested', value: l.notInterested, color: 'bg-amber-500' },
                                    { label: 'Opted out (STOP)', value: l.optedOut, color: 'bg-rose-500' },
                                    { label: 'Blocked', value: l.blocked, color: 'bg-zinc-500' },
                                ];
                                const total = Math.max(1, l.total);
                                return (
                                    <>
                                        <div className="flex h-3 overflow-hidden rounded-full bg-muted">
                                            {parts.map((x) => (x.value > 0 ? <div key={x.label} className={x.color} style={{ width: `${(x.value / total) * 100}%` }} title={`${x.label}: ${x.value}`} /> : null))}
                                        </div>
                                        <div className="mt-3 space-y-1.5">
                                            {parts.map((x) => (
                                                <div key={x.label} className="flex items-center justify-between text-xs">
                                                    <span className="flex items-center gap-2"><span className={cn('h-2.5 w-2.5 rounded-sm', x.color)} />{x.label}</span>
                                                    <span className="font-medium tabular-nums">{fmt(x.value)} <span className="text-muted-foreground">({fmtRate(Math.round((x.value / total) * 1000) / 10)})</span></span>
                                                </div>
                                            ))}
                                        </div>
                                    </>
                                );
                            })()}
                        </Panel>
                    </div>

                    {/* Campaign performance */}
                    <Panel title="Campaign performance" icon={Megaphone} hint={`${data.campaigns.length} campaigns created in this period · click a row to open it · click a heading to sort`}>
                        {campaigns.length === 0 ? (
                            <p className="text-sm text-muted-foreground">No campaigns in this period.</p>
                        ) : (
                            <div className="-mx-4 overflow-x-auto">
                                <table className="w-full min-w-[960px] text-sm">
                                    <thead>
                                        <tr className="border-b text-left text-xs text-muted-foreground">
                                            <th className="px-3 py-2 pl-4 font-medium">Campaign</th>
                                            <SortHead id="createdAt">Created</SortHead>
                                            <SortHead id="recipients" className="text-right">Recipients</SortHead>
                                            <SortHead id="deliveryRate">Delivery</SortHead>
                                            <SortHead id="replied" className="text-right">Replies</SortHead>
                                            <SortHead id="replyRate">Reply rate</SortHead>
                                            <SortHead id="optOutRate">Opt-out rate</SortHead>
                                            <SortHead id="cost" className="text-right">Cost</SortHead>
                                            <th className="w-6" />
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {campaigns.map((c) => (
                                            <tr key={c.id} onClick={() => navigate(`/broadcasts/${c.id}`)} className="group cursor-pointer border-b last:border-0 hover:bg-muted/40">
                                                <td className="px-3 py-2.5 pl-4">
                                                    <div className="flex items-center gap-2">
                                                        <span className="font-medium group-hover:underline">{c.name}</span>
                                                        <span className={cn('rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase', STATUS_STYLE[c.status] ?? 'bg-muted text-muted-foreground')}>{c.status.replace(/_/g, ' ')}</span>
                                                    </div>
                                                    <p className="text-[11px] text-muted-foreground">{c.createdBy ?? '—'}{c.durationMinutes != null && ` · took ${c.durationMinutes} min`}</p>
                                                </td>
                                                <td className="px-3 py-2.5 text-xs text-muted-foreground">{new Date(c.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</td>
                                                <td className="px-3 py-2.5 text-right tabular-nums">{fmt(c.recipients)}</td>
                                                <td className="px-3 py-2.5"><RateBar value={c.deliveryRate} color="bg-emerald-500" /></td>
                                                <td className="px-3 py-2.5 text-right font-medium tabular-nums">{fmt(c.replied)}</td>
                                                <td className="px-3 py-2.5"><RateBar value={c.replyRate} color="bg-sky-500" max={30} /></td>
                                                <td className="px-3 py-2.5"><RateBar value={c.optOutRate} color="bg-rose-500" max={20} /></td>
                                                <td className="px-3 py-2.5 text-right tabular-nums">{fmtMoney(c.cost, data.spend.currency)}</td>
                                                <td className="pr-3"><ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100" /></td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </Panel>

                    {/* Agents · applications */}
                    <div className="grid gap-5 lg:grid-cols-5">
                        <Panel title="Agent leaderboard" icon={Trophy} hint="Ranked by replies received in this period" className="lg:col-span-3">
                            {data.agents.length === 0 ? (
                                <p className="text-sm text-muted-foreground">No agent activity in this period.</p>
                            ) : (
                                <div className="-mx-4 overflow-x-auto">
                                    <table className="w-full min-w-[620px] text-sm">
                                        <thead>
                                            <tr className="border-b text-left text-xs text-muted-foreground">
                                                <th className="px-3 py-2 pl-4 font-medium">#</th>
                                                <th className="px-3 py-2 font-medium">Agent</th>
                                                <th className="px-3 py-2 text-right font-medium">Leads</th>
                                                <th className="px-3 py-2 text-right font-medium">Sent</th>
                                                <th className="px-3 py-2 font-medium">Replies</th>
                                                <th className="px-3 py-2 text-right font-medium">Reply rate</th>
                                                <th className="px-3 py-2 text-right font-medium">Opt-outs</th>
                                                <th className="px-3 py-2 pr-4 text-right font-medium">Interested</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {(() => {
                                                const maxReplies = Math.max(1, ...data.agents.map((a) => a.replies));
                                                return data.agents.map((a, i) => (
                                                    <tr key={a.name + i} className="border-b last:border-0">
                                                        <td className="px-3 py-2 pl-4 text-xs text-muted-foreground">{i + 1}</td>
                                                        <td className="whitespace-nowrap px-3 py-2">
                                                            <span className="font-medium">{a.name}</span>
                                                            <span className="ml-1.5 text-[10px] uppercase text-muted-foreground">{a.role.replace(/_/g, ' ')}</span>
                                                        </td>
                                                        <td className="px-3 py-2 text-right tabular-nums">{fmt(a.leadsOwned)}</td>
                                                        <td className="px-3 py-2 text-right tabular-nums">{fmt(a.broadcastSent + a.directSent)}</td>
                                                        <td className="px-3 py-2">
                                                            <div className="flex items-center gap-2">
                                                                <div className="h-2 w-24 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-sky-500" style={{ width: `${(a.replies / maxReplies) * 100}%` }} /></div>
                                                                <span className="font-medium tabular-nums">{fmt(a.replies)}</span>
                                                            </div>
                                                        </td>
                                                        <td className="px-3 py-2 text-right tabular-nums">{fmtRate(a.replyRate)}</td>
                                                        <td className="px-3 py-2 text-right tabular-nums text-rose-600">{fmt(a.optOuts)}</td>
                                                        <td className="px-3 py-2 pr-4 text-right tabular-nums text-emerald-600">{fmt(a.interested)}</td>
                                                    </tr>
                                                ));
                                            })()}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </Panel>

                        <Panel title="Applications" icon={Inbox} hint={`${fmt(data.applications.total)} created · ${fmtUsd(data.applications.requestedAmount)} requested`} className="lg:col-span-2">
                            {data.applications.byQueue.length === 0 ? (
                                <p className="text-sm text-muted-foreground">No applications in this period.</p>
                            ) : (
                                (() => {
                                    const max = Math.max(1, ...data.applications.byQueue.map((q) => q.count));
                                    return data.applications.byQueue.map((q) => (
                                        <BarRow key={q.queue} label={q.queue} value={q.count} max={max} color="bg-violet-500" right={`${q.count.toLocaleString()} · ${fmtUsd(q.requested)}`} />
                                    ));
                                })()
                            )}
                        </Panel>
                    </div>
                </div>
            )}

        </div>
    );
}

/** Percentage with a small bar; `max` sets what a full bar means. */
function RateBar({ value, color, max = 100 }: { value: number | null; color: string; max?: number }) {
    if (value == null) return <span className="text-xs text-muted-foreground">—</span>;
    return (
        <div className="flex items-center gap-2">
            <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                <div className={cn('h-full rounded-full', color)} style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
            </div>
            <span className="w-11 text-xs font-medium tabular-nums">{value}%</span>
        </div>
    );
}
