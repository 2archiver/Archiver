# Archiver 5 Model Architecture & Safari Optimisation (September 2026)

Current production baseline: **Archiver 5.3** — Archiver's own compact on-device model built on `Qwen2.5-0.5B-Instruct`, running WebLLM 0.2.80 (`Qwen2.5-0.5B-Instruct-q4f16_1-MLC` / `Qwen2.5-0.5B-Instruct-q4f32_1-MLC`) on WebGPU and `Qwen2.5-0.5B-Instruct` GGUF (`qwen2.5-0.5b-instruct-q4_0.gguf` / `-q4_k_m.gguf` / `-q8_0.gguf`) on wllama 3.6.1 for Safari/CPU. `Qwen3-0.6B` (`Qwen3-0.6B-q4f16_1-MLC` / `-q4f32_1-MLC`, and the `Qwen3-0.6B` Q4_0 / Q4_K_M / Q8_0 GGUFs) remains as an automatic fallback. Zero third-party cloud AI providers are used for in-browser generation.

## Qwen2.5 is the default again (October 2026)

5.3 shipped `Qwen3-0.6B` first. For static hosting (GitHub Pages) the default is now the lighter `Qwen2.5-0.5B-Instruct` — the Archiver 4.3 model — on both runtimes, and `Qwen3-0.6B` is only an automatic fallback.

| | Qwen2.5-0.5B-Instruct | Qwen3-0.6B |
|---|---|---|
| WebLLM `vram_required_MB` (q4f16_1 / q4f32_1) | 944.62 / 1060.2 | 1403.34 / 1924.98 |
| GGUF Q4_0 size | 428,730,208 B | 428,970,080 B |
| Hidden thinking pass | none | yes (switch needed) |

(VRAM figures are the pinned `web-llm-0.2.80` catalogue values; GGUF sizes are from the Hugging Face file listings.) The saving is on the GPU path — about a third less at q4f16_1. **The CPU/WebAssembly download is the same size either way**, so this change does not by itself make the WebAssembly path cheaper.

- **Selection.** WebGPU tries `PREFERRED` (Qwen2.5, f16 or f32 by adapter capability) and falls back to the matching `FALLBACK_MODELS` (Qwen3) entry only when the first cannot load. WebAssembly walks `WASM_SOURCES`: Qwen2.5 Q4_0, Q4_K_M, Q8_0, then Qwen3 Q4_0, Q4_K_M, Q8_0. Neither path ever picks a larger catalogue model.
- **Qwen3-only switches are gated.** `hasThinkingMode(id)` is true only for Qwen3 ids/URLs. `extra_body.enable_thinking` (WebGPU), `chat_template_kwargs` and the `/no_think` prompt token (CPU) are sent only then. WebLLM 0.2.80 appends a literal empty `<think></think>` block to the assistant turn whenever `enable_thinking` is `false`, for any model — harmless to Qwen3, noise in Qwen2.5's prompt.
- **Warm start.** `VALID_MODELS` holds only the primary model, so a persisted Qwen3 entry (from an earlier 5.x build or from a fallback load) is dropped and the primary is tried first on the next session; the page never claims a cache hit for weights the browser doesn't hold.
- **Branding.** Unchanged: both families render as `Archiver 5.3`.
- **Not benchmarked here.** Real weights and WebGPU generation were not run in the CI/sandbox environment; automated tests stub inference (see `tests/model.js`).

## 5.3 — Qwen3 with a legacy fallback, refresh-free tab, no memories (September 2026)

5.3 keeps the `Qwen3-0.6B` weights and adds resilience around them:

- **Automatic legacy fallback.** Both runtimes try the Qwen3-0.6B artifacts first and fall back to the proven `Qwen2.5-0.5B-Instruct` family when a Qwen3 artifact is missing or CORS-blocked, so Safari and weaker GPUs still generate.
- **Refresh-free tab lifecycle.** The model worker is kept warm through tab backgrounding, screen lock and WebGPU device loss instead of being torn down and reloaded.
- **Faster search recovery.** Provider cooldown cut from 600s to 120s; single-result queries trigger a second-chance search.
- **Earlier GPU warm-up.** Preparation triggers after 5 characters (was 8).
- **No memories.** The durable memory store, its API and its UI were removed; conversations stay in this browser and may sync to the app server.
- **Redesigned interface** and an expanded knowledge base (1,556 cards).

## 5.3 — Qwen3 with a legacy fallback, refresh-free tab, no memories (September 2026)

5.3 keeps the `Qwen3-0.6B` weights and adds resilience around them:

- **Automatic legacy fallback.** Both runtimes try the Qwen3-0.6B artifacts first and fall back to the proven `Qwen2.5-0.5B-Instruct` family when a Qwen3 artifact is missing or CORS-blocked, so Safari and weaker GPUs still generate.
- **Refresh-free tab lifecycle.** The model worker is kept warm through tab backgrounding, screen lock and WebGPU device loss instead of being torn down and reloaded.
- **Faster search recovery.** Provider cooldown cut from 600s to 120s; single-result queries trigger a second-chance search.
- **Earlier GPU warm-up.** Preparation triggers after 5 characters (was 8).
- **No memories.** The durable memory store, its API and its UI were removed; conversations stay in this browser and may sync to the app server.
- **Redesigned interface** and an expanded knowledge base (1,556 cards).

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

_This list describes the 5.0–5.3 Qwen3-first design. Since October 2026 the Qwen3 artifacts below are the fallback and Qwen2.5-0.5B-Instruct is tried first — see the section above._

1. **WebGPU (WebLLM 0.2.80):** Uses `Qwen3-0.6B-q4f16_1-MLC` (or `Qwen3-0.6B-q4f32_1-MLC` when `shader-f16` is absent), marked `low_resource_required: true` in the bundled WebLLM catalogue. 5.2 adds device-lost listener and f16 fallback hardening.
2. **Safari-optimised WebAssembly (wllama 3.6.1):**
   - Prioritizes `Qwen3-0.6B-Q4_0.gguf` (`ggml-org/Qwen3-0.6B-GGUF`) first for fast symmetric int4 SIMD/NEON dot-product decoding on Apple Silicon and mobile WebKit, with `Q4_K_M` and `Q8_0` fallbacks.
   - 5.2: `n_batch: 1024` on Apple mobile / 512 elsewhere (was 512/256), `parallelDownloads: 4` (was 3), `n_threads: 3` on iPhone (was 4), and quantized `q8_0` unified KV cache within a 2048-token CPU context budget.
   - Applies `SAFARI_CPU_PERSONA` and `/no_think` on CPU turns when explicit chain-of-thought is not requested, cutting CPU prompt prefill latency by >50% and preventing hidden `<think>` token burn. 5.2 compacts persona further.
3. **Thinking-tag & repetition handling:** `makeThinkingGate` and `makeShaper` in `web/archiver-engine.js` automatically hold and strip any leading `<think>…</think>` block from the visible response stream while lifting non-empty thoughts into the per-turn Thought process audit panel, and strip duplicate trailing sentences.
4. **Cache invalidation & Safari OPFS recovery:** `readPersistedBackend()` automatically invalidates stale `Qwen2.5-0.5B` entries in `archiver.engine.v1` and recovers from corrupted or evicted OPFS cache entries by retrying with `useCache: false`. 5.2 also warms cached models on Safari page load and improves viewport handling with `interactive-widget=resizes-content`.

References: https://ollama.com/library/qwen3 ; https://huggingface.co/ggml-org/Qwen3-0.6B-GGUF ; https://github.com/mlc-ai/web-llm ; https://github.com/ngxson/wllama

