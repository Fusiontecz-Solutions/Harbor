/**
 * Formatted Excel report, laid out to match the PDF:
 *
 *   Overview         platform KPIs for the period
 *   Campaign Index   every broadcast side by side, each name links to its sheet
 *   one sheet per broadcast
 *                    title band, KPI tiles, campaign details and funnel side by
 *                    side, message, cost and timing, activity by hour, status /
 *                    failure / suppression breakdowns, by lead owner and state,
 *                    every reply with its text, every recipient
 *   raw data sheets  the flat tables (recipients, replies, conversations,
 *                    messages, agents, applications) for filtering and pivots
 *
 * Real dates (not serial numbers), number formats, frozen headers and filters
 * throughout. Owner SSN and date of birth are never exported.
 */
import ExcelJS from 'exceljs';
import type { BroadcastDetail, Breakdown } from './broadcastDetail.service';

type Cell = string | number | boolean | Date | null | undefined;
type RawRow = Record<string, string | number | boolean | Date | null>;

const NAVY = 'FF1E3A5F';
const INK = 'FF1D2433';
const MUTED = 'FF6B7A90';
const LINE = 'FFE3E7EE';
const PANEL = 'FFF6F8FB';
const HEAD = 'FFF2F4F8';
const GREEN = 'FF0F8A5F';
const RED = 'FFC2362B';
const AMBER = 'FFB7791F';
const SKY = 'FF0284C7';

const DATE_FMT = 'mmm d, yyyy h:mm AM/PM';
const INT_FMT = '#,##0';
const PCT_FMT = '0.0"%"';
const MONEY_FMT = '#,##0.00';

/**
 * Excel has no time zones: a Date is shown as its UTC clock time. Shift every
 * timestamp to Eastern wall-clock time so the workbook reads the same as the
 * PDF and the app (send windows and hourly charts are Eastern too).
 */
const easternParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
function eastern(d: Date): Date {
  const p = Object.fromEntries(easternParts.formatToParts(d).map((x) => [x.type, x.value]));
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second));
}
/** Cell value with dates shifted to Eastern. */
const cv = (v: unknown): ExcelJS.CellValue => (v instanceof Date ? eastern(v) : ((v ?? null) as ExcelJS.CellValue));

