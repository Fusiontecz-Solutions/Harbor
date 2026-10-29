/**
 * Backfill SMS delivery status, cost and derived counters.
 *
 *   npx ts-node --transpile-only scripts/backfill-sms-status.ts [--xlsx <export.xlsx>] [--no-infobip] [--apply]
 *
 * DRY RUN BY DEFAULT: reads only, prints what would change. `--apply` writes.
 * Idempotent: a second run finds nothing left to change.
 *
 *  (a) Final statuses for outbound rows still SENT/QUEUED, from
 *      - Infobip GET /sms/3/logs (only ~48h of history is kept there), and
 *      - optionally an Infobip portal export (.xlsx; "Message Id", "Status",
 *        "Messages Count", "Total Cost" in USD).
 *      Mapping: Delivered→DELIVERED, Undeliverable/Expired→UNDELIVERABLE,
 *      Rejected→FAILED, Pending stays SENT. Forward-only (smsMetrics), and
 *      never invented: a row with no provider answer is left as it is.
 *      Writes go through applyProviderStatus — the same function the webhook
 *      and the reconciler use — so recipients are mirrored identically.
 *  (b) Segments / per-segment price where null, total cost (costAmount =
 *      price × segments) and costUsd (exact from the export, else converted
 *      with INFOBIP_<CUR>_PER_USD when set).
 *  (c) Recipient rows behind their message's status are mirrored; every
 *      broadcast's counters are recomputed from rows; every conversation's
 *      messageCount / hasInboundReply is recounted (unreadCount untouched).
 *  (d) Prints a summary of every change by category.
 */
import 'dotenv/config';
import * as path from 'path';
import * as XLSX from 'xlsx';

import prisma from '../src/config/prismaClient';
import { applyProviderStatus, planStatusUpdate, type ProviderStatusReport, type StoredMessageForStatus } from '../src/services/messaging/deliveryStatus.service';
import { computeBroadcastCounters, countersFromRows, recomputeBroadcastCounters } from '../src/services/messaging/broadcastCounters';
import { fetchMessageLogs, isInfobipConfigured } from '../src/services/messaging/infobip.service';
import { mapProviderStatus, outboundBucket, STATUS_RANK } from '../src/services/messaging/smsMetrics';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const USE_INFOBIP = !args.includes('--no-infobip');
const xlsxIdx = args.indexOf('--xlsx');
const XLSX_PATH = xlsxIdx >= 0 ? args[xlsxIdx + 1] : null;
const PAGE = 5_000;

const summary = new Map<string, number>();
const bump = (k: string, n = 1) => summary.set(k, (summary.get(k) ?? 0) + n);
const log = (...a: unknown[]) => console.log('[backfill-sms]', ...a);

interface ExportRow {
  status: ReturnType<typeof mapProviderStatus>;
  rawStatus: string;
  reason: string | null;
  segments: number | null;
  totalCostUsd: number | null;
}

/** Read the portal export. Untrusted data: only typed, named columns are used. */
function loadExport(file: string): Map<string, ExportRow> {
  const wb = XLSX.readFile(path.resolve(file));
  const out = new Map<string, ExportRow>();
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[name], { defval: null });
    for (const r of rows) {
      if (String(r['Service Name'] ?? '') && !/outbound/i.test(String(r['Service Name']))) continue;
      const id = String(r['Message Id'] ?? '').trim();
      if (!/^[\w-]{8,64}$/.test(id)) continue;
      const seg = Number(r['Messages Count']);
      const cost = Number(r['Total Cost']);
      out.set(id, {
        status: mapProviderStatus(String(r['Status'] ?? '')),
        rawStatus: String(r['Status'] ?? ''),
        reason: r['Reason'] != null ? String(r['Reason']).slice(0, 200) : null,
        segments: Number.isInteger(seg) && seg > 0 && seg < 50 ? seg : null,
        totalCostUsd: Number.isFinite(cost) && cost >= 0 && cost < 100 ? cost : null,
      });
    }
  }
  return out;
}

type Msg = StoredMessageForStatus & { providerMessageId: string | null };

