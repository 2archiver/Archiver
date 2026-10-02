/* Static-deploy checks for scripts/build_pages.py.

   These run offline: they execute the real builder into a temp dir and verify
   what it emits — layout, the isolation bootstrap, host-agnostic paths, and
   the safety gates that keep databases and server code out of a public site.
   A live end-to-end pass (Pages build, COI reload, model run) is documented
   in docs/PAGES.md and happens in the Pages workflow run, not here. */
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
                 'static/discord-banner.jpg', 'static/vendor/wllama-3.6.1.wasm', 'static/vendor/web-llm-0.2.80.js'])
  check(has(f), `static/ carries ${f}`);

/* ---- the page only makes relative, host-agnostic references ---- */
const idx = site('index.html');
check(!/src="\/static|href="\/static/.test(idx), 'index.html: no root-absolute /static refs');
check(idx.includes('src="static/archiver-engine.js"'), 'index.html: script srcs are document-relative');
check(idx.includes('href="manifest.json"') && idx.includes('href="favicon.svg"'), 'index.html: root links are relative');
check(idx.includes('document.baseURI') && /const ABS = /.test(idx), 'index.html: fetches route through the ABS rebaser');
check(/api\/archive\/export/.test(idx) && !/location\.href = '\/api/.test(idx), 'index.html: export rebased, never raw-navigates');

const engine = site('static/archiver-engine.js');
check(engine.includes("ABS('static/vendor/wllama-3.6.1.js')"), 'engine: runtimes resolve through ABS');
check(engine.includes("ABS('static/archiver-worker.js')"), 'engine: worker resolves through ABS');
check(!/fetch\(['"]\/api|new Worker\(['"]\/|import\(['"]\/static/.test(engine), 'engine: no root-absolute network refs');
check(engine.includes('SharedArrayBuffer'), 'engine: wasm preflight gates on SharedArrayBuffer');

const manifest = JSON.parse(site('manifest.json'));
check(manifest.start_url === './' && manifest.scope === './', 'manifest: scope stays inside the project pages root');
check(manifest.icons.every(i => !i.src.startsWith('/')), 'manifest: icon paths are relative');

/* ---- the Pages-only isolation bootstrap ---- */
check(idx.includes('archiver-coi-sw.js') && idx.includes('sessionStorage'), 'bootstrap: one-time SW register + reload is injected');
const srcIdx = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
check(!srcIdx.includes('archiver-coi-sw.js'), 'bootstrap is Pages-only — the served app shell is untouched');
const sw = site('archiver-coi-sw.js');
check(sw.includes('Cross-Origin-Opener-Policy') && sw.includes('Cross-Origin-Embedder-Policy'), 'worker injects both isolation headers');
check(/url\.origin !== self\.location\.origin/.test(sw), 'worker leaves cross-origin requests untouched');

/* The worker is exercised, not just grepped: run it against a fake service-worker
   scope. Real-browser finding (Chromium 153): with COEP: require-corp on the page, a
   dedicated worker whose script response lacks COEP is refused with
   net::ERR_BLOCKED_BY_RESPONSE — which would silently kill the WebGPU model worker. */
const isolationWorkerChecked = (async () => {
  const handlers = {};
  const scope = {
    location: { origin: 'https://example.github.io' },
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting() {}, clients: { claim: async () => {} },
  };
  let upstream = () => new Response('body', { status: 200, headers: { 'content-type': 'text/javascript' } });
  vm.runInNewContext(sw, { self: scope, URL, Headers, Response, fetch: async () => upstream() });
  const run = async (req) => {
    let responded = null;
    handlers.fetch({ request: { method: 'GET', cache: 'default', mode: 'same-origin', destination: '', url: 'https://example.github.io/Archiver/x', ...req },
                     respondWith: (p) => { responded = p; } });
    return responded && await responded;
  };
  const doc = await run({ mode: 'navigate', destination: 'document', url: 'https://example.github.io/Archiver/' });
  check(doc.headers.get('Cross-Origin-Embedder-Policy') === 'require-corp' && doc.headers.get('Cross-Origin-Opener-Policy') === 'same-origin',
    'worker: navigations are isolated');
  const dedicated = await run({ destination: 'worker', url: 'https://example.github.io/Archiver/static/archiver-worker.js' });
  check(dedicated && dedicated.headers.get('Cross-Origin-Embedder-Policy') === 'require-corp',
    'worker: dedicated worker scripts carry COEP (the WebGPU model worker would be blocked otherwise)');
  const shared = await run({ destination: 'sharedworker' });
  check(shared && shared.headers.get('Cross-Origin-Embedder-Policy') === 'require-corp', 'worker: shared worker scripts carry COEP');
  for (const destination of ['script', 'image', 'style', 'font', ''])
    check((await run({ destination })) === null, `worker: ${destination || 'fetch()'} subresources pass through untouched`);
  check((await run({ destination: 'worker', url: 'https://huggingface.co/x.js' })) === null, 'worker: cross-origin requests are left alone');
  check((await run({ method: 'POST', mode: 'navigate', destination: 'document' })) === null, 'worker: only GET is touched');
  upstream = () => ({ status: 0, type: 'opaqueredirect' });
  const redirect = await run({ mode: 'navigate', destination: 'document', url: 'https://example.github.io/Archiver/' });
  check(redirect && redirect.type === 'opaqueredirect', 'worker: an opaque redirect is passed back as it is, not rebuilt');
})();

/* ---- safety gates ---- */
const files = [];
(function r(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  const p = path.join(d, e.name); if (e.isDirectory()) r(p); else files.push(p); } })(out);
check(files.every(f => !/\.db(?:-wal|-shm)?$/.test(f)), 'no database files in the built site');
check(files.every(f => !/\.py$/.test(f)), 'no server source in the built site');
check(files.every(f => !/(^|[\/.])\.(?:env|git|key|pem)(?:$|[\/])/.test(path.basename(f))), 'no dotfiles/keys in the built site');

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
isolationWorkerChecked.then(() => console.log(`pages: ${checks} checks passed`), (e) => { console.error(e); process.exit(1); });
