/**
 * Repairs campaign reply attribution.
 *
 * Inbound replies were recorded with a null `broadcastId` because the webhook
 * looked up the campaign using Infobip's raw MO numbers ("19176151235") while
 * every stored number is normalized ("+19176151235"), so the lookup never
 * matched. Campaign reply counts therefore read zero no matter how many people
 * answered, and follow-ups could not tell a responder from a silent lead.
 *
 * The webhook is fixed going forward; this repairs what was already recorded.
 *
 * Two passes:
 *   1. Attribute each unattributed inbound message to the campaign whose
 *      message it is answering — the most recent broadcast message sent to
 *      that number, from the same sender, before the reply arrived.
 *   2. Recompute every campaign's repliedCount and optOutCount from the
 *      attributed messages, rather than trusting counters that drifted.
 *
 * Safe to re-run: pass 1 only fills nulls, and pass 2 derives counters from
 * data rather than incrementing them.
 *
 *   npx tsx src/scripts/backfillBroadcastReplies.ts          # report only
 *   npx tsx src/scripts/backfillBroadcastReplies.ts --apply  # write
 */
import prisma from '../config/prismaClient';

/** Matches the webhook's inference window. */
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  console.log(apply ? 'Mode: APPLY (writes)' : 'Mode: dry run (no writes) — pass --apply to write\n');

  /* ---- Pass 1: attribute replies to the campaign they answer ---- */

  const orphans = await prisma.messagingMessage.findMany({
    where: { direction: 'INBOUND', broadcastId: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true, fromNumber: true, toNumber: true, createdAt: true, isStopKeyword: true },
  });

  console.log(`Unattributed inbound messages: ${orphans.length}`);

  let matched = 0;
  /** What pass 1 would add per campaign: [replies, opt-outs]. */
  const perCampaign = new Map<string, { replied: number; optOut: number }>();

  for (const reply of orphans) {
    const source = await prisma.messagingMessage.findFirst({
      where: {
        direction: 'OUTBOUND',
        broadcastId: { not: null },
        toNumber: reply.fromNumber,
        fromNumber: reply.toNumber,
        // Anchored to when the reply arrived, not to now, so a reply is matched
        // against the campaign that was actually in flight at the time.
        createdAt: {
          lte: reply.createdAt,
          gte: new Date(reply.createdAt.getTime() - THIRTY_DAYS_MS),
        },
      },
      orderBy: { createdAt: 'desc' },
      select: { broadcastId: true },
    });

    if (!source?.broadcastId) continue;

    matched += 1;
    const pending = perCampaign.get(source.broadcastId) ?? { replied: 0, optOut: 0 };
    pending.replied += 1;
    if (reply.isStopKeyword) pending.optOut += 1;
    perCampaign.set(source.broadcastId, pending);

    if (apply) {
      await prisma.messagingMessage.update({
        where: { id: reply.id },
        data: { broadcastId: source.broadcastId },
      });
    }
  }

  console.log(`  attributable: ${matched}`);
  console.log(`  no matching campaign message: ${orphans.length - matched}\n`);

  /* ---- Pass 2: recompute counters from the attributed messages ---- */

  const campaigns = await prisma.smsBroadcast.findMany({
    select: { id: true, name: true, repliedCount: true, optOutCount: true },
    orderBy: { createdAt: 'desc' },
  });

  console.log('Campaign counters:');
  for (const campaign of campaigns) {
    // In a dry run the attribution above has not been written, so fold in what
    // pass 1 would have added to show the real end state.
    const [replied, optOut] = await Promise.all([
      prisma.messagingMessage.count({ where: { broadcastId: campaign.id, direction: 'INBOUND' } }),
      prisma.messagingMessage.count({
        where: { broadcastId: campaign.id, direction: 'INBOUND', isStopKeyword: true },
      }),
    ]);
    const pending = apply ? { replied: 0, optOut: 0 } : (perCampaign.get(campaign.id) ?? { replied: 0, optOut: 0 });
    const trueReplied = replied + pending.replied;
    const trueOptOut = optOut + pending.optOut;

    if (trueReplied === campaign.repliedCount && trueOptOut === campaign.optOutCount) continue;

    console.log(
      `  ${campaign.name.padEnd(24)} replied ${campaign.repliedCount} -> ${trueReplied}` +
        `   optOut ${campaign.optOutCount} -> ${trueOptOut}`,
    );

    if (apply) {
      await prisma.smsBroadcast.update({
        where: { id: campaign.id },
        data: { repliedCount: trueReplied, optOutCount: trueOptOut },
      });
    }
  }

  if (!apply) console.log('\nNothing written. Re-run with --apply.');
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('Backfill failed:', (err as Error)?.message);
  await prisma.$disconnect();
  process.exit(1);
});
