# Archiver 5.2

**An everyday assistant with instant local tools, open-ended answers from Archiver 5.2 — our own model — and live web search when you ask.**

No account or model-provider API key. Two inference runtimes are bundled with the website — WebGPU where a browser offers it, WebAssembly where it does not — and model assets are fetched and cached automatically in the browser. No model server, deployment-time npm step, or model weights in Git.

## New in 5.2 — 3 questions, simpler changelog, reliable online & GPU, Safari-optimised

- **Home: 3 questions.** Start page now shows 3 example prompts instead of 6 — clearer first-run, 3-col desktop / 1-col mobile grid.
- **Simpler changelog.** Release notes in-app and in CHANGELOG.md rewritten to short, readable bullets.
- **Online search fixed.** Wake hint, 75s timeout with retry, provider cooldown, empty report now synthesises a reading from sources, sources shown even without model, unverified flag works reliably.
- **GPU chat fixed.** WebGPU adapter probe hardened (f16 fallback, canary allocation), device-lost recovery, interrupt/cancel works on both runtimes, streaming coalescer fixed, progress shown when cached.
- **Safari optimised.** Cached model now warms on page load even on iOS (was deferred), prepare() triggers earlier while typing, WASM threads 3 on iPhone (was 4), batch 1024 on Apple mobile / 512 elsewhere, parallelDownloads 4, compact CPU persona, OPFS cache recovery, viewport with interactive-widget=resizes-content, 16px inputs to prevent zoom.
- **Bug fixes.** api() timeout respects custom signals, blank-answer recovery, citation validation, answer cache guards, storage quota handling, memory sync.
- **Corpus — 1,526 cards**, including ten Sopranos cards (sop-overview, sop-gandolfini, sop-finale, sop-cast, sop-melfi, sop-theme, sop-locations, sop-many-saints, sop-pine-barrens, sop-legacy) [...SOPRANOS].

## New in 4.3 — resilient search, open-minded persona, OLED theme

- **Search that survives provider blocks.** New DuckDuckGo-HTML and
  Wikipedia-OpenSearch legs, a second-chance round when every primary hit
  fails the relevance bar, a browser-UA retry when Bing refuses the first
  request, and a Bing parser that tolerates markup shifts.
- **One-word queries score honestly.** Relevance for a lone query word no
  longer clears the bar with zero overlap — the bug that let junk stubs gate
  as answers and starved the fallbacks.
- **Empty searches explain themselves.** The Thought-process panel names the
  upstream cause (a 403, a cooldown) instead of silently moving on.
- **Open-minded persona.** Committed takes, edgy questions engaged directly,
  brief declines only for genuine real-world harm — no lectures, no sermons.
- **69 new knowledge cards (1,515 total)** — strongmen and dictators,
  the ancient world, the Middle East, science, Australia, tech, culture.
- **OLED true-black theme**, applied before first paint with matching browser
  chrome. Faster retrieval, gzipped assets (~4x smaller), deferred scripts.
- **Bug fixes:** theme-following diagnostics, styled memory cards/changelog/
  session rows/typing indicator/toasts, retry keeps full history, and
  "funnel web" no longer opens the WEB explainer.

## New in 4.2 — capability checks, diagnostics, hardening

- **WebGPU only when it will actually work.** The adapter must be hardware,
  allow ≥ 128 MiB buffers, and pass a 64 MiB test allocation; otherwise the
  WebAssembly runtime is used and the audit trail says why. See
  [docs/BROWSER-SUPPORT.md](docs/BROWSER-SUPPORT.md) for the Chrome / Edge /
  Firefox / Safari (macOS, iOS) / Android matrix and the versions assumed.
- **Diagnostics** — Settings → Diagnostics, `#diag`, or Ctrl/⌘+Shift+D. Paste
  the report into bug reports. It can also clear cached model weights.
