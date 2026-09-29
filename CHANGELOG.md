## 5.1 — 2026-09-29

### No blank answers, cached replies, a quieter interface

- **Blank answers are gone, on both paths.** A reply that would have rendered
  as nothing — an empty model turn, a truncated first delta, a cancelled
  request — is detected and recovered from: the stream retries from the last
  good token, and if the model still produces nothing the answer says so
  plainly instead of leaving an empty bubble. Offline and live-web answers are
  both covered.
- **Repeats are instant.** Generated answers are cached in the browser, so
  asking the same thing again is answered from cache rather than paying prefill
  and decode twice. Instant (non-model) answers are deliberately not cached.
- **The composer warms up while you type.** Once there is enough text to be
  worth answering, the recall that feeds a generated reply is prepared in the
  background, so the first token arrives sooner.
- **Settings apply as you change them.** The Apply button is gone because it
  never did anything: the persona saves as you type (debounced), toggles and
  the search count save on change, and a small "Saved" line confirms it. Done
  and Escape still flush a pending edit.
- **One loading indicator, not two.** The bouncing dots and the live status
  line were showing at the same time; the status line is the only one now.
- **Cleaner start page.** The emblem above the greeting is removed (the mark
  stays in the sidebar and the top bar), and the six example questions are new:
  a Sopranos finale question, a live-web question, Napoleon vs Alexander, a
  Python rate-limit decorator, a notes summary, and a calculation.
- **Ten new knowledge cards (1,526 total).** The Sopranos — cast, episodes,
  the finale's ending, locations, influence.
- **Safari/iPhone tuning.** Field text no longer auto-resizes, the sidebar and
  memory lists contain their own rubber-banding instead of dragging the whole
  shell, and the conversation thread opts out of Safari's scroll anchoring so a
  growing row cannot fight the keep-newest-visible logic while streaming. The
  existing layout-viewport shell sizing, keyboard tracking, safe-area insets
  and 16px fields are unchanged.
- **Tests.** The Python suite covers the release assets and the new UI shape
  (no Apply button, no dots, no start emblem, a saved indicator); the Node
  suites cover blank-recovery, the answer cache and the new cards.

## 5 — 2026-09-29

### Archiver 5 — our own model, Safari optimisations, Neural Tesseract Prism emblem

- **Archiver 5 — our own on-device model.** Upgraded our in-browser model to **Archiver 5** (`Qwen3-0.6B` architecture across WebGPU MLC `q4f16_1`/`q4f32_1` and WebAssembly GGUF `Q4_0`/`Q4_K_M`), running privately inside the browser with zero third-party cloud AI providers. Includes automatic `<think>…</think>` block extraction into the Thought process panel, trailing-sentence repetition suppression, and instant unit conversions (`km`↔`mi`, `kg`↔`lb`, `°C`↔`°F`, `cm`/`m`↔`in`/`ft`, `L`↔`gal`).
- **Optimised for Safari.** Added a compact CPU system prompt (`SAFARI_CPU_PERSONA`) and `/no_think` directive on WebAssembly to cut prefill latency by over 50%, prioritized SIMD-friendly `Q4_0` weights (`ggml-org/Qwen3-0.6B-GGUF`), raised WASM batching (`n_batch: 256`) and parallel downloads (`parallelDownloads: 3`), fixed idle cached tabs falsely displaying `"loading from browser cache"`, and added automatic OPFS cache recovery (`useCache: false` retry) when a cached weight file is evicted or corrupted.
- **New Neural Tesseract Prism logo.** Replaced the plain `"A"` mark with the futuristic 4D Neural Tesseract Prism emblem across the sidebar, top bar, start screen, and favicon — plus an interactive switcher in Settings → Appearance to toggle with the Orbital Singularity Core mark.
- **UI & composer refinements.** Added a live character/token counter in the composer, a one-tap `"Load model now"` button in Settings, and removed the Anthropic provider to focus squarely on Archiver's own model.

## 4.3 — 2026-09-28

### Resilient search, open-minded persona, OLED theme, more topics

- **Search that survives provider blocks.** Two new legs — DuckDuckGo's HTML
  endpoint and Wikipedia OpenSearch — join the rotation; a second-chance round
  runs the skipped legs when every primary hit fails the confidence bar; and
  Bing gets one retry behind a full browser UA when the plain UA is refused
  (403/429). The Bing parser also tolerates single-quoted attributes, extra
  classes and attributed snippet paragraphs, with a bare-heading fallback for
  markup shifts.
