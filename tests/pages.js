/* Static-deploy checks for scripts/build_pages.py.

   These run offline: they execute the real builder into a temp dir and verify
   what it emits — layout, the isolation bootstrap (executed, not just grepped),
   host-agnostic paths under /Archiver/, the vendored runtimes, and the safety
   gates that keep databases and server code out of a public site.

   The service worker's behaviour is in tests/sw.js. A live pass against the
   published site is the Pages workflow's job (docs/PAGES.md). */
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'archiver-pages-'));
let checks = 0;
const check = (ok, msg) => { assert.ok(ok, msg); checks++; };

execFileSync('python3', [path.join(ROOT, 'scripts', 'build_pages.py'), '--out', out], { stdio: 'inherit' });

const site = (p) => fs.readFileSync(path.join(out, p), 'utf8');
const has = (p) => fs.existsSync(path.join(out, p));

/* ---- layout: root entry files, everything else under static/ ---- */
for (const f of ['index.html', 'manifest.json', 'favicon.svg', 'apple-touch-icon.png', 'archiver-coi-sw.js'])
  check(has(f), `site root carries ${f}`);
for (const f of ['static/archiver-knowledge.js', 'static/archiver-engine.js', 'static/archiver-worker.js',
                 'static/archiver-prep.js', 'static/archiver-sha256.js', 'static/archiver-hash-worker.js',
                 'static/discord-banner.jpg', 'static/vendor/wllama-3.6.1.wasm', 'static/vendor/web-llm-0.2.80.js'])
  check(has(f), `static/ carries ${f}`);

/* ---- the CPU runtime ships both builds, from this site ---- */
for (const f of ['static/vendor/wllama-3.6.1.js', 'static/vendor/wllama-compat-3.6.1.js', 'static/vendor/wllama-compat-3.6.1.wasm'])
  check(has(f), `the CPU runtime carries ${f}`);
check(fs.statSync(path.join(out, 'static/vendor/wllama-compat-3.6.1.wasm')).size > 1000000, 'the compat binary is the real one (megabytes, not a stub)');

/* ---- the page only makes relative, host-agnostic references ---- */
const idx = site('index.html');
check(!/src="\/static|href="\/static/.test(idx), 'index.html: no root-absolute /static refs');
check(idx.includes('src="static/archiver-engine.js"'), 'index.html: script srcs are document-relative');
check(idx.includes('src="static/archiver-prep.js"') && idx.indexOf('archiver-prep.js') < idx.indexOf('archiver-engine.js'),
  'index.html: the controller loads before the engine');