- **Render free has no persistent disk.** The server database is recreated on
  every restart or redeploy. Your chats live in this browser; when the server
  was reset, a banner says so. Use Settings → export to keep a JSON copy.
- **Hardened for one small instance:** COOP/COEP isolation and security
  headers, per-IP rate limits, request-size and concurrency caps, SQLite tuned
  for low memory with a WAL flush on shutdown, search-provider cooldowns,
  memory de-duplication, contradiction handling and a per-user cap.

Optional environment variables (none required):

| Variable | Default | Meaning |
|---|---|---|
| `ARCHIVER_COEP` | `require-corp` | `credentialless` or `off` to relax isolation |
| `ARCHIVER_CSP` | `report-only` | `enforce` or `off` |
| `ARCHIVER_RATE` | `search=30/60,sync=60/60,import=5/60` | per-IP requests/window(s) |
| `ARCHIVER_MAX_BODY` | `2097152` | request body cap (bytes) |
| `ARCHIVER_MAX_INFLIGHT` | `24` | concurrent requests before 503 |
| `ARCHIVER_MEMORY_CAP` | `2000` | memories per browser identity |
| `ARCHIVER_PROVIDER_COOLDOWN` | `600` | seconds to skip a blocked search provider |
| `ARCHIVER_PROVIDER_TIMEOUT` | `12` | per-provider search timeout (s) |

**Keep-warm trade-off.** `/api/ping` is the cheapest endpoint to hit. An
external pinger every ~10 minutes avoids 30–60 s cold starts, but it uses the
free tier's monthly instance hours continuously (one always-on free service
roughly consumes the whole allowance) and Render may treat artificial traffic
as against the spirit of the free plan. Archiver does not ship a pinger; the UI
shows "Waking the server…" instead.

## Safari and answer-reliability hotfix

- Safari/iOS (including iOS Chrome/Firefox) and hidden tabs no longer start model
  workers during page opening. A generative request still starts the model on
  demand. Cached model weights are retained; live workers are released on page
  exit and recreated after restoration. Pending WASM loads are cleaned up too.
- Fixed a reproducible viewport error: the real page did not inject timers, but
  the animation fallback called an undefined `deps.setTimeout` on focus/resize.
- Conversation downloads attach their anchor, keep the blob URL alive for 60
  seconds rather than one, and do not replace the app tab if opened as a file.
- Requested searches with no usable results now report missing evidence instead
  of silently generating from model memory. Fresh-fact/source-request detection
  is a heuristic; it is not a comprehensive factual-intent classifier.
- Web evidence is retained in a compact prompt on small contexts, or the answer
  is declined if it still cannot fit. Web IDs and local-card IDs are distinct.
- Generated answers are **buffered until citation checks finish**, then displayed.
  Unknown numeric citation IDs and HTTP(S) URLs outside supplied sources/the
  request cause the draft to be withheld. Code examples are excluded. This is
  citation-membership checking, **not verification that a claim is true or that
  the cited passage supports it**. Uncited false claims can still pass.
- Non-writing generation uses a lower default temperature (0.15); instructions
  allow uncertainty rather than forcing confident source assessments.

This updates the application's inference/retrieval safeguards, not the Qwen
weights. It cannot guarantee zero hallucinations. Tests use stub inference;
there is no measured factual-quality improvement on a real-model benchmark yet.

### Safari troubleshooting and validation

Open the actual HTTPS website URL, not a saved `blob:` URL. Blob URLs belong to
the page that created them and cannot be made into durable bookmarks by this
patch. The reported intermittent `WebKitBlobResource error 1` has **not** been
reproduced on the affected device. These are targeted startup/download
mitigations, not proof that every cause of that error has been eliminated.

