// SessionMax phone app: notifications from the PC (web push), and opening the chat they're about.

const SHELL = 'shell-v1';
const SHELL_FILES = ['/', '/app.js', '/app.css', '/manifest.webmanifest', '/icon-192.png'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).catch(() => {}));
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// The app's own files come from the PC when it's reachable, and from the cache when it isn't,
// so the installed app still opens (and says it can't reach the PC). The API is never cached.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname === '/pair') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || caches.match('/'))),
  );
});

self.addEventListener('push', (e) => {
  let note = {};
  try {
    note = e.data.json();
  } catch {}
  e.waitUntil(
    self.registration.showNotification(note.title || 'SessionMax', {
      body: note.body || '',
      tag: note.tag,
      renotify: true,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { chat: note.chat },
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = e.notification.data?.chat ? `/#chat/${e.notification.data.chat}` : '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list[0];
      if (open) {
        open.postMessage({ open: e.notification.data?.chat });
        return open.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