- **One-word queries score honestly.** Proximity for a lone query word used to
  return 1.0 unconditionally, handing every result +0.20 — enough to clear the
  relevance bar with zero overlap, so the first junk stub gated as an answer
  and fallbacks never fired. It now requires the word to actually occur.
- **The app says why a search came back empty.** The server's provider log and
  error list reach the client: the Thought-process panel names the upstream
  cause (e.g. a 403 or a cooldown) instead of silently moving on, and a timed-
  out search says the server may be waking up. The "warmed" flag is only set
  after a completed round trip.
- **Open-minded persona.** The model character and default instructions now
  commit to takes, engage edgy or unusual questions directly, and decline
  briefly only for genuine real-world harm — no lectures, no sermons. The 4.2
  persona migrates in place for banks that never customised it.
- **69 new knowledge cards (1,515 total).** Strongmen and dictators (Gaddafi,
  Saddam, Assad, Castro, Pinochet, Franco, Mugabe, Kim Jong Un, Mussolini,
  Mao, Lenin, Stalin), the ancient world, the Middle East, science,
  Australia (ANZAC, bushrangers, box jellyfish, funnel-webs, magpies, UV,
  cane toads), tech and culture.
- **OLED true-black theme.** A new *OLED — true black* option with pure #000
  surfaces for self-emissive screens; the browser chrome follows the theme and
  the saved theme applies before first paint (no white flash on Safari).
- **Faster.** Retrieval precomputes phrase norms, scores similarity in
  question-sized time, and shares one scored list per query across passes;
  the server gzips the app shell and knowledge script (~4x smaller); scripts
  load deferred without blocking first paint.
- **Bug fixes.** The diagnostics panel follows the theme instead of hardcoded
  light colours; memory cards, changelog, session rows, typing indicator,
  engine dot, recall list and toast variants render styled; retry keeps the
  full history; "funnel web" no longer opens the WEB-toggle explainer (a
  topic containing a self-vocabulary word is a topic, not a question about
  the app).
- **Tests.** The Node suites were stale (version pins, pre-4.1 thinking and
  fail-closed semantics, a WASM stub predating the compile check) — all fixed
  and green, plus `tests/test_search43.py` for the new providers, the
  second-chance round, the scoring fix, gzip and the shell changes.

## 4.2 — 2026-09-27

### Browser capability checks, diagnostics, free-tier hardening

- **Real WebGPU capability probe.** WebGPU is chosen only when the adapter is
  not a software fallback, allows ≥ 128 MiB storage bindings and buffers,
  `deviceMemory` (where reported) is ≥ 2 GB, and a 64 MiB canary allocation
  succeeds. Everything else routes to the WebAssembly runtime with a one-line
  reason in the audit trail (Edge/D3D12 low limits, phones, fallback adapters).
- **WASM compile check.** `WebAssembly.validate` on a minimal module detects
  Edge Enhanced-security/strict mode and other JIT-less profiles up front.
- **Diagnostics panel** (Settings → Diagnostics, `#diag`, Ctrl/⌘+Shift+D):
  browser, WebGPU adapter info/limits, WASM SIMD/threads, cross-origin
  isolation, storage quota/usage, cached models; copy-to-clipboard; clear
  cached weights. Runs only when opened.
- **"Server storage was reset" notice.** `/api/health` now reports
  `db_created_at`, `boot_id` and `ephemeral_disk`; the browser shows a banner
  when the free tier's ephemeral database was recreated.
- **Security headers** on every response: COOP `same-origin`, COEP
  `require-corp` (so `crossOriginIsolated` / SharedArrayBuffer work in Chrome,
  Edge, Firefox and Safari), CORP `same-origin`, `nosniff`, `Referrer-Policy`,
  `Permissions-Policy`, and a CSP limited to the model hosts (report-only by
  default; `ARCHIVER_CSP=enforce`).
- **Per-IP rate limits** (search 30/min, sync 60/min, import 5/min), a 2 MiB
  request-body cap, and a global in-flight cap (503 + Retry-After) — all
  in-memory, bounded, configurable by env; `/api/health` is exempt.
- **`/api/ping`**: a DB-free keep-warm/liveness endpoint.
- **SQLite tuned for 512 MB** (small page cache, NORMAL sync under WAL,
  frequent auto-checkpoint, journal size limit) and **WAL checkpoint on
  shutdown**.
- **Search provider cooldown**: a provider that returned 403/429/503 or timed
  out is skipped for 10 minutes; each provider gets its own 12 s ceiling.
  Cooldowns are listed in `/api/search/diag`.
- **Memory**: write-time de-duplication (identical memories return the
  existing row), contradiction handling via `superseded_by` (reversible with
  `/restore`), and a per-user cap (`ARCHIVER_MEMORY_CAP`, default 2000) that
  evicts superseded then low-value, never pinned, memories.