/** True once `prisma db push` has added the new cost / polling columns. */
async function hasNewColumns(): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT COUNT(*)::int AS n FROM information_schema.columns
     WHERE table_name = 'MessagingMessage' AND column_name IN ('costAmount', 'costUsd')`;
  return Number(rows[0]?.n ?? 0) === 2;
}

async function loadOutbound(withCostColumns: boolean): Promise<Msg[]> {
  const out: Msg[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page: Msg[] = await prisma.messagingMessage.findMany({
      where: { direction: 'OUTBOUND', providerMessageId: { not: null } },
      orderBy: { id: 'asc' },
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        providerMessageId: true,
        conversationId: true,
        broadcastId: true,
        status: true,
        segmentCount: true,
        priceAmount: true,
        priceCurrency: true,
        // Before the schema push these columns do not exist yet: read them as null.
        ...(withCostColumns ? { costAmount: true, costUsd: true } : {}),
      },
    }) as Msg[];
    if (!withCostColumns) for (const m of page) Object.assign(m, { costAmount: null, costUsd: null });
    out.push(...page);
    if (page.length < PAGE) break;
    cursor = page[page.length - 1].id;
  }
  return out;
}

const rank = (s: string | null | undefined) => STATUS_RANK[String(s)] ?? 0;

async function main() {
  log(APPLY ? 'APPLY mode — writing changes' : 'DRY RUN — no writes (pass --apply to write)');
  if (!APPLY) log('INFOBIP_BDT_PER_USD =', process.env.INFOBIP_BDT_PER_USD ?? '(unset: BDT rows get no converted USD)');

  const exported = XLSX_PATH ? loadExport(XLSX_PATH) : new Map<string, ExportRow>();
  if (XLSX_PATH) log(`export rows (outbound): ${exported.size}`);

  const withCostColumns = await hasNewColumns();
  if (!withCostColumns) {
    log('schema not pushed yet (no costAmount/costUsd columns) — cost fields are projected as if empty');
    if (APPLY) throw new Error('Run `prisma db push` for the new MessagingMessage/MessagingConversation columns before --apply');
  }
  const messages = await loadOutbound(withCostColumns);
  log(`outbound messages with a provider id: ${messages.length}`);

  // (a) Provider logs for rows still in flight.
  const inFlight = messages.filter((m) => m.status === 'SENT' || m.status === 'QUEUED');
  const logs = new Map<string, Awaited<ReturnType<typeof fetchMessageLogs>>[number]>();
  if (USE_INFOBIP && isInfobipConfigured() && inFlight.length) {
    const ids = inFlight.map((m) => m.providerMessageId as string);
    for (let i = 0; i < ids.length; i += 500) {
      const res = await fetchMessageLogs(ids.slice(i, i + 500));
      for (const r of res) logs.set(r.providerMessageId, r);
    }
    log(`Infobip logs: asked ${inFlight.length}, answered ${logs.size}`);
  }
  bump('source:infobip-logs-answered', logs.size);

  // Merge sources into one report per message, then plan (pure) and apply.
  const projected = new Map<string, string>(); // providerMessageId → resulting status
  let written = 0;
  for (const m of messages) {
    const pid = m.providerMessageId as string;
    const lg = logs.get(pid);
    const ex = exported.get(pid);
    if (ex) bump('source:export-matched');

    const candidates = [lg?.status, ex?.status].filter((s): s is NonNullable<typeof s> => Boolean(s));
    // Most final provider answer wins; never below what we already have.
    const best = candidates.sort((a, b) => rank(b) - rank(a))[0];
    const status = (best && rank(best) > rank(m.status) ? best : m.status) as ProviderStatusReport['status'];
    if (best === 'SENT' && m.status === 'SENT') bump('status:still-pending-at-provider');

    const report: ProviderStatusReport = {
      providerMessageId: pid,
      status,
      errorCode: lg?.errorCode ?? null,
      errorMessage: lg?.errorMessage ?? (ex && ex.status !== 'DELIVERED' && ex.status !== 'SENT' ? ex.reason : null),
      doneAt: lg?.doneAt ?? null,
      doneAtFallbackNow: false,
      segmentCount: lg?.segmentCount ?? ex?.segments ?? null,
      priceAmount: lg?.priceAmount ?? null,
      priceCurrency: lg?.priceCurrency ?? null,
      costUsd: ex?.totalCostUsd ?? null,
    };

    const plan = planStatusUpdate(m, report);
    projected.set(pid, plan.transition.to);
    for (const c of plan.categories) bump(c);
    if (Object.keys(plan.data).length === 0) continue;
    bump('messages:to-update');

    if (APPLY) {
      await applyProviderStatus(report, { message: m });
      written += 1;
      if (written % 500 === 0) log(`…${written} message rows written`);
    }
  }

  // (c1) Recipient rows behind their message status (the old reconciler never
  // mirrored). Projected in memory so the dry run shows the post-apply result.
  const recipients = await prisma.smsBroadcastRecipient.findMany({
    select: { id: true, broadcastId: true, providerMessageId: true, status: true, suppressedReason: true },
  });
  const recipientStatus = new Map<string, string>();
  const toMirror: Array<{ id: string; status: string }> = [];
  for (const r of recipients) {
    let s: string = r.status;
    const msgStatus = r.providerMessageId ? projected.get(r.providerMessageId) : undefined;
    if (!r.suppressedReason && msgStatus && rank(msgStatus) > rank(r.status)) {
      s = msgStatus;
      toMirror.push({ id: r.id, status: s });
      bump(`recipient:${r.status}->${s}`);
    }
    recipientStatus.set(r.id, s);
  }
  if (APPLY && toMirror.length) {
    const byStatus = new Map<string, string[]>();
    for (const r of toMirror) byStatus.set(r.status, [...(byStatus.get(r.status) ?? []), r.id]);
    for (const [status, ids] of byStatus) {
      for (let i = 0; i < ids.length; i += 1000) {
        await prisma.smsBroadcastRecipient.updateMany({
          where: { id: { in: ids.slice(i, i + 1000) }, suppressedReason: null },
          data: { status: status as never },
        });
      }
    }
    log(`mirrored ${toMirror.length} recipient rows`);
  }

  // (c2) Broadcast counters, recomputed from rows.
  const broadcasts = await prisma.smsBroadcast.findMany({
    select: {
      id: true,
      name: true,
      queuedCount: true,
      sentCount: true,
      deliveredCount: true,
      undeliverableCount: true,
      failedCount: true,
      suppressedCount: true,
      repliedCount: true,
      optOutCount: true,
    },
  });
  const recipientsByBroadcast = new Map<string, typeof recipients>();
  for (const r of recipients) recipientsByBroadcast.set(r.broadcastId, [...(recipientsByBroadcast.get(r.broadcastId) ?? []), r]);

  let broadcastsChanged = 0;
  for (const b of broadcasts) {
    let next;
    if (APPLY) {
      next = await recomputeBroadcastCounters(b.id);
    } else {
      // Project: same buckets as computeBroadcastCounters, with mirrored statuses.
      const live = await computeBroadcastCounters(b.id); // replies are unaffected by this script
      const rows = { queued: 0, suppressed: 0, sent: 0, delivered: 0, undeliverable: 0, pending: 0, failed: 0 };
      for (const r of recipientsByBroadcast.get(b.id) ?? []) {
        const bucket = outboundBucket({
          status: recipientStatus.get(r.id),
          hasProviderId: Boolean(r.providerMessageId),
          suppressed: Boolean(r.suppressedReason),
        });
        if (bucket === 'pending') rows.sent += 1;
        if (bucket === 'delivered' || bucket === 'undeliverable') rows.sent += 1;
        rows[bucket] += 1;
      }
      next = countersFromRows(rows, { repliers: live.repliedCount, optOuts: live.optOutCount });
    }
    if (!next) continue;
    let changed = false;
    for (const f of ['queuedCount', 'sentCount', 'deliveredCount', 'undeliverableCount', 'failedCount', 'suppressedCount', 'repliedCount', 'optOutCount'] as const) {
      const delta = next[f] - b[f];
      if (delta !== 0) {
        changed = true;
        bump(`broadcast.${f}:${delta > 0 ? 'up' : 'down'}`, Math.abs(delta));
      }
    }
    if (changed) broadcastsChanged += 1;
  }
  bump('broadcasts:counters-changed', broadcastsChanged);

  // (c3) Conversation messageCount / hasInboundReply drift.
  const convDrift = await prisma.$queryRaw<Array<{ id: string; stored: number; actual: number; reply_stored: boolean; reply_actual: boolean }>>`
    SELECT c.id, c."messageCount" AS stored, COALESCE(x.n, 0)::int AS actual,
           c."hasInboundReply" AS reply_stored, COALESCE(x.inbound, 0) > 0 AS reply_actual
      FROM "MessagingConversation" c
      LEFT JOIN (
        SELECT "conversationId", COUNT(*) FILTER (WHERE status NOT IN ('QUEUED','SENDING'))::int AS n,
               COUNT(*) FILTER (WHERE direction = 'INBOUND')::int AS inbound
          FROM "MessagingMessage" GROUP BY 1
      ) x ON x."conversationId" = c.id
     WHERE c."messageCount" <> COALESCE(x.n, 0) OR c."hasInboundReply" <> (COALESCE(x.inbound, 0) > 0)`;
  bump('conversation:messageCount-drift', convDrift.filter((c) => c.stored !== c.actual).length);
  bump('conversation:messageCount-abs-delta', convDrift.reduce((n, c) => n + Math.abs(c.actual - c.stored), 0));
  bump('conversation:hasInboundReply-drift', convDrift.filter((c) => c.reply_stored !== c.reply_actual).length);
  if (APPLY) {
    for (const c of convDrift) {
      await prisma.messagingConversation.update({
        where: { id: c.id },
        data: { messageCount: c.actual, hasInboundReply: c.reply_actual },
      });
    }
  }

  // Cost reconciliation figure.
  const usd = messages.reduce((n, m) => {
    const ex = exported.get(m.providerMessageId as string);
    return n + (ex?.totalCostUsd ?? (m.costUsd != null ? Number(m.costUsd) : 0));
  }, 0);
  log(`projected outbound USD cost (export where matched, else stored costUsd): $${usd.toFixed(2)}`);

  console.log('\n==== backfill-sms-status summary ' + (APPLY ? '(APPLIED)' : '(DRY RUN)') + ' ====');
  for (const [k, v] of [...summary.entries()].sort()) console.log(`${k.padEnd(48)} ${v}`);
}

main()
  .catch((err) => {
    console.error('[backfill-sms] failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    // Pools / timers from imported modules must not keep the script alive.
    setTimeout(() => process.exit(process.exitCode ?? 0), 200).unref();
  });
