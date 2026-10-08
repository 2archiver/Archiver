/* A browser stand-in for the Node test suites. It loads the real page scripts
   (archiver-sha256.js, archiver-prep.js, archiver-engine.js) into a VM context and
   gives them the APIs they touch:

   * the real wllama 3.6.1 ESM bundle (web/vendor/wllama-3.6.1.js), so that
     CacheManager, ModelManager, Model and ModelValidationStatus are wllama's own
     code — only its inference worker is replaced;
   * an in-memory Origin Private File System with quota and write-failure hooks;
   * a Cache API, localStorage/sessionStorage (optionally denied), Web Locks;
   * a scriptable fetch with HEAD, ranged-free GET, Hugging Face raw pointers,
     stalls, aborts, truncation and HTTP errors;
   * workers: the real archiver-hash-worker.js runs in a child context, other
     workers are inert stand-ins.

   Two browser "tabs" can share one `origin` object (storage, caches, locks and the
   simulated network), which is how the two-tab tests run.

   Nothing here is a real browser. Real OPFS, Web Locks and WebGPU behaviour is
   verified only on a real browser run, and tests/browser-*.js covers that path. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const WEB = path.join(__dirname, '..', 'web');
const WLLAMA_FILE = path.join(WEB, 'vendor', 'wllama-3.6.1.js');
const ORIGIN = 'http://localhost/Archiver/';

/* ------------------------------------------------------------------ data --- */

