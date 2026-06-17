// sw.js — Service Worker phục vụ preview project HTML.
// Scope: /_viewer/  → intercept mọi request dưới /_viewer/__preview__/
// File được lưu trong Cache Storage (bền qua việc SW bị kill khi idle).

const PREFIX = '__preview__/';
const CACHE = 'codegrid-preview';

const TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', avif: 'image/avif',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav',
  glb: 'model/gltf-binary', gltf: 'model/gltf+json', txt: 'text/plain; charset=utf-8',
};
function ctype(p) {
  const ext = p.split('.').pop().toLowerCase();
  return TYPES[ext] || 'application/octet-stream';
}
// Khoá cache tổng hợp, độc lập với cách encode của request thật
function keyFor(rel) {
  return new Request(self.registration.scope + '__store__/' + encodeURIComponent(rel));
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('message', (e) => {
  const { type, files } = e.data || {};
  const reply = (d) => e.ports[0]?.postMessage(d);
  if (type === 'load') {
    e.waitUntil((async () => {
      await caches.delete(CACHE);
      const cache = await caches.open(CACHE);
      let n = 0;
      for (const [rel, buf] of Object.entries(files)) {
        await cache.put(keyFor(rel), new Response(buf, {
          headers: { 'Content-Type': ctype(rel), 'Cache-Control': 'no-store' },
        }));
        n++;
      }
      reply({ ok: true, count: n });
    })());
  } else if (type === 'clear') {
    e.waitUntil(caches.delete(CACHE).then(() => reply({ ok: true })));
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const i = url.pathname.indexOf(PREFIX);
  if (i === -1) return;
  let rel = decodeURIComponent(url.pathname.slice(i + PREFIX.length)).replace(/^\/+/, '');
  event.respondWith(serve(rel));
});

async function serve(rel) {
  const cache = await caches.open(CACHE);
  let res = await cache.match(keyFor(rel));
  if (!res && (rel === '' || rel.endsWith('/'))) res = await cache.match(keyFor(rel + 'index.html'));
  if (!res) return new Response('Not found in preview: ' + rel, { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  return res;
}
