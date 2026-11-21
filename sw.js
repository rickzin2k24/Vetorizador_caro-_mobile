// Guarda o próprio app no celular para abrir sem internet (as áreas ficam no IndexedDB, não aqui).
// Ao publicar uma versão nova, troque o número abaixo.
const CACHE = 'caroa-celular-1.1.0';
const ARQUIVOS = [
  './', 'index.html', 'app.js', 'app.css', 'manifest.webmanifest',
  'icones/logo.svg', 'icones/apple-touch-icon.png', 'icones/icon-192.png', 'icones/icon-512.png',
  'vendor/ol.js', 'vendor/ol.css', 'vendor/jsQR.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k.startsWith('caroa-celular-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Do cache na hora (funciona no modo avião) e atualiza por trás quando tem internet.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;   // o túnel do computador passa direto
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const guardado = await c.match(req, { ignoreSearch: true });
    const rede = fetch(req).then((r) => { if (r && r.ok) c.put(req, r.clone()); return r; }).catch(() => null);
    if (guardado) { e.waitUntil(rede); return guardado; }
    const r = await rede;
    if (r) return r;
    if (req.mode === 'navigate') return (await c.match('index.html')) || Response.error();
    return Response.error();
  }));
});
