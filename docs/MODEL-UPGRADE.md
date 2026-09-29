# Archiver 5 Model Architecture & Safari Optimisation (September 2026)

Current production baseline: **Archiver 5** — Archiver's own compact on-device model built on the `Qwen3-0.6B` architecture, running WebLLM 0.2.80 (`Qwen3-0.6B-q4f16_1-MLC` / `Qwen3-0.6B-q4f32_1-MLC`) on WebGPU and `Qwen3-0.6B` GGUF (`Qwen3-0.6B-Q4_0.gguf` / `Qwen3-0.6B-Q4_K_M.gguf` / `Qwen3-0.6B-Q8_0.gguf`) on wllama 3.6.1 (`libllama b10663` with native `qwen3` architecture support) for Safari/CPU. Zero third-party cloud AI providers are used for in-browser generation.

## Archiver 5 Improvements & Safari Optimisations

1. **WebGPU (WebLLM 0.2.80):** Uses `Qwen3-0.6B-q4f16_1-MLC` (or `Qwen3-0.6B-q4f32_1-MLC` when `shader-f16` is absent), marked `low_resource_required: true` in the bundled WebLLM catalogue.
2. **Safari-optimised WebAssembly (wllama 3.6.1):**
   - Prioritizes `Qwen3-0.6B-Q4_0.gguf` (`ggml-org/Qwen3-0.6B-GGUF`) first for fast symmetric int4 SIMD/NEON dot-product decoding on Apple Silicon and mobile WebKit, with `Q4_K_M` and `Q8_0` fallbacks.
   - Uses `n_batch: 256`, `parallelDownloads: 3`, and quantized `q8_0` unified KV cache within a 2048-token CPU context budget.
   - Applies `SAFARI_CPU_PERSONA` and `/no_think` on CPU turns when explicit chain-of-thought is not requested, cutting CPU prompt prefill latency by >50% and preventing hidden `<think>` token burn.
3. **Thinking-tag & repetition handling:** `makeThinkingGate` and `makeShaper` in `web/archiver-engine.js` automatically hold and strip any leading `<think>…</think>` block from the visible response stream while lifting non-empty thoughts into the per-turn Thought process audit panel, and strip duplicate trailing sentences.
4. **Cache invalidation & Safari OPFS recovery:** `readPersistedBackend()` automatically invalidates stale `Qwen2.5-0.5B` entries in `archiver.engine.v1` and recovers from corrupted or evicted OPFS cache entries by retrying with `useCache: false`.

References: https://ollama.com/library/qwen3 ; https://huggingface.co/ggml-org/Qwen3-0.6B-GGUF ; https://github.com/mlc-ai/web-llm ; https://github.com/ngxson/wllama

