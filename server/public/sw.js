// FamilyCall Service Worker
// ─── CHANGE THIS VERSION whenever you deploy new code ───
const VERSION = 'fc-v16';
const CACHE = `familycall-${VERSION}`;

// Files to cache for offline
const CORE_FILES = [
  '/',
  '/index.html',
  '/js/app.js',
  '/js/audio-processor.js',
  '/js/pcm-recorder.js',
  '/manifest.json',
  '/icon.svg'
];

// ── Install: cache core files ──
self.addEventListener('install', e => {
  // Do NOT skipWaiting here — wait for user to trigger update
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(CORE_FILES)).catch(() => {})
  );
});

// ── Activate: delete old caches ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: network first, cache fallback ──
self.addEventListener('fetch', e => {
  // Skip WebSocket, API calls, external URLs
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;
  if (!url.origin.includes(self.location.origin)) return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Cache fresh response
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request)) // offline fallback
  );
});

// ── Message: user triggered "install update now" ──
self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
