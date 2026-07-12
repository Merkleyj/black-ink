/* =====================================================================
   Black Ink — service worker
   Makes the app installable and fully usable offline. Caches the app
   shell (HTML, JS, icons). Supabase API/auth traffic is cross-origin and
   is never intercepted, so sign-in and sync always hit the network.
   Bump CACHE_VERSION whenever shell files change to roll the cache.
   ===================================================================== */
const CACHE_VERSION = 'black-ink-v1';

// Paths are relative to the SW's scope, so this works on GitHub Pages
// sub-paths (username.github.io/black-ink/) as well as at a domain root.
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './js/config.js',
  './js/supabase.js',
  './js/auth.js',
  './js/sync.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './icons/favicon-16.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // Best-effort precache: don't fail the whole install if one file 404s
    // (e.g. an icon not yet generated in a fork).
    await Promise.allSettled(SHELL.map((p) => cache.add(new Request(p, { cache: 'reload' }))));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Allow the page to trigger an immediate update.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Only ever touch our own origin. Supabase (auth + data) is cross-origin
  // and must go straight to the network, untouched.
  if (url.origin !== self.location.origin) return;

  // Navigations → network-first so a fresh shell is served when online,
  // falling back to the cached shell offline.
  const isNav = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');

  if (isNav) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_VERSION);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch (e) {
        const cache = await caches.open(CACHE_VERSION);
        return (await cache.match('./index.html')) ||
               (await cache.match('./')) ||
               Response.error();
      }
    })());
    return;
  }

  // Static assets → cache-first, then revalidate in the background.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(req);
    const network = fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    return cached || (await network) || Response.error();
  })());
});
