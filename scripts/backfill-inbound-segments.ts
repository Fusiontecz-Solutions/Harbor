/**
 * Backfill segmentCount on inbound messages saved before the inbound webhook
 * stored Infobip's `smsCount`.
 *
 *   npx ts-node --transpile-only scripts/backfill-inbound-segments.ts [--apply]
 *
 * DRY RUN BY DEFAULT: reads only, prints what would change. `--apply` writes.
 * Idempotent: only rows with a null segmentCount are touched.
 *
 * The count is computed from the stored body with the same GSM-7 / UCS-2 rules
 * the provider uses (smsSegments.ts). Media-only messages count as 1.
 */
import 'dotenv/config';

import prisma from '../src/config/prismaClient';
import { analyzeSmsText } from '../src/services/messaging/smsSegments';

const APPLY = process.argv.slice(2).includes('--apply');
const BATCH = 500;

async function main() {
  let cursor: string | undefined;
  let scanned = 0;
  let multi = 0;
  const bySegments = new Map<number, number>();

  for (;;) {
    const rows = await prisma.messagingMessage.findMany({
      where: { direction: 'INBOUND', segmentCount: null },
      select: { id: true, body: true },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    const groups = new Map<number, string[]>();
    for (const r of rows) {
      const segments = Math.max(1, analyzeSmsText(r.body ?? '').segments);
      groups.set(segments, [...(groups.get(segments) ?? []), r.id]);
      bySegments.set(segments, (bySegments.get(segments) ?? 0) + 1);
      if (segments > 1) multi += 1;
    }
    scanned += rows.length;

    if (APPLY) {
      for (const [segments, ids] of groups) {
        await prisma.messagingMessage.updateMany({ where: { id: { in: ids } }, data: { segmentCount: segments } });
      }
    }
  }

  console.log(`${APPLY ? 'Updated' : 'Would update'} ${scanned} inbound messages (${multi} with more than one segment).`);
  for (const [segments, n] of [...bySegments].sort((a, b) => a[0] - b[0])) console.log(`  ${segments} segment(s): ${n}`);
  if (!APPLY && scanned > 0) console.log('Dry run. Re-run with --apply to write.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
