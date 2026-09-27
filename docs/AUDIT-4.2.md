# 4.2 audit and scope

Audit of `main` at `1fc8284` (4.1), what 4.2 changed, and what it deliberately
did not do. Line numbers refer to the 4.1 files.

## Findings

| # | Where | Finding | 4.2 |
|---|---|---|---|
| 1 | `web/archiver-engine.js:1149-1157` | WebGPU chosen whenever *any* adapter exists: no fallback-adapter check, no limit check, no allocation check — low-limit D3D12 (Edge) and phone GPUs could pick WebGPU and then fail. | Fixed: `gpuFitsModel()` |
| 2 | `web/archiver-engine.js:1059-1063` | `wasmSupported()` trusted the `WebAssembly` object; Edge strict mode / JIT-less profiles fail later with a cryptic error. | Fixed: `WebAssembly.validate` probe |
| 3 | `app/main.py` (no match) | No COOP/COEP → never `crossOriginIsolated`, no SharedArrayBuffer for threaded WASM. No CSP, Referrer-Policy, Permissions-Policy, nosniff. | Fixed: `app/hardening.py` |
| 4 | `app/main.py:1387` | `/api/search` unthrottled: one client can burn the monthly egress allowance and trigger upstream 403s for everyone. Same for sync/import. | Fixed: per-IP token buckets |
| 5 | `app/main.py:1411` | `/api/archive/import` and sync accept unbounded bodies on a 512 MB instance. | Fixed: 2 MiB cap (streamed count, not just Content-Length) |
| 6 | `app/memory.py:342` | `close()` did not checkpoint WAL; no low-memory pragmas. | Fixed |
| 7 | `app/search.py:562` | A provider that 403s (Wikipedia Action from datacentre IPs) is retried on every query; one hung provider can eat the 70 s budget. | Fixed: cooldown + per-provider timeout |
| 8 | `app/main.py:818` | `/api/memories` detected duplicates but stored them anyway; `conflicting()` existed but was unused on manual writes; no cap. | Fixed |
| 9 | `app/main.py:719` | Health gave no way to tell a reset server DB from an empty one (ephemeral disk). | Fixed: `db_created_at`, `boot_id`, banner |
| 10 | `app/__init__.py:3` | `__version__ = "2.4.1"` while the app said 4.1. | Fixed: 4.2 |
| 11 | `README.md:1` | Title said 4.0 while the app was 4.1. | Fixed |
| 12 | `tests/offline.js`, `tests/model.js` | Already failing on 4.1 `main` (they assert 4.0-era strings/behaviour). | **Not fixed** — pre-existing, out of scope; `make test` stops at `offline.js`. |

## Deliberately not done (and why)

| Item | Why not in 4.2 |
|---|---|
| Tiered model list (3–4B WebGPU / 1.5–3B WASM) | Changes download size by 3–5× for every visitor and needs on-device quality/memory testing that can't be done in CI. The probe added here is the prerequisite: tiers can now be gated on measured limits. Current pin: Qwen 2.5 0.5B Instruct (Apache-2.0). |
| Token-budget allocator, running summary, tool router, per-task sampling UI, BYO endpoint | Client prompt pipeline is ~2.4k lines of tightly coupled code with only string-level tests; rewriting it without a browser test harness risks regressions in grounding/citation rules. |
| IndexedDB-first storage / PWA service worker / offline shell | Chats are already browser-first (localStorage). A service worker changes caching of every asset and interacts with COEP; it needs manual Safari/Edge verification first. |
| HTTP Range pause/resume for weights | Handled inside WebLLM/wllama; overriding their fetchers means forking vendored code. |
| Brotli | No pure-Python Brotli in the stdlib; pre-gzipped vendor assets are already served. |
| Enforced CSP | App script is inline; shipped as report-only so a missed host can't break inference. Flip with `ARCHIVER_CSP=enforce` after checking the console. |
| External DB | Opt-in only, would add a dependency; export/import JSON already exists. |
