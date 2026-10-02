# Archiver on GitHub Pages — the static preview

**Live site:** <https://2archiver.github.io/Archiver/>
**Workflow:** `.github/workflows/pages.yml` → `scripts/build_pages.py` → `actions/deploy-pages`

Pages hosts the *frontend only*. That is the whole point of the architecture:
generation runs in the visitor's browser (WebGPU where the browser has it, the
WebAssembly runtime where it does not), the knowledge corpus is a bundled
JavaScript file, and conversations live in `localStorage`. Nothing server-side
is deployed, so there is no database, no memory bank and no API key that could
leak — the builder additionally refuses to emit `*.db`, `*.py`, `.env`, `.git`
or key files even if they existed in the checkout.

## One-time setup (repository owner)

Pages has to build from the workflow rather than from a branch folder:
**Settings → Pages → Build and deployment → Source → GitHub Actions** — or

```bash
gh api -X PUT repos/2archiver/Archiver/pages -f build_type=workflow
```

While the source is still *Deploy from a branch* (`main` / root), GitHub serves
the repository README through Jekyll instead of the app, and the `deploy` job
of the Pages workflow fails with "Ensure GitHub Pages has been enabled". After
the switch, the next push to `main` (or **Actions → Pages → Run workflow**)
publishes the site.

## How one codebase serves two hosts

Every asset reference in `web/` is document-relative and every same-origin
fetch is rebased through a small `ABS()` helper:

- Render (uvicorn/`app.main`): page at `/` → `static/…` → `/static/…`, `api/…` → `/api/…`.
  Byte-for-byte the same URLs as before.
- Pages: page at `/Archiver/` → the same refs resolve under `/Archiver/…`.

The `web/manifest.json` PWA fields (`start_url`, `scope`, icons) are relative
too, so an install from Pages is scoped to `/Archiver/` instead of claiming
the whole `github.io` origin.

## What static mode disables

On the first load the app probes `api/health`. A static host answers 404, the
app marks `SERVER.online = false` once, and from then on:

- **Server sync** (session mirroring, settings store) is skipped silently —
  chats still save and reload from this browser.
- **Live web search** fails fast with the existing honest error path
  ("no usable sources"), never a hang: the Pages artifact has no search proxy.
- **Settings → Export archive** says it needs the server and points at the
  per-conversation Download, which is browser-local.
- The thought-panel toast explains the mode once per load instead of nagging
  after every turn.

## Shared memory without COOP/COEP headers

The vendored `wllama` build allocates `WebAssembly.Memory({shared:true})`
even to run one thread, and browsers only grant shared memory in a
cross-origin-isolated document (COOP + COEP). The app server sends those
headers itself; **GitHub Pages cannot send any response headers.**

`scripts/build_pages.py` therefore injects a five-line bootstrap that
registers `web/archiver-coi-sw.js` — a service worker that synthesizes
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` on same-origin **documents and
worker scripts**. That is the standard GitHub-Pages trick for isolation; the
page reloads exactly once (guarded by `sessionStorage`, no reload loops) and
lands isolated. Desktop Chrome and Edge gate `SharedArrayBuffer` behind
isolation as well, so every desktop browser takes that one reload on its first
visit; a page that is already isolated never reloads. If a browser refuses
SW-granted isolation, the engine's preflight fails before the weights download
with a message that names the cause instead of a mystery.

**Worker scripts matter.** A page served with `COEP: require-corp` refuses to
start a worker whose script response does not carry COEP itself. Stamping only
navigations (the first version of this worker) left the WebGPU model worker
(`static/archiver-worker.js`) blocked on every isolated page — Chromium reports
`net::ERR_BLOCKED_BY_RESPONSE`. Opaque and redirect responses are handed back
untouched, since they cannot be rebuilt. `tests/pages.js` runs the worker
against a fake scope to keep all of this honest.

This mirrors Render's own `ARCHIVER_COEP=require-corp` default, so the set of
subresources (same-origin files, CORS-mode model downloads from
huggingface.co) is unchanged — everything the Pages site loads already
satisfies `require-corp`.

## The model is not what limits github.io

Pages only hosts the page and the two vendored runtimes (`web/vendor/`, about
20 MB). Model weights are never in the repository or the artifact: both
families are fetched from huggingface.co in CORS mode (which `require-corp`
allows) and cached in the visitor's browser, so *which* model is the default
changes the visitor's download and GPU memory, not whether the site deploys.
What did gate the site was the host: server-rooted URLs, no backend, and no
way to send COOP/COEP headers — the sections above. The default is
Qwen2.5-0.5B-Instruct with Qwen3-0.6B as fallback
(see [MODEL-UPGRADE.md](MODEL-UPGRADE.md)); on the CPU path both are the same
~429 MB download.

## What was verified, and what was not

Checked in headless Chromium 153 against the built site served at `/Archiver/`
by a static server that sends no COOP/COEP headers (a stand-in for Pages on
`http://localhost`):

- the service worker registers, the page reloads exactly once, and
  `crossOriginIsolated` / `SharedArrayBuffer` are then available (neither is
  available in desktop Chromium before that);
- the WebGPU model worker (`static/archiver-worker.js`, a module worker) is
  blocked with the first version of the service worker and starts with this one;
- with a small random-weight GGUF standing in for the Qwen2.5 file (served from
  a mocked `huggingface.co`), the unmodified page loads the real vendored
  wllama 3.6.1 build, starts its multithreaded workers, requests the
  `qwen2.5-0.5b-instruct-q4_0.gguf` URL first, and streams a generation;
- no console errors or failed requests other than the expected `api/health`
  404 of the static-mode probe.

**Not verified:** WebGPU generation (headless Chromium has no usable adapter),
real Qwen weights or answer quality, Hugging Face reachability from a visitor's
network, and Safari or Firefox. Treat those as the first things to try on the
live site.

## Rebuilding locally

```bash
make pages                      # → dist/pages/
python3 -m http.server -d "$(dirname dist/pages)" 8080   # then http://localhost:8080/pages/
make test                       # includes tests/pages.js (layout, refs, safety gates)
```

## What remains Render-only

The API, web-search proxy, settings/archive export, and cross-device session
sync. Nothing in this file changes those — `app/main.py` gained no routes and
the injected bootstrap lives only in the built Pages artifact.
