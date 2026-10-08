## 5.5 — 2026-10-08

Archiver 5.5 is the Archiver application. The models it runs are open models
published by Qwen (Qwen 2.5 0.5B Instruct as primary, Qwen 3 0.6B as the
automatic fallback). Archiver did not train them, and the app says so.

### Identity is metadata, not a guess

- `Archiver.status()` publishes an identity descriptor (app, app version, phase,
  selected and active model, quantization, backend, runtime and version,
  answer method, artifact revision). It is published only after a model has
  initialised successfully and is cleared on unload or failure.
- Labels: `Archiver 5.5 · Qwen 2.5 0.5B Instruct · GPU (WebGPU)`,
  `Archiver 5.5 · Qwen 2.5 0.5B Instruct · CPU (WebAssembly)`, the Qwen 3
  fallback as `Archiver 5.5 · Qwen 3 0.6B · CPU (WebAssembly)`, and
  `Archiver 5.5 · No model loaded.` when nothing is running. Direct card answers
  say `Local knowledge card · No model used for this answer.`
- "What model are you?", "are you Qwen?" and version questions are answered from
  that metadata. They never download a model.
- The generated prompt carries the same identity line, so the model is told
  the truth about itself at the moment it answers.

### Factual questions are routed before any model runs

- Exact aliases win over fuzzy matches. Substring matching is gone.
- A fuzzy match counts only when the query differs from a card word by one
  letter (a typo). Words that merely share a prefix (`internet`,
  `intermittent`, `interest`) no longer collide.
- Generic verbs and response-shaping words (`work`, `happen`, `detail`) are not
  evidence and no longer pull unrelated cards into the answer.
- A strong card answers directly, without generation, and its answer is
  finalised before display.
- A factual question with no reliable local or live evidence gets this
  reply, with no model call: "I don't have reliable information about that
  here. Paste a source, or use WEB when server search is available."
- The factual "give your best take anyway" persona line is retired. Retired
  persona text stays in the migration list, so saved settings still upgrade.
- An explicit new name overrides an earlier subject. A pronoun follow-up
  ("his books") resolves to the subject of the earlier turn.
- Cards are passed into the prompt whole (up to a 2,400-character budget), not
  cut at 650 characters, and are labelled as reference data. Instructions
  inside reference data are text to read, not commands.

### Knowledge corpus: 1,561 cards

- New: `lit-mishima-overview`, `lit-mishima-works`, `lit-mishima-dates`,
  `lit-mishima-politics-1970`, `hist-hitler-overview`.
- Corrected: `ww2-hitler-death` keeps its ID and no longer says "Führer since
  1933". He became chancellor in 1933 and Führer in 1934.

### Answers and cache

- Stored answers carry a policy revision (`grounding-5.5`). Answers stored
  under an older policy are not replayed; they are regenerated. Model files,
  chats and taught cards are untouched.

### Pages and browsers

- The shell cache is `archiver-shell-v5.5.0`. The service worker removes only
  its own older `archiver-shell-*` caches.
- Browser support notes are in `docs/BROWSER-SUPPORT.md`. Pages notes are in
  `docs/PAGES.md`.

### Not finished in 5.5 (stated plainly)

- Not tested on a real iPhone or Safari device. Safari and WebAssembly limits
  are documented, not measured.
- No real weight downloads were run in this environment. Inference is stubbed
  in the automated tests.
- Factual accuracy of the new cards was not checked against the source pages
  in this environment.
- Creative prompts about a topic can still get no card evidence if the topic
  only weakly matches a card. This is a threshold, and it was not tuned here.
- No reload-loop test was added for Pages.

## Public site & UX — 2026-10-02

### GitHub Pages is the public front door

- **Public destination: <https://2archiver.github.io/Archiver/>.** The README and Pages guide now make GitHub Pages the public front door. It serves the static, local-first client; the Render deployment remains available for server-backed live search and cross-device sync.
- **Clear about the trade-off, without the boot interruption.** On GitHub Pages, local knowledge, the on-device model and browser-stored chats still work; server search and sync do not. The app no longer interrupts first launch with a backend warning, and the redundant model/sync footer and persistent shortcut hint are gone. Useful in-progress status messages remain.
- **Local UI comes first.** Server detection runs after the local interface and cached conversation are ready, so a slow or absent backend does not hold the screen hostage.
- **Safari viewport fallback restored.** Layout uses `-webkit-fill-available` on older iOS Safari, `100dvh` where supported, and `100vh` as the baseline fallback.
- **Markup cleanup.** Removed an accidental duplicate fragment after the closing HTML document.

## Pages — 2026-10-02

### github.io 404 fixed — the workflow now owns the Pages source and verifies the live site

