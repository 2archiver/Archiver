## Pages — 2026-10-01

### Static GitHub Pages deployment — https://2archiver.github.io/Archiver/

- **The frontend now also ships with no backend.** `scripts/build_pages.py` + a `Pages` workflow publish `web/` to GitHub Pages; the safety gate refuses to emit databases, Python sources, `.env`/`.git` or key files.
- **Host-agnostic paths.** Asset refs are document-relative and fetches rebase through `ABS()`, so one build of `web/` serves correctly from `/` (Render) and `/Archiver/` (Pages). PWA `start_url`/`scope` are relative, so a Pages install can never claim the whole `github.io` origin.
- **Honest static mode.** A single boot probe detects the missing server: sync is skipped silently, search fails through the existing "no usable sources" path, and export explains itself — one notice, no per-turn nagging.
- **Shared memory on a header-less host.** The Pages build injects a one-time `archiver-coi-sw.js` bootstrap that synthesizes the COOP/COEP isolation the WebAssembly runtime needs (Pages cannot send headers); browsers that already allow `SharedArrayBuffer` never reload. The wasm preflight now fails with a named cause *before* downloading weights.

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

- Archiver 5.0 — our own model Qwen3-0.6B (q4f16/q4f32 WebGPU, Q4_0/Q4_K_M/Q8_0 WASM), 1,526 cards, sharp persona, no third-party cloud AI.
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