function fakeGGUF(sizeBytes, seed) {
  const bytes = new Uint8Array(sizeBytes);
  bytes.set([0x47, 0x47, 0x55, 0x46, 3, 0, 0, 0]);   // "GGUF", version 3
  let x = (seed || 1) >>> 0;
  for (let i = 8; i < sizeBytes; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    bytes[i] = x >>> 24;
  }
  return bytes;
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/* ----------------------------------------------------- shared origin state --- */

function createOrigin(options) {
  const opts = options || {};
  return {
    local: new Map(),
    session: new Map(),
    opfs: new Map(),              // file name -> Uint8Array (the 'cache' directory)
    caches: new Map(),            // cache name -> Map(url -> stored response)
    locks: { held: new Map(), queue: new Map() },
    hub: new Map(),               // url -> { bytes, sha256?, pointer?: boolean }
    persisted: !!opts.persisted,
    persistAnswer: opts.persistAnswer === undefined ? true : opts.persistAnswer,
    quota: opts.quota || 10 * 1024 * 1024 * 1024,
    failWrites: null,             // { afterBytes } — the next writes fail with QuotaExceededError
    fetchLog: [],                 // { url, method, range }
    network: { offline: false, routes: [] }
  };
}

function usageOf(origin) {
  let n = 0;
  for (const b of origin.opfs.values()) n += b.length;
  for (const store of origin.caches.values()) for (const e of store.values()) n += e.body.length;
  return n;
}

/* ----------------------------------------------------------- storage APIs --- */

function storageMap(map, denied) {
  return {
    getItem(key) {
      if (denied) throw Object.assign(new Error('storage is denied'), { name: 'SecurityError' });
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      if (denied) throw Object.assign(new Error('storage is denied'), { name: 'SecurityError' });
      map.set(key, String(value));
    },
    removeItem(key) { if (!denied) map.delete(key); },
    key(i) { return [...map.keys()][i] || null; },
    get length() { return map.size; }
  };
}

function makeOPFS(origin, ctx) {
  const dir = origin.opfs;
  class FileSystemFileHandle {
    constructor(name) { this.kind = 'file'; this.name = name; }
    async getFile() {
      const bytes = dir.get(this.name);
      if (!bytes) throw Object.assign(new Error('NotFound'), { name: 'NotFoundError' });
      return new ctx.Blob([bytes]);
    }
    async createWritable() {
      const name = this.name;
      let parts = [];
      let total = 0;
      return {
        async write(chunk) {
          const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          if (origin.failWrites && total + bytes.length > origin.failWrites.afterBytes) {
            throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
          }
          parts.push(bytes.slice());
          total += bytes.length;
        },
        async close() {
          const out = new Uint8Array(total);
          let at = 0;
          for (const p of parts) { out.set(p, at); at += p.length; }
          dir.set(name, out);
          parts = [];
        },
        async abort() { parts = []; }
      };
    }
  }
  const cacheDir = {
    kind: 'directory', name: 'cache',
    async getFileHandle(name, o) {
      if (!dir.has(name) && !(o && o.create)) throw Object.assign(new Error('NotFound'), { name: 'NotFoundError' });
      if (!dir.has(name)) dir.set(name, new Uint8Array(0));
      return new FileSystemFileHandle(name);
    },
    async removeEntry(name) {
      if (!dir.has(name)) throw Object.assign(new Error('NotFound'), { name: 'NotFoundError' });
      dir.delete(name);
    },
    async *entries() {
      for (const name of [...dir.keys()]) yield [name, new FileSystemFileHandle(name)];
    }
  };
  const root = {
    kind: 'directory', name: '',
    async getDirectoryHandle(name) { return cacheDir; }
  };
  return { getDirectory: async () => root };
}

function makeCacheAPI(origin, ctx) {
  const open = async (name) => {
    if (!origin.caches.has(name)) origin.caches.set(name, new Map());
    const store = origin.caches.get(name);
    const keyOf = (req) => (typeof req === 'string' ? req : req.url);
    return {
      async match(req) {
        const hit = store.get(keyOf(req));
        if (!hit) return undefined;
        return new ctx.Response(hit.body.slice(), { status: hit.status, headers: hit.headers });
      },
      async put(req, res) {
        const body = new Uint8Array(await res.arrayBuffer());
        store.set(keyOf(req), { status: res.status, headers: [...res.headers.entries()], body });
      },
      async add(req) {
        const res = await ctx.fetch(keyOf(req));
        if (!res.ok) throw new TypeError('Request failed');
        await this.put(req, res);
      },
      async keys() { return [...store.keys()].map(url => ({ url })); },
      async delete(req) { return store.delete(keyOf(req)); }
    };
  };
  return {
    open,
    async keys() { return [...origin.caches.keys()]; },
    async delete(name) { return origin.caches.delete(name); },
    async match(req) {
      for (const name of origin.caches.keys()) {
        const hit = await (await open(name)).match(req);
        if (hit) return hit;
      }
      return undefined;
    }
  };
}

/* Web Locks: exclusive, FIFO per name, released when the holder's promise settles. */
function makeLocks(origin) {
  return {
    request(name, optionsOrCb, maybeCb) {
      const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
      const opts = typeof optionsOrCb === 'function' ? {} : optionsOrCb;
      return new Promise((resolve, reject) => {
        const run = async () => {
          origin.locks.held.set(name, true);
          try { resolve(await cb({ name })); } catch (e) { reject(e); } finally {
            origin.locks.held.delete(name);
            const next = (origin.locks.queue.get(name) || []).shift();
            if (next) next();
          }
        };
        if (origin.locks.held.get(name)) {
          if (opts.ifAvailable) { resolve(cb(null)); return; }
          const q = origin.locks.queue.get(name) || [];
          q.push(run);
          origin.locks.queue.set(name, q);
        } else {
          run();
        }
      });
    }
  };
}

/* ------------------------------------------------------------- the network --- */

function hubRoute(origin, url, init, ctx, plan) {
  const method = (init && init.method) || 'GET';
  origin.fetchLog.push({ url, method, range: !!(init && init.headers && init.headers.Range) });
  if (origin.network.offline) throw new ctx.TypeError('Failed to fetch');
  // Scripted failures are matched first; a plan entry is consumed once.
  const step = plan && plan.find(p => p.match.test(url) && !p.used);
  if (step) {
    step.used = !!step.once;
    if (step.error) throw new ctx.TypeError(step.error);
    if (step.status) return new ctx.Response('nope', { status: step.status });
  }
  if (/\/raw\//.test(url)) {
    const resolved = url.replace('/raw/', '/resolve/');
    const entry = origin.hub.get(resolved);
    if (!entry || entry.pointer === false) return new ctx.Response('not found', { status: 404 });
    return new ctx.Response('version https://git-lfs.github.com/spec/v1\noid sha256:' + entry.sha256 + '\nsize ' + entry.bytes.length + '\n', { status: 200 });
  }
  const entry = origin.hub.get(url);
  if (!entry) return new ctx.Response('not found', { status: 404 });
  const size = entry.bytes.length;
  if (method === 'HEAD') {
    return new ctx.Response(null, { status: 200, headers: { 'content-length': String(size), etag: '"' + entry.sha256.slice(0, 12) + '"' } });
  }
  const headers = { 'content-length': String(entry.declaredSize || size), etag: '"' + entry.sha256.slice(0, 12) + '"' };
  const bytes = entry.bytes;
  const delay = entry.chunkDelayMs || 0;
  const shortAt = entry.truncateAt;
  const body = new ctx.ReadableStream({
    start(controller) {
      let at = 0;
      const chunk = entry.chunkSize || 64 * 1024;
      const signal = init && init.signal;
      const pump = () => {
        if (signal && signal.aborted) { controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })); return; }
        if (entry.stallAt !== undefined && at >= entry.stallAt) return;   // silent stall: no bytes, no end
        const limit = shortAt !== undefined ? Math.min(bytes.length, shortAt) : bytes.length;
        if (at >= limit) { controller.close(); return; }
        const end = Math.min(limit, at + chunk);
        controller.enqueue(bytes.slice(at, end));
        at = end;
        if (delay) setTimeout(pump, delay); else Promise.resolve().then(pump);
      };
      if (signal) signal.addEventListener('abort', () => { try { controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })); } catch (_) {} }, { once: true });
      pump();
    }
  });
  return new ctx.Response(body, { status: 200, headers });
}

