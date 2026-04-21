self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'Homelab', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'Homelab Dashboard';
  const options = {
    body: data.body || '',
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    tag:  data.tag || 'homelab',
    data: { url: data.url || '/' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      try {
        const u = new URL(c.url);
        if (u.pathname === target || u.pathname === '/' || u.pathname === '/index.html') {
          await c.focus();
          return;
        }
      } catch {}
    }
    await self.clients.openWindow(target);
  })());
});
