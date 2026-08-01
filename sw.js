/* セリフトレーナー Service Worker
 * app shell 一式を precache + network-first でオフライン動作させる。
 * SHELL の一覧を変えたら VERSION を上げること（古いキャッシュの掃除のため）。
 */
const VERSION = 'v1';
const SHELL_CACHE = `shell-${VERSION}`;

const base = new URL('./', self.location).href;
const url = (p) => new URL(p, base).href;

const SHELL = [
  './',
  'index.html',
  'style.css',
  'manifest.json',
  'register-sw.js',
  'js/app.js',
  'js/db.js',
  'js/parser.js',
  'js/appearances.js',
  'js/progress.js',
  'js/tts.js',
  'js/ui.js',
  'js/views/home.js',
  'js/views/import.js',
  'js/views/scriptDetail.js',
  'js/views/scriptView.js',
  'js/views/sceneNotes.js',
  'js/views/practiceMask.js',
  'js/views/practiceVoice.js',
  'vendor/pdf.min.js',
  'vendor/pdf.worker.min.js',
  'vendor/mammoth.browser.min.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
].map(url);

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await Promise.all(
        SHELL.map(async (u) => {
          try {
            await cache.add(u);
          } catch (e) {
            console.warn('precache failed', u, e);
          }
        })
      );
      self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)));
      self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) cache.put(req, fresh.clone());
        return fresh;
      } catch (e) {
        const cached = await cache.match(req);
        if (cached) return cached;
        if (req.mode === 'navigate') {
          const shell = await cache.match(url('index.html'));
          if (shell) return shell;
        }
        throw e;
      }
    })()
  );
});
