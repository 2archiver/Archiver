# Archiver 5 Model Architecture & Safari Optimisation (September 2026)

Current production baseline: **Archiver 5.2** — Archiver's own compact on-device model built on the `Qwen3-0.6B` architecture, running WebLLM 0.2.80 (`Qwen3-0.6B-q4f16_1-MLC` / `Qwen3-0.6B-q4f32_1-MLC`) on WebGPU and `Qwen3-0.6B` GGUF (`Qwen3-0.6B-Q4_0.gguf` / `Qwen3-0.6B-Q4_K_M.gguf` / `Qwen3-0.6B-Q8_0.gguf`) on wllama 3.6.1 (`libllama b10663` with native `qwen3` architecture support) for Safari/CPU. Zero third-party cloud AI providers are used for in-browser generation.

## 5.2 — same model, more reliable, Safari-ready (September 2026)

5.2 keeps the 5.1 model unchanged. What changed is reliability and Safari:

- **Home: 3 questions.** Start page simplified to 3 prompts (knowledge, live web, generation) — 3-col desktop, 1-col mobile.
- **Changelog simplified.** Both in-app overlay and CHANGELOG.md rewritten to short bullets.
- **Online search fixed.** Wake hint, 75s timeout with retry, provider cooldown, empty-report handling now synthesises a reading from sources, sources shown even without model, unverified flag.
- **GPU chat fixed.** WebGPU probe hardened, f16 fallback, device-lost recovery, interrupt/cancel on both runtimes, streaming coalescer, progress when cached.
- **Safari optimised.** Cached model warms on page load even on iOS (was deferred), prepare() on intent typing, WASM threads 3 on iPhone (was 4), batch 1024 Apple mobile / 512 desktop, parallelDownloads 4, compact CPU persona, OPFS recovery, viewport with interactive-widget=resizes-content, 16px inputs.

## 5.1 — same model, better answer reliability (September 2026)

5.1 keeps the architecture above unchanged. What changed is around the model:

- **Blank-answer recovery.** A turn that would have produced nothing — an empty
  model output, a truncated first delta, an aborted stream — is detected and the
  stream retries from the last good token; if nothing usable still arrives the
  reply states the limitation rather than rendering an empty bubble.
- **Per-browser answer cache.** Generated answers are cached in
  `localStorage` under `archiver.answers.v1` (40 entries, 7-day TTL, 12,000
  characters each) keyed on the normalised prompt, the persona hash, the runtime
  and the model label. Only non-web answers are cached: a live-data answer must
  never be replayed from yesterday. Refusals and answers that state a limitation
  are excluded, because a cached refusal would outlive the reason for it.
- **Composer prepare.** The recall that feeds a generated reply is prepared while
  you type, so the first token is not waiting on retrieval.

## Archiver 5 Improvements & Safari Optimisations

1. **WebGPU (WebLLM 0.2.80):** Uses `Qwen3-0.6B-q4f16_1-MLC` (or `Qwen3-0.6B-q4f32_1-MLC` when `shader-f16` is absent), marked `low_resource_required: true` in the bundled WebLLM catalogue. 5.2 adds device-lost listener and f16 fallback hardening.
2. **Safari-optimised WebAssembly (wllama 3.6.1):**
   - Prioritizes `Qwen3-0.6B-Q4_0.gguf` (`ggml-org/Qwen3-0.6B-GGUF`) first for fast symmetric int4 SIMD/NEON dot-product decoding on Apple Silicon and mobile WebKit, with `Q4_K_M` and `Q8_0` fallbacks.
   - 5.2: `n_batch: 1024` on Apple mobile / 512 elsewhere (was 512/256), `parallelDownloads: 4` (was 3), `n_threads: 3` on iPhone (was 4), and quantized `q8_0` unified KV cache within a 2048-token CPU context budget.
   - Applies `SAFARI_CPU_PERSONA` and `/no_think` on CPU turns when explicit chain-of-thought is not requested, cutting CPU prompt prefill latency by >50% and preventing hidden `<think>` token burn. 5.2 compacts persona further.
3. **Thinking-tag & repetition handling:** `makeThinkingGate` and `makeShaper` in `web/archiver-engine.js` automatically hold and strip any leading `<think>…</think>` block from the visible response stream while lifting non-empty thoughts into the per-turn Thought process audit panel, and strip duplicate trailing sentences.
4. **Cache invalidation & Safari OPFS recovery:** `readPersistedBackend()` automatically invalidates stale `Qwen2.5-0.5B` entries in `archiver.engine.v1` and recovers from corrupted or evicted OPFS cache entries by retrying with `useCache: false`. 5.2 also warms cached models on Safari page load and improves viewport handling with `interactive-widget=resizes-content`.

References: https://ollama.com/library/qwen3 ; https://huggingface.co/ggml-org/Qwen3-0.6B-GGUF ; https://github.com/mlc-ai/web-llm ; https://github.com/ngxson/wllama