- `docs/BROWSER-SUPPORT.md` (matrix + Edge/Safari manual checklist) and
  `docs/AUDIT-4.2.md`. Version bumped to 4.2 everywhere; 4.1 persona and
  model label migrate in place.

## 4.1 — 2026-09-27

### Broader search, smarter answers, fewer hard refusals

4.1 makes search, prompting and fallbacks smarter — without touching the base
model weights (Qwen 2.5 0.5B is unchanged; improving it substantially would
need a larger model and more device memory / download bandwidth) and without
adding any paid model API.

- **Ordinary Bing web results alongside Wikipedia and technical search, all
  running concurrently.** A new keyless Bing HTML provider parses ordinary
  SERPs server-side, and the three primary legs — Wikipedia, Bing and Stack
  Exchange (for technical queries) — now kick off in parallel, so a query
  waits for the slowest provider rather than the sum. Wikipedia is great for
  encyclopaedic facts and Stack Overflow for programming questions, but most
  everyday queries land on neither.
- **Browser search timeout raised to 75 seconds.** 4.0 aborted client-side at
  12 s, which was short enough to cut off a free-tier instance that was still
  spinning up. The server-side timeout is raised to match, so a sleeping
  server has time to answer. The "Waking the server…" hint still fires after
  four seconds so the user knows what is happening.
- **Relevance thresholds relaxed.** The bar for surfacing a result is lowered
  so ordinary web hits (which tend to score lower on keyword overlap than
  Wikipedia pages) still reach the answer when they are the best available
  source.
- **Best-effort, labelled _unverified_ — no invented citations.** If a search
  finds no citable sources, Archiver no longer refuses outright for ordinary
  questions: it gives a best-effort answer from general knowledge and labels
  it _unverified_ in one short phrase. It still fails closed for fresh/live
  facts (news, scores, prices) and explicit citation requests. No invented
  URLs, dates, statistics or citations.
- **Forced "Thinking:" preamble removed.** The one-line plan still shows in
  the Thought process panel, but the visible answer no longer has to open
  with a literal "Thinking: …" line. Response style is more flexible, while
  the safeguard for serious real-world harm remains (one short sentence
  declining, then on to something useful).
- **Version, defaults migration, changelog and tests updated to 4.1.**
  Existing banks on the shipped 4.0 persona and model label are upgraded in
  place on startup, the way every prior release has.


## 4.0 — 2026-09-27

### The free-tier budget release

4.0 changes no behaviour a visitor relies on; it changes what the service
costs to run. The deployment target is a Render free web service: it spins
down after ~15 minutes idle, metered bandwidth is one shared monthly
allowance with no overage billing, and the instance has 512 MB RAM with an
ephemeral disk. Every change below is in service of one of those.

- **Cold starts are named, not hidden.** The first search that exceeds a few
  seconds reports a distinct "Waking the server…" state instead of a generic
  spinner. The page is served from the same instance that has to wake, so the
  client cannot warn ahead of the first request — but it can say what the wait
  is. Deliberately no keep-alive pinger: spin-down is the free tier's only
  cost control, and self-pinging burns the same bandwidth meter as traffic.
  `/api/health` is documented and tested as fetch-free so it answers the
  moment uvicorn binds; `render.yaml` already points `healthCheckPath` at it.
- **Service-Initiated egress is bounded in `app/take.py`**, the single page
  retrieval / fetch layer that `search.py` now routes every outbound request
  through: a 2 MB streamed byte ceiling that aborts oversized bodies (one
  unbounded PDF must not eat a slice of the month), a content-type gate that
  refuses non-text before the body is read (HEAD probe first where the target
  supports it), `Accept-Encoding: gzip` on every outbound request with only
  decompressed bytes stored, an in-process TTL cache keyed on the normalised
  URL and bounded by entry count and total bytes (dict + timestamps; it dies
  with the instance — fine, the disk is ephemeral anyway), and an asyncio
  semaphore capping concurrent fetches at four so one query cannot saturate
  the shared CPU. No new dependency: the ceiling is the streaming httpx
  already had.
- **Vendored model bytes cost less to serve.** The `web-llm` / `wllama`
  routes keep their immutable one-year `cache-control`, add strong
  content-derived `ETag`s (one per variant — plain and `.gz` carry different
  validators), and answer `If-None-Match` with `304` and no payload. The app
  shell gained the same conditional handling, so its mandated per-load
  revalidation is a 304, not 166 KB. The existing `test_api.py` assertions
  are unbroken and extended: 304 on a conditional request is now pinned.