check(idx.includes('href="manifest.json"') && idx.includes('href="favicon.svg"'), 'index.html: root links are relative');
check(idx.includes('document.baseURI') && /const ABS = /.test(idx), 'index.html: fetches route through the ABS rebaser');
check(/api\/archive\/export/.test(idx) && !/location\.href = '\/api/.test(idx), 'index.html: export rebased, never raw-navigates');
check(idx.includes('--viewport-height: 100vh') && idx.includes('--viewport-height: -webkit-fill-available') && idx.includes('@supports (height: 100dvh)'),
  'index.html: Safari viewport units have legacy, iOS, and dynamic fallbacks');

const engine = site('static/archiver-engine.js');
const prep = site('static/archiver-prep.js');
check(prep.includes("file: 'static/vendor/wllama-3.6.1.js'") && engine.includes('ABS(Prep.RUNTIME.wllamaWasm)'),
  'runtimes resolve through ABS (controller paths, engine binary)');
check(engine.includes('ABS(Prep.RUNTIME.wllamaCompatJs)') && engine.includes('ABS(Prep.RUNTIME.wllamaCompatWasm)'),
  'the compat build is referenced through ABS, never a CDN');
check(!/fetch\(['"]\/api|new Worker\(['"]\/|import\(['"]\/static/.test(engine + prep), 'engine and controller: no root-absolute network refs');
check(engine.includes('SharedArrayBuffer') && engine.includes('crossOriginIsolated'), 'engine: the CPU runtime is gated on real shared memory and isolation');
check(!/cdn\.jsdelivr|unpkg\.com/.test(engine + prep), 'no CDN hosts in the engine or the controller');

const manifest = JSON.parse(site('manifest.json'));
check(manifest.start_url === './' && manifest.scope === './', 'manifest: scope stays inside the project pages root');
check(manifest.icons.every(i => !i.src.startsWith('/')), 'manifest: icon paths are relative');

/* ---- the Pages-only isolation bootstrap ---- */
const bootstrapStart = idx.indexOf('<!-- pages-bootstrap');
const bootstrapEnd = idx.indexOf('</script>', bootstrapStart) + '</script>'.length;
check(bootstrapStart > 0 && idx.split('pages-bootstrap:').length === 2, 'the bootstrap is injected exactly once');
check(idx.indexOf('<link rel="icon"') > bootstrapEnd, 'and sits in <head>, before the icon link');
const bootstrapSource = idx.slice(bootstrapStart, bootstrapEnd);
const srcIdx = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
check(!srcIdx.includes('archiver-coi-sw.js') && !srcIdx.includes('pages-bootstrap'), 'the bootstrap is Pages-only: the served app shell is untouched');
check(!/location\.replace|location\.href\s*=/.test(bootstrapSource), 'the bootstrap never navigates to a rebuilt URL (query and hash are kept)');

/* Run the injected script for real, against a fake browser. */
function runBootstrap(options) {
  const opts = Object.assign({
    href: 'https://example.github.io/Archiver/?q=1#chat',
    crossOriginIsolated: false,
    secure: true,
    hasServiceWorker: true,
    sessionDenied: false,
    controller: false,
    controllerChangeAfterRegister: true,
    registerRejects: false,
    preset: null
  }, options || {});
  const store = new Map(opts.preset ? [['archiver-coi', opts.preset]] : []);
  const calls = { register: [], reload: 0, replace: 0, assign: 0, timers: [] };
  const listeners = {};
  const sw = {
    controller: opts.controller ? {} : null,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    register(url, reg) {
      calls.register.push({ url, scope: reg && reg.scope });
      if (opts.registerRejects) return Promise.reject(new Error('blocked'));
      if (opts.controllerChangeAfterRegister) {
        setTimeout(() => { sw.controller = {}; (listeners.controllerchange || []).forEach(fn => fn({})); }, 0);
      }
      return Promise.resolve({});
    }
  };
  const location = {
    href: opts.href,
    reload() { calls.reload++; },
    replace() { calls.replace++; },
    assign() { calls.assign++; }
  };
  const ctx = {
    isSecureContext: opts.secure,
    crossOriginIsolated: opts.crossOriginIsolated,
    URL,
    setTimeout: (fn, ms) => { calls.timers.push(ms); return setTimeout(fn, 0); },
    location,
    document: { baseURI: opts.href },
    navigator: opts.hasServiceWorker ? { serviceWorker: sw } : {},
    sessionStorage: opts.sessionDenied ? new Proxy({}, { get() { throw new Error('denied'); } }) : {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v))
    }
  };
  // In a browser the window is the global object: storage, navigator and location are on it.
  ctx.window = ctx;
  const win = ctx;
  vm.createContext(ctx);
  const script = bootstrapSource.replace(/^[\s\S]*?<script>/, '').replace(/<\/script>[\s\S]*$/, '');
  vm.runInContext(script, ctx);
  return { win, calls, store, sw };
}

const flush = () => new Promise(r => setTimeout(r, 20));

