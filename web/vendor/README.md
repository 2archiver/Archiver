# Vendored browser inference runtimes

Two runtimes are shipped with the website, both unmodified, both same-origin,
both served precompressed with versioned immutable caching. Archiver picks
between them automatically at initialization; the visitor never chooses,
installs or downloads anything by hand.

| Runtime | Files | Used when | License |
|---|---|---|---|
| WebLLM 0.2.80 (WebGPU) | `web-llm-0.2.80.js`, `.js.gz` | The browser returns a usable WebGPU adapter | Apache-2.0 |
| wllama 3.6.1 (llama.cpp → WebAssembly) | `wllama-3.6.1.js`, `.wasm`, `.js.gz`, `.wasm.gz` | No usable WebGPU adapter, but WebAssembly workers exist | MIT |

The WASM runtime is not a nice-to-have. Safari on iOS and iPadOS ships WebGPU
switched off on most OS versions and desktop Firefox gates it, so a GPU-only
runtime means "no generation at all" for a large share of visitors, with no
fix available inside the app. llama.cpp compiled to WebAssembly needs no GPU
and no browser flag. It is slower, and the UI says so.

## WebLLM

`web-llm-0.2.80.js` is the **unmodified** `package/lib/index.js` from
`@mlc-ai/web-llm@0.2.80` on npm. Its Apache-2.0 license is included as
`web-llm-0.2.80.LICENSE`. Upstream: <https://github.com/mlc-ai/web-llm>.

- Package: <https://registry.npmjs.org/@mlc-ai/web-llm/-/web-llm-0.2.80.tgz>
- Archive SHA-256: `e344a81e022edddde47f76ba89786105491113a33aed5d50a127fc836953aed1`
- JavaScript SHA-256: `ef77cc550c47c441f0243d7d173864548164814a9565c1a9a0b8b57f82167199`

Reproduce with `python scripts/vendor_webllm.py`.

## wllama

`wllama-3.6.1.js` is the **unmodified** `package/esm/index.js` and
`wllama-3.6.1.wasm` is the **unmodified** `package/esm/wasm/wllama.wasm` from
`@wllama/wllama@3.6.1` on npm (the package spells its license file `LICENCE`;
it is shipped here as `wllama-3.6.1.LICENSE`). wllama is a WebAssembly binding
for [llama.cpp](https://github.com/ggerganov/llama.cpp), MIT licensed,
copyright Xuan Son NGUYEN. Upstream: <https://github.com/ngxson/wllama>.

- Package: <https://registry.npmjs.org/@wllama/wllama/-/wllama-3.6.1.tgz>
- Archive SHA-256: `866e9403a8d686e33d5df0512f507ab79fccfbf08902d4b7add4c3a7a706b539`
- JavaScript SHA-256: `ee4b31125271a8d525db06d59724ebdb79c3bda5396eb9e3245f64fd531faf6b`
- WebAssembly SHA-256: `6ca9fdd1b6c03206cd3a04e359b52c8f539896d6c5fb5d36243dded4a689f0ad`
- License SHA-256: `5866e3bd7e3cbd3f7c8bea6efd8a1e7fa7cc8de68c30f428aff7c6584a0fb720`

Reproduce with `python scripts/vendor_wllama.py`.

The unminified `esm/index.js` is vendored rather than `esm/index.min.js` so
stack traces in a visitor's console are readable; the gzip difference is small.
The runtime builds its workers from inlined code as blob URLs, so no extra worker
file has to be served and nothing reaches a CDN.

`app/main.py` serves `wllama-3.6.1.wasm` as `application/wasm`. That is not
cosmetic: `WebAssembly.instantiateStreaming` refuses any other media type, and
Safari would otherwise buffer the whole 8 MB module before compiling it.

The engine loads it with `n_gpu_layers: 0`, which forces CPU inference and stops
the runtime reaching for a WebGPU compatibility shim we already know is
unavailable. Multi-threading needs `Cross-Origin-Opener-Policy` and
`Cross-Origin-Embedder-Policy` headers; this deployment does not set them, so
wllama detects that and runs single-threaded. That is the intended, safe path —
adding COEP would put every cross-origin model fetch behind a CORP requirement.

## Model weights are not vendored

**These files are runtime code, not model weights.** Each runtime fetches the
selected Qwen2.5 0.5B artifacts from their publishers:

- WebGPU: the model, tokenizer and compiled GPU library listed in WebLLM's
  pinned catalog. Cached through WebLLM's browser Cache API.
- WASM: a GGUF of the same model family from
  `Qwen/Qwen2.5-0.5B-Instruct-GGUF`, tried in the order listed in
  `WASM_SOURCES` in `archiver-engine.js` so one renamed artifact cannot disable
  the fallback. Cached through wllama's own cache manager.

Both caches are subject to browser storage availability and eviction, and
neither is a durable backup of user data. Weights are never downloaded to the
Render service or committed to Git.

## Upgrading

Do not edit a versioned asset in place. Change its version and URL, the engine
constant, any worker import, the `VENDOR_ASSETS` route table in `app/main.py`,
the checksum in the vendor script, `tests/test_api.py` and this file together.
The upstream source-map reference is retained in the WebLLM file; source maps
are not vendored.
