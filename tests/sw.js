/* The GitHub Pages service worker (web/archiver-coi-sw.js), run against a model of
   the Cache API, a scripted network, and the worker lifecycle.

   What it proves: the app shell and the app's own files open offline, cached runtimes
   are served from this origin, nothing that must stay live is cached (API data,
   errors, partial responses, cross-origin requests such as model weights), updates
   wait for the reader, a slow network falls back to the last good copy, and the worker
   only ever deletes its own old caches.

   node tests/sw.js */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', 'web');
const SCOPE = 'https://example.github.io/Archiver/';
const ORIGIN = 'https://example.github.io';
const INDEX_HTML = [
  '<!doctype html><html><head>',
  '<link rel="icon" href="favicon.svg" type="image/svg+xml">',
  '<link rel="manifest" href="manifest.json">',
  '</head><body>',
  '<a href="https://github.com/2archiver/Archiver">source</a>',
  '<a href="#top">top</a>',
  '<script src="static/archiver-engine.js" defer></script>',
  '<script src="static/vendor/wllama-compat-3.6.1.js"></script>',
  '</body></html>',
].join('\n');

let passed = 0;
let failed = 0;

/* Node's Response.type is always 'default'. A same-origin response in a browser is
   'basic', which is what the worker checks before it caches anything. */
class BasicResponse extends Response {
  get type() { return 'basic'; }
}

/* Node's Request exposes mode, destination and cache as read-only getters. Shadow them
   with own properties so the worker sees what a browser would send. */
function makeRequest(url, props) {
  const req = new Request(url, { method: 'GET' });
  for (const [k, v] of Object.entries(Object.assign({ mode: 'same-origin', destination: '', cache: 'default' }, props || {}))) {
    Object.defineProperty(req, k, { value: v, configurable: true });
  }
  return req;
}

function makeWorker(options) {
  const opts = Object.assign({ activeRegistration: false, slowMs: 0 }, options || {});
  const caches = new Map();      // name -> Map(url -> { status, headers, body })
  const network = { offline: false, routes: new Map(), log: [] };
  const listeners = {};
  const sent = { skipWaiting: 0, claimed: 0 };
  const key = (req) => (typeof req === 'string' ? req : req.url);
  const cacheApi = {
    async open(name) {
      if (!caches.has(name)) caches.set(name, new Map());
      const store = caches.get(name);
      return {
        async match(req) {
          const hit = store.get(key(req));
          if (!hit) return undefined;
          return new Response(hit.body.slice(), { status: hit.status, headers: hit.headers });
        },
        async put(req, res) {
          if (res.status !== 200 && res.status !== 404) throw new TypeError('put: refused status ' + res.status);
          const body = new Uint8Array(await res.arrayBuffer());
          store.set(key(req), { status: res.status, headers: [...res.headers.entries()], body });
        },
      };
    },
    async keys() { return [...caches.keys()]; },
    async delete(name) { return caches.delete(name); },
  };
  const scope = {
    location: { origin: ORIGIN, href: SCOPE },
    registration: { scope: SCOPE, active: opts.activeRegistration ? {} : null },
    caches: cacheApi,
    Response: BasicResponse, Headers, Request, URL,
    addEventListener(type, fn) { listeners[type] = fn; },
    skipWaiting() { sent.skipWaiting++; return Promise.resolve(); },
    clients: { claim() { sent.claimed++; return Promise.resolve(); } },
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, Math.min(ms, opts.slowMs || ms)),
    clearTimeout: (t) => globalThis.clearTimeout(t),
    fetch: async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      // The effective cache mode: the init dictionary when given, else the request's own.
      const cacheMode = (init && init.cache) || (typeof input === 'string' ? undefined : input.cache);
      network.log.push({ url, cache: cacheMode, range: !!(init && init.headers && init.headers.has && init.headers.has('range')) });
      if (network.offline) throw new TypeError('Failed to fetch');
      const route = network.routes.get(url);
      if (!route) return new BasicResponse('not found', { status: 404 });
      const made = await route(init);
      const bytes = new Uint8Array(await made.arrayBuffer());
      const out = new BasicResponse(bytes, { status: made.status, headers: made.headers });
      return out;
    },
  };
  scope.self = scope;
  vm.createContext(scope);
  const source = fs.readFileSync(path.join(WEB, 'archiver-coi-sw.js'), 'utf8');
  vm.runInContext(source, scope, { filename: 'archiver-coi-sw.js' });
  return { scope, caches, network, listeners, sent, cacheApi };
}

/* Dispatch a lifecycle event; resolves once the worker's waitUntil promise settles. */
async function dispatch(worker, type) {
  let pending = null;
  worker.listeners[type]({ waitUntil(p) { pending = p; } });
  if (pending) await pending;
}