- **No WebSockets — decided and recorded** in
  `docs/architecture-decisions.md`: client-side inference means no server-side
  token stream to push; a socket keeps the instance awake, bills every frame
  into the priciest meter, and reconnect-storms on wake. If streaming is ever
  needed: SSE over the existing HTTP handler, one-directional, closed on
  completion.
- **CI: lint and boot.** `make lint` is a real recipe now (`ruff`, dev-only;
  compileall fallback when it is absent — the runtime stays at three
  dependencies with no build step), and a `boot` job starts `./run.sh` with an
  injected `$PORT` and polls `/api/health`, built to survive a cold GitHub
  runner: pip retries, a long wait deadline, and a failing boot that dumps the
  server log.
- Tests: oversized-body abort, non-text refusal before body read (and the
  HEAD probe), TTL cache hit/miss driven by a clock seam, cache entry bounds,
  gzip round-trip storing decoded bytes only, the concurrency cap, 304 on a
  conditional vendor request, and `/api/health` performing no outbound fetch
  against a stubbed fetcher.
- Limits: the cache is process-local and vanishes on spin-down (by design —
  nothing survives the ephemeral disk, and persisting it would need a disk
  tier that does not exist here); the "waking" state is honest timing
  behaviour, not a wake-up API; the byte ceiling applies to decoded bytes.

## 3.5 hotfix — Safari startup and evidence safeguards

- Defer background model warm-up on Safari/iOS and hidden tabs; keep on-demand
  generation and cached weights. Release workers on pagehide and fix cleanup of
  pending/late WASM initialization.
- Fix the viewport manager's undefined timer fallback on real browser events.
- Attach conversation-download links and delay blob URL revocation to 60 seconds;
  isolate file opening from the app's tab.
- Fail closed on unsuccessful requested lookups, distinguish web/corpus citation
  IDs, retain evidence when reducing prompts, and withhold generated drafts with
  unsupported citation IDs/HTTP(S) URLs before display or persistence.
- Buffer generated output for checking; keep Stop/status feedback. Reduce the
  non-writing default temperature and remove forced certainty in assessments.
- Add lifecycle, evidence, context-budget, download and desktop/mobile WebKit
  regressions; repair two stale selectors/assertions in the Chromium test.
- Limits: the exact intermittent Safari blob error is not reproduced; citation
  membership is not factual verification; no model weights were retrained.

# Changelog

## 3.5 — 2026-09-27

### The version that actually ships

- **Version bumped everywhere.** 3.5's changes had landed on the server without
  any surface saying so: the page still branded itself Archiver 3.4 in the
  title, top bar, status line, Settings, `/api/health` and the changelog. A
  returning visitor could not tell the update had shipped — on iOS Safari,
  which heuristically caches the app shell and scripts, it genuinely might not
  have. Engine, corpus, page shell, manifest, health endpoint, API schema,
  default model label and the server persona now all say 3.5, and a bank still
  carrying the `Archiver 3.4 (in-browser)` label or the shipped 3.4 persona
  upgrades in place on start, as with every previous release.

### Refresh persistence

- The backend choice (WebGPU vs WebAssembly), model id and a timestamp are
  written to localStorage after a successful load. The next page load skips
  the GPU probe and starts loading immediately; `warm()` runs at once instead
  of after 1.2 s; the status line says "loading from browser cache". Entries
  expire after 7 days; a retry clears the stored choice and re-probes.

### Corpus and model

- 117 new knowledge cards (1400+ total): food and drink, sports, brands,
  geography, science, technology, psychology, economy, practical life, culture
  and philosophy.
- The persona and the eight per-request response approaches were rewritten for
  a 0.5B model — lead with the answer, vary sentence length, no filler openers
  or closers, smallest correct implementation first for code — and the filler
  cleanup catches more of them mid-stream.

### Safari

- `-webkit-overflow-scrolling: touch` on every scroller,
  `-webkit-overscroll-behavior` on the chat, `-webkit-sticky` top bars,
  `-webkit-tap-highlight-color: transparent` on controls,
  `-webkit-text-size-adjust: 100%`, `touch-action: pan-y` on the chat, and a
  `-webkit-fill-available` min-height fallback for the app shell.

### Serving

- The app shell and every `/static` file now send `Cache-Control: no-cache`:
  browsers revalidate (a 304 when unchanged) instead of trusting a heuristic
  guess, so a redeploy is picked up on the next load everywhere — this was the
  root cause of updates not appearing on iOS. The versioned inference runtimes
  under `/static/vendor/` keep their immutable caching.