/* --------------------------------------------------------- workers (real hash) */

function makeWorkerClass(ctx, origin) {
  return class FakeWorker {
    constructor(url) {
      this.url = String(url);
      this.listeners = {};
      this.terminated = false;
      if (/archiver-hash-worker\.js/.test(this.url)) {
        this._child = vm.createContext({ console, Uint8Array, TextEncoder, Date, Math, Promise, Error, setTimeout, clearTimeout, URL, DOMException });
        const child = this._child;
        child.self = child;
        child.globalThis = child;
        child.Blob = ctx.Blob;
        child.postMessage = (msg) => this._emit('message', { data: msg });
        child.importScripts = (rel) => {
          vm.runInContext(fs.readFileSync(path.join(WEB, path.basename(String(rel))), 'utf8'), child, { filename: String(rel) });
        };
        vm.runInContext(fs.readFileSync(path.join(WEB, 'archiver-hash-worker.js'), 'utf8'), child, { filename: 'archiver-hash-worker.js' });
        this.onmessage = null;
        this.onerror = null;
        this.messageerror = null;
      }
      origin.workers = origin.workers || [];
      origin.workers.push(this);
    }
    _emit(type, event) {
      if (this.terminated) return;
      if (type === 'message' && typeof this.onmessage === 'function') this.onmessage(event);
      (this.listeners[type] || []).forEach(fn => fn(event));
    }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn); }
    postMessage(msg) {
      if (!this._child) return;
      origin.hashJobs = (origin.hashJobs || 0) + 1;
      const child = this._child;
      setTimeout(() => { if (typeof child.onmessage === 'function') child.onmessage({ data: msg }); }, 0);
    }
    terminate() { this.terminated = true; if (this._child) this._child = null; }
  };
}

/* ---------------------------------------------------------- module loading --- */

async function loadWllamaNamespace(ctx) {
  const src = fs.readFileSync(WLLAMA_FILE, 'utf8');
  const mod = new vm.SourceTextModule(src, { context: ctx, identifier: 'wllama-3.6.1.js' });
  await mod.link(() => { throw new Error('the wllama bundle has no imports'); });
  await mod.evaluate();
  return mod.namespace;
}

