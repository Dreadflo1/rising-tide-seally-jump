// Minimal service worker: stale-while-revalidate for same-origin GET
// requests. This is intentionally NOT a hardcoded precache list (Vite
// build output hashes filenames, so a static manifest would go stale on
// every deploy) — instead it caches whatever the player has actually
// loaded, so repeat visits and brief network drops fall back to cache
// instead of a blank screen.
const CACHE_NAME = 'seal-jump-v24';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // The entry document (index.html) is network-first: when online, always take
  // the freshly deployed page so a new release — new hashed asset refs, updated
  // ad config, etc. — is picked up on the very next load instead of a visit
  // later. Falls back to the cached page (or cached root) when offline.
  const isDocument = req.mode === 'navigate' || req.destination === 'document';
  if (isDocument) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        try {
          const res = await fetch(req);
          if (res && res.status === 200) cache.put(req, res.clone());
          return res;
        } catch {
          return (await cache.match(req)) || (await cache.match('/')) || Response.error();
        }
      })
    );
    return;
  }

  // Everything else same-origin (hashed JS/CSS, images, sfx) is content-
  // addressed, so stale-while-revalidate is safe and fast: serve from cache
  // immediately, refresh the cache in the background.
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(req);
      const networkFetch = fetch(req)
        .then((res) => {
          if (res && res.status === 200) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