const bootstrapChecked = (async () => {
  let run = runBootstrap();
  await flush();
  check(run.calls.register.length === 1, 'first visit: the service worker is registered once');
  check(run.calls.register[0].url === 'https://example.github.io/Archiver/archiver-coi-sw.js', 'registered at the project scope URL');
  check(run.calls.register[0].scope === '/Archiver/', 'with scope /Archiver/');
  check(run.calls.reload === 1, 'and the page reloads exactly once');
  check(run.calls.replace === 0 && run.calls.assign === 0, 'the reload keeps the exact URL: no replace, no assign');
  check(run.store.get('archiver-coi') === 'reloaded', 'the reload is recorded before it happens');

  run = runBootstrap({ preset: 'reloaded' });
  await flush();
  check(run.calls.register.length === 0 && run.calls.reload === 0, 'after the one reload, a page that still is not isolated never loops');
  check(run.win.__archiverIsolation.state === 'unavailable' && run.win.__archiverIsolation.reason === 'not-isolated-after-reload',
    'and says so, for the status line');

  run = runBootstrap({ crossOriginIsolated: true });
  await flush();
  check(run.calls.register.length === 0 && run.calls.reload === 0, 'an isolated page does nothing');
  check(run.win.__archiverIsolation.state === 'isolated', 'and reports itself isolated');

  run = runBootstrap({ sessionDenied: true });
  await flush();
  check(run.calls.register.length === 0 && run.calls.reload === 0, 'denied storage: no reload is attempted (the guard cannot be kept)');
  check(run.win.__archiverIsolation.state === 'unavailable', 'and the state reports it');

  run = runBootstrap({ controllerChangeAfterRegister: false });
  await flush();
  check(run.calls.reload === 1 && run.calls.register.length === 1, 'a controller that never arrives is bounded: one reload, not a loop');
  check(run.calls.timers.includes(6000), 'the wait for control has a bounded timeout');

  run = runBootstrap({ registerRejects: true });
  await flush();
  check(run.calls.reload === 0, 'a refused registration does not reload');
  check(run.win.__archiverIsolation.reason === 'sw-register-failed', 'and reports why');

  run = runBootstrap({ hasServiceWorker: false });
  await flush();
  check(run.calls.register.length === 0 && run.calls.reload === 0 && run.win.__archiverIsolation.reason === 'no-service-worker',
    'a browser without service workers gets no reload, and a reason');

  run = runBootstrap({ secure: false });
  await flush();
  check(run.calls.reload === 0, 'an insecure context is left alone');

  run = runBootstrap({ controller: true, controllerChangeAfterRegister: false });
  await flush();
  check(run.calls.reload === 1, 'a page already controlled still reloads once, so the worker takes effect for this document');

  /* The project path with a query and a hash: the reload keeps both, and the scope is /Archiver/. */
  run = runBootstrap({ href: 'https://example.github.io/Archiver/?sync=1#diag' });
  await flush();
  check(run.calls.register[0].scope === '/Archiver/' && run.calls.reload === 1, 'query and hash survive the first-visit reload');
})();

/* ---- the worker is registered at the project scope, and only there ---- */
check(/archiver-coi-sw\.js/.test(bootstrapSource) && /scope: scope\.pathname/.test(bootstrapSource), 'the worker is scoped to the page directory');

/* ---- the worker's own promises are tested in tests/sw.js; here: it ships with its version ---- */
const sw = site('archiver-coi-sw.js');
check(sw.includes('Cross-Origin-Opener-Policy') && sw.includes('Cross-Origin-Embedder-Policy'), 'worker injects both isolation headers');
check(/url\.origin !== self\.location\.origin/.test(sw), 'worker leaves cross-origin requests untouched');
check(/CACHE_PREFIX = 'archiver-shell-'/.test(sw), 'worker caches only under its own prefix');

/* ---- safety gates ---- */
const files = [];
(function r(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  const p = path.join(d, e.name); if (e.isDirectory()) r(p); else files.push(p); } })(out);
check(files.every(f => !/\.db(?:-wal|-shm)?$/.test(f)), 'no database files in the built site');
check(files.every(f => !/\.py$/.test(f)), 'no server source in the built site');
check(files.every(f => !/(^|[\\/.])\.(?:env|git|key|pem)(?:$|[\\/])/.test(path.basename(f))), 'no dotfiles/keys in the built site');

// A .db planted in web/ must abort the build (safety gate is real, not decorative).
fs.writeFileSync(path.join(ROOT, 'web', 'test-pages-leak.db'), 'x');
try {
  execFileSync('python3', [path.join(ROOT, 'scripts', 'build_pages.py'), '--out', out + '2'], { stdio: 'pipe' });
  check(false, 'build must refuse to ship a .db file');
} catch (e) {
  check(/refusing to publish/.test(String(e.stdout) + String(e.stderr)), 'build names the refused file');
} finally {
  fs.unlinkSync(path.join(ROOT, 'web', 'test-pages-leak.db'));
  fs.rmSync(out + '2', { recursive: true, force: true });
}

fs.rmSync(out, { recursive: true, force: true });
bootstrapChecked.then(() => console.log(`pages: ${checks} checks passed`), (e) => { console.error(e); process.exit(1); });
