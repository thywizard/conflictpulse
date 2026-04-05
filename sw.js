// ============================================================
//  ConflictPulse — Service Worker
//  Handles: Offline caching, background sync, push notifications
// ============================================================

const CACHE_NAME = 'conflictpulse-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/feed.html',
  '/article.html',
  '/404.html',
  '/admin-login.html',
  '/manifest.json',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=Space+Grotesk:wght@400;500;600;700&display=swap',
];

// ── INSTALL ───────────────────────────────────────────
// Cache all static assets when SW installs
self.addEventListener('install', event => {
  console.log('[SW] Installing ConflictPulse Service Worker...');
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[SW] Caching static assets');
      return cache.addAll(STATIC_ASSETS.map(url => new Request(url, { cache: 'reload' })))
        .catch(err => console.log('[SW] Cache addAll partial failure:', err));
    })
  );
  // Activate immediately without waiting
  self.skipWaiting();
});

// ── ACTIVATE ──────────────────────────────────────────
// Clean up old caches
self.addEventListener('activate', event => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE_NAME)
            .map(key => { console.log('[SW] Deleting old cache:', key); return caches.delete(key); })
      )
    )
  );
  self.clients.claim();
});

// ── FETCH ─────────────────────────────────────────────
// Strategy:
//   API calls     → Network first, fallback to cache
//   Static files  → Cache first, fallback to network
//   Images        → Cache first, fallback to network, cache response
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if(request.method !== 'GET') return;

  // Skip chrome-extension and other non-http requests
  if(!url.protocol.startsWith('http')) return;

  // API calls — Network first strategy
  if(url.hostname.includes('onrender.com') || url.pathname.startsWith('/api/')){
    event.respondWith(networkFirst(request));
    return;
  }

  // Google Fonts — Cache first
  if(url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com')){
    event.respondWith(cacheFirst(request));
    return;
  }

  // Images — Cache first, save to cache
  if(request.destination === 'image'){
    event.respondWith(cacheFirstWithUpdate(request));
    return;
  }

  // Everything else — Cache first with network fallback
  event.respondWith(cacheFirst(request));
});

// ── STRATEGIES ────────────────────────────────────────

// Network first — tries network, falls back to cache
async function networkFirst(request) {
  try {
    const networkResponse = await fetch(request);
    if(networkResponse.ok){
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch(err) {
    const cachedResponse = await caches.match(request);
    if(cachedResponse) return cachedResponse;
    // Return offline JSON for API calls
    return new Response(JSON.stringify({
      success: false,
      error: 'You are offline. Please check your connection.',
      articles: [],
      pagination: { total: 0, page: 1, pages: 0 }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Cache first — returns cache if available, else fetches
async function cacheFirst(request) {
  const cachedResponse = await caches.match(request);
  if(cachedResponse) return cachedResponse;

  try {
    const networkResponse = await fetch(request);
    if(networkResponse.ok){
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch(err) {
    // Return offline page for navigation requests
    if(request.mode === 'navigate'){
      const offlinePage = await caches.match('/404.html');
      return offlinePage || new Response('<h1>Offline</h1>', { headers: { 'Content-Type': 'text/html' } });
    }
    return new Response('Offline', { status: 503 });
  }
}

// Cache first + update in background
async function cacheFirstWithUpdate(request) {
  const cachedResponse = await caches.match(request);

  const fetchPromise = fetch(request).then(networkResponse => {
    if(networkResponse.ok){
      caches.open(CACHE_NAME).then(cache => cache.put(request, networkResponse.clone()));
    }
    return networkResponse;
  }).catch(() => null);

  return cachedResponse || fetchPromise;
}

// ── PUSH NOTIFICATIONS ────────────────────────────────
self.addEventListener('push', event => {
  const data = event.data?.json() || {};
  const title = data.title || '⚡ ConflictPulse Breaking News';
  const options = {
    body:    data.body || 'New conflict update available',
    icon:    '/icons/icon-192.png',
    badge:   '/icons/icon-192.png',
    image:   data.image || '',
    tag:     data.tag || 'conflictpulse-news',
    renotify: true,
    data: { url: data.url || '/feed.html' },
    actions: [
      { action: 'read', title: '📰 Read Now' },
      { action: 'dismiss', title: '✕ Dismiss' }
    ]
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Handle notification clicks
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if(event.action === 'dismiss') return;

  const urlToOpen = event.notification.data?.url || '/feed.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for(const client of clientList){
        if(client.url.includes(urlToOpen) && 'focus' in client)
          return client.focus();
      }
      if(clients.openWindow) return clients.openWindow(urlToOpen);
    })
  );
});

// ── BACKGROUND SYNC ───────────────────────────────────
self.addEventListener('sync', event => {
  if(event.tag === 'sync-likes'){
    event.waitUntil(syncPendingLikes());
  }
});

async function syncPendingLikes(){
  // Sync any offline like actions when back online
  console.log('[SW] Syncing pending likes...');
}

console.log('[SW] ConflictPulse Service Worker loaded ✅');