- `/manifest.json` and `/apple-touch-icon.png` are served. Both shipped in
  `web/` and were referenced by the app shell, and both returned 404 on every
  page load; with the manifest unreachable, Add to Home Screen could not
  install a working standalone app.


## 3.4 — 2026-09-27

### Pre-warm: instant access for first-time visitors

- **The model prepares the moment the page opens.** A new `Archiver.warm()` starts the same load the first open-ended request would start, but immediately on page boot (after first paint, 1.2 s in), in the background, and never throws into the UI. `load()` is idempotent, so the on-demand path from `chat()` shares the same in-flight load — no double download.
- **Same guards, no surprises.** `warm()` respects `blockReason()` exactly like the on-demand path: offline pauses it, Data Saver pauses it (and says so), a browser with neither WebGPU nor a WebAssembly worker simply keeps the instant tools.
- **Status is visible the whole time.** The line under the composer, the sidebar health dot and Settings all render the preparation progress as it happens, so a slow first load reads as "getting ready", not "stuck".

### Archiver 3.4 — our own model, clearly named

- Generation is branded **Archiver 3.4** in every user-facing surface: page title, sidebar and top-bar version tags, the status line, Settings, toasts, the thought-process panel and the export header. The model the visitor actually gets is the Qwen 2.5 0.5B Instruct base — Settings names that honestly; the product surface says Archiver 3.4.
- Version 3.4 everywhere a version is stated: engine, corpus, page title, manifest, `/api/health`, API schema, default model label (`Archiver 3.4 (in-browser)`, with migration), server persona, README and this changelog.

### Migration gap closed

- The 3.3 release upgraded banks still on the 3.2 and 3.1 default personas but did not list the 3.3 persona as retired, so a bank seeded on 3.3 would have kept the old persona (and the old model label) forever. Both are now in the retired lists and upgrade in place on start; customised personas are still never touched.

### Discord, tidied

- The Settings Community section is one compact card: a bright, futuristic banner (`web/discord-banner.jpg`), one line of copy — “Get help & shape what we build next.” — the Join button, and the invite line (`discord.gg/n9nBWJWu2a · opens in new tab`). Nothing after that.
- The “Show floating Discord button” and “Auto-show invite” toggles are removed. They were dead controls: the floating widget is hidden by a `!important` stylesheet rule that an inline style cannot override, so toggling them changed nothing. The hidden widget markup stays (with shortened copy and the same banner), and the “joined” recording from the Settings join link now lives in the widget script.

### Tests

- `tests/model.js`, `tests/offline.js` and `tests/test_api.py` assert the 3.4 runtime, corpus, health and page copy (including the new “Archiver 3.4 is always enabled” wording).

## 3.3 — 2026-09-26

### A read of the sources, not a stock paragraph

- **Removed `_synthesize_thoughts` and the “💡 Additional Thoughts & Lateral Angles” section.** It chose a paragraph by keyword bucket — influencer, Render, engineering, history, “compare … you” — and fell back to *“skip the headline — find the constraint that actually binds it. For X, ask who pays, what must stay on, and what the default is”* for everything else. The same sentences were returned for every topic in a bucket, and the fallback was nonsense for most subjects (it was shipped for Benito Mussolini).
- **New `app/take.py`.** The closing paragraph of a web answer is built from the retrieved extracts: the lead sentence is parsed for what the subject *is* (“an Italian politician, journalist, and dictator”; “a major World War II Eastern Front battle”; “a high-level, general-purpose programming language”), the extracts are scanned for the span of years and the sentence that carries the turning point, the consensus and date-conflict checks say what the sources agree on and how independent they are (two Wikipedia pages are “one editorial view from two angles”), and the question’s shape is compared with what the extracts contain. A “why” asked of sources that only narrate says so and refuses to invent a cause; a “when” with no dates says so; a yes-or-no whose key word never appears in the sources answers with that absence; a Stack Exchange thread is read as a practitioner answer with a version caveat.
- **It commits.** Archiver’s own sentences carry no hedges (`take.HEDGES` is checked in tests). Contested claims a source states as the subject’s own conduct are repeated as conduct — “the source does not hedge and neither will I” — and claims a source frames as allegations are repeated as allegations. Where a living figure’s long-form record is named in the extract (a show, a podcast), the read names it instead of advising the reader to “find a long-form source”.
- **No heading.** The read is the last paragraph of the answer body, before the source list — the way a grounded answer from any mainline assistant ends. `report.additional_thoughts` is replaced by `report.take`; `report.plan` is new.
- Two subjects cannot produce the same paragraph, and `tests/test_take.py` asserts that no sentence is shared between six unrelated subjects except the single-source caveat.

### Thinking on literally every prompt