Automated checks: `node tests/download.js`, `node tests/viewport.js`,
`node --experimental-vm-modules tests/model.js`, `node tests/offline.js`,
`node tests/smoke.js`, and `python -m pytest tests/ -q`.
With Playwright installed and the app running, run `node tests/browser-safari.js`
for desktop/mobile WebKit reload, history navigation and downloads, and
`node tests/browser-ai.js` for Chromium generation integration. Linux WebKit
emulation is not an actual iPhone/Mac Safari test. Device follow-up should cover
cold/cached opening, tab restoration, first generation, cancellation, and export.

## New in 4.0 — the free-tier budget release

4.0 is built around its deployment target: a Render free web service that
spins down when idle, throttles past one shared monthly bandwidth allowance,
and runs on 512 MB RAM with an ephemeral disk. Each change names the
constraint it serves.

- **Cold starts, named instead of mysterious.** The first search that runs
  past a few seconds shows a distinct **“Waking the server…”** state rather
  than an anonymous spinner: the free instance sleeps after ~15 minutes idle
  and takes tens of seconds to answer. There is deliberately **no keep-alive
  pinger** — keeping the instance hot is exactly what spin-down exists to
  prevent, and self-pinging burns the same metered bandwidth as real traffic.
  `/api/health` stays fetch-free (a test pins that) so it answers the moment
  uvicorn binds, which is what lets the UI tell “waking” from “broken”.
- **Service-Initiated egress is bounded in one place.** Every outbound fetch
  the search path makes now goes through the guarded fetcher in `app/take.py`:
  streamed under a **2 MB ceiling** (oversized bodies are aborted mid-stream,
  never read whole), **content-type gated** before the body is downloaded
  (`take.py` only ever needs text), `Accept-Encoding: gzip` on every request
  with only **decompressed bytes** kept, an in-process **TTL cache** on the
  normalised URL (dict + timestamps, bounded by entries and bytes — it dies
  with the instance, and that is fine: the disk is ephemeral anyway), and a
  **concurrency cap** of four so one query fanning out cannot saturate the
  shared CPU.
- **Vendored model bytes, as cheap as possible to serve.** The
  `web-llm` / `wllama` runtimes carry strong content-addressed `ETag`s: a warm
  browser revalidates and receives `304` instead of the payload, the pre-compressed
  `.gz` variants keep serving on `Accept-Encoding` negotiation, and the
  immutable one-year `cache-control` is unchanged. `tests/test_api.py` pins the
  MIME types, headers, integrity and the conditional path.
- **Why no WebSockets, in writing.** Inference is client-side, so there is no
  token stream to push; a socket would hold the instance awake (defeating the
  only cost control), bill every frame into the priciest bandwidth meter, and
  reconnect-storm on wake. If streaming is ever needed the answer is SSE over
  the existing HTTP handler — one-directional, closed on completion. See
  [`docs/architecture-decisions.md`](docs/architecture-decisions.md).
- **CI that survives a cold runner.** `make lint` runs `ruff` (a dev tool —
  `requirements.txt` stays at three runtime dependencies, no build step), and
  the `boot` job starts `./run.sh` with an injected `$PORT` and polls
  `/api/health` with pip retries and a long deadline.

## New in 3.5

- **The model persists across refreshes.** The chosen backend (WebGPU or
  WebAssembly) and model id are remembered in the browser for 7 days, so a
  reload skips the GPU probe entirely and starts loading from the browser
  cache at once on eligible browsers (Safari/iOS now wait for a request) — no 1.2 s delay, and the status line reports "loading from
  browser cache". A retry always re-probes from scratch.
- **117 new knowledge cards** (1400+ total) across food and drink, sports,
  brands, geography, science, technology, psychology, economy, practical life,
  culture and philosophy.
- **Better output from the 0.5B model.** The persona and the eight per-request
  approaches were rewritten: lead with the answer, no filler openers or
  sign-offs, sharper code, comparison and numerical behavior.
- **Safari polish.** Momentum scrolling and overscroll containment on the chat
  and sidebar, `-webkit-sticky` headers, tap-highlight removal, text-size
  locking, and a fill-available fallback for the app shell.
