## 5.6 — 2026-11-11

Cleanup release focused on the public GitHub Pages experience.

### Browser search on github.io
- WEB no longer depends on the Render backend. When `/api/search` is missing
  (static Pages) or fails, Archiver searches from the browser via Wikipedia
  (CORS `origin=*`) and Hacker News Algolia. Results use the same shape as the
  server path so grounding, sources, and the model prompt stay unchanged.
- Server search is still preferred when the backend is present (faster multi-provider).

### Cleaner first impression
- Discord invite (floating widget, FAB, and Settings Community card) removed.
- Generation tuning controls removed from Settings.
- Main page no longer leads with “open Qwen model”; the model name is shown in
  Settings in smaller text when relevant.
- Version labels and identity lines are Archiver 5.6.

### Model preparation
- Automatic preparation now downloads **and** initialises the on-device model
  when the page opens, including on phones and tablets.
- Auto-prep is scheduled sooner after first paint.

### Safari / iPhone diagnostics
- Diagnostics panel scrolling fixed for iPhone 14 Safari (safe-area insets,
  `max-height` with `100dvh`, `-webkit-overflow-scrolling: touch`).

### Pages
- Shell cache bumped to `archiver-shell-v5.6.0`.

## 5.5 — 2026-10-08

Archiver 5.5 is the Archiver application. The models it runs are open models
published by Qwen (Qwen 2.5 0.5B Instruct as primary, Qwen 3 0.6B as the
automatic fallback). Archiver did not train them, and the app says so.

### Identity is metadata, not a guess

- Labels: `Archiver 5.5 · Qwen 2.5 0.5B Instruct · GPU (WebGPU)`,
  `Archiver 5.5 · No model loaded.` when nothing is running.
- Factual questions are routed before any model runs.
- Knowledge corpus: 1,561 cards.
- Shell cache `archiver-shell-v5.5.0`.
