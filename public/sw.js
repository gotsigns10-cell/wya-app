// WYA Service Worker — offline support + fast load + push notifications
const CACHE = 'wya-v3';
const OFFLINE_URLS = ['/', '/vendor', '/customer', '/plans', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(OFFLINE_URLS))
      .then(() => self.skipWaiting())
      .catch(err => { console.warn('[SW] Cache addAll failed:', err); self.skipWaiting(); })
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Let the browser handle page navigation directly — no stale cached HTML
  if (e.request.destination === 'document' || e.request.mode === 'navigate') return;
  // API calls: network only, no cache
  if (e.request.url.includes('/api/')) return;
  // SSE: skip
  if (e.request.url.includes('/api/stream')) return;
  e.respondWith(
    fetch(e.request).then(r => {
      if (r.ok) {
        const clone = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return r;
    }).catch(() => caches.match(e.request))
  );
});

// Push notification handler
self.addEventListener('push', e => {
  let data = { title: 'WYA', body: 'You have a new update!' };
  try {
    if (e.data) data = e.data.json();
  } catch (err) {
    if (e.data) data.body = e.data.text();
  }
  const options = {
    body: data.body || data.message || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [200, 100, 200],
    tag: data.tag || 'wya-notification',
    data: { url: data.url || '/customer' },
    actions: data.actions || []
  };
  e.waitUntil(self.registration.showNotification(data.title || 'WYA', options));
});

// Notification click handler
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/customer';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (const client of windowClients) {
        if (client.url.includes(url) && 'focus' in client) return client.focus();
      }
      return clients.openWindow(url);
    })
  );
});
