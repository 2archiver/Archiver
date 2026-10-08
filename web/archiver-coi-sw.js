/* Archiver — same-origin service worker for the static GitHub Pages build.

   Two jobs, both scoped to this app's directory (/Archiver/ on Pages):

   1. COOP/COEP. The WebAssembly runtimes need SharedArrayBuffer, which browsers
      grant only in a cross-origin-isolated document. The app server sends the
      headers itself; GitHub Pages cannot, so this worker stamps them onto
      same-origin documents, frames and worker scripts. A page served with
      COEP: require-corp refuses a worker script whose response lacks the
      header itself, so workers are stamped too. Everything else passes through.

   2. A versioned, same-origin app-shell cache, so the app opens and runs offline
      once it has been visited online:
        - the shell (index.html) and the app's own scripts, styles and icons it
          references are stored at install, so an update never leaves the new
          cache without them;
        - navigations and /static/ app files are network first (the page's HTML
          names them without version strings, so they must stay in step with
          it). A slow network (over NETWORK_WAIT_MS) or no network yields the last
          good copy, and the network result still refreshes the cache;
        - /static/vendor/ runtimes have versioned, immutable names: cache first.
          They are stored the first time the page loads them;
        - never cached: /api/ responses, cross-origin requests (model weights come
          from Hugging Face and are stored by the runtime's own model cache), Range
          requests, non-200 responses (no error caching), opaque responses, and the
          service worker script itself (so updates are always detected).

   Updates: a new worker waits for the page to ask for it (SKIP_WAITING). The
   first install of a site activates at once because nothing is open yet. A
   running chat is never reloaded underneath the reader. Only caches whose name
   starts with this worker's own prefix and differs from the current name are
   deleted; the runtime's own caches (webllm/…) are left alone. */
'use strict';

var CACHE_PREFIX = 'archiver-shell-';
var CACHE_VERSION = '5.4.0';
var SHELL_CACHE = CACHE_PREFIX + 'v' + CACHE_VERSION;
var NETWORK_WAIT_MS = 4000;
var ISOLATION = [
  ['Cross-Origin-Opener-Policy', 'same-origin'],
  ['Cross-Origin-Embedder-Policy', 'require-corp'],
];
var ISOLATED_DESTINATIONS = { document: 1, iframe: 1, frame: 1, worker: 1, sharedworker: 1 };

function scopePath() {
  return new URL(self.registration.scope).pathname;
}

function shellUrl() {
  return new URL('index.html', self.registration.scope).href;
}

function sameScope(url) {
  return url.origin === self.location.origin && url.pathname.indexOf(scopePath()) === 0;
}

/* Adds the isolation headers without touching the body. Opaque and status-0
   responses cannot be rebuilt, so they pass through unchanged. */
function isolate(response) {
  if (response.type === 'opaque' || response.status === 0) return response;
  var headers = new Headers(response.headers);
  for (var i = 0; i < ISOLATION.length; i++) {
    if (!headers.has(ISOLATION[i][0])) headers.set(ISOLATION[i][0], ISOLATION[i][1]);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: headers });
}

function cacheable(response) {
  return !!response && response.status === 200 && response.type === 'basic';
}

/* The app's own files named by the shell: scripts, styles, icons, manifest. Runtimes
   under /static/vendor/ are left out; they are stored the first time they load. */
function shellAssetUrls(html) {
  var out = [];
  var seen = {};
  var pattern = /(?:src|href)=["']([^"'#]+)["']/g;
  var match;
  while ((match = pattern.exec(html)) !== null) {
    var url;
    try { url = new URL(match[1], shellUrl()); } catch (_) { continue; }
    if (!sameScope(url) || url.pathname.indexOf('/static/vendor/') !== -1) continue;
    if (seen[url.href]) continue;
    seen[url.href] = true;
    out.push(url.href);
  }
  return out;
}

async function precacheShell(cache) {
  var res = await fetch(shellUrl(), { cache: 'no-store' });
  if (!cacheable(res)) return;
  var copy = res.clone();
  var html = await res.text();
  await cache.put(shellUrl(), copy);
  await Promise.all(shellAssetUrls(html).map(function (href) {
    return fetch(href, { cache: 'no-store' }).then(function (r) {
      return cacheable(r) ? cache.put(href, r) : null;
    }).catch(function () {});
  }));
}

