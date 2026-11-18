/* Harbor push service worker: shows a notification for each new message and
 * opens the conversation when it is clicked. Kept deliberately small — it does
 * no caching, so it can never serve a stale app. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch {
        data = { title: 'New message', body: event.data ? event.data.text() : '' };
    }
    const title = data.title || 'New message';
    event.waitUntil(
        self.registration.showNotification(title, {
            body: data.body || '',
            tag: data.tag || undefined,
            // A new message in the same thread replaces the old one but still alerts.
            renotify: Boolean(data.tag),
            icon: '/harbor_logo.png',
            badge: '/harbor_logo.png',
            data: { url: data.url || '/inbox' },
        }),
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const target = new URL(event.notification.data?.url || '/inbox', self.location.origin).href;
    event.waitUntil(
        (async () => {
            const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
            for (const client of windows) {
                if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
                    await client.focus();
                    if ('navigate' in client) await client.navigate(target);
                    return;
                }
            }
            await self.clients.openWindow(target);
        })(),
    );
});
