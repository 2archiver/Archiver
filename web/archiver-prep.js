/* Archiver 5.4 — one controller for every path that puts a model into this browser.

   Before 5.4, five functions (warm, warmNow, prepare, load, retryAI) each decided
   for themselves when to download, and the boot path had its own user-agent
   check. The same model could be requested from several places at once, and a
   failure in one left another stuck. This module is the only place that decides:

     idle → checking → downloading → verifying → cached → initializing → ready
                                   ↘ paused (offline, Data Saver, slow link, cancelled)
                                   ↘ failed (categorised error, with Retry)

   Rules it enforces:
   * Verification is of the stored bytes, not of settings or cache names. A WASM
     model is adopted only when wllama's own Model.validate() passes AND the file
     starts with the GGUF magic. Checksums (streaming, in a worker) run once, after
     a fresh download or when adopting weights that have no manifest yet — never on
     every visit.
   * A manifest entry (backend, model, runtime version, artifact revision) is
     written only after the file is committed and verified. It lives in
     localStorage. Model bytes live only in the runtime's OPFS cache.
   * One download at a time per origin: Web Locks, with an expiring localStorage
     lease when Web Locks is missing. A second tab waits, then adopts the result.
   * Auto-preparation starts only while the page is visible, after first paint,
     and never on Data Saver, slow or offline connections. "Prepare now" is the
     explicit override. Mobile downloads to storage and initializes on the first
     question.
   * Sending a question joins the preparation in flight, or starts it under the
     same gates. A cancel stops everything for this page session: no fallback.
   * Transfers have no total timeout. A stall (no bytes for a while) and an
     initialization watchdog are the only time limits. Retries are bounded and
     categorised. Corrupt artifacts are removed individually, never chats or
     settings.
   * The runtime is initialized by the engine through the injected hooks below.
     This module never imports the chat engine, so it can be tested alone.

   Exposed as globalThis.ArchiverPrep. */
