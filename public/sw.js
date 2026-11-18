// Service worker: keeps the player and ad files available offline.
const SHELL = 'ad-shell-v1';
const MEDIA = 'ad-media';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // Ad files never change once uploaded: cache first.
  if (url.pathname.startsWith('/media/')) {
    e.respondWith(caches.open(MEDIA).then(async c => {
      const hit = await c.match(url.pathname);
      const range = e.request.headers.get('range');
      if (hit && range) return partial(hit, range);   // videos ask for byte ranges
      if (hit) return hit;
      if (range) return fetch(e.request);
      const r = await fetch(e.request);
      if (r.ok && r.status === 200) c.put(url.pathname, r.clone());
      return r;
    }));
    return;
  }

  // Player page: network first, fall back to cache when offline.
  if (url.pathname.startsWith('/screen/')) {
    e.respondWith(fetch(e.request).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(SHELL).then(c => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request)));
  }
});

async function partial(resp, range) {
  const buf = await resp.arrayBuffer();
  const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
  const start = m[1] ? Number(m[1]) : 0;
  const end = m[2] ? Math.min(Number(m[2]), buf.byteLength - 1) : buf.byteLength - 1;
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': resp.headers.get('Content-Type') || 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${buf.byteLength}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}
