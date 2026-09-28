# Browser support matrix (Archiver 4.3)

Archiver picks a runtime per device at the moment a request first needs the
model. It does not start a model worker on page open in Safari. On other browsers,
only a previously cached model is restored after first paint; new downloads
wait for a request.

**Runtime choice (4.2, unchanged in 4.3):** WebLLM on WebGPU only when *all* of these pass,
otherwise wllama (llama.cpp → WebAssembly, CPU):

1. `navigator.gpu.requestAdapter()` returns an adapter (null or a throw → WASM);
2. the adapter is not a software fallback (`isFallbackAdapter`);
3. `maxStorageBufferBindingSize` and `maxBufferSize` are ≥ 128 MiB (the pinned
   Qwen 2.5 0.5B q4 build is WebLLM `low_resource_required`);
4. `navigator.deviceMemory`, where reported, is ≥ 2 GB;
5. a device created with those limits accepts a 64 MiB storage-buffer canary
   allocation without an out-of-memory error.

WASM is used only when `WebAssembly.validate()` accepts a minimal module (this
catches Edge "Enhanced security"/strict mode and locked-down profiles that
expose the object but refuse to compile). If neither runtime is usable, the
instant local tools and web search still work and the reason is shown.

The whole probe result is visible in **Settings → Diagnostics** (or `#diag`,
or Ctrl/⌘+Shift+D).

## Versions assumed — verify before relying on them

| Fact | Assumed | Where to verify |
|---|---|---|
| Chrome/Edge desktop WebGPU | on by default since 113 (Win/macOS/ChromeOS); Linux still behind flags on many GPUs | chromestatus.com |
| Chrome Android WebGPU | since 121 on Android 12+ with Qualcomm/ARM GPUs | chromestatus.com |
| Safari WebGPU | on by default in **Safari 26** (macOS Tahoe 26, iOS/iPadOS 26, visionOS 26), released Sept 2025; off in Safari ≤ 18.x | WebKit / Safari 26 release notes |
| Firefox WebGPU | on by default on Windows since **141**; macOS (Apple Silicon) since ~145; Linux/Android still pending | Mozilla release notes |
| WebLLM | 0.2.80 (vendored) | `web/vendor/` |
| wllama | 3.6.1 (vendored, one `.wasm`; threads are used only if that build and `crossOriginIsolated` allow) | `web/vendor/` |
| Render free | 512 MB RAM, 0.1 CPU, spin-down after 15 min idle, ephemeral FS, no disks | render.com/docs/free |

## Matrix

| Browser | Runtime it normally gets | Threads (SharedArrayBuffer) | Notes |
|---|---|---|---|
| **Chrome desktop** (113+) | WebGPU | yes (COOP/COEP) | Best path. Linux often lacks an adapter → WASM. |
| **Edge desktop** (113+, Win/macOS) | WebGPU; WASM on D3D12 adapters under the 128 MiB binding limit | yes | *Enhanced security / strict mode* disables the WASM JIT; if `WebAssembly.validate` fails the UI says so and stays on instant tools. Sleeping/discarded tabs: a discarded tab reloads the page and the worker is recreated lazily on the next generative request; the `pagehide` handler already releases workers. Copilot sidebar/PWA windows may get a smaller storage quota — Diagnostics shows quota vs. usage. |
| **Firefox** (141+ Windows, macOS Apple Silicon) | WebGPU where enabled, else WASM | yes | Linux/Android: WASM. No `deviceMemory`. |
| **Safari macOS** 26+ | WebGPU if the probe passes, else WASM | yes (with COOP/COEP) | Safari ≤ 18: WASM. No `deviceMemory`, so the canary allocation is the memory check. ITP may evict Cache/OPFS storage after 7 days without a visit — the model then simply re-downloads with the normal progress UI; Diagnostics shows whether weights are cached. |
| **Safari iOS/iPadOS** 26+ (and *every* iOS browser — all are WebKit) | WebGPU if the probe passes, else WASM | yes | Per-tab memory ceiling: the default model is already the smallest tier (0.5B, ~400–490 MB), WASM context is capped at 2048 tokens with a q8 KV cache. Background tabs are throttled/suspended; generation resumes only when visible. iOS < 26: WASM. |
| **Android Chrome** 121+ | WebGPU on supported GPUs, else WASM | yes | Low-memory phones (deviceMemory < 2) go to WASM. |

## Cross-origin isolation

The server sends `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` (Safari does not implement
`credentialless`, so `require-corp` is the portable choice) plus
`Cross-Origin-Resource-Policy: same-origin` on everything it serves. Model
weights are fetched with `fetch()` (CORS mode) from Hugging Face / GitHub raw,
which send `Access-Control-Allow-Origin: *`, so they pass COEP. Set
`ARCHIVER_COEP=off` or `credentialless` to change this without a code edit.

## Manual test checklist

Run on a fresh profile (or after "Clear cached model weights" in Diagnostics).

**Every browser**
- [ ] Page opens; no model download starts until a generative prompt.
- [ ] Diagnostics opens from Settings, `#diag` and Ctrl/⌘+Shift+D; Escape closes; focus lands on Close.
- [ ] `Cross-origin isolated: true` in Diagnostics.
- [ ] A generative prompt shows the runtime (WebGPU/WASM) and reason in the audit trail.
- [ ] Reload → model loads from cache; Diagnostics lists cached stores.
- [ ] "Clear cached model weights" empties the stores; next prompt re-downloads with progress.
- [ ] Web search still answers; search with no evidence says so.
- [ ] DevTools console shows no CSP report-only violations for normal use.

**Edge**
- [ ] Windows, D3D12: Diagnostics shows adapter limits; a < 128 MiB binding routes to WASM with a reason.
- [ ] `edge://settings/privacy` → Enhanced security *Strict* → site not excepted: WASM validate false, one-line explanation, instant tools still work.
- [ ] Put tab to sleep (`edge://discards` → Discard), return, send a prompt: worker recreated, answer arrives.
- [ ] Installed as app / in sidebar: Diagnostics quota shown; model still downloads or explains quota.

**Safari macOS / iOS**
- [ ] Opening the page does not start a worker (Web Inspector → no worker listed).
- [ ] Safari 26: WebGPU chosen when the probe passes; Safari 18: WASM with "does not expose WebGPU".
- [ ] iPhone: 0.5B model loads without the tab reloading; long chat stays within budget.
- [ ] Background the tab mid-generation, come back: generation completes or can be retried cleanly.
- [ ] After a restart/redeploy of the server the "Server storage was reset… your browser copy is intact" banner appears once.
