/**
 * Browser side of Harbor's Web Push: registers /push-sw.js, asks permission,
 * subscribes with the server's VAPID key and keeps the server's copy of the
 * subscription in sync. Notifications then arrive even with Harbor closed.
 *
 * iPhone/iPad: Safari only delivers web push to a site added to the Home
 * Screen (iOS 16.4+); in a normal tab `isPushSupported()` is false there.
 */
import {
    deletePushSubscription,
    fetchPushConfig,
    savePushSubscription,
} from '@/services/messaging/messagingApi';

export type PushState = 'unsupported' | 'unavailable' | 'denied' | 'off' | 'on';

const SW_URL = '/push-sw.js';

export function isPushSupported(): boolean {
    return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function registration(): Promise<ServiceWorkerRegistration> {
    const existing = await navigator.serviceWorker.getRegistration(SW_URL);
    return existing ?? navigator.serviceWorker.register(SW_URL);
}

/** Current state, without prompting the user. */
export async function getPushState(): Promise<PushState> {
    if (!isPushSupported()) return 'unsupported';
    const config = await fetchPushConfig().catch(() => null);
    if (!config?.enabled) return 'unavailable';
    if (Notification.permission === 'denied') return 'denied';
    const reg = await navigator.serviceWorker.getRegistration(SW_URL);
    const sub = await reg?.pushManager.getSubscription();
    return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

/** Ask permission (must run from a click) and subscribe this browser. */
export async function enablePush(): Promise<PushState> {
    if (!isPushSupported()) return 'unsupported';
    const config = await fetchPushConfig();
    if (!config.enabled || !config.publicKey) return 'unavailable';
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';

    const reg = await registration();
    await navigator.serviceWorker.ready;
    const key = urlBase64ToUint8Array(config.publicKey);
    let sub = await reg.pushManager.getSubscription();
    // A subscription made with a different server key cannot be used; replace it.
    const existingKey = sub?.options?.applicationServerKey;
    if (sub && existingKey && new Uint8Array(existingKey).toString() !== key.toString()) {
        await sub.unsubscribe();
        sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource });
    await savePushSubscription(sub.toJSON());
    return 'on';
}

export async function disablePush(): Promise<PushState> {
    if (!isPushSupported()) return 'unsupported';
    const reg = await navigator.serviceWorker.getRegistration(SW_URL);
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
        await deletePushSubscription(sub.endpoint).catch(() => undefined);
        await sub.unsubscribe().catch(() => undefined);
    }
    return 'off';
}

/**
 * Re-send this browser's subscription after login, so a device keeps working
 * if the server lost it or another user signed in on the same browser.
 */
export async function syncPushSubscription(): Promise<void> {
    if (!isPushSupported() || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker.getRegistration(SW_URL);
    const sub = await reg?.pushManager.getSubscription();
    if (sub) await savePushSubscription(sub.toJSON()).catch(() => undefined);
}
