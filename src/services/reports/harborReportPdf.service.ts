/**
 * Harbor PDF report: cover and platform summary, a campaign index, then one
 * full section per broadcast (configuration, message, funnel, rates, cost,
 * timing, hourly activity, failures, breakdowns by lead owner and state, every
 * reply with its text, and every recipient), followed by agent performance and
 * applications.
 */
import type { Browser } from 'puppeteer';
import { launchLetterPdfBrowser } from '../pdf/letterHtmlToPdf.service';
import type { BroadcastDetail, Breakdown } from './broadcastDetail.service';
import { REPORT_TIMEZONE } from './broadcastDetail.service';

export interface PdfReportInput {
  periodLabel: string;
  generatedAt: Date;
  summary: {
    broadcasts: Record<string, number | null>;
    inbox: Record<string, number>;
    leads: { imported: number };
    applications: { total: number; byQueue: Array<{ queue: string; count: number }> };
  };
  broadcasts: BroadcastDetail[];
  agents: Array<Record<string, string | number | boolean | Date | null>>;
  applications: Array<Record<string, string | number | boolean | Date | null>>;
}

const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const dtFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: REPORT_TIMEZONE,
});
const dt = (d: Date | null | undefined) => (d ? dtFormat.format(d) : '—');
const n = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString('en-US'));
const p = (v: number | null | undefined) => (v == null ? '—' : `${v}%`);
const money = (v: number | null | undefined, currency?: string | null) =>
  v == null ? '—' : `${currency && currency !== 'USD' ? currency + ' ' : '$'}${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function duration(seconds: number | null): string {
  if (seconds == null) return '—';
  if (seconds < 60) return `${seconds}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h ? `${h}h ${m}m` : `${m}m ${s}s`;
}

const phone = (v: string | null | undefined) => {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length === 11 && d.startsWith('1') ? `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}` : esc(v ?? '—');
};

const STATUS_TONE: Record<string, string> = {
  COMPLETED: 'good',
  RUNNING: 'info',
  QUEUED: 'info',
  PAUSED: 'warn',
  DRAFT: 'muted',
  PENDING_APPROVAL: 'warn',
  FAILED: 'bad',
  CANCELLED: 'bad',
};

const kpi = (label: string, value: string, tone = '') =>
  `<div class="kpi ${tone}"><div class="v">${value}</div><div class="l">${esc(label)}</div></div>`;

function kv(rows: Array<[string, string]>): string {
  return `<table class="kv">${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join('')}</table>`;
}

