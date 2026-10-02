/* Archiver — static-host bootstrap worker (registered only on GitHub Pages).

   The WebAssembly runtime needs SharedArrayBuffer, which browsers grant only
   in a cross-origin-isolated document (Cross-Origin-Opener-Policy +
   Cross-Origin-Embedder-Policy). The app server sends both headers itself;
   GitHub Pages cannot set any response headers — but a same-origin service
   worker can synthesize them, which is what this worker does. It is inert
   unless a page registers it.

   Two kinds of same-origin GET responses are rewritten:

   * documents (top-level navigations and frames) — they carry the policy;
   * dedicated/shared worker scripts — easy to miss, and fatal to miss. A page
     served with COEP: require-corp refuses to start a worker whose script
     response does not carry the COEP header itself (Chrome reports it as
     net::ERR_BLOCKED_BY_RESPONSE), so the WebGPU model worker would never
     start on an isolated Pages site. Render's app server stamps every
     response, workers included; this worker has to do the same for them.

   Everything else — model weights (cross-origin, CORS-mode) and every other
   subresource — passes through untouched, so require-corp is satisfied the
   same way it is on Render: same-origin needs nothing, CORS needs nothing. */
'use strict';

var ARCHIVER_ISOLATION = [
  ['Cross-Origin-Opener-Policy', 'same-origin'],
  ['Cross-Origin-Embedder-Policy', 'require-corp'],
];

var ISOLATED_DESTINATIONS = { document: 1, iframe: 1, frame: 1, worker: 1, sharedworker: 1 };

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var navigation = req.mode === 'navigate';
  if (!navigation && ISOLATED_DESTINATIONS[req.destination] !== 1) return;
  // A cache-only request that is not same-origin cannot be re-issued.
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  var url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;
  // Pages are always fetched fresh; worker scripts use the HTTP cache like any
  // other subresource.
  var upstream = navigation ? fetch(req, { cache: 'no-store' }) : fetch(req);
  e.respondWith(
    upstream.then(function (res) {
      // Opaque and redirect responses have nothing to rewrite (and cannot be
      // rebuilt as a Response); hand them back as they are.
      if (res.status === 0 || res.type === 'opaque' || res.type === 'opaqueredirect') return res;
      var headers = new Headers(res.headers);
      for (var i = 0; i < ARCHIVER_ISOLATION.length; i++) {
        var pair = ARCHIVER_ISOLATION[i];
        if (!headers.has(pair[0])) headers.set(pair[0], pair[1]);
      }
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: headers });
    })
  );
});
