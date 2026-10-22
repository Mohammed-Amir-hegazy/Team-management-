// Service worker: the app opens fast and still shows the last data it loaded when the connection
// drops, and push notifications arrive even when the app is closed.

const VERSION = 'v1';
const SHELL = `ebtikar-shell-${VERSION}`;
const DATA = 'ebtikar-api';
const PRECACHE = ['/', '/styles.css', '/js/app.js', '/js/core.js', '/fonts/ebtikar.woff2', '/icon-192.png', '/brand/wordmark-white.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('ebtikar-shell-') && key !== SHELL) await caches.delete(key);
    await self.clients.claim();
  })());
});

// Network first, so updates show at once; the saved copy only when offline.
async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) (await caches.open(cacheName)).put(request, response.clone());
    return response;
  } catch (err) {
    const saved = await caches.match(request);
    if (saved) return saved;
    if (request.mode === 'navigate') return (await caches.match('/')) || Response.error();
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Photos and logos are versioned and never change: straight from the cache when there.
  if (url.pathname.startsWith('/api/images/') || /^\/api\/(users|companies)\/\d+\/(photo|brand)/.test(url.pathname)) {
    event.respondWith(caches.match(request).then((hit) => hit || networkFirst(request, DATA)));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    // Signing in/out and live counters are never served from the cache.
    if (/^\/api\/(login|logout|setup|signup|password|client-config)/.test(url.pathname)) return;
    event.respondWith(networkFirst(request, DATA));
    return;
  }
  event.respondWith(networkFirst(request, SHELL));
});

// A push: shown unless the app is open in front of the person (it shows its own alert then).
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (windows.some((w) => w.visibilityState === 'visible' && w.focused)) return;
    await self.registration.showNotification(data.title || 'ابتكار', {
      body: data.body || '', dir: 'rtl', lang: 'ar', icon: '/icon-192.png', badge: '/icon-192.png',
      tag: data.link || undefined, renotify: true, data: { link: data.link || '' },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || '#/notifications';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows[0];
    if (open) {
      await open.focus();
      open.postMessage({ type: 'open', link });
    } else {
      await self.clients.openWindow(`/${link}`);
    }
  })());
});

// Signing out: forget the saved data of the person who left.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'logout') event.waitUntil(caches.delete(DATA));
});
