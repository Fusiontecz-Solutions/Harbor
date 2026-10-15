/**
 * Creates AGENT users for Meridian Financials. Each user gets their own password.
 *
 *   npx ts-node src/scripts/seedMeridianAgents.ts
 *   MERIDIAN_ROTATE_PASSWORDS=1 npx ts-node src/scripts/seedMeridianAgents.ts
 *
 * MERIDIAN_ROTATE_PASSWORDS=1 sets a new unique password on existing listed agents
 * (use after a shared-password seed).
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { createUser } from '../services/userService';
import prisma from '../config/prismaClient';

const SALT_ROUNDS = 10;

const AGENT_EMAILS = [
  'Adam@meridianfinancials.com',
  'Benjamin@meridianfinancials.com',
  'Daniel@meridianfinancials.com',
  'Jonathan@meridianfinancials.com',
  'Eric@meridianfinancials.com',
  'Tom@meridianfinancials.com',
  'Zack@meridianfinancials.com',
  'Paul@meridianfinancials.com',
  'Emanuel@meridianfinancials.com',
];

function namesFromEmail(email: string): { firstName: string; lastName: string } {
  const local = email.split('@')[0] ?? 'Agent';
  const firstName = local.charAt(0).toUpperCase() + local.slice(1).toLowerCase();
  return { firstName, lastName: 'Meridian' };
}

function uniquePassword(email: string): string {
  const local = email.split('@')[0] ?? 'agent';
  const suffix = crypto.randomBytes(8).toString('base64url');
  return `Mf-${local}-${suffix}`;
}

async function main() {
  const rotate = ['1', 'true', 'yes'].includes(String(process.env.MERIDIAN_ROTATE_PASSWORDS ?? '').toLowerCase());

  let created = 0;
  let rotated = 0;
  let skipped = 0;
  const credentials: { email: string; password: string; action: string }[] = [];

  for (const raw of AGENT_EMAILS) {
    const email = raw.trim().toLowerCase();
    const password = uniquePassword(email);
    const existing = await prisma.user.findFirst({ where: { email } });

    if (existing) {
      if (!rotate) {
        console.log(`skip  ${email}  (already exists; set MERIDIAN_ROTATE_PASSWORDS=1 to assign a new password)`);
        skipped += 1;
        continue;
      }
      const hashed = await bcrypt.hash(password, SALT_ROUNDS);
      await prisma.user.update({ where: { id: existing.id }, data: { password: hashed } });
      console.log(`rotate ${email}  userId=${existing.userId}`);
      credentials.push({ email, password, action: 'rotated' });
      rotated += 1;
      continue;
    }

    const { firstName, lastName } = namesFromEmail(email);
    const user = await createUser({
      firstName,
      lastName,
      email,
      password,
      role: 'AGENT',
      isActive: true,
    });
    console.log(`create ${user.email}  userId=${user.userId}`);
    credentials.push({ email, password, action: 'created' });
    created += 1;
  }

  if (credentials.length) {
    console.log('\n--- credentials (share securely; each password is unique) ---');
    for (const { email, password, action } of credentials) {
      console.log(`${email}\t${password}\t(${action})`);
    }
  }

  console.log(`\nDone: ${created} created, ${rotated} passwords rotated, ${skipped} skipped.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
