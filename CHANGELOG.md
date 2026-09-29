## 5.2 — 2026-09-29

### Faster, more reliable, Safari-ready

- **3 questions on start page** — down from 6, clearer first-run experience, 3-col desktop / 1-col mobile grid.
- **Simpler changelog** — short, readable release notes in-app and in CHANGELOG.md.
- **Online search fixed** — wake hint, 75s timeout with retry, provider cooldown, empty report now synthesises a reading from sources, sources shown even without model, unverified flag works.
- **GPU chat fixed** — WebGPU probe hardened (f16 fallback, canary allocation), device-lost recovery, interrupt/cancel works on both runtimes, streaming coalescer fixed, progress shown when cached.
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
