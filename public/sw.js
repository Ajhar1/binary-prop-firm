// Binary Prop Firm - Progressive Web App Service Worker
const CACHE_NAME = 'bpf-pwa-v1.0.3';

const PRECACHE_ASSETS = [
  '/',
  '/dashboard',
  '/manifest.json',
  '/apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/assets/logo.png',
  '/assets/favicon.png'
];

// Install: precache shell and take control immediately
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS).catch((err) => {
        console.warn('[PWA-SW] Precache asset fetch warning:', err);
      });
    })
  );
});

// Activate: clean up outdated caches and claim clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((name) => {
          if (name !== CACHE_NAME) {
            console.log('[PWA-SW] Deleting old cache:', name);
            return caches.delete(name);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: Smart Strategy
// 1. API & dynamic routes: Network-Only (NEVER cache financial or account data)
// 2. Navigation: Network-First with cached fallback
// 3. Static assets: Stale-While-Revalidate
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Skip non-GET requests
  if (req.method !== 'GET') {
    return;
  }

  // Network-Only for APIs, auth, websockets, and dynamic routes
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/socket.io/') ||
    url.pathname.startsWith('/videos/') ||
    url.pathname.startsWith('/admin')
  ) {
    return;
  }

  // HTML Navigation: Network-First
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            const resClone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
          }
          return networkRes;
        })
        .catch(() => {
          return caches.match(req).then((cachedRes) => {
            if (cachedRes) return cachedRes;
            return caches.match('/dashboard');
          });
        })
    );
    return;
  }

  // Static Assets (Images, Icons, Fonts, Manifest): Cache-First / Stale-While-Revalidate
  if (
    url.pathname.startsWith('/icons/') ||
    url.pathname.startsWith('/assets/') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.jpg') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.json')
  ) {
    event.respondWith(
      caches.match(req).then((cachedRes) => {
        const fetchPromise = fetch(req)
          .then((networkRes) => {
            if (networkRes && networkRes.status === 200) {
              const resClone = networkRes.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
            }
            return networkRes;
          })
          .catch(() => null);

        return cachedRes || fetchPromise;
      })
    );
    return;
  }
});