const fill = (argb: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const thin = { style: 'thin' as const, color: { argb: LINE } };

/** Writes stacked blocks onto a sheet, tracking the next free row. */
class Writer {
  row = 1;
  constructor(readonly ws: ExcelJS.Worksheet, readonly width: number) {}

  gap(n = 1) {
    this.row += n;
  }

  band(text: string, sub?: string) {
    const ws = this.ws;
    ws.mergeCells(this.row, 1, this.row, this.width);
    const c = ws.getCell(this.row, 1);
    c.value = text;
    c.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
    c.fill = fill(NAVY);
    c.alignment = { vertical: 'middle', indent: 1 };
    ws.getRow(this.row).height = 30;
    this.row += 1;
    if (sub) {
      ws.mergeCells(this.row, 1, this.row, this.width);
      const s = ws.getCell(this.row, 1);
      s.value = sub;
      s.font = { size: 10, color: { argb: MUTED } };
      s.alignment = { indent: 1 };
      this.row += 1;
    }
  }

  heading(text: string, col = 1, span = this.width, atRow = this.row) {
    const ws = this.ws;
    ws.mergeCells(atRow, col, atRow, col + span - 1);
    const c = ws.getCell(atRow, col);
    c.value = text.toUpperCase();
    c.font = { bold: true, size: 10, color: { argb: '4B5568'.padStart(8, 'F') } };
    c.border = { bottom: { style: 'medium', color: { argb: NAVY } } };
    if (atRow === this.row) this.row += 1;
  }

  /** A row of KPI tiles: label above, big value below, each tile `span` columns wide. */
  tiles(items: Array<{ label: string; value: Cell; fmt?: string; color?: string }>, span = 2) {
    const ws = this.ws;
    const labelRow = this.row;
    const valueRow = this.row + 1;
    items.forEach((t, i) => {
      const col = 1 + i * span;
      ws.mergeCells(labelRow, col, labelRow, col + span - 1);
      ws.mergeCells(valueRow, col, valueRow, col + span - 1);
      const l = ws.getCell(labelRow, col);
      l.value = t.label;
      l.font = { size: 9, color: { argb: MUTED } };
      l.fill = fill(PANEL);
      l.alignment = { indent: 1 };
      const v = ws.getCell(valueRow, col);
      v.value = (t.value ?? '—') as ExcelJS.CellValue;
      v.font = { bold: true, size: 15, color: { argb: t.color ?? INK } };
      v.fill = fill(PANEL);
      v.alignment = { indent: 1, horizontal: 'left' };
      if (t.fmt && typeof t.value === 'number') v.numFmt = t.fmt;
      for (let c = col; c < col + span; c += 1) {
        ws.getCell(labelRow, c).border = { top: thin, left: c === col ? thin : undefined, right: c === col + span - 1 ? thin : undefined };
        ws.getCell(valueRow, c).border = { bottom: thin, left: c === col ? thin : undefined, right: c === col + span - 1 ? thin : undefined };
      }
    });
    ws.getRow(valueRow).height = 24;
    this.row += 3;
  }

  /** Key / value pairs starting at `col`; returns the last row used. */
  kv(rows: Array<[string, Cell, string?]>, col = 1, keySpan = 2, valueSpan = 3, startRow = this.row): number {
    const ws = this.ws;
    let r = startRow;
    for (const [k, v, fmt] of rows) {
      ws.mergeCells(r, col, r, col + keySpan - 1);
      ws.mergeCells(r, col + keySpan, r, col + keySpan + valueSpan - 1);
      const kc = ws.getCell(r, col);
      kc.value = k;
      kc.font = { size: 10, color: { argb: MUTED } };
      const vc = ws.getCell(r, col + keySpan);
      vc.value = v == null ? '—' : cv(v);
      vc.font = { size: 10, color: { argb: INK } };
      vc.alignment = { horizontal: 'left', wrapText: true };
      if (v instanceof Date) vc.numFmt = DATE_FMT;
      else if (fmt && typeof v === 'number') vc.numFmt = fmt;
      for (let c = col; c < col + keySpan + valueSpan; c += 1) ws.getCell(r, c).border = { bottom: thin };
      r += 1;
    }
    return r - 1;
  }

  /**
   * A table with a styled header. `bars` names numeric columns that get an
   * in-cell data bar; `fmts` sets number formats by column index.
   */
  table(
    headers: string[],
    rows: Cell[][],
    opts: { col?: number; startRow?: number; bars?: Array<{ index: number; color: string }>; fmts?: Record<number, string>; wrap?: number[]; filter?: boolean } = {},
  ): number {
    const ws = this.ws;
    const col = opts.col ?? 1;
    const start = opts.startRow ?? this.row;
    headers.forEach((h, i) => {
      const c = ws.getCell(start, col + i);
      c.value = h;
      c.font = { bold: true, size: 9, color: { argb: '4B5568'.padStart(8, 'F') } };
      c.fill = fill(HEAD);
      c.border = { bottom: thin };
      c.alignment = { vertical: 'middle', wrapText: true };
    });
    if (rows.length === 0) {
      const c = ws.getCell(start + 1, col);
      c.value = 'None';
      c.font = { italic: true, size: 9, color: { argb: MUTED } };
      return start + 1;
    }
    rows.forEach((r, ri) => {
      r.forEach((v, i) => {
        const c = ws.getCell(start + 1 + ri, col + i);
        c.value = cv(v);
        c.font = { size: 9, color: { argb: INK } };
        c.border = { bottom: thin };
        if (v instanceof Date) c.numFmt = DATE_FMT;
        else if (opts.fmts?.[i] && typeof v === 'number') c.numFmt = opts.fmts[i];
        if (opts.wrap?.includes(i)) c.alignment = { wrapText: true, vertical: 'top' };
        else c.alignment = { vertical: 'top' };
      });
    });
    const end = start + rows.length;
    for (const bar of opts.bars ?? []) {
      const letter = ws.getColumn(col + bar.index).letter;
      ws.addConditionalFormatting({
        ref: `${letter}${start + 1}:${letter}${end}`,
        rules: [
          {
            type: 'dataBar',
            priority: 1,
            minLength: 0,
            maxLength: 100,
            gradient: false,
            cfvo: [{ type: 'num', value: 0 }, { type: 'max' }],
            color: { argb: bar.color },
          } as unknown as ExcelJS.ConditionalFormattingRule,
        ],
      });
    }
    if (opts.filter) {
      ws.autoFilter = { from: { row: start, column: col }, to: { row: end, column: col + headers.length - 1 } };
    }
    return end;
  }
}

const statusColor = (s: string) =>
  s === 'COMPLETED' ? GREEN : s === 'FAILED' || s === 'CANCELLED' ? RED : s === 'PAUSED' || s === 'PENDING_APPROVAL' ? AMBER : SKY;

function sheetNameFor(b: BroadcastDetail, used: Set<string>): string {
  const base = `${String(b.index).padStart(2, '0')} ${b.name}`.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31).trim();
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i += 1) name = `${base.slice(0, 27)} (${i})`;
  used.add(name.toLowerCase());
  return name;
}

