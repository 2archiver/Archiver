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
`Cross-Origin-Embedder-Policy: require-corp` on same-origin navigations.
That is the standard GitHub-Pages trick for isolation; the page reloads
exactly once (guarded by `sessionStorage`, no reload loops) and lands
isolated. Chrome and Edge ship `SharedArrayBuffer` in any secure context, so
they never reload at all. If a browser refuses SW-granted isolation, the
engine's preflight fails before the weights download with a message that
names the cause instead of a mystery.

This mirrors Render's own `ARCHIVER_COEP=require-corp` default, so the set of
subresources (same-origin files, CORS-mode model downloads from
huggingface.co) is unchanged — everything the Pages site loads already
satisfies `require-corp`.

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
