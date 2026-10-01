/* Archiver — static-host bootstrap worker (registered only on GitHub Pages).

   The WebAssembly runtime needs SharedArrayBuffer, which browsers grant only
   in a cross-origin-isolated document (Cross-Origin-Opener-Policy +
   Cross-Origin-Embedder-Policy). The app server sends both headers itself;
   GitHub Pages cannot set any response headers — but a same-origin service
   worker can synthesize them for navigations, which is exactly what this
   34-line worker does. It is inert unless a page registers it.

   Only GET, same-origin, top-level document requests are touched. Model
   weights (cross-origin, CORS-mode) and every subresource pass through
   untouched, so require-corp is satisfied the same way it is on Render. */
'use strict';

var ARCHIVER_ISOLATION = [
  ['Cross-Origin-Opener-Policy', 'same-origin'],
  ['Cross-Origin-Embedder-Policy', 'require-corp'],
];

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var isDocument = req.mode === 'navigate' || req.destination === 'document';
  if (!isDocument) return;
  var url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(req, { cache: 'no-store' }).then(function (res) {
      var headers = new Headers(res.headers);
      for (var i = 0; i < ARCHIVER_ISOLATION.length; i++) {
        var pair = ARCHIVER_ISOLATION[i];
        if (!headers.has(pair[0])) headers.set(pair[0], pair[1]);
      }
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: headers });
    })
  );
});