function breakdownRows(rows: Breakdown[]): Cell[][] {
  return rows.map((r) => [
    r.label,
    r.recipients,
    r.delivered,
    r.undeliverable,
    r.failed,
    r.replied,
    r.delivered ? Math.round((r.replied / r.delivered) * 1000) / 10 : null,
    r.optedOut,
    r.interested,
  ]);
}

function writeBroadcastSheet(wb: ExcelJS.Workbook, b: BroadcastDetail, name: string) {
  const W = 12;
  const ws = wb.addWorksheet(name, { views: [{ showGridLines: false }], properties: { tabColor: { argb: statusColor(b.status) } } });
  ws.columns = Array.from({ length: W }, () => ({ width: 15 }));
  const w = new Writer(ws, W);
  const f = b.funnel;
  const r = b.rates;

  w.band(`Broadcast ${b.index} · ${b.name}`, `${b.status.replace(/_/g, ' ')} · ${b.campaignKey} · from ${b.fromNumber} · times are US Eastern`);
  const back = ws.getCell(w.row, 1);
  back.value = { text: '← Back to Campaign Index', hyperlink: "#'Campaign Index'!A1" };
  back.font = { size: 9, color: { argb: SKY }, underline: true };
  w.gap(2);

  w.tiles([
    { label: 'Recipients', value: f.recipients, fmt: INT_FMT },
    { label: 'Sent', value: f.sent, fmt: INT_FMT },
    { label: 'Delivered', value: f.delivered, fmt: INT_FMT, color: GREEN },
    { label: 'Undeliverable', value: f.undeliverable, fmt: INT_FMT, color: f.undeliverable ? AMBER : INK },
    { label: 'Failed (not sent)', value: f.failed, fmt: INT_FMT, color: f.failed ? RED : INK },
    { label: 'Replied (people)', value: f.replied, fmt: INT_FMT, color: GREEN },
    { label: 'Opted out', value: f.optedOut, fmt: INT_FMT, color: f.optedOut ? AMBER : INK },
  ]);
  w.tiles([
    { label: 'Delivery rate', value: r.delivery, fmt: PCT_FMT },
    { label: 'Reply rate (of sent)', value: r.reply, fmt: PCT_FMT },
    { label: 'Reply rate (of delivered)', value: r.replyOfDelivered, fmt: PCT_FMT },
    { label: 'Opt-out rate', value: r.optOut, fmt: PCT_FMT },
    { label: 'Interested (of repliers)', value: r.interested, fmt: PCT_FMT },
    { label: `Total cost${b.cost.currency ? ` (${b.cost.currency})` : ''}`, value: b.cost.total, fmt: MONEY_FMT },
  ]);

  // Campaign details (left) and funnel + outcome (right), side by side.
  const top = w.row;
  w.heading('Campaign details', 1, 5, top);
  w.heading('Delivery funnel', 7, 6, top);
  const leftEnd = w.kv(
    [
      ['Created', b.createdAt],
      ['Created by', b.createdBy],
      ['Approved', b.approvedAt],
      ['Approved by', b.approvedBy],
      ['Scheduled for', b.scheduledAt],
      ['Started', b.startedAt],
      ['Finished', b.finishedAt],
      ['Duration (minutes)', b.timing.durationSeconds != null ? Math.round(b.timing.durationSeconds / 60) : null, INT_FMT],
      ['Throttle (msg/sec)', b.throttlePerSecond ?? 'Default'],
      ['Achieved (msg/min)', b.timing.throughputPerMinute],
      ['Lead batch', b.leadBatch],
      ['Follow-up of', b.followUpOf],
      ['Follow-ups sent', b.followUps.join(', ') || null],
    ],
    1,
    2,
    3,
    top + 1,
  );
  const funnelEnd = w.table(
    ['Stage', 'Count', '% of recipients'],
    [
      ['Recipients', f.recipients, 100],
      ['Sent', f.sent, f.recipients ? Math.round((f.sent / f.recipients) * 1000) / 10 : null],
      ['Delivered', f.delivered, f.recipients ? Math.round((f.delivered / f.recipients) * 1000) / 10 : null],
      ['Replied', f.replied, f.recipients ? Math.round((f.replied / f.recipients) * 1000) / 10 : null],
      ['Interested', f.interested, f.recipients ? Math.round((f.interested / f.recipients) * 1000) / 10 : null],
    ],
    { col: 7, startRow: top + 1, bars: [{ index: 1, color: 'FF3B6FD8' }], fmts: { 1: INT_FMT, 2: PCT_FMT } },
  );
  w.heading('Outcome detail', 7, 6, funnelEnd + 2);
  const rightEnd = w.kv(
    [
      ['Suppressed before send', f.suppressed, INT_FMT],
      ['Undeliverable (carrier, incl. expired)', f.undeliverable, INT_FMT],
      ['Failed (rejected / not sent)', f.failed, INT_FMT],
      ['Awaiting delivery report', f.pending, INT_FMT],
      ['Still queued', f.stillQueued, INT_FMT],
      ['Total replies (excl. STOP)', f.totalReplies, INT_FMT],
      ['Interested / not interested', `${f.interested} / ${f.notInterested}`],
    ],
    7,
    3,
    3,
    funnelEnd + 3,
  );
  w.row = Math.max(leftEnd, rightEnd) + 2;

  // Message
  w.heading('Message');
  ws.mergeCells(w.row, 1, w.row, W);
  const m = ws.getCell(w.row, 1);
  m.value = b.body;
  m.font = { size: 11, color: { argb: INK } };
  m.fill = fill(PANEL);
  m.alignment = { wrapText: true, vertical: 'top', indent: 1 };
  m.border = { left: { style: 'thick', color: { argb: NAVY } } };
  ws.getRow(w.row).height = Math.min(160, 18 + Math.ceil((b.body?.length ?? 0) / 150) * 15);
  w.row += 1;
  w.row = w.kv(
    [
      ['Encoding', b.message.encoding],
      ['Length', `${b.message.characters} characters · ${b.message.segmentsPerMessage} segment(s) per message`],
      ['Merge fields', b.message.mergeFields.join(', ') || 'None'],
      ['Non-GSM characters', b.message.unicodeTriggers.join(' ') || 'None'],
      ['Media', b.media.join(', ') || 'None'],
    ],
    1,
    2,
    10,
  ) + 2;

  // Cost (left) and timing (right)
  const ct = w.row;
  w.heading('Cost', 1, 5, ct);
  w.heading('Timing', 7, 6, ct);
  const costEnd = w.kv(
    [
      ['Segments billed', b.cost.segments, INT_FMT],
      ['Total cost (USD)', b.cost.total, MONEY_FMT],
      ['Per message sent', b.cost.perSent, '0.0000'],
      ['Per delivered', b.cost.perDelivered, '0.0000'],
      ['Per replier', b.cost.perReply, MONEY_FMT],
    ],
    1,
    2,
    3,
    ct + 1,
  );
  const timeEnd = w.kv(
    [
      ['First send', b.timing.firstSentAt],
      ['Last send', b.timing.lastSentAt],
      ['Median seconds to deliver', b.timing.deliveryMedianSeconds, INT_FMT],
      ['90th pct seconds to deliver', b.timing.deliveryP90Seconds, INT_FMT],
      ['Median minutes to first reply', b.timing.replyMedianMinutes, INT_FMT],
      ['First reply', b.timing.firstReplyAt],
      ['Last reply', b.timing.lastReplyAt],
    ],
    7,
    3,
    3,
    ct + 1,
  );
  w.row = Math.max(costEnd, timeEnd) + 2;

  // Activity by hour (left) and status of every recipient (right)
  const ah = w.row;
  w.heading('Activity by hour (Eastern)', 1, 5, ah);
  w.heading('Status of every recipient', 7, 6, ah);
  const hourEnd = w.table(
    ['Hour', 'Sent', 'Replies'],
    b.sendsByHour.map((v, h) => [`${String(h).padStart(2, '0')}:00`, v, b.repliesByHour[h]]).filter((x) => (x[1] as number) + (x[2] as number) > 0),
    { col: 1, startRow: ah + 1, bars: [{ index: 1, color: 'FF3B6FD8' }, { index: 2, color: 'FF8B5CF6' }], fmts: { 1: INT_FMT, 2: INT_FMT } },
  );
  let rightRow = w.table(
    ['Status', 'Recipients', '%'],
    b.statusBreakdown.map((s) => [s.label, s.count, f.recipients ? Math.round((s.count / f.recipients) * 1000) / 10 : null]),
    { col: 7, startRow: ah + 1, bars: [{ index: 1, color: 'FF13A06F' }], fmts: { 1: INT_FMT, 2: PCT_FMT } },
  );
  w.heading('Failure reasons', 7, 6, rightRow + 2);
  rightRow = w.table(['Reason', 'Count'], b.failureReasons.map((x) => [x.label, x.count]), { col: 7, startRow: rightRow + 3, bars: [{ index: 1, color: 'FFE5484D' }], fmts: { 1: INT_FMT } });
  w.heading('Suppression reasons', 7, 6, rightRow + 2);
  rightRow = w.table(['Reason', 'Count'], b.suppressionReasons.map((x) => [x.label, x.count]), { col: 7, startRow: rightRow + 3, fmts: { 1: INT_FMT } });
  w.heading('Replies by day', 7, 6, rightRow + 2);
  rightRow = w.table(['Day', 'Replies'], b.repliesByDay.map((x) => [x.label, x.count]), { col: 7, startRow: rightRow + 3, bars: [{ index: 1, color: 'FF8B5CF6' }], fmts: { 1: INT_FMT } });
  w.row = Math.max(hourEnd, rightRow) + 2;

  const bdHeaders = ['', 'Recipients', 'Delivered', 'Undeliverable', 'Failed', 'Replied', 'Reply % (of delivered)', 'Opted out', 'Interested'];
  const bdFmts = { 1: INT_FMT, 2: INT_FMT, 3: INT_FMT, 4: INT_FMT, 5: INT_FMT, 6: PCT_FMT, 7: INT_FMT, 8: INT_FMT };
  w.heading('By lead owner');
  w.row = w.table(bdHeaders, breakdownRows(b.byOwner), { bars: [{ index: 5, color: 'FF0EA5E9' }], fmts: bdFmts }) + 2;
  w.heading('By state');
  w.row = w.table(bdHeaders, breakdownRows(b.byState), { bars: [{ index: 1, color: 'FF94A3B8' }], fmts: bdFmts }) + 2;

  w.heading(`Replies (${b.replies.length}) — full text`);
  w.row =
    w.table(
      ['Received', 'From', 'Contact', 'Company', 'Lead owner', 'STOP', 'Minutes after send', 'Reply text'],
      b.replies.map((x) => [x.receivedAt, x.from, x.contactName, x.company, x.leadOwner, x.isStop ? 'STOP' : '', x.minutesAfterSend, x.text]),
      { fmts: { 6: INT_FMT }, wrap: [7] },
    ) + 2;
  // Reply text is long: let it span the remaining columns visually.
  ws.getColumn(8).width = 60;

  w.heading(`All recipients (${b.recipients.length})`);
  w.table(
    ['Phone', 'Name', 'Company', 'State', 'Lead owner', 'Status', 'Sent', 'Delivered', 'Seconds to deliver', 'Replies', 'Opted out', 'Disposition', 'Error'],
    b.recipients.map((x) => [
      x.phone,
      `${x.firstName ?? ''} ${x.lastName ?? ''}`.trim() || null,
      x.company,
      x.state,
      x.leadOwner,
      x.suppressedReason ? `SUPPRESSED (${x.suppressedReason})` : x.messageStatus ?? x.recipientStatus,
      x.sentAt,
      x.deliveredAt,
      x.deliverySeconds,
      x.replies,
      x.optedOut ? 'Yes' : '',
      x.disposition,
      x.error,
    ]),
    { fmts: { 8: INT_FMT, 9: INT_FMT }, filter: true },
  );
  ws.getColumn(13).width = 30;
}

