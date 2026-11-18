/**
 * Registers sending numbers and assigns one per Meridian AGENT (by seed email order).
 *
 *   npx ts-node src/scripts/assignMeridianSenderNumbers.ts
 *
 * Override pairing with MERIDIAN_SENDER_MAP=email:+1...,email:+1... (semicolon-separated).
 */
import prisma from '../config/prismaClient';
import { assignSenderToUser, upsertSender } from '../services/messaging/sender.service';

/** Same order as seedMeridianAgents.ts — one number per agent from the ops list. */
const DEFAULT_ASSIGNMENTS: { email: string; phone: string }[] = [
  { email: 'adam@meridianfinancials.com', phone: '19349437180' },
  { email: 'benjamin@meridianfinancials.com', phone: '18388839141' },
  { email: 'daniel@meridianfinancials.com', phone: '19349437963' },
  { email: 'jonathan@meridianfinancials.com', phone: '13214048285' },
  { email: 'eric@meridianfinancials.com', phone: '18585643242' },
  { email: 'tom@meridianfinancials.com', phone: '14423219847' },
  { email: 'zack@meridianfinancials.com', phone: '13502019623' },
  { email: 'paul@meridianfinancials.com', phone: '13214048314' },
  { email: 'emanuel@meridianfinancials.com', phone: '19176151235' },
];

function parseEnvMap(): { email: string; phone: string }[] | null {
  const raw = process.env.MERIDIAN_SENDER_MAP?.trim();
  if (!raw) return null;
  return raw.split(';').map((pair) => {
    const [email, phone] = pair.split(',').map((s) => s.trim());
    if (!email || !phone) throw new Error(`Invalid MERIDIAN_SENDER_MAP segment: "${pair}"`);
    return { email: email.toLowerCase(), phone };
  });
}

async function main() {
  const assignments = parseEnvMap() ?? DEFAULT_ASSIGNMENTS;

  for (const { email, phone } of assignments) {
    const user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' }, role: 'AGENT', isActive: true },
    });
    if (!user) {
      console.warn(`skip  ${email}  (no active AGENT user)`);
      continue;
    }

    const label = [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || email;
    const sender = await upsertSender({ phoneNumber: phone, label, isActive: true });
    const updated = await assignSenderToUser(user.id, sender.id);
    console.log(
      `assign ${updated.email}  ->  ${updated.messagingSender?.phoneNumber}  (${updated.messagingSender?.label})`,
    );
  }

  console.log('\nDone.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
