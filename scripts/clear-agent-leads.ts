/**
 * Remove distributed messaging leads from all non-admin Harbor users.
 *
 * Keeps ADMIN / SUPER_ADMIN-owned contacts (if any). Clears lead batches so
 * the next upload starts fresh on Lead Distribution.
 *
 *   DRY_RUN=1 npx ts-node scripts/clear-agent-leads.ts
 *   npx ts-node scripts/clear-agent-leads.ts
 */
import 'dotenv/config';

import prisma from '../src/config/prismaClient';

const PRIVILEGED_ROLES = ['ADMIN', 'SUPER_ADMIN'] as const;
const BATCH = 500;

async function main() {
  const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

  const owners = await prisma.user.findMany({
    where: { role: { notIn: [...PRIVILEGED_ROLES] } },
    select: { id: true, email: true, role: true },
  });
  const ownerIds = owners.map((u) => u.id);

  if (ownerIds.length === 0) {
    console.log('No non-admin users — nothing to clear.');
    return;
  }

  const toDelete = await prisma.messagingContact.findMany({
    where: { ownerUserId: { in: ownerIds } },
    select: { id: true },
  });
  const contactIds = toDelete.map((c) => c.id);

  const batchCount = await prisma.messagingLeadBatch.count();

  console.log(`Non-admin users: ${owners.length}`);
  console.log(`Messaging contacts to remove: ${contactIds.length}`);
  console.log(`Lead batches to remove: ${batchCount}`);

  if (contactIds.length === 0 && batchCount === 0) {
    console.log('Already empty.');
    return;
  }

  if (dryRun) {
    console.log('\nDRY_RUN — no changes written. Unset DRY_RUN to apply.');
    return;
  }

  for (let i = 0; i < contactIds.length; i += BATCH) {
    const slice = contactIds.slice(i, i + BATCH);
    await prisma.$transaction([
      prisma.smsBroadcastRecipient.updateMany({
        where: { contactId: { in: slice } },
        data: { contactId: null },
      }),
      prisma.messagingConversation.updateMany({
        where: { contactId: { in: slice } },
        data: { contactId: null },
      }),
      prisma.messagingContact.deleteMany({
        where: { id: { in: slice } },
      }),
    ]);
    console.log(`Deleted contacts ${Math.min(i + BATCH, contactIds.length)} / ${contactIds.length}`);
  }

  const deletedBatches = await prisma.messagingLeadBatch.deleteMany({});
  console.log(`Removed ${deletedBatches.count} lead batch record(s).`);
  console.log('Done. Re-upload and distribute from Lead Distribution.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