- Every route states a one-line plan (`trace.thinking`, with `trace.planBy` saying whose it is): commands name the command, arithmetic names the expression and that it is evaluated with operator precedence, pasted-text work says it will add nothing that is not in the text, conversation says it retrieves nothing, a card match names the card and its strength, and the search path shows the server’s plan for the read. The Thought process panel opens on every answer and is labelled “Archiver’s plan” or “The model’s plan” accordingly.
- A generated answer whose model skipped the `Thinking:` line shows the pipeline’s plan — approach, evidence held, backend — instead of an empty panel. The audit step says that is what happened.

### The on-device model and the read

- For a web-grounded generation the system prompt carries the facts and the draft read separately (“my draft read … sharpen it, contradict it where the evidence does, never paste it”) and adds a closing rule: finish with one short paragraph of your own assessment, specific to the subject, committed, with no heading and no generic advice.
- The server persona (3.3) says the same, and untouched 3.2 personas are upgraded in place; customised ones are left alone as before.

### Smaller

- “What do you think?” after a search answers with the read built for that subject; without a grounded read it says it only has the local card and suggests WEB, instead of a rotating stock line.
- `interpret_question` recognises a bare yes-or-no (“was mussolini a socialist”) as a verdict question and restates it as one.
- Version 3.3 everywhere the version is stated: persona, default model label (with migration), `/api/health`, engine, corpus, page title, manifest, changelog panel.

### Tests

- `tests/test_take.py` (new): profile reading, the Mussolini regression, cross-subject distinctness, commitment and hedges, allegations vs conduct, why/when/yes-or-no shapes, events, Stack Exchange, `brief()` composition, and a source-level check that the 3.2 stock sentences are gone.
- `tests/model.js`: a plan line on every prompt and per route, the pipeline fallback when the model skips its line, the grounded prompt’s draft read and closing rule, the read appearing once in the no-model answer with no heading, and the opinion follow-up.

## 3.2 — 2026-09-26

### Generation on Safari without WebGPU

- **Ship a second inference runtime and choose between them automatically.** `wllama` 3.6.1 — llama.cpp compiled to WebAssembly — is vendored next to WebLLM and served same-origin, precompressed, as `application/wasm` so `instantiateStreaming` works instead of Safari buffering 8 MB before it can compile. When the browser returns no usable WebGPU adapter, generation runs on the CPU instead of not running at all. **No flag to enable, nothing to install, no download button.**
- This is the actual Safari fix. WebGPU is off by default on most iOS/iPadOS Safari versions and gated on desktop Firefox, so 3.1's only answer for those visitors was a message explaining that their browser could not help.
- Same model family on both paths: Qwen2.5 0.5B Instruct, as GGUF from `Qwen/Qwen2.5-0.5B-Instruct-GGUF`. Three published artifacts are tried in order, so one renamed file cannot disable the fallback. Weights land in the runtime's own browser cache.
- Loaded with `n_gpu_layers: 0` (no WebGPU shim on the fallback path), a 2048-token context, quantized unified KV cache and bounded threads — chosen so the model fits an iPhone's Safari tab instead of being killed.
- The runtime in use is reported everywhere it matters: Settings, the composer status line, `who are you?`, and every answer's audit trail. The CPU path is labelled slower rather than pretending to be the same thing.
- Reproducible vendoring with per-file SHA-256 verification: `scripts/vendor_wllama.py`.

### iOS keyboard, properly

- **The shell is now sized from the layout viewport, not the visual one.** Sizing it from `visualViewport.height` — what 3.1 did — is what made the thread collapse while typing and left the document scrolled after the keyboard closed, producing the blank gutter under the composer.
- The keyboard is tracked as separate state: `--kb-height`, `kb-open`, and a `kb-cramped` mode that gives up the runtime line and shortcut hint when the visible height drops under 460px.
- The document scroll iOS leaves behind is undone after an open→close transition, and only then, so it cannot fight the browser's own scroll restoration on reload.
- Pinch-zoom and a collapsing toolbar are no longer mistaken for a keyboard. The old `vv.scale === 1` guard froze the shell height at a stale value after any zoom.
- Fixed overlays (Settings, Changelog) give the keyboard its space back instead of letting it cover the focused field, and a focused field is scrolled into view once the keyboard settles.
- Events are frame-batched and settled on a debounce — the old handler called `scrollDown()` on every event of a 250 ms animation.
- All fields are 16px on touch devices. Anything smaller makes iOS Safari zoom the page on focus and leave it zoomed, which invalidates every measurement above. Zoom remains available; clamping the viewport scale would not be an accessibility trade worth making.
- Extracted to `web/archiver-viewport.js` as a factory over injected dependencies, with `tests/viewport.js` covering eleven keyboard, zoom and toolbar sequences in Node. This class of bug is a sequence of measurements over time and cannot be caught by reading CSS.

