# Qwen upgrade assessment (September 2026)

Current production baseline: Qwen2.5-0.5B-Instruct, WebLLM 0.2.80 q4f16/q4f32 on WebGPU and Qwen publisher GGUF on wllama 3.6.1 for Safari/CPU. These are not interchangeable downloads: the two backends require different formats and tokenization/chat templates. No model weights are shipped with the site.

## Candidate

Qwen3-0.6B is a plausible next small-text candidate (~523 MB in Ollama's packaged version). Qwen3.5-0.8B is another candidate, but even quantized it would increase the memory/download budget on iPhone. Neither should be silently substituted for the current model: the pinned WebLLM catalogue currently selects exact Qwen2.5 model IDs, and the pinned wllama WASM binary must understand the new architecture and chat template. A GGUF URL change alone would break one or both backends. Qwen3 also has thinking/non-thinking behavior that requires explicit prompt and output handling; existing response parsing and latency expectations need validation.

## Upgrade gate

1. Reproduce/pin the latest compatible WebLLM and wllama runtimes with SHA-256 and licenses; verify exact WebGPU model ID, publisher GGUF filename, CORS, and tokenizer/chat template.
2. Test GPU f16 and f32 paths and Safari WASM on actual macOS/iOS, including low-memory tab reload, cancellation, cache eviction, offline revisit, and the 2048-token CPU context ceiling.
3. Benchmark first download, startup memory, tokens/second, and answer quality on the existing deterministic, retrieval, and grounded-answer fixtures. Keep the existing Qwen2.5 path until the replacement passes both backends.
4. Version cache keys and labels together; do not call a stock replacement a custom fine-tune. Announce the new download size before fetching it.

Decision: keep the proven production weights for now; upgrade in a separately tested change rather than risking Safari generation in a UI refresh.

References: https://ollama.com/library/qwen3 ; https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF ; https://github.com/mlc-ai/web-llm ; https://github.com/ngxson/wllama