- **Why <https://2archiver.github.io/Archiver/> answered GitHub's 404 page.** The Pages source was on *Deploy from a branch* (`main` / `docs`), so GitHub's built-in builder ran on the same push as the `Pages` workflow, finished two minutes after it, and replaced the app with its own build of `docs/` — five rendered markdown files and no `index.html`. `/Archiver/PAGES.html` answered 200 while `/Archiver/` 404'd, and the workflow's deploy job was green throughout: `actions/deploy-pages` had published the artifact, then something else published over it.
- **The source is asserted, not assumed.** `scripts/ensure_pages_source.py` runs before every build on `main`: no-op when the source is *GitHub Actions*, an idempotent `PUT …/pages build_type=workflow` when it is a branch, `POST` when Pages is not enabled at all, and a loud failure naming **Settings → Pages** if the call is refused. `actions/configure-pages@v5` with `enablement: true` cannot do this — it returns an existing site unchanged, so it changes nothing on a branch-sourced repository.
- **A queued built-in build is waited out** after such a switch, so the workflow's artifact is the last one published for that commit.
- **The deploy now verifies the site it just published.** `scripts/verify_pages_site.py` fetches the reported `page_url` and requires the app shell plus a 200 for `manifest.json`, `favicon.svg`, `archiver-coi-sw.js`, `static/archiver-engine.js`, `static/archiver-worker.js` and `static/vendor/wllama-3.6.1.wasm`, retrying for two minutes. A replaced site is now a red run instead of a silent 404.
- **A daily run re-asserts and re-verifies** (`cron: '17 6 * * *'`), repairing a site replaced by a later settings change within a day.

## Model — 2026-10-02

### Lighter default model for static hosting — Qwen2.5-0.5B first, Qwen3-0.6B as fallback

- **The default model is Qwen2.5-0.5B-Instruct again**, on both runtimes (`Qwen2.5-0.5B-Instruct-q4f16_1-MLC` / `-q4f32_1-MLC` on WebGPU; `qwen2.5-0.5b-instruct` `q4_0` / `q4_k_m` / `q8_0` GGUF on WebAssembly). WebLLM's catalogue lists ~945 MB of GPU memory for it against ~1.4 GB for Qwen3-0.6B (q4f16_1). The CPU download is the same size either way (~429 MB at Q4_0).
- **Qwen3-0.6B is now only the automatic fallback**, tried when every Qwen2.5 artifact is missing or blocked. Branding is unchanged: it is still Archiver 5.3.
- **Qwen3-only switches are gated to Qwen3.** `extra_body.enable_thinking` (WebGPU), `chat_template_kwargs` and `/no_think` (CPU) are sent only while the Qwen3 fallback is active; WebLLM 0.2.80 would otherwise write an empty `<think></think>` block into Qwen2.5's prompt as plain text.
- **A warm start trusts only the primary model.** A persisted Qwen3 entry from an earlier 5.x build is invalidated, so the page never claims a cache hit for weights the browser does not hold.
- **Pages fix: worker scripts are isolated too.** The COI service worker only stamped navigations, so on an isolated page Chrome refused to start the WebGPU model worker (`net::ERR_BLOCKED_BY_RESPONSE`). It now stamps dedicated and shared worker scripts as well, and hands opaque responses back untouched. Checked in headless Chromium 153 against a header-less static host (see `docs/PAGES.md`).
- **Knowledge cards and in-app notes** name the current model.

## Pages — 2026-10-01

### Static GitHub Pages deployment — https://2archiver.github.io/Archiver/

- **The frontend now also ships with no backend.** `scripts/build_pages.py` + a `Pages` workflow publish `web/` to GitHub Pages; the safety gate refuses to emit databases, Python sources, `.env`/`.git` or key files.
- **Host-agnostic paths.** Asset refs are document-relative and fetches rebase through `ABS()`, so one build of `web/` serves correctly from `/` (Render) and `/Archiver/` (Pages). PWA `start_url`/`scope` are relative, so a Pages install can never claim the whole `github.io` origin.
- **Honest static mode.** A boot probe detects the missing server: sync is skipped silently, search fails through the existing "no usable sources" path, and export explains itself. The current UX performs this probe after the local UI is ready and does not show a startup warning.
- **Shared memory on a header-less host.** The Pages build injects a one-time `archiver-coi-sw.js` bootstrap that synthesizes the COOP/COEP isolation the WebAssembly runtime needs (Pages cannot send headers); a page that is already isolated never reloads. The wasm preflight now fails with a named cause *before* downloading weights.

## 5.3 — 2026-09-29

### Qwen3 model, no memories, refresh-free, redesigned

- **Model upgraded to Qwen3-0.6B** on both runtimes, with automatic fallback to Qwen2.5-0.5B if a Qwen3 artifact is missing or CORS-blocked.
- **Memories removed** — no durable memory store; chats still live in this browser and may sync to this app's server.
- **No more random refresh** — the model worker is kept warm through tab backgrounding, screen lock and WebGPU device loss.
- **Corpus — 1,556 cards**, a 5.3 expansion with new cards across science, technology, culture and current events.
- **Search recovers faster** — provider cooldown 120s (was 600s); single-result queries trigger a second-chance search.
- **Model warms sooner** — GPU preparation after 5 characters (was 8).
- **Redesigned interface** — refreshed design system, clearer layout, better contrast and spacing.

