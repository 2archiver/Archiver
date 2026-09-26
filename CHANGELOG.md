# Changelog

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
