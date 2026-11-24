# Archiver 6

A local-first AI assistant that runs an open Qwen model directly in your browser (WebGPU or Safari-optimised WebAssembly), paired with 1,561 cards of instant local knowledge and optional live web search.

## Features

- **In-browser inference:** Runs Qwen 2.5 0.5B Instruct (with automatic fallback to Qwen 3 0.6B) on WebGPU or single/multi-threaded WebAssembly — no API keys or external inference servers required.
- **Persistent model cache:** Stores model weights in OPFS (including Safari's worker sync-access path) so repeat visits start without re-downloading.
- **Live web search:** Optional `WEB` toggle for current information, with grounded citations.
- **Static or self-hosted:** Runs as a static site (e.g. GitHub Pages via `scripts/build_pages.py`) or with the lightweight FastAPI backend (`./run.sh`).

## Browser Support

- **Desktop:** Chrome, Edge, Firefox, and Safari 16.4+.
- **Mobile:** **iPhone / iOS 16.4+ (Safari)** and modern Android browsers. (iOS 16.0–16.3 lacks OPFS sync-access handles and regex lookbehind; 16.4+ is the supported floor.)

## Quick Start

### Local Server

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
./run.sh
```

Then open `http://localhost:8000`.

### Static Site (GitHub Pages)

```bash
python3 scripts/build_pages.py --out dist
```

Serve `dist/` over HTTPS (required for `crossOriginIsolated` / `SharedArrayBuffer` and OPFS).

## Tests

```bash
.venv/bin/pytest tests/ -q
node tests/smoke.js && node tests/pages.js && node --experimental-vm-modules tests/prep.js
```