function cachedShell() {
  return caches.open(SHELL_CACHE).then(function (cache) {
    return cache.match(shellUrl());
  }, function () { return undefined; });
}

/* The network answers when it is quick. Otherwise, or when it fails, the cached copy
   answers, and the network result (still in flight) refreshes the cache. */
function preferNetwork(network, cached) {
  return new Promise(function (resolve) {
    var timer = setTimeout(function () { resolve(isolate(cached)); }, NETWORK_WAIT_MS);
    network.then(function (res) {
      clearTimeout(timer);
      resolve(res);
    }, function () {
      clearTimeout(timer);
      resolve(isolate(cached));
    });
  });
}

self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    var cache = await caches.open(SHELL_CACHE);
    // A few hundred kilobytes. An install never downloads megabytes of runtime.
    try { await precacheShell(cache); } catch (_) { /* offline install: cached on the next online visit */ }
    // First install: nothing is open yet, so take over at once. Otherwise wait
    // for the page's explicit SKIP_WAITING (the "update available" action).
    if (!self.registration.active) await self.skipWaiting();
  })());
});

self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    var names = await caches.keys();
    await Promise.all(names.map(function (name) {
      if (name.indexOf(CACHE_PREFIX) === 0 && name !== SHELL_CACHE) return caches.delete(name);
      return null;
    }));
    await self.clients.claim();
  })());
});

function serveNavigation(request) {
  var network = fetch(request, { cache: 'no-store' }).then(function (res) {
    if (res.status === 0 || res.type === 'opaque' || res.type === 'opaqueredirect') return res;
    // Cloned before the body is handed on: a clone taken after isolate() has
    // consumed the stream would fail, and the shell would silently stop refreshing.
    var copy = cacheable(res) ? res.clone() : null;
    if (copy) {
      caches.open(SHELL_CACHE).then(function (cache) { return cache.put(shellUrl(), copy); }).catch(function () {});
    }
    return isolate(res);
  });
  network.then(null, function () {});  // handled below; no unhandled-rejection report
  return cachedShell().then(function (cached) {
    if (cached) return preferNetwork(network, cached);
    // Nothing cached and no network: say so plainly, rather than a browser error page.
    return network.catch(function () {
      return new Response(
        '<!doctype html><meta charset="utf-8"><title>Archiver is offline</title>' +
        '<p>Archiver has not been opened on this device yet, so its app shell is not stored here. ' +
        'Connect once and reload.</p>',
        { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
      );
    });
  });
}

function serveAsset(request, url) {
  var immutable = url.pathname.indexOf('/static/vendor/') !== -1;
  return caches.open(SHELL_CACHE).then(function (cache) {
    return cache.match(request).then(function (cached) {
      if (cached && immutable) return isolate(cached);
      // Revalidate app files with the server so a fresh HTML never meets a stale script.
      var upstream = immutable ? request : new Request(request, { cache: 'no-cache' });
      var network = fetch(upstream).then(function (res) {
        var copy = cacheable(res) ? res.clone() : null;  // cloned before isolate() takes the body
        if (copy) cache.put(request, copy).catch(function () {});
        return isolate(res);
      });
      network.then(null, function () {});
      if (!cached) return network;
      return preferNetwork(network, cached);
    });
  });
}

function passThrough(request) {
  return fetch(request).then(isolate);
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  // A cache-only request that is not same-origin cannot be re-issued.
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  var url;
  try { url = new URL(request.url); } catch (_) { return; }
  // Model weights, third-party hosts and other apps on the same origin: untouched.
  if (url.origin !== self.location.origin || !sameScope(url)) return;
  if (request.mode === 'navigate') {
    event.respondWith(serveNavigation(request));
    return;
  }
  // The service worker script itself must always come from the network, or an
  // update could never be detected.
  if (request.destination === 'serviceworker') return;
  // Partial responses and live API data are never stored.
  if (request.headers.has('range') || url.pathname.indexOf('/api/') !== -1) {
    event.respondWith(passThrough(request));
    return;
  }
  // Frames and documents outside /static/ are fetched fresh, never cached.
  if (ISOLATED_DESTINATIONS[request.destination] === 1 && url.pathname.indexOf('/static/') === -1) {
    event.respondWith(passThrough(request));
    return;
  }
  event.respondWith(serveAsset(request, url));
});