/* A WebLLM stand-in: the real prebuilt config shape, a Cache-API completeness check
   of the same scopes WebLLM uses, and a controllable engine constructor. */
function makeWebLLMExports(ctx, origin, plan, opts) {
  origin.webllm = origin.webllm || { ids: [], configs: [], payloads: [], interrupts: 0, unloads: 0, engines: [] };
  const record = (id) => ({
    model_id: id,
    model: 'https://huggingface.co/mlc-ai/' + id,
    model_lib: 'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/' + id + '-webgpu.wasm',
    vram_required_MB: 945,
    low_resource_required: true
  });
  const models = [
    'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', 'Qwen2.5-0.5B-Instruct-q4f32_1-MLC',
    'Qwen3-0.6B-q4f16_1-MLC', 'Qwen3-0.6B-q4f32_1-MLC'
  ].map(record);
  const cacheHas = async (scope, url) => {
    const store = origin.caches.get(scope);
    return !!(store && store.has(url));
  };
  return {
    prebuiltAppConfig: { model_list: models },
    async hasModelInCache(modelId) {
      const rec = models.find(m => m.model_id === modelId);
      if (!rec) throw new Error('unknown model ' + modelId);
      const base = rec.model + '/resolve/main/';
      return cacheHas('webllm/model', base + 'tensor-cache.json');
    },
    CreateWebWorkerMLCEngine: async (worker, modelId, config) => {
      const log = origin.webllm;
      log.ids.push(modelId);
      log.configs.push(config);
      const step = plan && plan.find(p => p.match.test(modelId) && !p.used);
      if (step && step.once) step.used = true;
      if (step && step.error) throw new ctx.Error(step.error);
      if (step && step.hang) return new Promise(() => {});
      if (step && step.deviceLost) {
        // The worker reports the GPU fault through its own error signal, then the start-up fails.
        setTimeout(() => worker._emit && worker._emit('error', { message: 'WebGPU device was lost' }), 0);
        return new Promise(() => {});
      }
      if (config && config.initProgressCallback) {
        config.initProgressCallback({ progress: 0.5, text: 'Loading shards' });
        config.initProgressCallback({ progress: 1, text: 'Loaded' });
      }
      const base = (models.find(m => m.model_id === modelId) || models[0]).model + '/resolve/main/';
      const store = origin.caches.get('webllm/model') || new Map();
      origin.caches.set('webllm/model', store);
      store.set(base + 'tensor-cache.json', { status: 200, headers: [], body: new Uint8Array([123, 125]) });
      const engine = {
        interruptGenerate() { log.interrupts++; },
        unload: async () => { log.unloads++; },
        chat: { completions: { create: async (args) => {
          log.payloads.push(args);
          const set = opts && opts.nextChunks ? opts.nextChunks() : ['WebGPU answer.'];
          return (async function* () { for (const c of set) yield { choices: [{ delta: { content: c } }] }; })();
        } } }
      };
      log.engines.push(engine);
      return engine;
    }
  };
}

/* ---------------------------------------------------------- the whole thing --- */