(function (root) {
  'use strict';

  var VERSION = '5.4';
  var MB = 1024 * 1024;

  /* Pinned runtimes. Files are versioned and served by app/main.py (VENDOR_ASSETS)
     and by the Pages build. A bump changes these names, the vendor scripts and the
     route table together. */
  var RUNTIME = {
    version: VERSION,
    webllm: { file: 'static/vendor/web-llm-0.2.80.js', version: '0.2.80' },
    wllama: { file: 'static/vendor/wllama-3.6.1.js', version: '3.6.1' },
    wllamaWasm: 'static/vendor/wllama-3.6.1.wasm',
    wllamaCompatJs: 'static/vendor/wllama-compat-3.6.1.js',
    wllamaCompatWasm: 'static/vendor/wllama-compat-3.6.1.wasm',
    gpuWorker: 'static/archiver-worker.js',
    hashWorker: 'static/archiver-hash-worker.js'
  };

  /* Model catalogue. Qwen2.5-0.5B-Instruct is the default on both runtimes; the
     Qwen3-0.6B entries are fallbacks only. Both are open models published by their
     authors (Qwen, ggml-org, unsloth, MLC). Archiver does not train or modify them. */
  var CATALOG = {
    webgpu: {
      primary: ['Qwen2.5-0.5B-Instruct-q4f16_1-MLC', 'Qwen2.5-0.5B-Instruct-q4f32_1-MLC'],
      fallback: ['Qwen3-0.6B-q4f16_1-MLC', 'Qwen3-0.6B-q4f32_1-MLC']
    },
    wasm: {
      /* One artifact is chosen before any transfer starts. The next entry is tried
         only when the publisher answers "not available" for this one. Q4_0 first:
         4-bit block quantization decodes fastest on llama.cpp's SIMD/NEON paths. */
      primary: [
        { id: 'Qwen2.5-0.5B-Instruct', quant: 'Q4_0', family: 'primary',
          url: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_0.gguf' },
        { id: 'Qwen2.5-0.5B-Instruct', quant: 'Q4_K_M', family: 'primary',
          url: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf' },
        { id: 'Qwen2.5-0.5B-Instruct', quant: 'Q8_0', family: 'primary',
          url: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q8_0.gguf' }
      ],
      fallback: [
        { id: 'Qwen3-0.6B', quant: 'Q4_0', family: 'fallback',
          url: 'https://huggingface.co/ggml-org/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_0.gguf' },
        { id: 'Qwen3-0.6B', quant: 'Q4_K_M', family: 'fallback',
          url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf' },
        { id: 'Qwen3-0.6B', quant: 'Q8_0', family: 'fallback',
          url: 'https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf' }
      ]
    }
  };

  /* Time limits. Tests shrink them through configure({ timeouts }). None of them
     is a total download time: a healthy transfer may run as long as it needs. */
  var TIMEOUTS = {
    headMs: 15000,          // size lookup before a download
    probeMs: 8000,          // bounded GPU probe on init
    stallMs: 45000,         // no bytes for this long = stalled attempt
    initStallMs: 180000,    // initialization without any progress = watchdog
    backoffMs: [2000, 5000, 12000],   // bounded retries for transient errors
    statusThrottleMs: 250
  };

  var KEYS = {
    prefs: 'archiver.prep.v1',
    manifest: 'archiver.models.v2',
    lease: 'archiver.prep.lease',
    status: 'archiver.prep.status'
  };

  var LOCK_NAME = 'archiver-model-prep';
  var TAB_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);

  var cfg = {
    probeGPU: null,        // () => Promise<{ ok, reason, f16 }>
    wasmSupported: null,   // () => boolean
    importWebLLM: null,    // () => Promise<module>
    initWebGPU: null,      // (record, hooks) => Promise<handle>
    initWASM: null,        // (artifact, source, hooks) => Promise<handle>
    teardown: null,        // (backend, handle) => Promise<void>
    timeouts: TIMEOUTS
  };

  /* ---------------------------------------------------------------- helpers */

  function now() { return Date.now(); }

  function absUrl(p) {
    var rel = String(p).replace(/^\/+/, '');
    try {
      return new URL(rel, root.document && root.document.baseURI).href;
    } catch (_) {
      return '/' + rel;
    }
  }

  function abortError(message) {
    var e = new Error(message || 'Stopped');
    e.name = 'AbortError';
    return e;
  }

  function isAbort(err) {
    return !!err && (err.name === 'AbortError' || err.category === 'cancelled');
  }

  function sleep(ms, signal) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) { reject(abortError()); return; }
      var t = setTimeout(function () {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      function onAbort() { clearTimeout(t); reject(abortError()); }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function megabytes(bytes) {
    return bytes >= 1024 * MB ? (bytes / (1024 * MB)).toFixed(1) + ' GB' : Math.round(bytes / MB) + ' MB';
  }

  /* A categorised error. The category decides what the controller does next:
     storage/corrupt/source/gpu/unsupported are never retried blindly; network,
     stall, server and timeout are retried a bounded number of times. */
  function PrepError(category, message, extra) {
    var e = new Error(message);
    e.name = 'PrepError';
    e.category = category;
    if (extra) e.extra = extra;
    return e;
  }

  /* Maps whatever an upstream layer threw onto a category. Upstream errors are
     plain Error objects with messages, so this reads the status code and the
     DOMException name rather than trusting a single string. */
  function categorize(err) {
    if (!err) return 'runtime';
    if (err.category) return err.category;
    var name = String(err.name || '');
    var msg = String(err.message || err);
    if (name === 'AbortError') return 'cancelled';
    if (name === 'QuotaExceededError' || /quota/i.test(msg)) return 'storage';
    if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'NoModificationAllowedError') return 'storage';
    var http = /HTTP (\d{3})/.exec(msg);
    if (http) {
      var code = Number(http[1]);
      return code === 429 || code >= 500 ? 'server' : 'source';
    }
    if (/device was lost|device.*lost|webgpu|gpu|shader/i.test(msg)) return 'gpu';
    if (root.navigator && root.navigator.onLine === false) return 'offline';
    if (name === 'TypeError' || /Failed to fetch|NetworkError|network error/i.test(msg)) return 'network';
    if (/timed out|timeout|did not respond/i.test(msg)) return 'timeout';
    return 'runtime';
  }

  var RETRYABLE = { network: 1, stall: 1, server: 1, timeout: 1 };

  /* ----------------------------------------------------- preferences & store */

  /* localStorage first; sessionStorage when it is blocked; memory when both are.
     Writes go to memory as well, so a read in this page always sees the latest
     value even when the durable store refuses it. */
  var kv = (function () {
    var memory = {};
    function usable(name) {
      try {
        var s = root[name];
        if (!s) return null;
        var probe = '__archiver_probe__';
        s.setItem(probe, '1');
        s.removeItem(probe);
        return s;
      } catch (_) { return null; }
    }
    var durable = usable('localStorage');
    var session = durable ? null : usable('sessionStorage');
    var store = durable || session;
    return {
      kind: durable ? 'local' : session ? 'session' : 'memory',
      get: function (key) {
        try { if (store) { var v = store.getItem(key); if (v !== null) return v; } } catch (_) {}
        return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null;
      },
      set: function (key, value) {
        memory[key] = value;
        try { if (store) store.setItem(key, value); } catch (_) {}
      },
      remove: function (key) {
        delete memory[key];
        try { if (store) store.removeItem(key); } catch (_) {}
      }
    };
  })();

  function readJSON(key, fallback) {
    try { var raw = kv.get(key); return raw ? JSON.parse(raw) : fallback; } catch (_) { return fallback; }
  }

  function preferences() { return readJSON(KEYS.prefs, {}); }

  function setPreference(name, value) {
    var p = preferences();
    p[name] = value;
    kv.set(KEYS.prefs, JSON.stringify(p));
  }

  function autoEnabled() { return preferences().auto !== false; }

  /* The manifest key names everything that makes a stored artifact the one we
     mean: backend, model, runtime version and artifact revision. A runtime bump or
     a new publisher revision is therefore a new key, and the old entry is ignored. */
  function artifactRevision(artifact) {
    return artifact.sha256 ? 'sha256-' + artifact.sha256.slice(0, 16) : 'main';
  }

  function manifestKey(backend, model, runtime, revision) {
    return [backend, model, runtime, revision].join('|');
  }

  function wasmManifestKey(artifact) {
    return manifestKey('wasm', artifact.id + '/' + artifact.quant, RUNTIME.wllama.version, artifactRevision(artifact));
  }

  function readManifest() { return readJSON(KEYS.manifest, {}); }

  function writeManifestEntry(key, entry) {
    var m = readManifest();
    m[key] = entry;
    kv.set(KEYS.manifest, JSON.stringify(m));
  }

  function dropManifestEntry(key) {
    var m = readManifest();
    if (m[key]) { delete m[key]; kv.set(KEYS.manifest, JSON.stringify(m)); }
  }

  /* ----------------------------------------------------------- status store */

  var S = {
    version: VERSION,
    phase: 'idle',           // idle|checking|downloading|verifying|cached|initializing|ready|paused|failed
    backend: null,           // 'webgpu' | 'wasm' | null
    model: null,             // e.g. 'Qwen2.5-0.5B-Instruct Q4_0'
    modelId: null,
    reason: '',              // one human sentence explaining the current phase
    error: null,             // { category, message } when failed
    pct: 0,
    bytesDone: 0,
    bytesTotal: 0,
    rate: 0,                 // bytes per second, smoothed
    verified: null,          // 'sha256' | 'size' | 'webllm-keys' | null
    durable: null,           // true when weights can be stored; false = this session only
    persist: 'unknown',      // 'granted' | 'denied' | 'unsupported' | 'unknown'
    auto: true,
    cancelled: false,        // a cancel stops automatic preparation for this page session
    cachedAt: 0,
    updatedAt: 0,
    remote: null             // another tab's status, when it is preparing the same model
  };

  var subscribers = [];
  var lastEmit = 0;
  var lastStored = 0;
  var lastRate = { at: 0, bytes: 0 };

  function snapshot() {
    var out = {};
    for (var k in S) if (Object.prototype.hasOwnProperty.call(S, k)) out[k] = S[k];
    out.auto = autoEnabled();
    out.storage = kv.kind;
    return out;
  }

  function emit(force) {
    var t = now();
    if (!force && t - lastEmit < TIMEOUTS.statusThrottleMs) return;
    lastEmit = t;
    var snap = snapshot();
    for (var i = 0; i < subscribers.length; i++) {
      try { subscribers[i](snap); } catch (_) {}
    }
    // Other tabs read this key (storage event). Written at most once a second.
    if (force || t - lastStored >= 1000) {
      lastStored = t;
      try {
        if (root.localStorage) {
          root.localStorage.setItem(KEYS.status, JSON.stringify({
            tab: TAB_ID, phase: S.phase, pct: S.pct, model: S.model, at: t
          }));
        }
      } catch (_) {}
    }
  }

  function setPhase(phase, patch) {
    S.phase = phase;
    if (patch) for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) S[k] = patch[k];
    S.updatedAt = now();
    emit(true);
  }

  function setProgress(done, total) {
    var t = now();
    if (lastRate.at && t > lastRate.at) {
      var inst = (done - lastRate.bytes) / ((t - lastRate.at) / 1000);
      S.rate = S.rate ? S.rate * 0.7 + inst * 0.3 : inst;
    }
    lastRate = { at: t, bytes: done };
    S.bytesDone = done;
    if (total) S.bytesTotal = total;
    S.pct = S.bytesTotal ? Math.min(100, Math.floor((S.bytesDone / S.bytesTotal) * 100)) : 0;
    emit(false);
  }

  /* ---------------------------------------------------- OPFS storage backend */

  /* The runtime's own CacheManager defaults to a backend that can divert writes to
     navigator.crossOriginStorage while listing only OPFS. That would split one model
     across two stores. This backend is OPFS only, uses the same directory and file
     names as the runtime, so weights stored by 5.3 are adopted as they are. */
  function OPFSBackend() {}

  OPFSBackend.prototype.isSupported = function () {
    var nav = root.navigator;
    return !!(nav && nav.storage && typeof nav.storage.getDirectory === 'function' &&
      root.FileSystemFileHandle && root.FileSystemFileHandle.prototype &&
      typeof root.FileSystemFileHandle.prototype.createWritable === 'function');
  };

  async function cacheDir() {
    var top = await root.navigator.storage.getDirectory();
    return top.getDirectoryHandle('cache', { create: true });
  }

  OPFSBackend.prototype.read = async function (key) {
    try {
      var dir = await cacheDir();
      var handle = await dir.getFileHandle(key);
      return await handle.getFile();
    } catch (_) { return null; }
  };

  OPFSBackend.prototype.getSize = async function (key) {
    try {
      var dir = await cacheDir();
      var handle = await dir.getFileHandle(key);
      return (await handle.getFile()).size;
    } catch (_) { return -1; }
  };

  OPFSBackend.prototype.write = async function (key, stream) {
    var dir = await cacheDir();
    var handle = await dir.getFileHandle(key, { create: true });
    var writable = await handle.createWritable();   // replaces the file only on close()
    var reader = stream.getReader();
    var pending = [];
    var pendingBytes = 0;
    var FLUSH = 4 * MB;
    try {
      for (;;) {
        var step = await reader.read();
        if (step.done) break;
        pending.push(step.value);
        pendingBytes += step.value.byteLength;
        if (pendingBytes >= FLUSH) {
          await writable.write(joinChunks(pending, pendingBytes));
          pending = [];
          pendingBytes = 0;
        }
      }
      if (pendingBytes) await writable.write(joinChunks(pending, pendingBytes));
      await writable.close();
    } catch (err) {
      try { await writable.abort(); } catch (_) {}
      // getFileHandle(create) made an empty entry; a failed write must not leave it.
      try { await dir.removeEntry(key); } catch (_) {}
      throw err;
    }
  };

  function joinChunks(chunks, total) {
    var out = new Uint8Array(total);
    var at = 0;
    for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], at); at += chunks[i].byteLength; }
    return out;
  }

  OPFSBackend.prototype.list = async function () {
    var dir = await cacheDir();
    var out = [];
    // wllama's own OPFS backend iterates the same way; entries() is in every
    // engine this app supports.
    for await (var pair of dir.entries()) {
      var name = pair[0];
      var handle = pair[1];
      if (handle.kind === 'file') out.push({ key: name, size: (await handle.getFile()).size });
    }
    return out;
  };

  OPFSBackend.prototype.delete = async function (key) {
    try {
      var dir = await cacheDir();
      await dir.removeEntry(key);
    } catch (e) {
      if (!e || e.name !== 'NotFoundError') throw e;
    }
  };

  /* The runtime module, loaded once per page. Tests replace it through configure(). */
  var kit = null;
  async function wllamaKit() {
    if (kit) return kit;
    var mod = await import(/* webpackIgnore: true */ absUrl(RUNTIME.wllama.file));
    var store = new OPFSBackend();
    var cacheManager = new mod.CacheManager([store]);
    var modelManager = new mod.ModelManager({
      cacheManager: cacheManager,
      logger: mod.LoggerWithoutDebug || root.console,
      parallelDownloads: 1
    });
    kit = { mod: mod, store: store, cacheManager: cacheManager, modelManager: modelManager };
    return kit;
  }

  /* Read the first four bytes of a stored file: a GGUF model starts with "GGUF". */
  async function hasGgufMagic(blob) {
    if (!blob || blob.size < 16) return false;
    var head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    return head[0] === 0x47 && head[1] === 0x47 && head[2] === 0x55 && head[3] === 0x46;
  }

  /* ---------------------------------------------------------- storage guard */

  async function storageEstimate() {
    try {
      var est = await root.navigator.storage.estimate();
      return { quota: est.quota || 0, usage: est.usage || 0 };
    } catch (_) { return null; }
  }

  /* Reported as it is. "denied" means the browser answered no; "unsupported" means
     the API is missing. Neither is hidden behind a green status. */
  async function requestPersist() {
    var st = root.navigator && root.navigator.storage;
    if (!st || typeof st.persist !== 'function') return 'unsupported';
    try {
      if (typeof st.persisted === 'function' && await st.persisted()) return 'granted';
      return (await st.persist()) ? 'granted' : 'denied';
    } catch (_) { return 'unknown'; }
  }

  async function persistedState() {
    var st = root.navigator && root.navigator.storage;
    if (!st || typeof st.persisted !== 'function') return 'unsupported';
    try { return (await st.persisted()) ? 'granted' : 'not-granted'; } catch (_) { return 'unknown'; }
  }

  /* A real round-trip, not a capability check: write a small file through the
     same backend the weights use, read it back, compare, delete. */
  async function probeDurableStorage() {
    var store = new OPFSBackend();
    if (!store.isSupported()) return false;
    var key = '__archiver_probe__';
    var payload = new Uint8Array(1024);
    for (var i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) & 255;
    try {
      await store.write(key, new Blob([payload]).stream());
      var back = await store.read(key);
      var bytes = back ? new Uint8Array(await back.arrayBuffer()) : null;
      var same = !!bytes && bytes.length === payload.length && bytes.every(function (b, j) { return b === payload[j]; });
      await store.delete(key);
      return same;
    } catch (_) {
      try { await store.delete(key); } catch (__) {}
      return false;
    }
  }

  /* Margin: 10 % of the file plus 256 MB, so a near-full disk fails here, with a
     clear sentence, rather than halfway through a 400 MB write. */
  async function checkSpace(neededBytes) {
    var est = await storageEstimate();
    if (!est || !est.quota) return { ok: true, unknown: true };
    var free = est.quota - est.usage;
    var need = Math.ceil(neededBytes * 1.1) + 256 * MB;
    return free >= need ? { ok: true, free: free, need: need } : { ok: false, free: free, need: need };
  }

  /* ----------------------------------------------------------- lease / lock */

  /* Web Locks serializes downloads across tabs of this origin. The lock is
     released by the browser when a tab closes, so a crashed tab cannot hold it. */
  function withLease(signal, fn) {
    var locks = root.navigator && root.navigator.locks;
    if (locks && typeof locks.request === 'function') {
      return locks.request(LOCK_NAME, function () {
        if (signal && signal.aborted) throw abortError();
        return fn();
      });
    }
    return withExpiringLease(signal, fn);
  }

  /* Fallback without Web Locks: a localStorage lease that expires. A holder that
     stops renewing (closed tab, frozen process) is replaced after LEASE_TTL_MS. */
  var LEASE_TTL_MS = 20000;
  var LEASE_RENEW_MS = 5000;
  async function withExpiringLease(signal, fn) {
    for (;;) {
      if (signal && signal.aborted) throw abortError();
      var current = readJSON(KEYS.lease, null);
      if (!current || current.until < now() || current.tab === TAB_ID) {
        kv.set(KEYS.lease, JSON.stringify({ tab: TAB_ID, until: now() + LEASE_TTL_MS }));
        if (readJSON(KEYS.lease, null) && readJSON(KEYS.lease, null).tab === TAB_ID) break;
      }
      await sleep(1500, signal);
    }
    var renew = setInterval(function () {
      kv.set(KEYS.lease, JSON.stringify({ tab: TAB_ID, until: now() + LEASE_TTL_MS }));
    }, LEASE_RENEW_MS);
    try {
      return await fn();
    } finally {
      clearInterval(renew);
      var mine = readJSON(KEYS.lease, null);
      if (mine && mine.tab === TAB_ID) kv.remove(KEYS.lease);
    }
  }

  /* ------------------------------------------------------- hashing (worker) */

  function hashOnPage(blob, signal, onProgress) {
    var Hasher = root.ArchiverSHA256;
    if (!Hasher) return Promise.reject(new Error('the checksum module is not loaded'));
    return Hasher.hashBlob(blob, { onProgress: onProgress });
  }

  /* Streams the file through SHA-256 in a worker, so the page never holds the
     file. Falls back to the page when workers are unavailable. */
  function hashFile(blob, signal, onProgress) {
    return new Promise(function (resolve, reject) {
      var worker = null;
      try { worker = new root.Worker(absUrl(RUNTIME.hashWorker)); } catch (_) { worker = null; }
      if (!worker) { hashOnPage(blob, signal, onProgress).then(resolve, reject); return; }
      var id = TAB_ID + ':' + now();
      var done = false;
      function finish(fn, value) {
        if (done) return;
        done = true;
        try { worker.terminate(); } catch (_) {}
        if (signal) signal.removeEventListener('abort', onAbort);
        fn(value);
      }
      function onAbort() { finish(reject, abortError()); }
      worker.onmessage = function (event) {
        var d = event.data || {};
        if (d.id !== id) return;
        if (d.type === 'progress') { if (onProgress) onProgress(d.done, d.total); }
        else if (d.type === 'done') finish(resolve, d.hex);
        else if (d.type === 'error') finish(reject, new Error(d.message || 'checksum failed'));
      };
      worker.onerror = function () { finish(reject, new Error('the checksum worker failed')); };
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      worker.postMessage({ id: id, blob: blob });
    });
  }

  /* ------------------------------------------------------------- WASM path */

  function wasmArtifacts() {
    return CATALOG.wasm.primary.concat(CATALOG.wasm.fallback);
  }

  function artifactLabel(a) {
    return (a.id === 'Qwen3-0.6B' ? 'Qwen 3 0.6B' : 'Qwen 2.5 0.5B Instruct') + ' ' + a.quant;
  }

  /* Adoption check: wllama's own validation (size and metadata, so truncated and
     missing-shard caches fail) plus the GGUF magic. Returns the Model, or null. */
  async function findValidWasm(artifact) {
    var k;
    try { k = await wllamaKit(); } catch (_) { return null; }
    var models = [];
    try { models = await k.modelManager.getModels({ includeInvalid: true }); } catch (_) { return null; }
    var model = null;
    for (var i = 0; i < models.length; i++) if (models[i].url === artifact.url) { model = models[i]; break; }
    if (!model) return null;
    if (model.validate() !== k.mod.ModelValidationStatus.VALID) return { invalid: true, model: model };
    if (!model.files || model.files.length !== 1) return { invalid: true, model: model };
    var blob = await k.cacheManager.open(model.files[0].name);
    if (!(await hasGgufMagic(blob))) return { invalid: true, model: model, corrupt: 'magic' };
    return { model: model, file: model.files[0] };
  }

  /* Removes exactly one artifact (its files and metadata). Chats, settings and
     other models are not touched. Only called on corruption evidence. */
  async function dropArtifact(artifact) {
    var k = await wllamaKit();
    await k.cacheManager.deleteMany(function (entry) {
      return !!entry.metadata && entry.metadata.originalURL === artifact.url;
    });
    dropManifestEntry(wasmManifestKey(artifact));
  }

  async function headSize(url, signal) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, cfg.timeouts.headMs);
    function onAbort() { ctl.abort(); }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      var res = await root.fetch(url, { method: 'HEAD', signal: ctl.signal, cache: 'no-store' });
      if (!res.ok) return 0;
      return Number(res.headers.get('content-length') || 0);
    } catch (_) {
      return 0;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  /* One download attempt. The stall timer is the only per-request limit: it is
     reset by every progress callback, so a slow but moving transfer is never cut
     off, however long it takes. */
  async function downloadOnce(artifact, op) {
    var k = await wllamaKit();
    var attempt = new AbortController();
    var stalled = false;
    var lastByte = now();
    function onAbort() { attempt.abort(); }
    op.signal.addEventListener('abort', onAbort, { once: true });
    var watch = setInterval(function () {
      if (now() - lastByte > cfg.timeouts.stallMs) {
        stalled = true;
        attempt.abort();
      }
    }, 1000);
    try {
      var model = await k.modelManager.downloadModel({ url: artifact.url }, {
        signal: attempt.signal,
        progressCallback: function (p) {
          lastByte = now();
          setProgress(p.loaded, p.total || S.bytesTotal);
        }
      });
      if (op.signal.aborted) throw abortError();
      return model;
    } catch (err) {
      if (op.signal.aborted) throw abortError();
      if (stalled) throw PrepError('stall', 'The download stopped for ' + Math.round(cfg.timeouts.stallMs / 1000) + ' seconds without new data.');
      throw err;
    } finally {
      clearInterval(watch);
      op.signal.removeEventListener('abort', onAbort);
    }
  }

  /* Download with bounded retries for transient categories. Everything else is
     returned at once, so a 404 moves on to the next source and a full disk stops. */
  async function downloadArtifact(artifact, op) {
    var size = await headSize(artifact.url, op.signal);
    if (size) setPhase('downloading', { bytesTotal: size, pct: 0, bytesDone: 0 });
    if (size && S.durable !== false) {
      var space = await checkSpace(size);
      if (!space.ok) {
        throw PrepError('storage', 'Not enough browser storage for this model: about ' + megabytes(space.need) +
          ' is needed and ' + megabytes(space.free) + ' is free. Free some space, then press Retry.');
      }
    }
    if (!persistAsked) {
      persistAsked = true;
      S.persist = await requestPersist();
    }
    var attempts = 0;
    for (;;) {
      try {
        return await withLease(op.signal, async function () {
          // Another tab may have finished this download while we waited for the lock.
          var existing = await findValidWasm(artifact);
          if (existing && existing.model && !existing.invalid) return existing.model;
          setPhase('downloading', { reason: 'Downloading the model once. Other tabs wait for this one.' });
          return downloadOnce(artifact, op);
        });
      } catch (err) {
        var category = categorize(err);
        if (category === 'cancelled') throw err;
        if (!RETRYABLE[category] || attempts >= cfg.timeouts.backoffMs.length) {
          throw err.category ? err : PrepError(category, err.message || String(err));
        }
        var wait = cfg.timeouts.backoffMs[attempts];
        attempts++;
        setPhase('downloading', { reason: 'The connection dropped. Retrying in ' + Math.round(wait / 1000) + ' s (attempt ' + (attempts + 1) + ').' });
        await sleep(wait, op.signal);
      }
    }
  }

  /* Verifies a freshly downloaded or adopted file, then commits the manifest. The
     checksum is the publisher's (wllama stores it from the Hugging Face pointer).
     No publisher digest means "size" verification, and the UI says so. */
  async function verifyWasm(artifact, found, op) {
    setPhase('verifying', { reason: 'Checking the stored file.' });
    var entry = found.file;
    var digest = entry.metadata && entry.metadata.sha256 ? entry.metadata.sha256 : null;
    var verified = 'size';
    if (digest) {
      var k = await wllamaKit();
      var blob = await k.cacheManager.open(entry.name);
      var hex = await hashFile(blob, op.signal, function (done, total) {
        setProgress(done, total);
      });
      if (hex !== digest) {
        await dropArtifact(artifact);
        throw PrepError('corrupt', 'The stored model did not match its published checksum, so it was removed. Press Retry to download it again.');
      }
      verified = 'sha256';
    }
    writeManifestEntry(wasmManifestKey(artifact), {
      backend: 'wasm', model: artifact.id + '/' + artifact.quant, runtime: RUNTIME.wllama.version,
      revision: artifactRevision(artifact), url: artifact.url, bytes: entry.size, sha256: digest,
      verify: verified, verifiedAt: now(), complete: true
    });
    return verified;
  }

  /* Session fallback: the file is kept in memory for this page only. Used only when
     durable storage fails its probe, and the UI says so. */
  async function downloadToMemory(artifact, op) {
    var res = await root.fetch(artifact.url, { signal: op.signal, cache: 'no-store' });
    if (!res.ok) throw PrepError('source', 'Failed to fetch ' + artifact.url + ': HTTP ' + res.status);
    var blob = await res.blob();
    setProgress(blob.size, blob.size);
    return blob;
  }

  /* Picks the artifact to use. A valid cached copy of any listed artifact wins
     (primary order first). Otherwise the first listed artifact is downloaded, and
     the next one is tried only if this one is not published. */
  async function prepareWasm(op) {
    var artifacts = wasmArtifacts();
    for (var i = 0; i < artifacts.length; i++) {
      var found = await findValidWasm(artifacts[i]);
      if (found && found.model && !found.invalid) {
        var manifest = readManifest()[wasmManifestKey(artifacts[i])];
        if (!manifest || !manifest.complete) {
          await verifyWasm(artifacts[i], found, op);   // adoption: verify once, then commit
        }
        setPhase('cached', { backend: 'wasm', model: artifactLabel(artifacts[i]), modelId: artifacts[i].id,
          verified: (readManifest()[wasmManifestKey(artifacts[i])] || {}).verify || 'size', cachedAt: now() });
        return { artifact: artifacts[i], source: found.model };
      }
      if (found && found.invalid && found.corrupt === 'magic') {
        await dropArtifact(artifacts[i]);
      }
    }
    if (!op.allowDownload) {
      setPhase('paused', { reason: op.pausedReason || 'The model is not stored yet. It downloads when you press Prepare now or ask a question.', error: null });
      return null;
    }
    var lastError = null;
    for (var j = 0; j < artifacts.length; j++) {
      var a = artifacts[j];
      var corruptRetried = false;
      for (;;) {
        try {
          setPhase('checking', { backend: 'wasm', model: artifactLabel(a), modelId: a.id, pct: 0, bytesDone: 0, bytesTotal: 0 });
          if (S.durable === false) {
            var blob = await downloadToMemory(a, op);
            setPhase('cached', { backend: 'wasm', model: artifactLabel(a), modelId: a.id, verified: 'size',
              reason: 'Kept in memory for this session only: this browser would not store it.' });
            return { artifact: a, source: blob, memory: true };
          }
          await downloadArtifact(a, op);
          var after = await findValidWasm(a);
          if (!after || !after.model || after.invalid) {
            throw PrepError('corrupt', 'The downloaded file is incomplete. Press Retry to download it again.');
          }
          var verified = await verifyWasm(a, after, op);
          setPhase('cached', { backend: 'wasm', model: artifactLabel(a), modelId: a.id, verified: verified, cachedAt: now(),
            reason: verified === 'sha256' ? 'Verified against the published checksum.' : 'Complete; no published checksum to compare, so its size and format were checked.' });
          return { artifact: a, source: after.model };
        } catch (err) {
          var category = categorize(err);
          if (category === 'cancelled') throw err;
          if (category === 'corrupt' && !corruptRetried) {
            corruptRetried = true;
            await dropArtifact(a).catch(function () {});
            continue;
          }
          lastError = err.category ? err : PrepError(category, err.message || String(err));
          if (category === 'source' || category === 'corrupt') break;   // try the next listed artifact
          throw lastError;
        }
      }
    }
    throw lastError || PrepError('source', 'No published copy of the model could be downloaded.');
  }

  /* ----------------------------------------------------------- WebGPU path */

  /* Completeness of a WebLLM model in its Cache API scopes: tensors and shards via
     WebLLM's own hasModelInCache, plus the chat config, the tokenizer and the
     compiled library, which hasModelInCache does not check. */
  function cleanModelUrl(url) {
    var u = String(url);
    u += u.endsWith('/') ? '' : '/';
    if (!u.match(/.+\/resolve\/.+\//)) u += 'resolve/main/';
    return new URL(u).href;
  }

  async function webllmStatus(mod, record, modelId) {
    var appConfig = { model_list: [record], useIndexedDBCache: false };
    var weights = false;
    try { weights = await mod.hasModelInCache(modelId, appConfig); } catch (_) { weights = false; }
    if (!weights) return { complete: false, missing: 'weights' };
    var base = cleanModelUrl(record.model);
    var caches = root.caches;
    if (!caches) return { complete: false, missing: 'cache-api' };
    try {
      var config = await caches.open('webllm/config');
      if (!(await config.match(new URL('mlc-chat-config.json', base).href))) return { complete: false, missing: 'config' };
      var model = await caches.open('webllm/model');
      var tokenizer = (await model.match(new URL('tokenizer.json', base).href)) ||
        (await model.match(new URL('tokenizer.model', base).href));
      if (!tokenizer) return { complete: false, missing: 'tokenizer' };
      var lib = await caches.open('webllm/wasm');
      if (!record.model_lib || !(await lib.match(record.model_lib))) return { complete: false, missing: 'library' };
    } catch (_) {
      return { complete: false, missing: 'cache-api' };
    }
    return { complete: true };
  }

  function webllmCandidates(gpu) {
    var f16 = !!(gpu && gpu.f16);
    return f16
      ? [CATALOG.webgpu.primary[0], CATALOG.webgpu.fallback[0]]
      : [CATALOG.webgpu.primary[1], CATALOG.webgpu.fallback[1]];
  }

  /* The primary WebGPU model first; the fallback family only when the primary cannot
     be started (a missing or blocked artifact). A GPU fault is not a reason to try
     another model on the GPU: it goes to the one WASM transition in pipeline(). */
  async function prepareWebGPU(op, gpu) {
    var mod = await cfg.importWebLLM();
    var list = (mod.prebuiltAppConfig && mod.prebuiltAppConfig.model_list) || [];
    var candidates = webllmCandidates(gpu);
    var lastErr = null;
    var started = null;
    for (var i = 0; i < candidates.length && !started; i++) {
      var id = candidates[i];
      var record = list.find(function (r) { return r.model_id === id; });
      if (!record) { lastErr = PrepError('runtime', 'The bundled WebGPU runtime does not include ' + id + '.'); continue; }
      var status = await webllmStatus(mod, record, id);
      var size = Number(record.vram_required_MB || 0) * MB;
      setPhase('checking', { backend: 'webgpu', modelId: id, model: id.replace(/-q4f(16|32)_1-MLC$/, ''),
        bytesTotal: size, bytesDone: 0, pct: 0, verified: null });
      if (status.complete) {
        setPhase('cached', { verified: 'webllm-keys', cachedAt: now(), reason: 'Model files are complete in this browser’s cache.' });
      }
      if (!op.allowInit) {
        setPhase('paused', { reason: op.pausedReason || 'WebGPU prepares this model on your first question, so it is not downloaded in the background.', error: null });
        return null;
      }
      if (!status.complete && !op.allowDownload) {
        setPhase('paused', { reason: op.pausedReason || 'Downloads wait for Prepare now or your first question.', error: null });
        return null;
      }
      if (!status.complete && S.durable !== false) {
        var space = await checkSpace(size || 900 * MB);
        if (!space.ok) throw PrepError('storage', 'Not enough browser storage for this model. Free some space, then press Retry.');
      }
      if (!status.complete && !persistAsked) {
        persistAsked = true;
        S.persist = await requestPersist();
      }
      setPhase('initializing', { reason: status.complete ? 'Starting WebGPU from the cached files.' : 'Downloading and starting WebGPU. This is a one-time download.' });
      try {
        var handleValue = await initWithWatchdog(op, 'webgpu', function (touch) {
          return cfg.initWebGPU(record, {
            signal: op.signal,
            fresh: op.fresh,
            touch: touch,
            onProgress: function (pct, text) {
              touch();
              S.reason = text || S.reason;
              setProgress(Math.round((pct || 0) * 100), 100);
            }
          });
        });
      } catch (err) {
        if (isAbort(err)) throw err;
        var category = categorize(err);
        if (category === 'storage' || category === 'gpu') throw err;
        lastErr = err.category ? err : PrepError(category, err.message || String(err));
        continue;   // the primary could not start: try the fallback model
      }
      var after = await webllmStatus(mod, record, id);
      setPhase('ready', { backend: 'webgpu', modelId: id, model: id.replace(/-q4f(16|32)_1-MLC$/, ''),
        verified: after.complete ? 'webllm-keys' : null, cachedAt: after.complete ? now() : S.cachedAt, reason: '' });
      started = handleValue;
    }
    if (!started) throw lastErr || PrepError('runtime', 'No WebGPU model could start.');
    return started;
  }

  /* An initialization that goes quiet is not allowed to hold the page forever. The
     watchdog is separate from the download stall timer: initialization makes no
     byte-level progress for wllama, so it has its own, longer limit. */
  function initWithWatchdog(op, backend, start) {
    return new Promise(function (resolve, reject) {
      var last = now();
      var done = false;
      function touch() { last = now(); }
      var timer = setInterval(function () {
        if (!done && now() - last > cfg.timeouts.initStallMs) {
          done = true;
          clearInterval(timer);
          op.signal.removeEventListener('abort', onAbort);
          reject(PrepError('timeout', 'The ' + (backend === 'webgpu' ? 'WebGPU' : 'WebAssembly') +
            ' runtime did not respond for ' + Math.round(cfg.timeouts.initStallMs / 1000) + ' seconds.'));
        }
      }, 1000);
      function onAbort() {
        if (done) return;
        done = true;
        clearInterval(timer);
        reject(abortError());
      }
      if (op.signal.aborted) { onAbort(); return; }
      op.signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve().then(function () { return start(touch); }).then(function (value) {
        if (done) return;
        done = true;
        clearInterval(timer);
        op.signal.removeEventListener('abort', onAbort);
        resolve(value);
      }, function (err) {
        if (done) return;
        done = true;
        clearInterval(timer);
        op.signal.removeEventListener('abort', onAbort);
        reject(err);
      });
    });
  }

  /* -------------------------------------------------------------- controller */

  var persistAsked = false; // persistence is requested once, before the first transfer
  var run = null;          // the operation in flight: { source, allowDownload, allowInit, abort, signal, promise }
  var handle = null;       // { backend, value, modelId } while a runtime is ready
  var transitions = 0;     // GPU → WASM transitions in this page session (at most one)

  function covers(op, want) {
    return (op.allowDownload || !want.allowDownload) && (op.allowInit || !want.allowInit);
  }

  function gpuProbe() {
    var probe = cfg.probeGPU ? cfg.probeGPU() : Promise.resolve({ ok: false, reason: 'no GPU probe' });
    var timer = null;
    var bound = new Promise(function (resolve) {
      timer = setTimeout(function () { resolve({ ok: false, reason: 'The WebGPU check did not finish in time.' }); }, cfg.timeouts.probeMs);
    });
    return Promise.race([Promise.resolve(probe).catch(function (e) {
      return { ok: false, reason: (e && e.message) || 'The WebGPU check failed.' };
    }), bound]).then(function (verdict) { clearTimeout(timer); return verdict; });
  }

  async function pipeline(op) {
    if (handle) return true;
    setPhase('checking', { reason: 'Checking which runtime this browser can use.', error: null });
    var gpu = op.forceWasm ? { ok: false, reason: 'Switched from WebGPU to the CPU runtime.' } : await gpuProbe();
    if (!gpu.ok && gpu.reason) S.gpuReason = gpu.reason;
    if (gpu.ok) {
      try {
        var ready = await prepareWebGPU(op, gpu);
        if (ready) { handle = { backend: 'webgpu', value: ready, modelId: S.modelId }; }
        return !!ready;
      } catch (err) {
        if (isAbort(err)) throw err;
        var category = categorize(err);
        // One controlled transition: a GPU fault (device lost, shader or buffer
        // error) moves to the verified WASM runtime. Network, storage and cancel
        // never do; those surface as they are.
        if (category === 'gpu' && transitions === 0 && cfg.wasmSupported && cfg.wasmSupported()) {
          transitions++;
          await stopGPU();
          setPhase('checking', { reason: 'WebGPU stopped responding. Switching to the CPU runtime.' });
          return pipeline(Object.assign({}, op, { forceWasm: true }));
        }
        throw err;
      }
    }
    if (!cfg.wasmSupported || !cfg.wasmSupported()) {
      // Say both things: why the GPU is not used, and why the CPU runtime cannot start.
      var cpuWhy = cfg.unsupportedReason ? cfg.unsupportedReason() : '';
      var gpuWhy = !gpu.ok && gpu.reason ? gpu.reason + ' ' : '';
      throw PrepError('unsupported', gpuWhy + (cpuWhy || 'This browser has no WebAssembly support, so the on-device model cannot run here.') + ' Instant tools remain available.');
    }
    var picked = await prepareWasm(op);
    if (!picked) return false;
    if (!op.allowInit) return false;
    setPhase('initializing', { backend: 'wasm', reason: 'Starting the CPU runtime from the stored file.' });
    try {
      var value = await initWithWatchdog(op, 'wasm', function (touch) {
        return cfg.initWASM(picked.artifact, picked.source, {
          signal: op.signal,
          touch: touch,
          onProgress: function () { touch(); }
        });
      });
      handle = { backend: 'wasm', value: value, modelId: picked.artifact.id };
      setPhase('ready', { backend: 'wasm', model: artifactLabel(picked.artifact), modelId: picked.artifact.id, reason: '' });
      return true;
    } catch (err) {
      await stopWASM(err);
      if (isAbort(err)) throw err;
      var c = categorize(err);
      if (c === 'corrupt') throw err;
      throw err.category ? err : PrepError(c === 'runtime' || c === 'timeout' ? c : 'runtime',
        'The CPU runtime could not start the model: ' + (err.message || err));
    }
  }

  async function stopGPU() {
    var old = handle;
    handle = null;
    if (old && cfg.teardown) { try { await cfg.teardown(old.backend, old.value); } catch (_) {} }
    else if (cfg.teardown) { try { await cfg.teardown('webgpu', null); } catch (_) {} }
  }

  async function stopWASM() {
    var old = handle;
    handle = null;
    if (cfg.teardown) { try { await cfg.teardown('wasm', old && old.value); } catch (_) {} }
  }

  function failureState(err, op) {
    if (isAbort(err)) {
      if (op.abortReason === 'pause') {
        return { phase: 'paused', reason: 'Paused. Prepare now resumes; a download restarts from the beginning.', error: null };
      }
      if (op.abortReason === 'lifecycle') {
        return { phase: 'paused', reason: 'Paused while the page was closing. It resumes the next time you open Archiver.', error: null };
      }
      return { phase: 'idle', reason: 'Preparation stopped. Prepare now starts it again.', error: null };
    }
    var category = categorize(err);
    if (category === 'offline') {
      return { phase: 'paused', reason: 'You are offline. Preparation resumes when the connection returns.', error: { category: 'offline', message: 'offline' } };
    }
    return { phase: 'failed', reason: '', error: { category: category, message: err && err.message ? String(err.message) : String(err) } };
  }

  function ensure(want) {
    var wanted = {
      source: want.source || 'auto',
      allowDownload: !!want.allowDownload,
      allowInit: !!want.allowInit,
      fresh: !!want.fresh,
      forceWasm: !!want.forceWasm,
      pausedReason: want.pausedReason || ''
    };
    if (handle) return Promise.resolve(true);
    if (run) {
      if (covers(run, wanted)) return run.promise;
      return run.promise.then(function () { return ensure(wanted); }, function () { return ensure(wanted); });
    }
    var ctl = new AbortController();
    var op = Object.assign({}, wanted, { abort: ctl, signal: ctl.signal, abortReason: '' });
    run = op;
    op.promise = pipeline(op).then(function (ok) {
      run = null;
      if (ok) S.error = null;
      return !!ok;
    }, function (err) {
      run = null;
      var st = failureState(err, op);
      if (st.phase === 'idle' && !op.allowDownload) st.phase = 'idle';
      setPhase(st.phase, { reason: st.reason || S.reason, error: st.error, backend: S.backend });
      return false;
    });
    return op.promise;
  }

  /* Automatic preparation: runs once after first paint, only while the page is
     visible, and only when the connection and the user's settings allow it. */
  function gates() {
    var nav = root.navigator || {};
    var conn = nav.connection || {};
    if (nav.onLine === false) return { download: false, init: false, reason: 'You are offline. Preparation resumes when the connection returns.', paused: true };
    if (conn.saveData) return { download: false, init: false, reason: 'Data Saver is on, so the model is not downloaded automatically. Press Prepare now to download it.', paused: true };
    var slow = /^(slow-2g|2g|3g)$/.test(String(conn.effectiveType || '')) || (typeof conn.downlink === 'number' && conn.downlink > 0 && conn.downlink < 1.5);
    if (slow) return { download: false, init: false, reason: 'The connection looks slow, so the model is not downloaded automatically. Press Prepare now to download it.', paused: true };
    return { download: true, init: true, reason: '' };
  }

  /* “Mobile” is a property of the device, detected by capability and input type,
     never by user-agent text. Phones and tablets download to storage and start the
     runtime on the first question; desktops start it in the background. */
  function isTouchFirst() {
    var nav = root.navigator || {};
    if (nav.userAgentData && typeof nav.userAgentData.mobile === 'boolean') return nav.userAgentData.mobile;
    try {
      return !!(root.matchMedia && root.matchMedia('(any-pointer: coarse) and (hover: none)').matches);
    } catch (_) { return false; }
  }

  var autoScheduled = false;
  var pendingVisible = false;

  function scheduleAuto() {
    if (autoScheduled) return;
    autoScheduled = true;
    var run1 = function () { autoScheduled = false; maybeAuto('auto'); };
    if (typeof root.requestIdleCallback === 'function') root.requestIdleCallback(run1, { timeout: 2000 });
    else setTimeout(run1, 1200);
  }

  function maybeAuto(source) {
    if (handle) return Promise.resolve(true);
    if (!autoEnabled()) {
      setPhase('idle', { reason: 'Automatic preparation is off. Prepare now starts it.', auto: false });
      return Promise.resolve(false);
    }
    if (S.cancelled && source === 'auto') return Promise.resolve(false);
    if (root.document && root.document.visibilityState === 'hidden') {
      pendingVisible = true;
      return Promise.resolve(false);
    }
    var g = gates();
    if (g.paused) {
      // Stored weights may still start (no network); a missing model waits and says why.
      return ensure({ source: 'auto', allowDownload: false, allowInit: !isTouchFirst(), pausedReason: g.reason });
    }
    if (S.durable === false && source === 'auto') {
      setPhase('paused', { reason: 'Browser storage is unavailable, so the model is not downloaded in the background. It loads for this session when you ask a question.' });
      return Promise.resolve(false);
    }
    if (isTouchFirst()) {
      // Phones and tablets: store the file now, start the runtime on the first question.
      return ensure({ source: 'auto', allowDownload: true, allowInit: false });
    }
    return ensure({ source: 'auto', allowDownload: true, allowInit: true });
  }

  /* The public verbs. Each is idempotent, and each is a single call into the one
     controller above. */
  function prepareNow() {
    S.cancelled = false;
    setPhase(S.phase, { error: null });
    return ensure({ source: 'manual', allowDownload: true, allowInit: true });
  }

  /* A question joins a preparation already running, or starts one. Downloads obey
     the same gates as automatic preparation (Data Saver, slow link, offline); starting
     a model that is already stored needs no network, so it is always allowed. After
     an explicit cancel, a question does not restart the download. */
  function joinOnSend() {
    if (handle) return Promise.resolve(true);
    if (S.cancelled && !run) return Promise.resolve(false);
    var g = gates();
    return ensure({ source: 'send', allowDownload: g.download, allowInit: true, pausedReason: g.reason });
  }

  function cancel(reason) {
    S.cancelled = true;
    if (run) {
      run.abortReason = reason || 'cancel';
      run.abort.abort();
    }
    if (!run && S.phase !== 'ready') setPhase('idle', { reason: 'Preparation stopped. Prepare now starts it again.', error: null });
  }

  function pause() { cancel('pause'); }

  function retry() {
    S.cancelled = false;
    S.error = null;
    return ensure({ source: 'retry', allowDownload: true, allowInit: true, fresh: true });
  }

  function setAuto(on) {
    setPreference('auto', !!on);
    S.auto = !!on;
    if (on) { S.cancelled = false; scheduleAuto(); }
    emit(true);
    return !!on;
  }

  /* The engine calls this when its runtime disappears on its own (device lost,
     worker error). The state reports it; nothing reloads. */
  function reportRuntimeLost(reason) {
    var old = handle;
    handle = null;
    var canTransition = !!old && old.backend === 'webgpu' && transitions === 0 && cfg.wasmSupported && cfg.wasmSupported();
    // Stop the old worker first and wait for it, then start the one WASM transition.
    var stopped = old && cfg.teardown ? Promise.resolve(cfg.teardown(old.backend, old.value)).catch(function () {}) : Promise.resolve();
    if (canTransition) {
      transitions++;
      setPhase('checking', { backend: null, reason: 'WebGPU stopped responding. Switching to the CPU runtime.', error: null });
      stopped.then(function () { return ensure({ source: 'transition', allowDownload: true, allowInit: true, forceWasm: true }); });
      return;
    }
    setPhase('failed', { backend: null, reason: '', error: { category: 'gpu', message: String(reason || 'The runtime stopped.') } });
  }

  function release() {
    var old = handle;
    handle = null;
    if (old && cfg.teardown) return Promise.resolve(cfg.teardown(old.backend, old.value)).catch(function () {});
    return Promise.resolve();
  }

  /* Diagnostics: what is actually stored, and why. Model files and user data are
     separate things: this reports the first, and clearModelFiles() removes only it. */
  async function inventory() {
    var out = { entries: [], manifest: readManifest(), durable: S.durable, persist: S.persist };
    try {
      var k = await wllamaKit();
      out.entries = (await k.cacheManager.list()).map(function (e) {
        return { name: e.name, size: e.size, url: e.metadata && e.metadata.originalURL, sha256: !!(e.metadata && e.metadata.sha256) };
      });
    } catch (err) {
      out.error = String((err && err.message) || err);
    }
    try {
      var est = await storageEstimate();
      if (est) out.quota = est.quota;
      if (est) out.usage = est.usage;
    } catch (_) {}
    return out;
  }

  async function clearModelFiles() {
    if (run) cancel('clear');
    await release();
    try {
      var k = await wllamaKit();
      await k.cacheManager.deleteMany(function () { return true; });
    } catch (_) {}
    try {
      var caches = root.caches;
      if (caches) {
        await caches.delete('webllm/model');
        await caches.delete('webllm/config');
        await caches.delete('webllm/wasm');
      }
    } catch (_) {}
    kv.remove(KEYS.manifest);
    kv.remove(KEYS.lease);
    S.cancelled = true;
    setPhase('idle', { reason: 'Model files were removed. Chats and settings were kept.', verified: null, cachedAt: 0, error: null, pct: 0 });
    return true;
  }

  /* Startup: decide storage durability, persistence, and the stored preference. This
     is cheap (one small write) and never downloads anything. */
  async function init() {
    S.auto = autoEnabled();
    S.durable = await probeDurableStorage();
    S.persist = await persistedState();
    if (!S.durable) {
      S.reason = 'Browser storage is unavailable here, so models last only for this page session.';
    }
    emit(true);
    return snapshot();
  }

  /* ----------------------------------------------------------- wiring events */

  if (root.addEventListener) {
    root.addEventListener('storage', function (event) {
      if (event.key !== KEYS.status || !event.newValue) return;
      try {
        var other = JSON.parse(event.newValue);
        if (!other || other.tab === TAB_ID) return;
        S.remote = { phase: other.phase, pct: other.pct, model: other.model, at: other.at };
        emit(true);
      } catch (_) {}
    });
    root.addEventListener('online', function () {
      if (S.phase === 'paused' && S.error && S.error.category === 'offline') maybeAuto('auto');
    });
    root.addEventListener('pagehide', function (event) {
      if (!event.persisted && run) cancel('lifecycle');
    });
    root.addEventListener('pageshow', function (event) {
      // Back from the back-forward cache: the runtime may have been frozen. Re-check
      // the stored files; a live runtime keeps its handle.
      if (event.persisted) maybeAuto('auto');
    });
  }
  if (root.document && root.document.addEventListener) {
    root.document.addEventListener('visibilitychange', function () {
      if (root.document.visibilityState === 'visible' && pendingVisible) {
        pendingVisible = false;
        maybeAuto('auto');
      }
    });
  }

  function configure(options) {
    if (!options) return;
    for (var k in options) {
      if (!Object.prototype.hasOwnProperty.call(options, k)) continue;
      if (k === 'timeouts') {
        for (var t in options.timeouts) if (Object.prototype.hasOwnProperty.call(options.timeouts, t)) TIMEOUTS[t] = options.timeouts[t];
      } else if (k === 'kit') {
        kit = options.kit;
      } else {
        cfg[k] = options[k];
      }
    }
  }

  var api = {
    version: VERSION,
    RUNTIME: RUNTIME,
    CATALOG: CATALOG,
    TIMEOUTS: TIMEOUTS,
    KEYS: KEYS,
    configure: configure,
    init: init,
    snapshot: snapshot,
    subscribe: function (fn) {
      subscribers.push(fn);
      return function () {
        var at = subscribers.indexOf(fn);
        if (at >= 0) subscribers.splice(at, 1);
      };
    },
    scheduleAuto: scheduleAuto,
    maybeAuto: function () { return maybeAuto('auto'); },
    ensureReady: function (opts) {
      var o = opts || {};
      if (o.source === 'send') return joinOnSend();
      return ensure({ source: o.source || 'manual', allowDownload: !!o.allowDownload, allowInit: o.allowInit !== false });
    },
    joinOnSend: joinOnSend,
    prepareNow: prepareNow,
    cancel: function () { cancel('cancel'); },
    pause: pause,
    retry: retry,
    setAuto: setAuto,
    release: release,
    reportRuntimeLost: reportRuntimeLost,
    handle: function () { return handle; },
    inFlight: function () { return !!run; },
    inventory: inventory,
    runtimeKit: wllamaKit,
    clearModelFiles: clearModelFiles,
    manifestKey: wasmManifestKey,
    artifactLabel: artifactLabel,
    categorize: categorize,
    gates: gates,
    isTouchFirst: isTouchFirst,
    probeDurableStorage: probeDurableStorage,
    hasGgufMagic: hasGgufMagic,
    checkSpace: checkSpace,
    webllmCandidates: webllmCandidates,
    kvKind: function () { return kv.kind; },
    /* Internals exposed for the test suites (tests/prep.js). Not a public API. */
    _internal: {
      OPFSBackend: OPFSBackend, PrepError: PrepError, hashFile: hashFile, webllmStatus: webllmStatus,
      cleanModelUrl: cleanModelUrl, joinChunks: joinChunks, TAB_ID: TAB_ID,
      findValidWasm: findValidWasm, wasmArtifacts: wasmArtifacts, dropArtifact: dropArtifact,
      readManifest: readManifest, wasmManifestKey: wasmManifestKey, categorize: categorize,
      probeDurableStorage: probeDurableStorage, checkSpace: checkSpace
    }
  };

  root.ArchiverPrep = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