- **The update actually reaches browsers now.** The app shell, engine and
  knowledge scripts are served with `Cache-Control: no-cache` so Safari
  revalidates instead of guessing — previously a redeploy could sit unseen
  behind a heuristic-cache stale copy. `/manifest.json` and
  `/apple-touch-icon.png` are served (both 404ed before), so Add to Home
  Screen installs a real standalone app.

## New in 3.4

- **Instant access for first-time visitors.** The model now starts preparing the moment the page opens — in the background, under the same offline and Data Saver guards as before (`Archiver.warm()` in `web/archiver-engine.js`, called from the page boot). A first open-ended question meets a model that is ready (or nearly so) instead of a cold, minutes-long download. No download button, no settings detour, no second visit needed.
- **Our own model, clearly named.** Generation is branded **Archiver 3.4** in every user-facing label — top bar, status line, Settings, toasts, the thought-process panel — with the open Qwen 2.5 0.5B base named honestly in Settings. It still runs entirely in the visitor's browser; nothing runs on Render.
- **Discord, tidied.** The Settings Community section is one small card: a bright, futuristic banner (`web/discord-banner.jpg`), one line of copy, the invite. The floating-button and auto-show toggles are gone — the button was already off everywhere, so the controls were dead.
- **Migration gap closed.** Banks still on the shipped 3.3 persona and the `Archiver 3.3 (in-browser)` model label now upgrade in place on start, like 3.2 and earlier did.
- Everything else stays as 3.3: grounded web reads, a plan line on every prompt, the Safari WebAssembly runtime, private per-browser archives.

## New in 3.3

- **Web answers close with a read of the sources, not a stock paragraph.** 3.2 ended every web answer with a section headed “Additional Thoughts & Lateral Angles” whose text was chosen by keyword bucket — one paragraph for anything mentioning an influencer, one for anything mentioning Render, and a fallback (“ask who pays, what must stay on, and what the default is”) for everything else, Benito Mussolini included. That code is gone. The closing paragraph is now built in `app/take.py` from the retrieved text itself: what kind of thing the subject is comes from the lead sentence (“an Italian politician, journalist, and dictator”), the span of years and the turning-point sentence come from the extracts, agreement and disagreement come from comparing the sources, and a “why” asked of sources that only narrate is called out as unanswered instead of filled with a generic angle. Two subjects cannot produce the same paragraph. There is no heading, no emoji, and no hedging: a claim a source states as the subject’s own conduct is repeated as such, a claim it frames as an allegation is repeated as an allegation, and a yes-or-no whose key word never appears in the sources is answered with that absence.
- **Thinking on literally every prompt.** 3.2 showed a plan line only when the on-device model wrote one. Every route now states its own one-line plan in its own terms — the arithmetic to be evaluated, the command to be run, the pasted text to be worked from, the matched card and its strength, or the web read (“1 source (Wikipedia) describes the Battle of Kursk as an event … lead with the strongest line, then what the sources agree on, then my own read of the 1943 record”). A generated answer whose model skipped its planning line shows the pipeline’s plan instead of nothing, and the panel says whose plan it is.
- **The on-device model gets the read as a draft, not as fact.** For a web-grounded answer the prompt carries the facts and Archiver’s draft read separately, and asks the model to finish with its own specific, committed assessment — sharpening or contradicting the draft, never pasting it.
- **“What do you think?”** after a search answers with the read built for that subject, not one of three rotating stock lines.
- Yes-or-no questions (“was mussolini a socialist”) are recognised as such and restated honestly. Tests: `tests/test_take.py` (new) covers the read against real Wikipedia leads; `tests/model.js` covers the plan line on every route and the grounded prompt.

## New in 3.2

