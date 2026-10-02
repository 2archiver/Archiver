# Archiver on GitHub Pages — the public site

**Public site:** <https://2archiver.github.io/Archiver/>
**Workflow:** `.github/workflows/pages.yml` → `scripts/build_pages.py` → `actions/deploy-pages`

The public-facing app has moved to the project site on GitHub Pages. The Render deployment remains available as an optional backend for live web search and cross-device sync; GitHub Pages is the public front door and runs the local-first client. Pages hosts the *frontend only*. That is the whole point of the architecture:
generation runs in the visitor's browser (WebGPU where the browser has it, the
WebAssembly runtime where it does not), the knowledge corpus is a bundled
JavaScript file, and conversations live in `localStorage`. Nothing server-side
is deployed, so there is no database, no memory bank and no API key that could
leak — the builder additionally refuses to emit `*.db`, `*.py`, `.env`, `.git`
or key files even if they existed in the checkout.

## The Pages source: GitHub Actions, asserted by the workflow

Pages has to build from the workflow rather than from a branch folder, and the
workflow no longer assumes that is already true.
`scripts/ensure_pages_source.py` runs before every build on `main` and is a
no-op unless something is wrong:

- source already *GitHub Actions* → one GET, nothing else;
- source *Deploy from a branch* → `PUT /repos/…/pages` with
  `build_type=workflow`, then a re-read to confirm it took;
- Pages not enabled at all → the same call as a `POST`.

If the API refuses (the run's token may not change repository settings), the
step fails with the settings path instead of deploying into a host that will
404. The manual equivalent remains

```bash
gh api -X PUT repos/2archiver/Archiver/pages -f build_type=workflow
```

or **Settings → Pages → Build and deployment → Source → GitHub Actions**.

`actions/configure-pages@v5` with `enablement: true` looks like the standard
way to assert this and is not: it calls `getPagesSite()` first and returns the
existing site when there is one, so `build_type: workflow` is only sent when
Pages is off entirely. Against a branch-sourced site it succeeds in about a
second having changed nothing, which is why the API call lives in the repo.

## A green deploy is not a working site (2026-10-02)

On 2026-10-02 <https://2archiver.github.io/Archiver/> served GitHub's 404 page
— *"The site configured at this address does not contain the requested file …
For root URLs (like `http://example.com/`) you must provide an `index.html`
file"* — while the `Pages` workflow's deploy job and the `github-pages`
deployment status were both green.

What had happened: the repository's Pages source was on *Deploy from a branch*
(`main` / `docs`), so GitHub's built-in builder ran on the same push as the
workflow, landed a couple of minutes later, and replaced the deployed app with
its own build of `docs/` — five rendered markdown files and no `index.html`.
The site's last successful deployment was that 34 KB artifact, while the
workflow's was 9.4 MB. `/Archiver/` 404'd; `/Archiver/PAGES.html` answered 200
with the rendered copy of this file, which is how the leftover was identified.
`actions/deploy-pages` had done its job — it uploads an artifact and asks Pages
to publish it, and nothing tells it that something else publishes afterwards.

Three guards now make that failure hard to repeat and impossible to miss:

- **The source assertion above**, so GitHub's built-in builder stops being
  scheduled at all.
- **A settle step**: when the assertion did change the source, a built-in build
  already queued for the same commit is allowed to finish before the deploy, so
  the workflow's artifact is the last one published (a settings change stops
  new builds being queued, but not a run that already exists).
- **A post-deploy check**: `scripts/verify_pages_site.py` fetches the URL
  `actions/deploy-pages` reported and requires the app shell (the page must name
  `static/archiver-engine.js` — GitHub's 404 page and the docs-only build do
  not) plus a 200 for `manifest.json`, `favicon.svg`, `archiver-coi-sw.js`,
  `static/archiver-engine.js`, `static/archiver-worker.js` and
  `static/vendor/wllama-3.6.1.wasm`. It retries for two minutes because a fresh
  deployment takes a moment to reach every edge, and it fails the run with the
  settings path if the host is serving something else.

The workflow also runs the whole thing once a day (`cron: '17 6 * * *'`), so a
site replaced by a hand-made settings change is repaired — or reported red —
within a day rather than waiting for the next push.

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

After the local interface and cached conversation are ready, the app probes
`api/health`. A static host answers 404, the app marks `SERVER.online = false`,
and from then on:

- **Server sync** (session mirroring, settings store) is skipped silently —
  chats still save and reload from this browser.
- **Live web search** needs the optional backend and cannot retrieve sources on
  Pages; local knowledge and on-device generation remain available.
- **Settings → Export archive** says it needs the server and points at the
  per-conversation Download, which is browser-local.
- There is no startup warning toast; the local app opens immediately. Actions
  that specifically need the server explain that when attempted.

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
make test                       # includes tests/pages.js and tests/test_pages_deploy.py
```

`tests/test_pages_deploy.py` covers the two guards offline: the source assertion
against a fake `gh` (already-workflow, branch-sourced, not-enabled, refused and
write-did-not-take), and the post-deploy verifier against a real loopback HTTP
server serving an app-shaped site, a docs-only site (the 2026-10-02 state) and a
site missing an asset. One test builds the real site and checks every path the
verifier demands still exists, so a rename cannot turn a good deploy red.

## What remains Render-only

The API, web-search proxy, settings/archive export, and cross-device session
sync. Nothing in this file changes those — `app/main.py` gained no routes and
the injected bootstrap lives only in the built Pages artifact.
