/* Service worker: cache-first for map tiles, so pre-cached areas work offline. */
const TILE_CACHE = 'rover-gcs-tiles-v2';
// Only WGS-84 tile hosts (GCJ-02 Bing/Google sources were removed to avoid map/GPS offset).
const TILE_HOSTS = ['arcgisonline.com', 'tile.openstreetmap.org'];

self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', (event) => {
  const url = event.request.url;
  const isTile = TILE_HOSTS.some((h) => url.includes(h));
  if (!isTile) return; // let the page/app assets load normally
  event.respondWith(
    caches.open(TILE_CACHE).then((cache) =>
      cache.match(event.request).then((hit) => {
        if (hit) return hit;
        return fetch(event.request).then((resp) => {
          // cache opaque tile responses too (no-cors)
          try { cache.put(event.request, resp.clone()); } catch (_) {}
          return resp;
        }).catch(() => hit); // offline + not cached -> fail gracefully
      })
    )
  );
});