- **Generation works on Safari.** A second runtime, `wllama` 3.6.1 (llama.cpp compiled to WebAssembly), is bundled alongside WebLLM. When the browser has no usable WebGPU adapter — most iOS and iPadOS Safari versions, gated desktop Firefox — the same Qwen2.5 0.5B family runs on the CPU instead. Nothing to enable, install, or download by hand; it is slower, and the interface says so.
- **iOS keyboard behavior rewritten.** The shell is sized from the layout viewport rather than the visual one, so the thread no longer collapses while you type and no blank gutter is left under the composer. Pinch-zoom and a collapsing toolbar are no longer mistaken for a keyboard, overlays make room for it, focused fields are revealed, and every field is 16px on touch so iOS does not zoom the page on focus.
- **Thinking on every prompt.** Each answer carries an audit trail built from what the pipeline actually did — matched card and match strength, comparison, arithmetic, search query and hosts, chosen backend and why, prompt, tokens, seconds — including `hi` and `2 + 3 * 4`. Generated answers also open with one visible `Thinking:` planning line, lifted out of the reply into the disclosure. Route names are rendered in plain words.
- **Better output from a small model.** Eight task-specific response approaches instead of five, a persona written for a 0.5B model, `top_p` and presence-penalty tuning against looping, and output cleanup performed *inside* the stream (filler openers, padding, sign-offs, unclosed fences) so the deltas still add up to the final answer.
- **Data Saver is actually honored.** Generation pauses and reports why. Offline state still pauses it too.

## New in 3.1

- **Local answers do not wait for the server.** Conversation history is read from the browser cache; server synchronization runs in the background, in turn order.
- **Better offline handling:** comparisons between known topics, informal request cleanup, requested sentence/bullet formatting, extractive summaries and action items from pasted notes, and restored conversation context.
- **Corrected calculator:** parentheses, operator precedence, right-associative powers, unary signs, and percentages. No `eval`.
- **Browser generation:** requests that need open-ended writing, explanations, coding or plans initialize a compact 0.5B model when the device supports WebGPU. No Settings detour or manual installation. Inference runs in a browser worker, not on Render; local tools still answer immediately.
- **Transparent answer path:** every new answer can expose a concise “Thought process · answer path” showing which local tools, live sources, saved context and runtime were used. It is an audit trail, not a verbatim private reasoning transcript.
- **Responsive chat:** frame-batched streaming, working Stop and Retry for search/generation, larger touch targets, keyboard-aware layout, accessible zoom, corrected light/dark themes, and local transcript download.
- **Accurate capability reporting:** ask “who are you?” or “are you self-aware?” to see what is actually running, what is stored where, and its limits. This is software introspection, **not consciousness**.
- **Server regression fixes:** completed answers and extracted memories retain their owner, prepare-time recall is scoped to that browser, and the automatic-memory setting is respected.

3.3 is not a claim of Meta AI parity or a measured 10× comprehension improvement. The instant path is deterministic retrieval and text processing; the closing read of a web answer is assembled from the retrieved sentences by rules, not written by a model on the server. Requests beyond it automatically try a small language model, which broadens the supported tasks but can still make mistakes. Earlier releases are described in [CHANGELOG.md](CHANGELOG.md); the in-app changelog panel carries the same recent entries plus older releases, newest-first, and counts what it actually renders.

## Try it

| Request | What happens without a model |
|---|---|
| `Compare Python and JavaScript` | Side-by-side excerpts from local knowledge cards |
| `What is 18% of 250?` | Local calculation: 45 |
| `(2 + 3) * 4` | Local calculation: 20 |
| `Explain photosynthesis in 2 bullet points` | Formats a local answer |
| `one sentence` / `make it shorter` | Extracts a shorter version of the previous reply |
| `Summarize: …your notes…` | Selects key sentences; does not pretend to generate a new summary |
| `Extract action items: …your notes…` | Extracts explicitly signaled tasks; does not invent owners or deadlines |
| `count words: …` | Whitespace-separated word count |
| `teach: question = answer` | Saves a knowledge card in this browser |
| `forget: question` | Removes a taught card (not a memory-bank entry) |
| `help` | Lists commands |