/* Options:
     origin       shared storage/network object (createOrigin); a fresh one by default
     navigator    overrides merged into navigator (connection, onLine, gpu, userAgent, locks)
     storage      { denied: bool } — localStorage/sessionStorage throw
     durableOPFS  false removes OPFS (memory-only sessions)
     plan         scripted failures: [{ match: /regex/, error|status, once }]
     gpuPlan      scripted WebLLM outcomes: [{ match: /regex/, error|hang, once }]
     timeouts     overrides for ArchiverPrep.configure({ timeouts })
     wllamaStub   true: replace Wllama with a stand-in (engine tests); default: real module
     touch        true: the page reports a touch-first device
     visibility   'visible' | 'hidden'
     requestIdle  true: provide requestIdleCallback (fallback is setTimeout)
*/
async function createBrowser(options) {
  const opts = options || {};
  const origin = opts.origin || createOrigin(opts.originOptions);
  const ctx = {};
  const localMap = origin.local;
  const sessionMap = origin.session;
  const storageDenied = !!(opts.storage && opts.storage.denied);
  const nav = Object.assign({
    userAgent: opts.userAgent || 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36',
    onLine: !origin.network.offline,
    hardwareConcurrency: 8,
    connection: { saveData: false, effectiveType: '4g', downlink: 20 }
  }, opts.navigator || {});
  ctx.console = console;
  ctx.setTimeout = setTimeout; ctx.clearTimeout = clearTimeout;
  ctx.setInterval = setInterval; ctx.clearInterval = clearInterval;
  ctx.URL = URL; ctx.URLSearchParams = URLSearchParams;
  ctx.AbortController = AbortController; ctx.AbortSignal = AbortSignal;
  ctx.DOMException = DOMException;
  ctx.Error = Error; ctx.TypeError = TypeError; ctx.RangeError = RangeError;
  ctx.Uint8Array = Uint8Array; ctx.ArrayBuffer = ArrayBuffer; ctx.Promise = Promise;
  ctx.Blob = Blob; ctx.File = File; ctx.Response = Response; ctx.Headers = Headers; ctx.Request = Request;
  ctx.ReadableStream = ReadableStream; ctx.TransformStream = TransformStream; ctx.WritableStream = WritableStream;
  ctx.TextEncoder = TextEncoder; ctx.TextDecoder = TextDecoder;
  ctx.JSON = JSON; ctx.Math = Math; ctx.Date = Date; ctx.Symbol = Symbol; ctx.Map = Map; ctx.Set = Set;
  ctx.Object = Object; ctx.Array = Array; ctx.String = String; ctx.Number = Number; ctx.Boolean = Boolean;
  ctx.RegExp = RegExp; ctx.Reflect = Reflect; ctx.Proxy = Proxy; ctx.parseInt = parseInt; ctx.isNaN = isNaN;
  ctx.queueMicrotask = queueMicrotask; ctx.structuredClone = structuredClone;
  ctx.crypto = crypto.webcrypto;
  ctx.WebAssembly = { validate: () => true, instantiate: async () => ({}) };
  ctx.localStorage = storageMap(localMap, storageDenied);
  ctx.sessionStorage = storageMap(sessionMap, storageDenied);
  ctx.caches = makeCacheAPI(origin, ctx);
  const visibility = { state: opts.visibility || 'visible', listeners: [] };
  ctx.document = {
    baseURI: opts.baseURI || ORIGIN,
    get visibilityState() { return visibility.state; },
    addEventListener(type, fn) { if (type === 'visibilitychange') visibility.listeners.push(fn); },
    body: null
  };
  ctx.location = { href: ORIGIN, protocol: 'http:', origin: 'http://localhost' };
  ctx.navigator = nav;
  // The OPFS backend detects support from this prototype (as real browsers expose it).
  if (opts.durableOPFS !== false) {
    ctx.FileSystemFileHandle = function FileSystemFileHandle() {};
    ctx.FileSystemFileHandle.prototype.createWritable = function () {};
  }
  ctx.navigator.storage = {
    getDirectory: async () => (opts.durableOPFS === false ? (() => { throw Object.assign(new Error('no OPFS'), { name: 'NotSupportedError' }); })() : makeOPFS(origin, ctx).getDirectory()),
    estimate: async () => ({ quota: origin.quota, usage: usageOf(origin) }),
    persist: async () => origin.persistAnswer,
    persisted: async () => origin.persisted
  };
  ctx.navigator.locks = opts.noLocks ? undefined : makeLocks(origin);
  ctx.matchMedia = (q) => ({ matches: /coarse/.test(q) ? !!opts.touch : false });
  if (opts.requestIdle) ctx.requestIdleCallback = (fn, o) => setTimeout(() => fn({ didTimeout: false }), 0);
  ctx.Worker = makeWorkerClass(ctx, origin);
  ctx.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    return hubRoute(origin, url, init || {}, ctx, opts.plan || null);
  };
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.globalThis = ctx;
  ctx.addEventListener = (type, fn) => {
    (ctx.__listeners = ctx.__listeners || {});
    (ctx.__listeners[type] = ctx.__listeners[type] || []).push(fn);
  };
  ctx.dispatchEvent = (type, event) => {
    ((ctx.__listeners || {})[type] || []).forEach(fn => fn(event));
  };
  ctx.Archiver = undefined;
  if (opts.crossOriginIsolated !== false) ctx.crossOriginIsolated = true;
  if (opts.sharedArrayBuffer !== false) ctx.SharedArrayBuffer = SharedArrayBuffer;
  ctx.__isolation = undefined;
  vm.createContext(ctx);

  // Modules: real wllama (or a stand-in Wllama class), WebLLM stand-in.
  const wllamaReal = await loadWllamaNamespace(ctx);
  let wllamaNS = wllamaReal;
  if (opts.wllamaStub) {
    const stub = opts.wllamaStub;
    const synthetic = new vm.SyntheticModule(['Wllama', 'LoggerWithoutDebug', 'CacheManager', 'ModelManager', 'Model', 'ModelValidationStatus', 'isValidGgufFile'], function () {
      this.setExport('Wllama', stub);
      this.setExport('LoggerWithoutDebug', wllamaReal.LoggerWithoutDebug);
      this.setExport('CacheManager', wllamaReal.CacheManager);
      this.setExport('ModelManager', wllamaReal.ModelManager);
      this.setExport('Model', wllamaReal.Model);
      this.setExport('ModelValidationStatus', wllamaReal.ModelValidationStatus);
      this.setExport('isValidGgufFile', wllamaReal.isValidGgufFile);
    }, { context: ctx });
    await synthetic.link(() => {});
    await synthetic.evaluate();
    wllamaNS = synthetic.namespace;
  }
  const webllmExports = makeWebLLMExports(ctx, origin, opts.gpuPlan || null, opts);
  const webllmSynthetic = new vm.SyntheticModule(Object.keys(webllmExports), function () {
    for (const k of Object.keys(webllmExports)) this.setExport(k, webllmExports[k]);
  }, { context: ctx });
  await webllmSynthetic.link(() => {});
  await webllmSynthetic.evaluate();

  // A browser without WebAssembly: the context's own global must go, not just a property.
  if (opts.noWasm) vm.runInContext('delete globalThis.WebAssembly', ctx);

  const imports = [];
  const importer = async (specifier) => {
    imports.push(String(specifier));
    if (/web-llm-0\.2\.80\.js$/.test(specifier)) return webllmSynthetic;
    if (/wllama-3\.6\.1\.js$/.test(specifier)) {
      const m = new vm.SyntheticModule(Object.keys(wllamaNS).filter(k => k !== 'default'), function () {
        for (const k of Object.keys(wllamaNS)) if (k !== 'default') this.setExport(k, wllamaNS[k]);
      }, { context: ctx });
      await m.link(() => {});
      await m.evaluate();
      return m;
    }
    throw new Error('unexpected import ' + specifier);
  };
  ctx.__imports = imports;
  const files = ['archiver-sha256.js', 'archiver-prep.js', 'archiver-knowledge.js', 'archiver-comprehension.js', 'archiver-engine.js'];
  for (const file of files) {
    if (file === 'archiver-knowledge.js' && opts.skipKnowledge) continue;
    const script = new vm.Script(fs.readFileSync(path.join(WEB, file), 'utf8'), {
      filename: file,
      importModuleDynamically: importer
    });
    script.runInContext(ctx);
  }
  if (opts.timeouts) ctx.ArchiverPrep.configure({ timeouts: opts.timeouts });
  ctx.__visibility = visibility;
  return { ctx, origin, Prep: ctx.ArchiverPrep, Archiver: ctx.Archiver, wllamaNS, webllm: webllmExports, imports };
}

module.exports = { createBrowser, createOrigin, fakeGGUF, sha256Hex, ORIGIN, WEB };