function writeRawSheet(wb: ExcelJS.Workbook, name: string, rows: RawRow[]) {
  const ws = wb.addWorksheet(name.slice(0, 31), { views: [{ state: 'frozen', ySplit: 1 }] });
  if (rows.length === 0) {
    ws.getCell(1, 1).value = 'No data for this period';
    return;
  }
  const headers = Object.keys(rows[0]);
  ws.columns = headers.map((h) => {
    const sample = rows.slice(0, 200).map((r) => (r[h] instanceof Date ? 18 : String(r[h] ?? '').length));
    return { header: h, key: h, width: Math.min(60, Math.max(h.length + 2, ...sample) + 1) };
  });
  ws.addRows(rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, cv(v)]))));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = fill(NAVY);
  head.height = 20;
  headers.forEach((h, i) => {
    const sampleValue = rows.find((r) => r[h] != null)?.[h];
    if (sampleValue instanceof Date) {
      ws.getColumn(i + 1).numFmt = DATE_FMT;
      ws.getCell(1, i + 1).value = `${h} (ET)`;
    }
    else if (typeof sampleValue === 'number' && /%/.test(h)) ws.getColumn(i + 1).numFmt = PCT_FMT;
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: rows.length + 1, column: headers.length } };
}

export interface ExcelReportInput {
  periodLabel: string;
  generatedAt: Date;
  overview: Array<[string, Cell]>;
  broadcasts: BroadcastDetail[];
  rawSheets: Array<[string, RawRow[]]>;
  notes: string[];
}