The bundled corpus has 1,526 cards across history, science, language, technology, Australia and everyday topics. `cards` reports the actual count, including taught cards. Coverage and depth vary. Weak matches are labeled; open-ended requests prepare browser generation when supported, rather than substituting an unrelated card. If browser generation cannot start, the response explains the limitation.

**WEB** enables live search. An explicit request such as `search …` also enables search for that turn. Greetings, exact tools, and pasted-text extraction do not need a search request. Search failures fall back to local knowledge. Citations are evidence to inspect, not guarantees of truth.

## Browser generation is part of the website

Just ask, for example, `write a short email asking to reschedule a meeting`.
Archiver initializes a model and answers the original request—without a manual
download button. Greetings, calculations, stored-topic answers, and text
extraction do not trigger an expensive model download.

- **Two bundled runtimes, chosen automatically:** `web/vendor/web-llm-0.2.80.js` when the browser exposes a usable WebGPU adapter, otherwise `web/vendor/wllama-3.6.1.js` plus `wllama-3.6.1.wasm` on the CPU. Both are unmodified upstream builds, shared by the page and worker, served same-origin, precompressed, with long-lived versioned caching, their licenses, and checksum-verified reproduction scripts. The WASM binary is served as `application/wasm` so streaming compilation works. No inference-library CDN dependency at runtime.
- **Compact model:** the **Qwen 3 0.6B** family (Archiver 5.2) at Q4 on both paths. The GPU path chooses f16 or f32 by adapter capability; the WASM path uses a GGUF of the same model, tried from three upstream artifacts in order so one renamed file cannot disable the fallback. It never tries a larger model.
- **Automatic assets:** the first generative request fetches weights directly from the upstream model/library hosts, not through Render — a few hundred MB on GPU, ~490 MB of GGUF on CPU. Each runtime caches them in browser storage and reuses them when storage permits. Clearing browser data or cache eviction can require another transfer.
- **Device requirements:** HTTPS (or localhost) and enough free memory. The GPU path additionally needs WebGPU and sufficient GPU memory; the WASM path needs neither, only WebAssembly workers, which every current browser has. Without `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` headers, wllama detects that and runs single-threaded — intended here, since COEP would put every cross-origin model fetch behind a CORP requirement.
- **Graceful fallback:** offline, Data Saver, or initialization errors leave instant tools available and say why. A missing or unusable GPU is no longer a dead end — it selects the WASM runtime. Initialization is bounded, failed initialization is isolated, and **Try browser generation again** starts a fresh worker. Stop cancels initialization as well as generation.
- **Browser generation:** always enabled and started on demand for open-ended tasks. Settings shows which runtime is enabled, loading, active, or unavailable; a retry action is available when initialization fails. The first-use model download requires a network connection. Initialization is allowed up to eight minutes on mobile Safari's GPU path and twelve on the WASM path, which compiles an 8 MB module before it can start on the weights.
- **iPhone/Safari:** safe-area insets, layout-viewport shell sizing with the keyboard tracked separately (`--kb-height`, `kb-open`, `kb-cramped`), document-scroll restoration only on a genuine keyboard close, pinch-zoom and toolbar-collapse guards, frame-batched and debounced measurement, overlays that make room for the keyboard, 16px fields on touch, storage guards, text-size/overscroll/scroll-anchoring fixes, and CPU generation when iOS Safari does not expose usable WebGPU. Add Archiver to Home Screen for standalone mode. The logic lives in `web/archiver-viewport.js` and is tested in `tests/viewport.js`.
- **Bounded context:** this is a small model with a 4K context on GPU and 2K on CPU. Very long generation requests may need splitting, and reference notes are dropped before your request is ever truncated. History and notes are bounded rather than pretending to provide unlimited recall.

