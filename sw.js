/* オフラインでも開けるようにする Service Worker。
   本体は通信優先（直したら次に開いたとき反映される）、圏外ならキャッシュから起動する。
   Supabase（別のドメイン）と version.txt には触らない。 */
const CACHE = "hatsudoya-2026-10-19-1";
const SHELL = ["./", "./index.html", "./app.js", "./style.css", "./config.js", "./vendor/supabase-2.45.4.js",
               "./manifest.webmanifest", "./favicon.svg", "./icon-180.png", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.allSettled(SHELL.map(u => c.add(u))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.endsWith("/version.txt")) return;
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match("./index.html"))));
});