## 5.2 — 2026-09-29

### Faster, more reliable, Safari-ready

- **3 questions on start page** — down from 6, clearer first-run experience, 3-col desktop / 1-col mobile grid.
- **Simpler changelog** — short, readable release notes in-app and in CHANGELOG.md.
- **Online search fixed** — wake hint, 75s timeout with retry, provider cooldown, empty report now synthesises a reading from sources, sources shown even without model, unverified flag works.
- **GPU chat fixed** — WebGPU probe hardened (f16 fallback, canary allocation), device-lost recovery, interrupt/cancel works on both runtimes, streaming coalescer fixed, progress shown when cached.
- **GPU blank answers fixed** — the WebGPU path now tells WebLLM `extra_body: { enable_thinking: false }` (the same switch the CPU path already used via `chat_template_kwargs`), so Qwen 3's hidden thinking pass can no longer consume the entire token budget and leave an empty bubble. Live streaming is rewired to the display stream (it was silently buffered until the end), and the blank-failure notice is never stored in the answer cache.
- **Advanced retrieval settings are real** — Minimum relevance, Memories per query, Half-life and Context token budget now load from the stored settings (no more empty inputs), save on change, and are clamped to server-safe ranges so an empty field can never write an unparsable value.
- **Logo mark** — the Orbital Singularity option is removed; the Neural Tesseract mark is the only one, and any stored preference for the old mark is cleared.
- **Safari optimised** — cached model now warms on page load even on iOS (was deferred), prepare() triggers earlier while typing, WASM threads 3 on iPhone (was 4), batch 1024 on Apple mobile / 512 elsewhere (was 512/256), parallelDownloads 4, compact CPU persona, OPFS cache recovery, viewport with interactive-widget=resizes-content, 16px inputs to prevent zoom.
- **Bug fixes** — api() timeout now respects custom signals, blank-answer recovery, citation validation, answer cache guards, storage quota handling, memory sync, and more.
- **Corpus** — 1,526 cards, including ten Sopranos cards (sop-overview, sop-gandolfini, sop-finale, sop-cast, sop-melfi, sop-theme, sop-locations, sop-many-saints, sop-pine-barrens, sop-legacy) [...SOPRANOS].

## 5.1 — 2026-09-29

- Blank-answer detection and retry so empty bubbles never show.
- Live streaming with safe display and thinking gate for <think> blocks.
- Per-browser answer cache (40 entries, 7-day TTL, 12k chars).
- Composer warms up while you type; settings apply as you change them.
- Ten Sopranos cards, total 1,526 cards.
- iPhone tuning: Q4_0 first, q8 KV cache, 2048 context, viewport fixes.

## 5.0 — 2026-09-29

- Archiver 5.0 — an Archiver build of the open Qwen3-0.6B model (q4f16/q4f32 WebGPU, Q4_0/Q4_K_M/Q8_0 WASM), 1,526 cards, sharp persona, no third-party cloud AI.
- Safari optimisations: compact CPU persona, /no_think, batch 256, parallelDownloads 3.
- Neural Tesseract Prism emblem, character counter, load model button.

## 4.3 — 2026-09-28

- Resilient search: DuckDuckGo HTML, Wikipedia OpenSearch, second-chance round, browser-UA retry for Bing.
- Open-minded persona, OLED true-black theme, faster scoring, 1,515 cards.

## 4.2 — 2026-09-27

- Real WebGPU probe: fallback adapter, buffer limits, deviceMemory, 64 MiB canary.
- WASM validate, diagnostics panel, server reset notice, COOP/COEP, rate limits, memory dedup.

## 4.1 — 2026-09-27

- Bing keyless, concurrent providers, 75s wake timeout, relaxed thresholds, unverified label, no forced Thinking preamble.

## 4.0 — 2026-09-27

- Free-tier budget: waking hint, bounded fetches (2 MiB), 304 ETag, no WebSockets, architecture decisions.

## 3.5 — 2026-09-27

- Backend persisted 7 days, warm from cache, 1400+ cards, Safari polish, manifest.

## 3.4 — 2026-09-27

- Pre-warm on page open, own model branding Archiver 3.4.

## 3.3 — 2026-09-26

- Grounded read built from sources, plan on every prompt, commitment checks.

## 3.2 — 2026-09-26

- Safari WASM fallback (wllama 3.6.1), iOS keyboard rewrite, thinking panel on every prompt.

## 3.1 — 2026-09-26

- Built-in AI WebLLM 0.2.80, Qwen2.5 0.5B auto-init, Render free, local comprehension.

## 2.x — 2026-09-24

- 60 → 1000 topics, private chats, instant tools, Render deploy.

## 1.x–2.0 — 2026-09-23

- Chat that saves memory — first code, SQLite, local-first storage.