/* Dispatch a fetch event; returns the promise the worker handed to respondWith, or null
   if the worker chose to let the browser go to the network itself. */
function fetchTo(worker, req) {
  let promised = null;
  worker.listeners.fetch({ request: req, respondWith(p) { promised = p; } });
  return promised;
}

const settle = () => new Promise((r) => globalThis.setTimeout(r, 20));
const ok = (body, type) => new Response(body, { status: 200, headers: { 'content-type': type || 'text/plain' } });
const js = (body) => ok(body, 'text/javascript');
const shellPage = (body) => ok(body, 'text/html; charset=utf-8');

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok    ' + name);
  } catch (err) {
    failed++;
    console.log('  FAIL  ' + name + '\n        ' + String((err && err.stack) || err).split('\n').slice(0, 6).join('\n        '));
  }
}

async function cachedText(worker, cacheName, url) {
  const cache = await worker.cacheApi.open(cacheName);
  const hit = await cache.match(url);
  return hit ? hit.text() : null;
}

(async () => {
  console.log('Pages service worker (tests/sw.js)');
  const SHELL = 'archiver-shell-v5.4.0';

  await test('first install stores the shell and the app files it names, not the runtimes', async () => {
    const w = makeWorker();
    w.network.routes.set(SCOPE + 'index.html', () => shellPage(INDEX_HTML));
    w.network.routes.set(SCOPE + 'static/archiver-engine.js', () => js('// engine'));
    w.network.routes.set(SCOPE + 'favicon.svg', () => ok('<svg/>', 'image/svg+xml'));
    w.network.routes.set(SCOPE + 'manifest.json', () => ok('{}', 'application/json'));
    await dispatch(w, 'install');
    assert.equal(w.sent.skipWaiting, 1, 'nothing is open yet, so no waiting');
    assert.equal(await cachedText(w, SHELL, SCOPE + 'index.html'), INDEX_HTML);
    assert.equal(await cachedText(w, SHELL, SCOPE + 'static/archiver-engine.js'), '// engine');
    assert.equal(await cachedText(w, SHELL, SCOPE + 'favicon.svg'), '<svg/>');
    assert.equal(await cachedText(w, SHELL, SCOPE + 'manifest.json'), '{}');
    const keys = [...w.caches.get(SHELL).keys()];
    assert.ok(!keys.some(k => k.includes('static/vendor/')), 'runtimes are cached on first use, not at install');
    assert.ok(!keys.some(k => k.includes('huggingface') || k.includes('github.com')), 'no third-party link is stored');
  });

  await test('an update waits for the reader: no takeover until the page asks', async () => {
    const w = makeWorker({ activeRegistration: true });
    w.network.routes.set(SCOPE + 'index.html', () => shellPage('<html>new</html>'));
    await dispatch(w, 'install');
    assert.equal(w.sent.skipWaiting, 0, 'a running session is never swapped under the reader');
    w.listeners.message({ data: { type: 'SOMETHING_ELSE' } });
    assert.equal(w.sent.skipWaiting, 0, 'other messages do nothing');
    w.listeners.message({ data: { type: 'SKIP_WAITING' } });
    assert.equal(w.sent.skipWaiting, 1, 'the explicit action from the page is honoured');
  });

  await test('activation claims open pages and deletes only its own old caches', async () => {
    const w = makeWorker();
    w.caches.set('archiver-shell-v5.3.0', new Map([[SCOPE + 'index.html', { status: 200, headers: [], body: new Uint8Array(1) }]]));
    w.caches.set('webllm/model', new Map([['https://huggingface.co/x/tensor-cache.json', { status: 200, headers: [], body: new Uint8Array(2) }]]));
    w.caches.set(SHELL, new Map());
    await dispatch(w, 'activate');
    assert.equal(w.sent.claimed, 1);
    assert.ok(!w.caches.has('archiver-shell-v5.3.0'), 'the superseded shell is deleted');
    assert.ok(w.caches.has(SHELL), 'the current shell is kept');
    assert.ok(w.caches.has('webllm/model'), 'the runtime’s model cache is never touched');
  });

  await test('online navigation is fresh, isolated, and refreshes the stored shell', async () => {
    const w = makeWorker();
    w.network.routes.set(SCOPE, () => shellPage('<html>v1</html>'));
    const res = await fetchTo(w, makeRequest(SCOPE, { mode: 'navigate', destination: 'document' }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
    assert.equal(res.headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
    assert.equal(w.network.log[0].cache, 'no-store', 'the page itself is never taken from the HTTP cache');
    assert.equal(await res.text(), '<html>v1</html>');
    await settle();
    assert.equal(await cachedText(w, SHELL, SCOPE + 'index.html'), '<html>v1</html>', 'the stored shell was written (clone taken before the body was used)');
  });

  await test('the stored shell follows each online visit (a new deploy reaches the offline copy)', async () => {
    const w = makeWorker();
    let version = 1;
    w.network.routes.set(SCOPE, () => shellPage('<html>v' + (version++) + '</html>'));
    await (await fetchTo(w, makeRequest(SCOPE, { mode: 'navigate', destination: 'document' }))).text();
    await settle();
    await (await fetchTo(w, makeRequest(SCOPE, { mode: 'navigate', destination: 'document' }))).text();
    await settle();
    assert.equal(await cachedText(w, SHELL, SCOPE + 'index.html'), '<html>v2</html>');
  });

  await test('offline navigation opens the stored shell, with the isolation headers', async () => {
    const w = makeWorker();
    w.network.routes.set(SCOPE + 'index.html', () => shellPage('<html>cached shell</html>'));
    await dispatch(w, 'install');
    w.network.offline = true;
    const res = await fetchTo(w, makeRequest(SCOPE + '?chat=1#drafts', { mode: 'navigate', destination: 'document' }));
    assert.equal(res.status, 200, 'a real page, not a browser error');
    assert.equal(await res.text(), '<html>cached shell</html>');
    assert.equal(res.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp', 'cached documents carry the headers too');
  });

  await test('offline with nothing stored says so plainly', async () => {
    const w = makeWorker();
    w.network.offline = true;
    const res = await fetchTo(w, makeRequest(SCOPE, { mode: 'navigate', destination: 'document' }));
    assert.equal(res.status, 503);
    assert.match(await res.text(), /has not been opened on this device yet/);
  });

  await test('runtimes are cached on first use, then served from cache with no network, offline too', async () => {
    const w = makeWorker();
    const url = SCOPE + 'static/vendor/wllama-compat-3.6.1.wasm';
    let hits = 0;
    w.network.routes.set(url, () => { hits++; return new Response(new Uint8Array([0, 97, 115, 109]), { status: 200, headers: { 'content-type': 'application/wasm' } }); });
    await (await fetchTo(w, makeRequest(url, { destination: 'empty' }))).arrayBuffer();
    await settle();
    await (await fetchTo(w, makeRequest(url, { destination: 'empty' }))).arrayBuffer();
    assert.equal(hits, 1, 'the second request never reaches the network');
    w.network.offline = true;
    const offline = await fetchTo(w, makeRequest(url, { destination: 'empty' }));
    assert.equal(offline.status, 200, 'the runtime still loads with no connection');
    assert.equal(offline.headers.get('content-type'), 'application/wasm', 'and keeps its type (instantiateStreaming needs it)');
    assert.equal(offline.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
  });

  await test('app files are network first: a fresh deploy is what the page gets, revalidated', async () => {
    const w = makeWorker();
    const url = SCOPE + 'static/archiver-engine.js';
    let version = 1;
    w.network.routes.set(url, () => js('// engine v' + (version++)));
    assert.equal(await (await fetchTo(w, makeRequest(url, { destination: 'script' }))).text(), '// engine v1');
    assert.equal(await (await fetchTo(w, makeRequest(url, { destination: 'script' }))).text(), '// engine v2', 'no stale copy while online');
    assert.equal(w.network.log.at(-1).cache, 'no-cache', 'the request revalidates with the server');
  });

  await test('a slow network yields the last good copy, and the late answer still refreshes the cache', async () => {
    const w = makeWorker({ slowMs: 15 });
    const url = SCOPE + 'static/archiver-engine.js';
    let version = 1;
    w.network.routes.set(url, () => js('// engine v1'));
    await (await fetchTo(w, makeRequest(url, { destination: 'script' }))).text();
    await settle();
    w.network.routes.set(url, async () => {
      await new Promise((r) => globalThis.setTimeout(r, 80));
      return js('// engine v' + (++version));
    });
    const quick = await (await fetchTo(w, makeRequest(url, { destination: 'script' }))).text();
    assert.equal(quick, '// engine v1', 'the stored copy answers when the network is slow');
    await new Promise((r) => globalThis.setTimeout(r, 150));
    assert.equal(await cachedText(w, SHELL, url), '// engine v2', 'the late answer is stored for next time');
  });

  await test('a failed network with a stored copy serves the stored copy', async () => {
    const w = makeWorker();
    const url = SCOPE + 'static/archiver-engine.js';
    w.network.routes.set(url, () => js('// stored'));
    await (await fetchTo(w, makeRequest(url, { destination: 'script' }))).text();
    await settle();
    w.network.offline = true;
    assert.equal(await (await fetchTo(w, makeRequest(url, { destination: 'script' }))).text(), '// stored');
  });

  await test('model weights and other cross-origin requests are never touched', async () => {
    const w = makeWorker();
    const weights = 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/q.gguf';
    const r = fetchTo(w, makeRequest(weights, { mode: 'cors', destination: '' }));
    assert.equal(r, null, 'the worker does not answer cross-origin requests');
    assert.equal(w.caches.size, 0, 'and nothing is cached');
  });

  await test('requests outside this app’s directory are not handled', async () => {
    const w = makeWorker();
    const r = fetchTo(w, makeRequest('https://example.github.io/other-project/app.js', { destination: 'script' }));
    assert.equal(r, null);
    assert.equal(w.caches.size, 0);
  });

  await test('API data is always fresh and never stored', async () => {
    const w = makeWorker();
    let n = 0;
    w.network.routes.set(SCOPE + 'api/search?q=x', () => { n++; return new Response('{"n":' + n + '}', { status: 200, headers: { 'content-type': 'application/json' } }); });
    const a = await fetchTo(w, makeRequest(SCOPE + 'api/search?q=x', { destination: 'empty' }));
    const b = await fetchTo(w, makeRequest(SCOPE + 'api/search?q=x', { destination: 'empty' }));
    assert.equal(await a.text(), '{"n":1}');
    assert.equal(await b.text(), '{"n":2}');
    for (const store of w.caches.values()) {
      assert.ok(![...store.keys()].some(k => k.includes('/api/')), 'no API response is stored');
    }
  });

  await test('errors are not cached, so a fixed file is fetched again', async () => {
    const w = makeWorker();
    const url = SCOPE + 'static/archiver-prep.js';
    let status = 500;
    w.network.routes.set(url, () => new Response('oops', { status, headers: { 'content-type': 'text/javascript' } }));
    const broken = await fetchTo(w, makeRequest(url, { destination: 'script' }));
    assert.equal(broken.status, 500);
    await settle();
    status = 200;
    w.network.routes.set(url, () => js('// fixed'));
    assert.equal(await (await fetchTo(w, makeRequest(url, { destination: 'script' }))).text(), '// fixed');
  });

  await test('partial (Range) responses pass through and are never stored', async () => {
    const w = makeWorker();
    const url = SCOPE + 'static/vendor/wllama-3.6.1.wasm';
    w.network.routes.set(url, () => new Response(new Uint8Array(2), { status: 206, headers: { 'content-type': 'application/wasm' } }));
    const res = await fetchTo(w, makeRequest(url, { destination: 'empty', headers: new Headers({ Range: 'bytes=0-1' }) }));
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
    await settle();
    assert.equal([...w.caches.values()].reduce((n, s) => n + s.size, 0), 0, 'nothing stored');
  });

  await test('the service worker script itself always comes from the network', async () => {
    const w = makeWorker();
    const r = fetchTo(w, makeRequest(SCOPE + 'archiver-coi-sw.js', { destination: 'serviceworker' }));
    assert.equal(r, null, 'the browser’s update check is never answered from cache');
  });

  await test('workers and frames carry the isolation headers a COEP page requires', async () => {
    const w = makeWorker();
    const url = SCOPE + 'static/archiver-worker.js';
    w.network.routes.set(url, () => js('self.onmessage=()=>{}'));
    const res = await fetchTo(w, makeRequest(url, { destination: 'worker' }));
    assert.equal(res.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
    assert.equal(res.headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
  });

  await test('an opaque or status-0 response passes through without being rebuilt', async () => {
    const w = makeWorker();
    const opaque = { status: 0, type: 'opaque', headers: new Headers(), body: null };
    w.network.routes.set(SCOPE + 'api/opaque', () => { throw new Error('unused'); });
    w.scope.fetch = async () => opaque;
    const res = await fetchTo(w, makeRequest(SCOPE + 'api/opaque', { destination: 'empty' }));
    assert.equal(res, opaque, 'returned as-is');
  });

  await test('the cache version follows the app version', async () => {
    const engine = fs.readFileSync(path.join(WEB, 'archiver-engine.js'), 'utf8');
    const app = (engine.match(/const VERSION = '([\d.]+)';/) || [])[1];
    const sw = fs.readFileSync(path.join(WEB, 'archiver-coi-sw.js'), 'utf8');
    const cache = (sw.match(/CACHE_VERSION = '([\d.]+)'/) || [])[1];
    assert.ok(app && cache, 'both versions found');
    assert.equal(cache.split('.').slice(0, 2).join('.'), app, `cache ${cache} follows app ${app}`);
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})().catch((err) => {
  console.error('sw suite crashed', err);
  process.exit(1);
});