The bundled runtimes are imported in Chromium in the browser tests. Weight
loading and generation are stubbed in automated lifecycle tests; those tests
verify integration, not live GPU performance or answer quality. Neither backend
has been benchmarked on a physical iOS device, and the GGUF fetch is an external
dependency that cannot be exercised from a sandbox without outbound access to the
model host. External asset hosts and browser storage policies remain dependencies.

### Why this fits a free Render web service

Render serves FastAPI, SQLite-backed APIs, and the website's static files. It does
**not** load an LLM, require a GPU, download model weights at boot/build time,
or proxy hundreds of MB of model assets per visitor. Browser workers do inference;
the runtime is a small, cacheable website asset. `render.yaml` explicitly selects
`plan: free` and keeps the existing Python-only build/start commands.

Bundling all the weights into the Render deployment would not remove the browser
transfer. It would instead increase deploy size and consume Render outbound
bandwidth. Putting inference in the free service would add model/runtime memory
pressure and CPU latency. Neither is required for this architecture.

According to [Render's Free-instance documentation](https://render.com/docs/free),
free services spin down after idle periods, have an ephemeral filesystem, and
cannot attach persistent disks. **SQLite memories on Render Free are therefore
not durable across restarts, spin-downs, or redeployments.** Keep exports; use a
suitable external durable database or a paid service with a persistent disk if
permanent server-side archives are required. This release does not claim to solve
Render Free's storage limits.

Full release notes: [CHANGELOG.md](CHANGELOG.md).

## Privacy and storage — precisely

- **Answers:** calculated/retrieved in the browser, or generated by the browser model. Prompts are not sent to a hosted model inference API.
- **Conversations:** cached in browser storage and synchronized to this app’s server in the background. Sync is best effort, not a durable offline delivery queue. Keep a local transcript export if the server is unavailable.
- **Memory bank:** stored in SQLite **on the app server**, associated with a browser cookie. Relevant cached memories can inform browser generation; instant lookup does not generate personalized answers from memory.
- **Settings:** the explicit **Restore defaults** action confirms before replacing custom server-backed settings; chats and memories are kept.
- **Taught cards:** browser local storage only. Clearing browser data removes them.
- **WEB:** sends search queries through the app server to search services.

The loaded page’s local tools work without a network connection; loading the page from scratch is not an offline/PWA guarantee. There is no service worker.

**No account authentication.** Cookie-associated archives are not a substitute for access control. Use this as a personal app; do not expose sensitive archives publicly. Clearing cookies can lose access to the corresponding server archive.

## Run it

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
./run.sh
```

Open <http://localhost:8000>.

| Environment variable | Default | Purpose |
|---|---|---|
| `PORT` | `8000` | HTTP port |
| `ARCHIVER_DB` | `archiver.db` | Server-side SQLite archive |

For Render Free: build `pip install -r requirements.txt`, start `./run.sh`. The Blueprint selects the free plan; no inference service or extra process is needed. Free instances cannot attach a persistent disk (see the storage warning above). The app binds to `0.0.0.0` and uses relative browser API URLs.

## Tests

Node 18+ and Python 3.10+:

```bash
.venv/bin/pip install pytest
make test
```

Runs the conversation/search smoke checks, offline and cancellation regressions, viewport and iOS-keyboard lifecycle checks (`tests/viewport.js`), stub browser-generation lifecycle tests covering both runtimes, and FastAPI storage/isolation/vendor-serving tests. The VM-module test uses Node's experimental VM modules; no model is downloaded.

Optional browser checks (with the app running): install Playwright in your development environment and run `node tests/browser.js` and `node tests/browser-ai.js`. `BASE_URL` defaults to `http://127.0.0.1:8000`; `CHROMIUM_EXECUTABLE` can select an existing browser. These cover a blocked sync server, five viewport sizes, themes, text escaping, Stop/recovery, local export, real bundled-runtime import, and browser-generation initialization/reuse/cancellation with stub inference. Playwright is not a runtime dependency.

MIT — see `LICENSE`.
