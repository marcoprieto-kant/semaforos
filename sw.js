// Increment on EVERY public release: the shell is installed as one coherent set.
const CACHE_NAME = "semaforos-v4-20261104-5";
const LOCAL_ASSETS = [
  "./", "./index.html", "./styles.css", "./app.js", "./config.js", "./db.js",
  "./traffic-cycle.js", "./manifest.webmanifest", "./icons/icon.svg",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png",
];
const EXTERNAL_ASSETS = [
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
];
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(LOCAL_ASSETS.map((path) => new Request(path, { cache: "reload" })));
    await Promise.allSettled(EXTERNAL_ASSETS.map((url) => cache.add(url)));
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Never delete unrelated applications' caches on the same origin.
    for (const name of await caches.keys()) if (name.startsWith("semaforos-") && name !== CACHE_NAME) await caches.delete(name);
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (event) => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== "GET") return;
  // No API, PIN, session or OSM tile caching. Only an explicit public-shell allowlist.
  const isShell = url.origin === self.location.origin && LOCAL_ASSETS.some((path) => new URL(path, self.registration.scope).pathname === url.pathname);
  if (!isShell && !EXTERNAL_ASSETS.includes(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request, { ignoreSearch: isShell });
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  })());
});
