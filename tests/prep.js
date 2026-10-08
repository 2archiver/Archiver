/* Model preparation: the one controller in web/archiver-prep.js, run against the real
   wllama 3.6.1 storage code in a simulated browser (tests/harness.js).

   What is real here: wllama's CacheManager, ModelManager and Model (validation,
   downloads, metadata), the streaming SHA-256 worker, and the controller's state
   machine. What is simulated: OPFS, the Cache API, Web Locks, the network and the
   inference runtime (the engine's own hooks are replaced by plain functions).

   node --experimental-vm-modules tests/prep.js */
'use strict';
const assert = require('node:assert/strict');
const { createBrowser, createOrigin, fakeGGUF, sha256Hex } = require('./harness.js');

const Q4_0 = 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_0.gguf';
const Q4_K_M = 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf';
const Q8_0 = 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q8_0.gguf';
const QWEN3_Q4 = 'https://huggingface.co/ggml-org/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_0.gguf';
const SESSIONS_KEY = 'archiver_sessions_v3';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok    ' + name);
  } catch (err) {
    failed++;
    console.log('  FAIL  ' + name + '\n        ' + ((err && err.stack) || err).toString().split('\n').slice(0, 6).join('\n        '));
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(predicate, ms, label) {
  const end = Date.now() + (ms || 4000);
  while (Date.now() < end) {
    if (await predicate()) return true;
    await sleep(5);
  }
  throw new Error('timed out waiting for ' + (label || 'condition'));
}

const gets = (origin, url) => origin.fetchLog.filter(f => f.method === 'GET' && f.url === url).length;
const heads = (origin, url) => origin.fetchLog.filter(f => f.method === 'HEAD' && f.url === url).length;

/* A runtime stand-in for the controller's hooks: records what it was asked to start. */
function runtimeHooks(log) {
  return {
    probeGPU: async () => ({ ok: false, reason: 'no WebGPU adapter in this test' }),
    wasmSupported: () => true,
    initWASM: async (artifact, source) => {
      log.push({ id: artifact.id, quant: artifact.quant, source: source && source.constructor && source.constructor.name });
      return { started: artifact.quant };
    }
  };
}

function hubFile(origin, url, bytes, extra) {
  origin.hub.set(url, Object.assign({ bytes, sha256: sha256Hex(bytes) }, extra || {}));
}

(async () => {
  console.log('Model preparation controller (tests/prep.js)');
  const bytes = fakeGGUF(300 * 1024, 11);
  const bytesAlt = fakeGGUF(256 * 1024, 29);

  /* ----- adoption and validation: verify contents, not names or settings ----- */

  await test('a backend hint without files is not a cache hit', async () => {
    const origin = createOrigin();
    hubFile(origin, Q4_0, bytes);
    const b = await createBrowser({ origin });
    b.ctx.localStorage.setItem('archiver.models.v2', JSON.stringify({
      'wasm|Qwen2.5-0.5B-Instruct/Q4_0|3.6.1|main': { complete: true, verify: 'sha256' }
    }));
    b.Prep.configure(runtimeHooks([]));
    const ok = await b.Prep.ensureReady({ source: 'manual', allowDownload: false, allowInit: true });
    assert.equal(ok, false, 'no weights, so no ready model');
    const s = b.Prep.snapshot();
    assert.notEqual(s.phase, 'cached');
    assert.equal(s.cachedAt, 0);
    assert.equal(gets(origin, Q4_0), 0, 'nothing was downloaded without consent');
  });

  await test('a complete cache is adopted with no download and no hashing on a repeat visit', async () => {
    const origin = createOrigin();
    hubFile(origin, Q4_0, bytes);
    const first = await createBrowser({ origin });
    first.Prep.configure(runtimeHooks([]));
    assert.equal(await first.Prep.ensureReady({ source: 'manual', allowDownload: true, allowInit: false }), false, 'downloaded, not started');
    assert.equal(first.Prep.snapshot().phase, 'cached');
    const hashesAfterFirst = origin.hashJobs;
    assert.equal(gets(origin, Q4_0), 1);

    // A new page on the same origin: the reload path.
    const again = await createBrowser({ origin });
    const log = [];
    again.Prep.configure(runtimeHooks(log));
    await again.Prep.init();
    assert.equal(await again.Prep.ensureReady({ source: 'manual', allowDownload: false, allowInit: true }), true);
    assert.equal(gets(origin, Q4_0), 1, 'no second transfer');
    assert.equal(origin.hashJobs, hashesAfterFirst, 'no second checksum on a repeat visit');
    assert.equal(log.length, 1);
    assert.equal(log[0].quant, 'Q4_0');
  });

  await test('weights stored by an earlier version without a manifest are adopted after one check', async () => {
    const origin = createOrigin();
    hubFile(origin, Q4_0, bytes);
    const first = await createBrowser({ origin });
    first.Prep.configure(runtimeHooks([]));
    await first.Prep.ensureReady({ source: 'manual', allowDownload: true, allowInit: false });
    first.ctx.localStorage.removeItem('archiver.models.v2');      // what a 5.3 install has
    const hashes = origin.hashJobs;
    const again = await createBrowser({ origin });
    again.Prep.configure(runtimeHooks([]));
    await again.Prep.ensureReady({ source: 'manual', allowDownload: false, allowInit: false });
    assert.equal(gets(origin, Q4_0), 1, 'adopted, not downloaded again');
    assert.equal(origin.hashJobs, hashes + 1, 'one checksum to earn the manifest');
    assert.ok(again.ctx.localStorage.getItem('archiver.models.v2').includes('"complete":true'));
  });

  await test('a truncated cache is not adopted; it is downloaded again', async () => {
    const origin = createOrigin();
    hubFile(origin, Q4_0, bytes);
    const first = await createBrowser({ origin });
    first.Prep.configure(runtimeHooks([]));
    await first.Prep.ensureReady({ source: 'manual', allowDownload: true, allowInit: false });
    // Truncate the stored file behind wllama's metadata.
    const key = [...origin.opfs.keys()].find(k => !k.startsWith('__metadata__'));
    origin.opfs.set(key, origin.opfs.get(key).slice(0, 100 * 1024));
    const again = await createBrowser({ origin });
    again.Prep.configure(runtimeHooks([]));
    assert.equal(await again.Prep.ensureReady({ source: 'manual', allowDownload: true, allowInit: false }), false);
    assert.equal(gets(origin, Q4_0), 2, 'the truncated file was fetched again');
    assert.equal(again.Prep.snapshot().verified, 'sha256');
  });

  await test('a missing shard makes a split model invalid (validation, not names)', async () => {
    const origin = createOrigin();
    const shard1 = 'https://example.test/models/big-00001-of-00002.gguf';
    const shard2 = 'https://example.test/models/big-00002-of-00002.gguf';
    hubFile(origin, shard1, bytes);
    hubFile(origin, shard2, bytesAlt);
    const b = await createBrowser({ origin });
    b.Prep.configure(runtimeHooks([]));
    // wllama downloads every shard of a split model; then one shard goes missing.
    const kit = await b.Prep.runtimeKit();
    await kit.modelManager.downloadModel({ url: shard1 }, {});
    let models = await kit.modelManager.getModels({ includeInvalid: true });
    assert.equal(models[0].validate(), 'valid', 'both shards present');
    await kit.cacheManager.deleteMany(e => !!e.metadata && e.metadata.originalURL === shard2);
    // wllama refuses to describe a model whose shard is gone; either way it is not valid.
    let listed = null;
    try { listed = await kit.modelManager.getModels({ includeInvalid: true }); } catch (err) {
      assert.match(String(err.message), /Model file not found/);
    }
    if (listed) assert.ok(listed.every(m => m.validate() !== 'valid'), 'no valid model remains');
    const found = await b.Prep._internal.findValidWasm({ url: shard1 });
    assert.ok(!found || found.invalid, 'and the controller will not adopt it');
  });

  await test('the app-shell cache alone is not a model', async () => {
    const origin = createOrigin();
    origin.caches.set('archiver-shell-v5.4.0', new Map([['http://localhost/Archiver/index.html', { status: 200, headers: [], body: new Uint8Array(4) }]]));
    const b = await createBrowser({ origin });
    b.Prep.configure(runtimeHooks([]));
    assert.equal(await b.Prep.ensureReady({ source: 'send', allowDownload: false, allowInit: true }), false);
    assert.notEqual(b.Prep.snapshot().phase, 'cached');
  });

  /* ----- gates: Save-Data, slow links, offline, storage, visibility ----- */

  await test('Save-Data with a cache hit starts from the cache, without a download', async () => {
    const origin = createOrigin();
    hubFile(origin, Q4_0, bytes);
    const seed = await createBrowser({ origin });
    seed.Prep.configure(runtimeHooks([]));
    await seed.Prep.ensureReady({ source: 'manual', allowDownload: true, allowInit: false });
    const log = [];
    const b = await createBrowser({ origin, navigator: { connection: { saveData: true, effectiveType: '4g' } } });
    b.Prep.configure(runtimeHooks(log));
    b.Prep.maybeAuto();
    await until(() => b.Prep.snapshot().phase === 'ready', 3000, 'ready from cache');
    assert.equal(log.length, 1);
    assert.equal(gets(origin, Q4_0), 1, 'still only the first visit transferred');
  });

  await test('Save-Data without a cache waits, says why, and downloads only on request', async () => {
    const origin = createOrigin();
    hubFile(origin, Q4_0, bytes);
    const b = await createBrowser({ origin, navigator: { connection: { saveData: true, effectiveType: '4g' } } });
    b.Prep.configure(runtimeHooks([]));
    await b.Prep.maybeAuto();
    const s = b.Prep.snapshot();
    assert.equal(s.phase, 'paused');
    assert.match(s.reason, /Data Saver/);
    assert.equal(gets(origin, Q4_0), 0, 'nothing downloaded on a metered connection');
    await b.Prep.prepareNow();
    assert.equal(gets(origin, Q4_0), 1, 'Prepare now is the explicit override');
  });

  await test('a slow connection is treated like Data Saver for automatic preparation', async () => {
    const origin = createOrigin();
    hubFile(origin, Q4_0, bytes);
    const b = await createBrowser({ origin, navigator: { connection: { saveData: false, effectiveType: '3g', downlink: 0.4 } } });
    b.Prep.configure(runtimeHooks([]));
    await b.Prep.maybeAuto();
    assert.equal(b.Prep.snapshot().phase, 'paused');
    assert.match(b.Prep.snapshot().reason, /slow/);
    assert.equal(gets(origin, Q4_0), 0);
  });

  await test('offline: a complete cache is ready; without one the page says it is offline', async () => {
    const origin = createOrigin();
    hubFile(origin, Q4_0, bytes);
    const seed = await createBrowser({ origin });
    seed.Prep.configure(runtimeHooks([]));
    await seed.Prep.ensureReady({ source: 'manual', allowDownload: true, allowInit: false });
    origin.network.offline = true;
    const log = [];
    const b = await createBrowser({ origin, navigator: { onLine: false } });
    b.Prep.configure(runtimeHooks(log));
    assert.equal(await b.Prep.ensureReady({ source: 'send', allowDownload: false, allowInit: true }), true, 'offline with a complete model');
    assert.equal(log.length, 1);

    const empty = createOrigin();
    const c = await createBrowser({ origin: empty, navigator: { onLine: false } });
    c.Prep.configure(runtimeHooks([]));
    await c.Prep.maybeAuto();
    assert.equal(c.Prep.snapshot().phase, 'paused');
    assert.match(c.Prep.snapshot().reason, /offline/);
  });

  await test('storage denied: weights are session-only, nothing is written, the state says so', async () => {
    const origin = createOrigin();
    hubFile(origin, Q4_0, bytes);
    const b = await createBrowser({ origin, durableOPFS: false, storage: { denied: true } });
    b.Prep.configure(runtimeHooks([]));
    await b.Prep.init();
    assert.equal(b.Prep.snapshot().durable, false);
    assert.equal(b.Prep.snapshot().storage, 'memory', 'preferences fall back to memory');
    await b.Prep.maybeAuto();
    assert.equal(b.Prep.snapshot().phase, 'paused', 'no background download when nothing can be kept');
    assert.match(b.Prep.snapshot().reason, /storage is unavailable/);
    assert.equal(gets(origin, Q4_0), 0);
    const log = [];
    b.Prep.configure(runtimeHooks(log));
    assert.equal(await b.Prep.ensureReady({ source: 'send', allowDownload: true, allowInit: true }), true, 'a question still works for this session');
    assert.equal(log[0].source, 'Blob', 'the weights are held in memory');
    assert.equal(origin.opfs.size, 0, 'nothing was written to storage');
    assert.equal(origin.local.has('archiver.models.v2'), false, 'no manifest without storage');
  });

  await test('a write that hits the quota fails once, as a storage error, and leaves no partial file', async () => {
    const origin = createOrigin();
    hubFile(origin, Q4_0, bytes);
    origin.failWrites = { afterBytes: 64 * 1024 };
    const b = await createBrowser({ origin });
    b.Prep.configure(runtimeHooks([]));
    assert.equal(await b.Prep.prepareNow(), false);
    const s = b.Prep.snapshot();
    assert.equal(s.phase, 'failed');
    assert.equal(s.error.category, 'storage');
    assert.equal(gets(origin, Q4_0), 1, 'a full disk is not retried');
    assert.ok(!origin.opfs.has([...origin.opfs.keys()].find(k => /qwen2\.5-0\.5b-instruct-q4_0/.test(k) && !k.startsWith('__')) || '__none__'), 'no truncated final file');
  });

  await test('the quota check refuses a download that would not fit, with a margin', async () => {
    const origin = createOrigin({ quota: 300 * 1024 + 5 * 1024 * 1024 });
    hubFile(origin, Q4_0, bytes);
    const b = await createBrowser({ origin });
    b.Prep.configure(runtimeHooks([]));
    assert.equal(await b.Prep.prepareNow(), false);
    assert.equal(b.Prep.snapshot().error.category, 'storage');
    assert.match(b.Prep.snapshot().error.message, /storage/i);
    assert.equal(gets(origin, Q4_0), 0, 'refused before any transfer');
  });

  await test('persist denied is reported as denied, not as persistent', async () => {
    const origin = createOrigin({ persistAnswer: false });
    hubFile(origin, Q4_0, bytes);
    const b = await createBrowser({ origin });
    b.Prep.configure(runtimeHooks([]));
    await b.Prep.prepareNow();
    assert.equal(b.Prep.snapshot().persist, 'denied');
    const granted = await createBrowser({ origin: createOrigin({ persisted: true, persistAnswer: true }) });
    granted.Prep.configure(runtimeHooks([]));
    await granted.Prep.init();
    assert.equal(granted.Prep.snapshot().persist, 'granted');
  });

  /* ----- scheduling: after first paint, while visible ----- */

  await test('automatic preparation waits for the page to be visible, then starts once', async () => {
    const origin = createOrigin();
    hubFile(origin, Q4_0, bytes);
    const b = await createBrowser({ origin, visibility: 'hidden', requestIdle: true });
    b.Prep.configure(runtimeHooks([]));
    b.Prep.scheduleAuto();
    await sleep(60);
    assert.equal(gets(origin, Q4_0), 0, 'a hidden tab starts no large work');
    b.ctx.__visibility.state = 'visible';
    for (const fn of b.ctx.__visibility.listeners) fn({});
    await until(() => b.Prep.snapshot().phase === 'cached' || b.Prep.snapshot().phase === 'ready', 4000, 'auto-prep');
    assert.equal(gets(origin, Q4_0), 1);
  });

  await test('cold auto-prep on desktop downloads, verifies, and starts without a click', async () => {
    const origin = createOrigin();
    hubFile(origin, Q4_0, bytes);
    const log = [];
    const b = await createBrowser({ origin, requestIdle: true });
    b.Prep.configure(runtimeHooks(log));
    const seen = [];
    b.Prep.subscribe(s => seen.push(s.phase));
    b.Prep.scheduleAuto();
    await until(() => b.Prep.snapshot().phase === 'ready', 4000, 'ready');
    for (const phase of ['downloading', 'verifying', 'cached', 'initializing', 'ready']) {
      assert.ok(seen.includes(phase), 'passed through ' + phase);
    }
    assert.equal(log.length, 1);
  });

  await test('on a touch-first device auto-prep stores the file and waits for the first question', async () => {
    const origin = createOrigin();
    hubFile(origin, Q4_0, bytes);
    const log = [];
    const b = await createBrowser({ origin, touch: true });
    b.Prep.configure(runtimeHooks(log));
    await b.Prep.maybeAuto();
    assert.equal(b.Prep.snapshot().phase, 'cached');
    assert.equal(log.length, 0, 'not started before a question');
    assert.equal(await b.Prep.ensureReady({ source: 'send', allowDownload: true, allowInit: true }), true);
    assert.equal(log.length, 1);
  });

  await test('automatic preparation can be turned off, and the choice survives a reload', async () => {
    const origin = createOrigin();
    hubFile(origin, Q4_0, bytes);
    const b = await createBrowser({ origin, requestIdle: true });
    b.Prep.configure(runtimeHooks([]));
    b.Prep.setAuto(false);
    b.Prep.scheduleAuto();
    await sleep(40);
    assert.equal(gets(origin, Q4_0), 0);
    assert.equal(b.Prep.snapshot().auto, false);
    const again = await createBrowser({ origin: origin });
    assert.equal(again.Prep.snapshot().auto, false, 'stored preference');
  });

  /* ----- joins, cancel, pause, stalls, retries ----- */

  await test('a question joins the preparation already running instead of starting another', async () => {
    const origin = createOrigin();
    hubFile(origin, Q4_0, bytes, { chunkDelayMs: 2, chunkSize: 8 * 1024 });
    const b = await createBrowser({ origin });
    const log = [];
    b.Prep.configure(runtimeHooks(log));
    const auto = b.Prep.prepareNow();
    await until(() => b.Prep.snapshot().phase === 'downloading', 2000);
    const joined = b.Prep.joinOnSend();
    const [a, j] = await Promise.all([auto, joined]);
    assert.equal(a, true);
    assert.equal(j, true);
    assert.equal(gets(origin, Q4_0), 1, 'one transfer for both');
    assert.equal(log.length, 1, 'one start');
  });

  await test('a stall is detected, and a slow but moving download is never cut off', async () => {
    const origin = createOrigin();
    // 300 KB at 4 KB per 40 ms is about 3 s: far longer than the stall limit, but always moving.
    hubFile(origin, Q4_0, bytes, { chunkDelayMs: 40, chunkSize: 4 * 1024 });
    const b = await createBrowser({ origin, timeouts: { stallMs: 400 } });
    b.Prep.configure(runtimeHooks([]));
    const t0 = Date.now();
    assert.equal(await b.Prep.prepareNow(), true);
    assert.ok(Date.now() - t0 > 400, 'ran past the stall limit');
    assert.equal(gets(origin, Q4_0), 1, 'never restarted');
  });

  await test('a download that goes silent is stopped, retried a bounded number of times, then reported as a stall', async () => {
    const origin = createOrigin();
    hubFile(origin, Q4_0, bytes, { stallAt: 16 * 1024 });
    const b = await createBrowser({ origin, timeouts: { stallMs: 150, backoffMs: [5, 5, 5] } });
    b.Prep.configure(runtimeHooks([]));
    assert.equal(await b.Prep.prepareNow(), false);
    const s = b.Prep.snapshot();
    assert.equal(s.phase, 'failed');
    assert.equal(s.error.category, 'stall');
    assert.equal(gets(origin, Q4_0), 4, 'one attempt and three bounded retries');
  });

  await test('transient network errors are retried with a bound, then reported', async () => {
    const origin = createOrigin();
    hubFile(origin, Q4_0, bytes);
    const plan = [{ match: /qwen2\.5-0\.5b-instruct-q4_0\.gguf$/, error: 'Failed to fetch' }];
    const b = await createBrowser({ origin, plan, timeouts: { backoffMs: [5, 5, 5] } });
    b.Prep.configure(runtimeHooks([]));
    assert.equal(await b.Prep.prepareNow(), false);
    assert.equal(b.Prep.snapshot().error.category, 'network');
    // Every request for the file counts (the size lookup fails first on each attempt).
    const attempts = origin.fetchLog.filter(f => f.url === Q4_0).length;
    assert.ok(attempts >= 4 && attempts <= 6, 'one attempt and three bounded retries, got ' + attempts);
  });

  await test('cancel stops the transfer, does not fall back, and a question does not restart it', async () => {
    const origin = createOrigin();
    hubFile(origin, Q4_0, bytes, { chunkDelayMs: 5, chunkSize: 4 * 1024 });
    hubFile(origin, Q4_K_M, bytes);
    const b = await createBrowser({ origin });
    const log = [];
    b.Prep.configure(runtimeHooks(log));
    const running = b.Prep.prepareNow();
    await until(() => b.Prep.snapshot().phase === 'downloading', 2000);
    b.Prep.cancel();
    assert.equal(await running, false);
    const s = b.Prep.snapshot();
    assert.equal(s.phase, 'idle');
    assert.match(s.reason, /stopped/i);
    assert.equal(gets(origin, Q4_K_M), 0, 'no fallback source after a cancel');
    assert.equal(await b.Prep.joinOnSend(), false, 'a question does not restart a cancelled download');
    assert.equal(gets(origin, Q4_0), 1);
    assert.equal(log.length, 0);
  });

  await test('pause stops the transfer and says the next run restarts it', async () => {
    const origin = createOrigin();
    hubFile(origin, Q4_0, bytes, { chunkDelayMs: 5, chunkSize: 4 * 1024 });
    const b = await createBrowser({ origin });
    b.Prep.configure(runtimeHooks([]));
    const running = b.Prep.prepareNow();
    await until(() => b.Prep.snapshot().phase === 'downloading', 2000);
    b.Prep.pause();
    await running;
    assert.equal(b.Prep.snapshot().phase, 'paused');
    assert.match(b.Prep.snapshot().reason, /restarts/);
  });

  /* ----- source fallback, corruption, and single-artifact cleanup ----- */

  await test('an unpublished quantization falls back to the next listed one, with a fresh start', async () => {
    const origin = createOrigin();
    hubFile(origin, Q4_0, bytes);
    hubFile(origin, Q4_K_M, bytesAlt);
    origin.hub.get(Q4_0).pointer = true;
    const plan = [{ match: /qwen2\.5-0\.5b-instruct-q4_0\.gguf$/, status: 404, once: false }];
    const b = await createBrowser({ origin, plan });
    const log = [];
    b.Prep.configure(runtimeHooks(log));
    assert.equal(await b.Prep.prepareNow(), true);
    assert.equal(log[0].quant, 'Q4_K_M');
    assert.equal(gets(origin, Q4_K_M), 1);
  });

  await test('a checksum mismatch rejects that download, removes it, and moves on to the next artifact', async () => {
    const origin = createOrigin();
    hubFile(origin, Q4_0, bytes);
    origin.hub.get(Q4_0).sha256 = sha256Hex(fakeGGUF(300 * 1024, 999));   // the publisher digest is wrong
    hubFile(origin, Q4_K_M, bytesAlt);
    const b = await createBrowser({ origin });
    b.ctx.localStorage.setItem(SESSIONS_KEY, JSON.stringify([{ id: 's1', title: 'keep me' }]));
    const log = [];
    b.Prep.configure(runtimeHooks(log));
    assert.equal(await b.Prep.prepareNow(), true);
    assert.equal(log[0].quant, 'Q4_K_M', 'the next listed artifact started');
    assert.equal(gets(origin, Q4_0), 2, 'fetched, rejected, fetched once more, rejected');
    const manifest = JSON.parse(b.ctx.localStorage.getItem('archiver.models.v2') || '{}');
    assert.equal(manifest['wasm|Qwen2.5-0.5B-Instruct/Q4_0|3.6.1|main'], undefined, 'no manifest for the rejected artifact');
    assert.equal(b.ctx.localStorage.getItem(SESSIONS_KEY), JSON.stringify([{ id: 's1', title: 'keep me' }]), 'chats untouched');
  });

  await test('targeted cleanup removes one artifact and keeps other weights and every chat', async () => {
    const origin = createOrigin();
    hubFile(origin, Q8_0, bytesAlt);
    hubFile(origin, Q4_K_M, bytes);
    const b = await createBrowser({ origin });
    b.Prep.configure(runtimeHooks([]));
    const kit = await b.Prep.runtimeKit();
    await kit.modelManager.downloadModel({ url: Q8_0 }, {});
    await kit.modelManager.downloadModel({ url: Q4_K_M }, {});
    b.ctx.localStorage.setItem(SESSIONS_KEY, '[1,2,3]');
    await b.Prep.inventory();
    // Q4_0 has nothing stored: dropping it is a no-op for the others.
    await b.Prep._internal.dropArtifact({ url: Q4_0, id: 'Qwen2.5-0.5B-Instruct', quant: 'Q4_0' });
    let models = await kit.modelManager.getModels();
    assert.equal(JSON.stringify(models.map(m => m.url).sort()), JSON.stringify([Q4_K_M, Q8_0].sort()));
    await b.Prep._internal.dropArtifact({ url: Q8_0, id: 'Qwen2.5-0.5B-Instruct', quant: 'Q8_0' });
    models = await kit.modelManager.getModels();
    assert.equal(JSON.stringify(models.map(m => m.url)), JSON.stringify([Q4_K_M]), 'only the dropped artifact is gone');
    assert.equal(b.ctx.localStorage.getItem(SESSIONS_KEY), '[1,2,3]', 'chats untouched');
  });

  await test('clearing model files keeps chats and settings', async () => {
    const origin = createOrigin();
    hubFile(origin, Q4_0, bytes);
    const b = await createBrowser({ origin });
    b.Prep.configure(runtimeHooks([]));
    await b.Prep.prepareNow();
    b.ctx.localStorage.setItem(SESSIONS_KEY, '[1]');
    b.ctx.localStorage.setItem('archiver_settings_v3', '{"persona":"x"}');
    await b.Prep.clearModelFiles();
    assert.equal(origin.opfs.size, 0, 'model files gone');
    assert.equal(b.ctx.localStorage.getItem(SESSIONS_KEY), '[1]', 'chats kept');
    assert.equal(b.ctx.localStorage.getItem('archiver_settings_v3'), '{"persona":"x"}', 'settings kept');
    assert.equal(b.Prep.snapshot().cachedAt, 0);
  });

  /* ----- two tabs ----- */

  await test('two tabs share one download: the second waits, then adopts the stored file', async () => {
    const origin = createOrigin();
    hubFile(origin, Q4_0, bytes, { chunkDelayMs: 3, chunkSize: 8 * 1024 });
    const a = await createBrowser({ origin });
    const c = await createBrowser({ origin });
    const logA = [];
    const logC = [];
    a.Prep.configure(runtimeHooks(logA));
    c.Prep.configure(runtimeHooks(logC));
    const [ra, rc] = await Promise.all([a.Prep.prepareNow(), c.Prep.prepareNow()]);
    assert.equal(ra, true);
    assert.equal(rc, true);
    assert.equal(gets(origin, Q4_0), 1, 'exactly one transfer across both tabs');
    assert.equal(logA.length + logC.length, 2, 'both tabs can start their own runtime');
  });

  await test('two tabs without Web Locks still share one download through the expiring lease', async () => {
    const origin = createOrigin();
    hubFile(origin, Q4_0, bytes, { chunkDelayMs: 3, chunkSize: 8 * 1024 });
    const a = await createBrowser({ origin, noLocks: true });
    const c = await createBrowser({ origin, noLocks: true });
    a.Prep.configure(runtimeHooks([]));
    c.Prep.configure(runtimeHooks([]));
    const [ra, rc] = await Promise.all([a.Prep.prepareNow(), c.Prep.prepareNow()]);
    assert.equal(ra && rc, true);
    assert.equal(gets(origin, Q4_0), 1);
  });

  /* ----- page lifecycle ----- */

  await test('pagehide while a download runs stops it cleanly; a back-forward restore keeps it', async () => {
    const origin = createOrigin();
    hubFile(origin, Q4_0, bytes, { chunkDelayMs: 5, chunkSize: 4 * 1024 });
    const b = await createBrowser({ origin });
    b.Prep.configure(runtimeHooks([]));
    const running = b.Prep.prepareNow();
    await until(() => b.Prep.snapshot().phase === 'downloading', 2000);
    b.ctx.dispatchEvent('pagehide', { persisted: true });
    await sleep(30);
    assert.equal(b.Prep.inFlight(), true, 'a page kept in the back-forward cache keeps its work');
    b.ctx.dispatchEvent('pagehide', { persisted: false });
    assert.equal(await running, false);
    assert.equal(b.Prep.snapshot().phase, 'paused');
    assert.match(b.Prep.snapshot().reason, /closing/);
  });

  await test('a reload finds the same state from storage alone', async () => {
    const origin = createOrigin();
    hubFile(origin, Q4_0, bytes);
    const a = await createBrowser({ origin });
    a.Prep.configure(runtimeHooks([]));
    await a.Prep.prepareNow();
    const b = await createBrowser({ origin });
    await b.Prep.init();
    b.Prep.configure(runtimeHooks([]));
    b.Prep.maybeAuto();
    await until(() => b.Prep.snapshot().phase === 'ready' || b.Prep.snapshot().phase === 'cached', 3000);
    assert.equal(b.Prep.snapshot().verified, 'sha256');
  });

  /* ----- catalogue and identity ----- */

  await test('the fallback model is Qwen3-0.6B and only after every primary artifact is unavailable', async () => {
    const origin = createOrigin();
    const b = await createBrowser({ origin });
    const names = b.Prep.CATALOG.wasm.primary.map(a => a.quant).join(',');
    assert.equal(names, 'Q4_0,Q4_K_M,Q8_0');
    assert.ok(b.Prep.CATALOG.wasm.fallback.every(a => a.id === 'Qwen3-0.6B'));
    assert.equal(b.Prep.CATALOG.wasm.fallback[0].url, QWEN3_Q4);
    assert.equal(b.Prep.RUNTIME.wllama.version, '3.6.1');
    assert.equal(b.Prep.RUNTIME.webllm.version, '0.2.80');
    assert.equal(b.Prep.RUNTIME.wllamaCompatWasm, 'static/vendor/wllama-compat-3.6.1.wasm');
  });

  await test('the controller never reports a model name that is not the artifact it started', async () => {
    const origin = createOrigin();
    hubFile(origin, Q4_0, bytes);
    const b = await createBrowser({ origin });
    b.Prep.configure(runtimeHooks([]));
    await b.Prep.prepareNow();
    const s = b.Prep.snapshot();
    assert.equal(s.model, 'Qwen 2.5 0.5B Instruct Q4_0');
    assert.equal(b.Prep.artifactLabel({ id: 'Qwen3-0.6B', quant: 'Q8_0' }), 'Qwen 3 0.6B Q8_0');
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})().catch((err) => {
  console.error('prep suite crashed', err);
  process.exit(1);
});