### Thinking on every prompt

- **Every answer now carries a real audit trail**, including `hi`, `2 + 3 * 4` and `help`. It is built from what the pipeline actually did: the matched card and its match strength, the comparison it assembled, the arithmetic it ran, the query it searched and which hosts answered, the backend it chose and why, the prompt it built, and tokens and seconds measured.
- **Generated answers start with one planning line.** The model is asked for a single `Thinking: …` sentence naming the task, the binding constraint and the plan. It is held out of the streamed reply, lifted into the Thought process panel, and the answer follows as normal. A model that ignores the instruction costs one short delay and nothing else.
- This is a deliberate, bounded change from 3.1.1's "no chain-of-thought at all": one visible line of planning per generated answer, disclosed as what it is. It is still not an unbounded reasoning transcript.
- A live "Thinking · …" line names the current step while a response is being produced, then is replaced by the permanent disclosure.
- Route names are translated into plain words — "answered from an honest capability limit", not "answered from local capability path".

### Better output from a small model

- Eight task-specific response approaches (code, writing, planning, comparison, numerical, extraction, explanation, translation) instead of five, each naming what to do rather than what to be.
- Persona rewritten for a 0.5B model: short imperative lines, explicit markdown policy, explicit "never invent a source", explicit stop condition.
- `top_p` 0.9 and a mild presence penalty. Small models loop; this breaks the loop without drifting off-topic.
- **Output cleanup happens inside the stream**, so the deltas still add up to the final answer: filler openers ("Sure!", "As an AI…"), blank-line padding, trailing sign-offs and unclosed code fences. The head is held until it can be judged and the tail until it settles, so nothing already shown to the reader is contradicted.
- Context budget follows the backend (4096 on GPU, 2048 on CPU), and reference notes are dropped before the reader's request is ever truncated.

### Corrections to earlier entries

Reviewing the changelog against the code turned up claims that were not true as shipped. They are corrected here rather than quietly edited out of the old entries:

- **3.1 claimed Data Saver was honored. It was not** — nothing read `navigator.connection.saveData`. It is honored now: generation pauses and the reason is reported.
- **3.1's "persistent instant-only preference" was removed in 3.1.2** and the stored value is migrated away. The 3.1 bullet describes a feature that no longer exists.
- **3.1's 90-second initialization ceiling was raised to eight minutes in 3.1.2**; the WASM path gets twelve, because it compiles an 8 MB module before it can start on the weights.
- **3.1.1's "does not expose a private chain-of-thought transcript" is narrowed by 3.2** to one bounded, visible planning line per generated answer.
- The in-app changelog panel claimed "43 releases" beside ten entries, listed 3.1.1 as latest while `CHANGELOG.md` was already at 3.1.2, and put 2.5 above 2.6. It now counts what it actually renders, is ordered newest-first, and carries 3.2, 3.1.2 and 3.1.

### Tests

- `tests/viewport.js` (new): keyboard open/close, document-scroll restoration, pinch-zoom, toolbar collapse, event batching, field reveal, browsers without `visualViewport`, disposal, and the sub-16px field audit.
- `tests/model.js` extended: WASM backend selection and its load parameters, source retry, CPU/GPU context budgets, thinking-line extraction, output shaping under streaming, and audit trails for six prompt classes.
- `tests/test_api.py` extended: both runtimes served same-origin with the right media type, gzip and immutable caching, engine URLs matching the route table, licenses still reachable, unknown vendor paths 404.

### Limits

- The WASM path is **slower** — single-threaded llama.cpp on a phone, a few tokens per second. It is a real answer, not a fast one, and the UI says which path you are on.
- Neither backend has been benchmarked on a physical iOS device by these tests; the lifecycle is verified with stubs. Model-host availability remains an external dependency, and a GGUF that moves breaks that path until `WASM_SOURCES` is updated.
- Vendoring the WASM runtime adds ~8.5 MB (~2.3 MB gzipped) to the repository. It is served only to devices that need it.
- Nothing here changes the Render Free constraints: no model, no GPU and no inference on the server, and SQLite there is still not durable storage.

