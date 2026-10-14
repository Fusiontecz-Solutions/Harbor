/**
 * Web Push for new inbound messages.
 *
 * A browser subscribes once (service worker + VAPID public key) and stores its
 * endpoint here. When a message arrives, every subscription whose user can see
 * that conversation in their inbox gets a notification — even with the Harbor
 * tab closed. Who may see a conversation is decided by the same rule the inbox
 * uses (visibleSendersForUser), so nobody is notified about a thread they could
 * not open.
 *
 * Configure with VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT
 * (a mailto: or https: URL). Without them push is simply disabled.
 */
import webpush from 'web-push';
import prisma from '../../config/prismaClient';
import { visibleSendersForUser } from './sender.service';
import { normalizePhoneNumber, normalizeSender } from './phone';

const publicKey = () => String(process.env.VAPID_PUBLIC_KEY ?? '').trim();
const privateKey = () => String(process.env.VAPID_PRIVATE_KEY ?? '').trim();
const subject = () => String(process.env.VAPID_SUBJECT ?? 'mailto:support@harborviewcapitals.com').trim();

let configured: boolean | null = null;

export function isPushConfigured(): boolean {
  if (configured !== null) return configured;
  if (!publicKey() || !privateKey()) {
    configured = false;
    return false;
  }
  try {
    webpush.setVapidDetails(subject(), publicKey(), privateKey());
    configured = true;
  } catch (err) {
    console.error('[messaging:push] invalid VAPID configuration:', (err as Error)?.message);
    configured = false;
  }
  return configured;
}

export function getPushPublicKey(): string | null {
  return isPushConfigured() ? publicKey() : null;
}

export interface BrowserSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function parseSubscription(raw: unknown): BrowserSubscription | null {
  const s = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  const endpoint = String(s?.endpoint ?? '').trim();
  const p256dh = String(s?.keys?.p256dh ?? '').trim();
  const auth = String(s?.keys?.auth ?? '').trim();
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) return null;
  return { endpoint, keys: { p256dh, auth } };
}

/** Upsert by endpoint: a device re-subscribing (or changing user) moves with it. */
export async function saveSubscription(userId: string, sub: BrowserSubscription, userAgent?: string | null) {
  await prisma.pushSubscription.upsert({
    where: { endpoint: sub.endpoint },
    create: { userId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent: userAgent ?? null },
    update: { userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent: userAgent ?? null },
  });
}

export async function removeSubscription(endpoint: string, userId?: string) {
  await prisma.pushSubscription.deleteMany({ where: { endpoint, ...(userId ? { userId } : {}) } });
}

export interface PushPayload {
  title: string;
  body: string;
  /** Where clicking the notification goes. */
  url: string;
  /** Notifications with the same tag replace each other (one per thread). */
  tag?: string;
}

/** Send to a set of subscriptions; drop the ones the push service says are gone. */
async function deliver(subs: Array<{ id: string; endpoint: string; p256dh: string; auth: string }>, payload: PushPayload): Promise<number> {
  if (!isPushConfigured() || subs.length === 0) return 0;
  const body = JSON.stringify(payload);
  let sent = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 60 * 60, urgency: 'high' });
        sent += 1;
        await prisma.pushSubscription.update({ where: { id: s.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
      } catch (err) {
        const status = (err as { statusCode?: number })?.statusCode;
        if (status === 404 || status === 410) {
          // The user revoked permission or the browser dropped the endpoint.
          await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => undefined);
        } else {
          console.warn('[messaging:push] send failed:', status ?? '', (err as Error)?.message);
        }
      }
    }),
  );
  return sent;
}

export async function sendTestPush(userId: string): Promise<number> {
  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  return deliver(subs, {
    title: 'Harbor notifications are on',
    body: 'You will be notified here when a contact replies.',
    url: '/inbox',
    tag: 'harbor-test',
  });
}

/**
 * Notify everyone who can see this conversation that a message arrived.
 * Fire-and-forget from the inbound webhook: never throws.
 */
export async function notifyInboundMessage(input: {
  conversationId: string;
  businessNumber: string;
  contactNumber: string;
  text: string | null;
  isStop: boolean;
  hasMedia: boolean;
}): Promise<void> {
  try {
    if (!isPushConfigured()) return;
    const subs = await prisma.pushSubscription.findMany();
    if (subs.length === 0) return;

    const business = normalizeSender(input.businessNumber);
    const userIds = [...new Set(subs.map((s) => s.userId))];
    const users = await prisma.user.findMany({
      where: { id: { in: userIds }, isActive: true },
      select: { id: true, role: true },
    });
    const allowed = new Set<string>();
    for (const u of users) {
      const senders = await visibleSendersForUser(u.id, u.role);
      if (senders === null || senders.map((n) => normalizeSender(n)).includes(business)) allowed.add(u.id);
    }
    const targets = subs.filter((s) => allowed.has(s.userId));
    if (targets.length === 0) return;

    const contact = normalizePhoneNumber(input.contactNumber) ?? input.contactNumber;
    const conversation = await prisma.messagingConversation.findUnique({
      where: { id: input.conversationId },
      select: { contact: { select: { firstName: true, lastName: true, company: true } } },
    });
    const c = conversation?.contact;
    const name = [c?.firstName, c?.lastName].filter(Boolean).join(' ').trim() || c?.company || formatPhone(contact);

    const text = (input.text ?? '').trim();
    const body = input.isStop
      ? 'Opted out (replied STOP)'
      : text
        ? text.length > 180
          ? `${text.slice(0, 177)}…`
          : text
        : input.hasMedia
          ? 'Sent an attachment'
          : 'New message';

    await deliver(targets, {
      title: name,
      body,
      url: `/inbox?conversation=${encodeURIComponent(input.conversationId)}`,
      tag: `conversation-${input.conversationId}`,
    });
  } catch (err) {
    console.error('[messaging:push] notify failed:', (err as Error)?.message);
  }
}

function formatPhone(value: string): string {
  const d = value.replace(/\D/g, '');
  return d.length === 11 && d.startsWith('1') ? `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}` : value;
}
