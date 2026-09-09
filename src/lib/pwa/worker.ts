export function workerSource(version: string) {
  return String.raw`
// API/auth responses and private photos are never intercepted.
const CACHE = ${JSON.stringify(`kcalcue-shell-${version}`)};
const SHELL = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];
self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    const page = await cache.match("/");
    const html = await page.text();
    const assets = [...html.matchAll(/(?:src|href)="([^" ]+)"/g)]
      .map(match => match[1]).filter(path => path.startsWith("/_next/static/"));
    await cache.addAll([...new Set(assets)]);
  })());
});
self.addEventListener("message", event => {
  if (event.data?.type === "ACTIVATE_UPDATE") self.skipWaiting();
});
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    // Keep the previous shell's chunks for another tab that has not accepted the update yet.
    const previous = (await caches.keys()).filter(key => key.startsWith("kcalcue-shell-") && key !== CACHE).sort();
    for (const key of previous.slice(0, -1)) await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth") || request.headers.has("authorization") || request.headers.has("RSC")) return;
  if (request.mode === "navigate" && url.pathname === "/") {
    event.respondWith(fetch(request).catch(async () => (await caches.match("/")) || Response.error()));
    return;
  }
  if (url.pathname.startsWith("/_next/static/") || SHELL.includes(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request) || await caches.match(request); if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    })());
  }
});
`;
}