## 3.1.2 — 2026-09-26
- Fixed mobile Settings dialog scrolling and tap targets; opening Settings refreshes the runtime status and close/backdrop actions work on touch devices.
- Browser generation is now always enabled (no optional toggle); legacy instant-only preferences are migrated back to enabled. Settings continues to show live ready/loading/unavailable status and retry controls.
- Improved mobile Safari WebGPU adapter selection, including a retry without power hints, and extended the first-load timeout from 3.1's 90 seconds to eight minutes for slower downloads and compilation (the WASM path added in 3.2 allows twelve).
- Added task-specific response guidance for generated answers while keeping hidden chain-of-thought private.


## 3.1.1 — 2026-09-26

### Reliable controls, transparency & Safari polish

- Wire the per-message **retry** action and make model retry start from a clean worker/promise state after timeout, cancellation or a failed initialization.
- Rename the broad Auto AI wording to **browser generation** for its real scope: open-ended writing, explanations, coding and plans. Settings now explicitly confirms whether it is enabled or active in the current browser.
- Add **Restore defaults** with confirmation and a server-side reset that removes retired provider settings without deleting chats or memories.
- Add an accessible **Thought process · answer path** disclosure to responses. It lists the actual tools, sources, saved context and runtime used; it intentionally does not expose a private chain-of-thought transcript.
- Harden iPhone Safari behavior: safe-area is applied once, visual-viewport sizing survives the keyboard, storage failures degrade safely, settings scroll correctly, and unsupported WebGPU falls back to instant tools.

## 3.1 — 2026-09-26

### Built-in AI, designed for Render Free

- Ship the pinned WebLLM 0.2.80 runtime and license with the website. The page and inference worker use the same same-origin asset; there is no inference-library CDN dependency or deployment-time npm step.
- Automatically initialize Qwen2.5 **0.5B** for requests that need generation. Visitors no longer open Settings or manually download/install a model to ask for writing and reasoning. Known-topic answers, calculations, commands, and text extraction stay instant without downloading weights.
- Select the compact f16/f32 variant based on GPU capabilities instead of starting with a 1.5B model or silently selecting a larger catalog entry.
- Fetch model weights, tokenizer, and compiled GPU library directly into the browser from their upstream hosts. Use WebLLM's browser Cache API for reuse, subject to storage availability and eviction. Do not store or run a model on the Render service.
- Serve the bundled runtime precompressed, with versioned immutable caching. Include checksum-verified tooling to reproduce the vendored files.
- Show automatic initialization progress and disclose the first-use transfer (a few hundred MB). Honor Data Saver, offline state, unsupported GPUs, and a persistent instant-only preference.
- Limit initialization to 90 seconds, terminate abandoned workers, prevent repeated failed downloads, and offer retry after a failure. Stop cancels initialization or generation; late initialization cannot answer a cancelled request.
- Set the Render Blueprint to `plan: free`. Document that Render Free cannot attach persistent disks and that SQLite on its ephemeral filesystem is not durable storage.

### Better local comprehension and chat

- Remove server preparation from the response-critical path. Read conversation context from the browser cache and synchronize completed turns in the background.
- Add deterministic topic comparisons, informal-input cleanup, requested sentence/bullet formatting, extractive summaries, explicit action-item extraction, and word counting.
- Correct arithmetic precedence, parentheses, unary signs, powers, and percentages without using `eval`.
- Add 20 focused knowledge cards; report the actual card count rather than a hard-coded claim.
- Restore context for reopened chats, normalize model history roles, bound model context, and clear subjects when starting a new conversation.
- Distinguish deterministic tools, loaded AI, unavailable AI, browser storage, server-backed memory, and search. Capability reporting is not consciousness; no unmeasured Meta AI parity or “10×” quality claim.

### Interface and reliability

- Batch streamed rendering per animation frame. Make Stop functional for search, initialization, and generation.
- Improve touch targets, mobile keyboard sizing, accessible zoom, readable light/dark themes, code overflow, and local transcript export.
- Preserve browser ownership when saving answers/memories and preparing memory recall; respect automatic-memory extraction settings.
- Add offline regression checks, automatic-model lifecycle tests, API ownership/integrity tests, and real-browser tests across five viewport sizes. Import the actual bundled runtime in Chromium; use stub weights/inference for lifecycle tests.

### Limits

- Integrating the runtime does **not** eliminate the initial model download or the device's WebGPU/memory requirements. Cached assets can be evicted. Small models can be wrong.
- Live GPU inference and answer quality have not been benchmarked by the automated tests. Model-host availability remains an external dependency.
- Server chat synchronization is best effort, not a durable offline-delivery queue. Browser caches and transcript exports remain important on a free, ephemeral host.

## 2.6 / 2.6.1 — 2026-09-25

- Expanded Archiver identity detection to avoid unrelated retrieval matches.
- Refined the thinking prompt and updated version labels/header.
- Earlier release notes remain available in the website's changelog panel.