export async function renderReportExcel(input: ExcelReportInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Harbor View Capital';
  wb.created = input.generatedAt;

  // Overview
  const ov = wb.addWorksheet('Overview', { views: [{ showGridLines: false }], properties: { tabColor: { argb: NAVY } } });
  ov.columns = [{ width: 40 }, { width: 22 }, { width: 4 }, { width: 40 }, { width: 22 }];
  const ow = new Writer(ov, 5);
  ow.band(
    'Harbor View Capital — Platform Report',
    `${input.periodLabel} · generated ${input.generatedAt.toLocaleString('en-US', { timeZone: 'America/New_York' })} · all times are US Eastern`,
  );
  ow.gap();
  const half = Math.ceil(input.overview.length / 2);
  const ovEnd = Math.max(
    ow.kv(input.overview.slice(0, half).map(([k, v]) => [k, v, typeof v === 'number' && /rate/i.test(k) ? PCT_FMT : INT_FMT]), 1, 1, 1, ow.row),
    ow.kv(input.overview.slice(half).map(([k, v]) => [k, v, typeof v === 'number' && /rate/i.test(k) ? PCT_FMT : INT_FMT]), 4, 1, 1, ow.row),
  );
  ow.row = ovEnd + 2;
  for (const note of input.notes) {
    ov.mergeCells(ow.row, 1, ow.row, 5);
    const c = ov.getCell(ow.row, 1);
    c.value = note;
    c.font = { size: 9, italic: true, color: { argb: MUTED } };
    ow.row += 1;
  }
  ow.gap();
  ov.mergeCells(ow.row, 1, ow.row, 5);
  ov.getCell(ow.row, 1).value =
    'How to read this workbook: "Campaign Index" lists every broadcast — click a name to open its own sheet with every detail. The sheets after the campaigns hold the raw data for filtering.';
  ov.getCell(ow.row, 1).alignment = { wrapText: true };
  ov.getCell(ow.row, 1).font = { size: 10, color: { argb: INK } };
  ov.getRow(ow.row).height = 32;

  // Campaign index + per-broadcast sheets
  const used = new Set(['overview', 'campaign index']);
  const names = input.broadcasts.map((b) => sheetNameFor(b, used));
  if (input.broadcasts.length) {
    const idx = wb.addWorksheet('Campaign Index', { views: [{ state: 'frozen', ySplit: 3, showGridLines: false }], properties: { tabColor: { argb: SKY } } });
    idx.columns = [6, 34, 14, 22, 20, 12, 12, 12, 12, 12, 12, 12, 12, 14].map((width) => ({ width }));
    const iw = new Writer(idx, 14);
    iw.band('Campaign Index', 'Every broadcast in the period. Click a campaign name to open its detailed sheet.');
    const end = iw.table(
      ['#', 'Campaign', 'Status', 'Created', 'Created by', 'Recipients', 'Sent', 'Delivered', 'Delivery %', 'Replied', 'Reply %', 'Opted out', 'Opt-out %', 'Cost (USD)'],
      input.broadcasts.map((b) => [
        b.index,
        b.name,
        b.status,
        b.createdAt,
        b.createdBy,
        b.funnel.recipients,
        b.funnel.sent,
        b.funnel.delivered,
        b.rates.delivery,
        b.funnel.replied,
        b.rates.reply,
        b.funnel.optedOut,
        b.rates.optOut,
        b.cost.total,
      ]),
      {
        bars: [{ index: 8, color: 'FF13A06F' }, { index: 10, color: 'FF0EA5E9' }, { index: 12, color: 'FFE5484D' }],
        fmts: { 5: INT_FMT, 6: INT_FMT, 7: INT_FMT, 8: PCT_FMT, 9: INT_FMT, 10: PCT_FMT, 11: INT_FMT, 12: PCT_FMT, 13: MONEY_FMT },
        filter: true,
      },
    );
    input.broadcasts.forEach((b, i) => {
      const c = idx.getCell(iw.row + 1 + i, 2);
      c.value = { text: b.name, hyperlink: `#'${names[i].replace(/'/g, "''")}'!A1` };
      c.font = { size: 9, color: { argb: SKY }, underline: true };
    });
    void end;
    input.broadcasts.forEach((b, i) => writeBroadcastSheet(wb, b, names[i]));
  }

  // Raw data
  for (const [name, rows] of input.rawSheets) writeRawSheet(wb, `Data · ${name}`, rows);

  return Buffer.from(await wb.xlsx.writeBuffer());
}