function table(headers: string[], rows: string[][], cls = ''): string {
  if (rows.length === 0) return '<p class="empty">None.</p>';
  return `<table class="grid ${cls}"><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

/** Horizontal funnel: each stage as a bar relative to recipients. */
function funnel(b: BroadcastDetail): string {
  const f = b.funnel;
  const max = Math.max(1, f.recipients);
  const stages: Array<[string, number, string]> = [
    ['Recipients', f.recipients, 'c1'],
    ['Sent', f.sent, 'c2'],
    ['Delivered', f.delivered, 'c3'],
    ['Replied', f.replied, 'c4'],
    ['Interested', f.interested, 'c5'],
  ];
  return `<div class="funnel">${stages
    .map(
      ([label, value, c]) =>
        `<div class="frow"><span class="fl">${label}</span><span class="fb"><span class="bar ${c}" style="width:${Math.max(0.5, (value / max) * 100)}%"></span></span><span class="fv">${n(value)}</span></div>`,
    )
    .join('')}</div>`;
}

/** 24 vertical bars, one per hour (Eastern). */
function hourChart(title: string, values: number[], cls: string): string {
  const max = Math.max(1, ...values);
  const total = values.reduce((a, v) => a + v, 0);
  if (total === 0) return `<div class="chart"><h4>${esc(title)}</h4><p class="empty">No activity.</p></div>`;
  return `<div class="chart"><h4>${esc(title)} <span class="muted">(${n(total)}, Eastern time)</span></h4><div class="hours">${values
    .map(
      (v, h) =>
        `<div class="hcol" title="${h}:00 — ${v}"><span class="hv">${v || ''}</span><span class="hbar ${cls}" style="height:${(v / max) * 100}%"></span><span class="hl">${h}</span></div>`,
    )
    .join('')}</div></div>`;
}

function breakdownTable(title: string, rows: Breakdown[]): string {
  return `<h3>${esc(title)}</h3>${table(
    ['', 'Recipients', 'Delivered', 'Undeliverable', 'Failed', 'Replied', 'Reply %', 'Opted out', 'Interested'],
    rows.map((r) => [
      esc(r.label),
      n(r.recipients),
      n(r.delivered),
      n(r.undeliverable),
      n(r.failed),
      n(r.replied),
      p(r.delivered ? Math.round((r.replied / r.delivered) * 1000) / 10 : null),
      n(r.optedOut),
      n(r.interested),
    ]),
    'num',
  )}`;
}

function broadcastSection(b: BroadcastDetail): string {
  const f = b.funnel;
  const r = b.rates;
  const counterMismatch =
    b.counters.delivered !== f.delivered || b.counters.replied !== f.replied
      ? `<p class="note">Live counters on the campaign read ${n(b.counters.sent)} sent / ${n(b.counters.delivered)} delivered / ${n(
          b.counters.replied,
        )} replies; figures in this report are recounted from the individual message records.</p>`
      : '';

  return `
<section class="broadcast">
  <div class="bhead">
    <div>
      <div class="eyebrow">Broadcast ${b.index}</div>
      <h2>${esc(b.name)}</h2>
      <div class="sub">${esc(b.campaignKey)} · from ${phone(b.fromNumber)}</div>
    </div>
    <span class="badge ${STATUS_TONE[b.status] ?? 'muted'}">${esc(b.status.replace(/_/g, ' '))}</span>
  </div>

  <div class="kpis">
    ${kpi('Recipients', n(f.recipients))}
    ${kpi('Sent', n(f.sent))}
    ${kpi('Delivered', n(f.delivered), 'good')}
    ${kpi('Undeliverable', n(f.undeliverable), f.undeliverable ? 'warn' : '')}
    ${kpi('Failed (not sent)', n(f.failed), f.failed ? 'bad' : '')}
    ${kpi('Replied', n(f.replied), 'good')}
    ${kpi('Opted out', n(f.optedOut), f.optedOut ? 'warn' : '')}
  </div>
  <div class="kpis">
    ${kpi('Delivery rate', p(r.delivery))}
    ${kpi('Reply rate', p(r.reply))}
    ${kpi('Reply rate (of delivered)', p(r.replyOfDelivered))}
    ${kpi('Opt-out rate', p(r.optOut))}
    ${kpi('Interested (of repliers)', p(r.interested))}
    ${kpi('Total cost', money(b.cost.total, b.cost.currency))}
  </div>

  <div class="two">
    <div>
      <h3>Campaign details</h3>
      ${kv([
        ['Created', `${dt(b.createdAt)} by ${esc(b.createdBy ?? '—')}`],
        ['Approved', b.approvedAt ? `${dt(b.approvedAt)} by ${esc(b.approvedBy ?? '—')}` : 'Not required / not approved'],
        ['Scheduled for', dt(b.scheduledAt)],
        ['Started', dt(b.startedAt)],
        ['Finished', dt(b.finishedAt)],
        ['Duration', duration(b.timing.durationSeconds)],
        ['Throttle', b.throttlePerSecond ? `${b.throttlePerSecond} msg/sec` : 'Default'],
        ['Achieved throughput', b.timing.throughputPerMinute != null ? `${b.timing.throughputPerMinute} msg/min` : '—'],
        ['Lead batch', esc(b.leadBatch ?? '—')],
        ['Follow-up of', esc(b.followUpOf ?? '—')],
        ['Follow-ups sent', b.followUps.length ? esc(b.followUps.join(', ')) : '—'],
      ])}
    </div>
    <div>
      <h3>Delivery funnel</h3>
      ${funnel(b)}
      <h3>Outcome detail</h3>
      ${kv([
        ['Suppressed before send', n(f.suppressed)],
        ['Delivered', `${n(f.delivered)} (${p(r.delivery)})`],
        ['Undeliverable (carrier, incl. expired)', `${n(f.undeliverable)} (${p(r.undeliverable)})`],
        ['Failed (rejected / not sent)', `${n(f.failed)} (${p(r.failure)})`],
        ['Awaiting delivery report', n(f.pending)],
        ['Still queued', n(f.stillQueued)],
        ['Unique repliers / total replies (excl. STOP)', `${n(f.replied)} / ${n(f.totalReplies)}`],
        ['Interested / not interested', `${n(f.interested)} / ${n(f.notInterested)}`],
      ])}
    </div>
  </div>

  <h3>Message</h3>
  <div class="message">${esc(b.body).replace(/\n/g, '<br>')}</div>
  ${kv([
    ['Encoding', esc(b.message.encoding)],
    ['Length', `${n(b.message.characters)} characters · ${n(b.message.segmentsPerMessage)} segment(s) per message`],
    ['Merge fields', b.message.mergeFields.length ? esc(b.message.mergeFields.join(', ')) : 'None'],
    ['Non-GSM characters', b.message.unicodeTriggers.length ? esc(b.message.unicodeTriggers.join(' ')) : 'None'],
    ['Media', b.media.length ? esc(b.media.join(', ')) : 'None'],
  ])}

  <div class="two">
    <div>
      <h3>Cost</h3>
      ${kv([
        ['Segments billed', n(b.cost.segments)],
        ['Total cost', money(b.cost.total, b.cost.currency)],
        ['Per message sent', money(b.cost.perSent, b.cost.currency)],
        ['Per delivered', money(b.cost.perDelivered, b.cost.currency)],
        ['Per replier', money(b.cost.perReply, b.cost.currency)],
      ])}
    </div>
    <div>
      <h3>Timing</h3>
      ${kv([
        ['First / last send', `${dt(b.timing.firstSentAt)} → ${dt(b.timing.lastSentAt)}`],
        ['Median time to deliver', duration(b.timing.deliveryMedianSeconds)],
        ['90th pct time to deliver', duration(b.timing.deliveryP90Seconds)],
        ['Median time to first reply', b.timing.replyMedianMinutes == null ? '—' : `${n(b.timing.replyMedianMinutes)} min`],
        ['First / last reply', `${dt(b.timing.firstReplyAt)} → ${dt(b.timing.lastReplyAt)}`],
      ])}
    </div>
  </div>

  <div class="two">
    ${hourChart('Messages sent by hour', b.sendsByHour, 'c2')}
    ${hourChart('Replies by hour', b.repliesByHour, 'c4')}
  </div>

  <div class="two">
    <div><h3>Status of every recipient</h3>${table(['Status', 'Recipients', '%'], b.statusBreakdown.map((s) => [esc(s.label), n(s.count), p(Math.round((s.count / Math.max(1, f.recipients)) * 1000) / 10)]), 'num')}</div>
    <div>
      <h3>Failure reasons</h3>${table(['Reason', 'Count'], b.failureReasons.map((s) => [esc(s.label), n(s.count)]), 'num')}
      <h3>Suppression reasons</h3>${table(['Reason', 'Count'], b.suppressionReasons.map((s) => [esc(s.label), n(s.count)]), 'num')}
    </div>
  </div>
  ${b.repliesByDay.length > 1 ? `<h3>Replies by day</h3>${table(['Day', 'Replies'], b.repliesByDay.map((d) => [esc(d.label), n(d.count)]), 'num')}` : ''}

  ${breakdownTable('By lead owner', b.byOwner)}
  ${breakdownTable('By state', b.byState.slice(0, 25))}
  ${counterMismatch}

  <h3>Replies (${n(b.replies.length)})</h3>
  ${table(
    ['Received', 'From', 'Contact', 'Lead owner', 'Reply', 'After send'],
    b.replies.map((x) => [
      dt(x.receivedAt),
      phone(x.from),
      esc([x.contactName, x.company].filter(Boolean).join(' · ') || '—'),
      esc(x.leadOwner ?? '—'),
      `${x.isStop ? '<span class="stop">STOP</span> ' : ''}${esc(x.text ?? '')}${x.media ? `<div class="muted">${esc(x.media)}</div>` : ''}`,
      x.minutesAfterSend == null ? '—' : x.minutesAfterSend < 60 ? `${x.minutesAfterSend} min` : `${Math.round(x.minutesAfterSend / 6) / 10} h`,
    ]),
    'replies',
  )}

  <h3>All recipients (${n(b.recipients.length)})</h3>
  ${table(
    ['Phone', 'Name', 'Company', 'State', 'Owner', 'Status', 'Sent', 'Delivered', 'Seg', 'Replies', 'Opt-out', 'Disposition', 'Error'],
    b.recipients.map((x) => [
      phone(x.phone),
      esc(`${x.firstName ?? ''} ${x.lastName ?? ''}`.trim() || '—'),
      esc(x.company ?? '—'),
      esc(x.state ?? '—'),
      esc(x.leadOwner ?? '—'),
      esc(x.suppressedReason ? `SUPPRESSED (${x.suppressedReason})` : x.messageStatus ?? x.recipientStatus),
      dt(x.sentAt),
      dt(x.deliveredAt),
      n(x.segments),
      n(x.replies),
      x.optedOut ? 'Yes' : '',
      esc(x.disposition ?? ''),
      esc(x.error ?? ''),
    ]),
    'recipients',
  )}
</section>`;
}

const CSS = `
@page { size: A4 landscape; margin: 14mm 12mm 16mm; }
* { box-sizing: border-box; }
html, body { background: #ffffff; color-scheme: light; }
body { font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1d2433; font-size: 10px; margin: 0; }
h1 { font-size: 30px; margin: 0 0 6px; letter-spacing: -0.02em; }
h2 { font-size: 19px; margin: 2px 0; letter-spacing: -0.01em; }
h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #4b5568; margin: 16px 0 6px; border-bottom: 1px solid #e3e7ee; padding-bottom: 3px; break-after: avoid; }
h4 { font-size: 10.5px; margin: 0 0 6px; }
.muted { color: #7a8394; font-weight: normal; }
.empty { color: #7a8394; font-style: italic; margin: 2px 0 6px; }
.note { background: #fff8e6; border: 1px solid #f3d998; padding: 6px 8px; border-radius: 6px; color: #6b5310; }
.cover { height: 175mm; display: flex; flex-direction: column; justify-content: space-between; break-after: page; }
.cover .brand { font-size: 12px; letter-spacing: .3em; color: #1e3a5f; font-weight: 700; }
.cover .period { font-size: 15px; color: #4b5568; }
.eyebrow { font-size: 9px; letter-spacing: .14em; text-transform: uppercase; color: #6b7a90; font-weight: 600; }
.sub { color: #6b7a90; font-size: 10px; }
.kpis { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; margin: 8px 0; }
.kpis.k4 { grid-template-columns: repeat(4, 1fr); }
.kpi { border: 1px solid #e3e7ee; border-radius: 8px; padding: 7px 9px; background: #fafbfd; }
.kpi .v { font-size: 17px; font-weight: 700; line-height: 1.1; }
.kpi .l { font-size: 9px; color: #6b7a90; margin-top: 2px; }
.kpi.good .v { color: #0f8a5f; } .kpi.bad .v { color: #c2362b; } .kpi.warn .v { color: #b7791f; }
.badge { padding: 4px 10px; border-radius: 999px; font-size: 10px; font-weight: 700; letter-spacing: .04em; }
.badge.good { background: #e3f6ee; color: #0f6e4c; } .badge.bad { background: #fde8e6; color: #a32d24; }
.badge.warn { background: #fdf3dc; color: #8a5a0b; } .badge.info { background: #e6eefb; color: #1e4fa0; } .badge.muted { background: #eef0f4; color: #4b5568; }
.broadcast { break-before: page; }
.bhead { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #1e3a5f; padding-bottom: 8px; margin-bottom: 4px; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
table { border-collapse: collapse; width: 100%; }
table.kv th { text-align: left; font-weight: 500; color: #6b7a90; width: 42%; padding: 3px 6px 3px 0; vertical-align: top; }
table.kv td { padding: 3px 0; font-weight: 500; }
table.kv tr + tr th, table.kv tr + tr td { border-top: 1px solid #f0f2f6; }
table.grid { font-size: 9px; margin-bottom: 4px; }
table.grid th { background: #f2f4f8; text-align: left; font-weight: 600; color: #4b5568; padding: 4px 5px; border-bottom: 1px solid #dfe3ea; }
table.grid td { padding: 3px 5px; border-bottom: 1px solid #eef0f4; vertical-align: top; }
table.grid thead { display: table-header-group; }
table.grid tr { break-inside: avoid; }
table.num td:not(:first-child), table.num th:not(:first-child) { text-align: right; font-variant-numeric: tabular-nums; }
table.recipients { font-size: 7.6px; }
table.recipients td { padding: 2px 4px; }
table.replies td:nth-child(5) { width: 42%; }
.message { background: #f6f8fb; border-left: 3px solid #1e3a5f; padding: 8px 10px; border-radius: 4px; font-size: 11px; line-height: 1.45; margin-bottom: 6px; white-space: normal; }
.stop { background: #c2362b; color: white; font-size: 7.5px; font-weight: 700; padding: 1px 4px; border-radius: 3px; }
.funnel .frow { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
.funnel .fl { width: 70px; color: #4b5568; }
.funnel .fb { flex: 1; background: #f0f2f6; border-radius: 4px; height: 12px; overflow: hidden; }
.funnel .fv { width: 50px; text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }
.bar { display: block; height: 100%; border-radius: 4px; }
.c1 { background: #94a3b8; } .c2 { background: #3b6fd8; } .c3 { background: #13a06f; } .c4 { background: #8b5cf6; } .c5 { background: #e08a12; }
.chart { break-inside: avoid; }
.hours { display: flex; align-items: flex-end; gap: 2px; height: 90px; border-bottom: 1px solid #dfe3ea; padding-top: 12px; }
.hcol { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; position: relative; }
.hbar { width: 100%; border-radius: 2px 2px 0 0; min-height: 0; }
.hv { font-size: 6.5px; color: #4b5568; }
.hl { position: absolute; bottom: -11px; font-size: 6.5px; color: #7a8394; }
.chart .hours { margin-bottom: 14px; }
.index td:first-child { width: 22px; color: #7a8394; }
table.index td:nth-child(-n+5), table.index th:nth-child(-n+5) { text-align: left; }
.part { break-before: page; }
`;

export function buildReportHtml(input: PdfReportInput): string {
  const s = input.summary;
  const b = s.broadcasts;
  const cover = `
<div class="cover">
  <div>
    <div class="brand">HARBOR VIEW CAPITAL</div>
    <h1 style="margin-top:40px">Platform Report</h1>
    <div class="period">${esc(input.periodLabel)}</div>
    <div class="muted" style="margin-top:4px">Generated ${esc(dt(input.generatedAt))} (Eastern)</div>
  </div>
  <div>
    <h3>Broadcasts</h3>
    <div class="kpis">
      ${kpi('Campaigns', n(b.campaigns as number))}${kpi('Recipients', n(b.recipients as number))}${kpi('Sent', n(b.sent as number))}
      ${kpi('Delivered', n(b.delivered as number), 'good')}${kpi('Replied', n(b.replied as number), 'good')}${kpi('Opted out', n(b.optedOut as number), 'warn')}
    </div>
    <div class="kpis">
      ${kpi('Delivery rate', p(b.deliveryRate))}${kpi('Reply rate', p(b.replyRate))}${kpi('Failed', n(b.failed as number), 'bad')}
      ${kpi('Suppressed', n(b.suppressed as number))}${kpi('Leads imported', n(s.leads.imported))}${kpi('Applications', n(s.applications.total))}
    </div>
    <h3>Inbox</h3>
    <div class="kpis k4">
      ${kpi('Messages sent', n(s.inbox.messagesSent))}${kpi('Messages received', n(s.inbox.messagesReceived), 'good')}
      ${kpi('Opt-outs (STOP)', n(s.inbox.optOuts), 'warn')}${kpi('Active conversations', n(s.inbox.activeConversations))}
    </div>
  </div>
</div>`;

  const index = input.broadcasts.length
    ? `<section><h2>Campaign index</h2>${table(
        ['#', 'Campaign', 'Status', 'Created', 'Created by', 'Recipients', 'Sent', 'Delivered', 'Delivery %', 'Replied', 'Reply %', 'Opt-outs', 'Cost'],
        input.broadcasts.map((x) => [
          String(x.index),
          esc(x.name),
          esc(x.status),
          dt(x.createdAt),
          esc(x.createdBy ?? '—'),
          n(x.funnel.recipients),
          n(x.funnel.sent),
          n(x.funnel.delivered),
          p(x.rates.delivery),
          n(x.funnel.replied),
          p(x.rates.reply),
          n(x.funnel.optedOut),
          money(x.cost.total, x.cost.currency),
        ]),
        'num index',
      )}</section>`
    : '<section><h2>Campaign index</h2><p class="empty">No broadcasts were created in this period.</p></section>';

  const agents = input.agents.length
    ? `<section class="part"><h2>Agent &amp; lead performance</h2>${table(
        Object.keys(input.agents[0]).filter((k) => k !== 'Email'),
        input.agents.map((row) =>
          Object.entries(row)
            .filter(([k]) => k !== 'Email')
            .map(([, v]) => (typeof v === 'number' ? n(v) : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : esc(v ?? '—'))),
        ),
        'num',
      )}</section>`
    : '';

  const apps = `<section class="part"><h2>Applications</h2>
    <div class="kpis">${kpi('Created', n(s.applications.total))}${s.applications.byQueue
      .slice(0, 5)
      .map((q) => kpi(q.queue, n(q.count)))
      .join('')}</div>
    ${table(
      ['#', 'Business', 'Owner', 'Queue', 'Status', 'Requested', 'Offer', 'Decision', 'Sales rep', 'Created'],
      input.applications.map((a) => [
        esc(a['Application #']),
        esc(a['Business'] ?? '—'),
        esc(a['Owner'] ?? '—'),
        esc(a['Queue'] ?? '—'),
        esc(a['Status'] ?? a['State (Workflow)'] ?? '—'),
        money(a['Requested Amount'] as number | null),
        money(a['Offer Amount'] as number | null),
        esc(a['Offer Decision'] ?? '—'),
        esc(a['Sales Rep'] ?? '—'),
        dt(a['Created At'] as Date | null),
      ]),
    )}</section>`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
${cover}
${index}
${input.broadcasts.map(broadcastSection).join('\n')}
${agents}
${apps}
</body></html>`;
}

export async function renderReportPdf(input: PdfReportInput): Promise<Buffer> {
  const html = buildReportHtml(input);
  let browser: Browser | undefined;
  try {
    browser = await launchLetterPdfBrowser();
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 120_000 });
    const pdf = await page.pdf({
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="width:100%;font-size:7px;color:#8a93a3;padding:0 12mm;display:flex;justify-content:space-between;font-family:Helvetica,Arial,sans-serif">
        <span>Harbor View Capital · Platform Report · ${esc(input.periodLabel)}</span>
        <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
      timeout: 300_000,
    });
    return Buffer.from(pdf);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}
