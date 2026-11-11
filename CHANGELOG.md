## 5.6 — 2026-11-11

Cleanup release focused on the public GitHub Pages experience.

### Cleaner first impression
- Discord invite (floating widget, FAB, and Settings Community card) removed.
- Generation tuning controls removed from Settings.
- Main page no longer leads with “open Qwen model”; the model name is shown in Settings in smaller text when relevant.
- Version labels and identity lines are Archiver 5.6.

### Model preparation
- Automatic preparation now downloads **and** initialises the on-device model when the page opens, including on phones and tablets (previously mobile only downloaded and deferred init until the first question).
- Auto-prep is scheduled sooner after first paint so the model is more likely to be ready when you ask.

### Safari / iPhone diagnostics
- Diagnostics panel scrolling fixed for iPhone 14 Safari (safe-area insets, `max-height` with `100dvh`, `-webkit-overflow-scrolling: touch`, `overscroll-behavior: contain` on the report body).

### Pages
- Shell cache bumped to `archiver-shell-v5.6.0`.

## 5.5 — 2026-10-08

Archiver 5.5 is the Archiver application. The models it runs are open models
published by Qwen (Qwen 2.5 0.5B Instruct as primary, Qwen 3 0.6B as the
automatic fallback). Archiver did not train them, and the app says so.

### Identity is metadata, not a guess

- `Archiver.status()` publishes an identity descriptor (app, app version, phase,
  selected and active model, quantization, backend, runtime and version,
  answer method, artifact revision). It is published only after a model has
  initialised successfully and is cleared on unload or failure.
- Labels: `Archiver 5.5 · Qwen 2.5 0.5B Instruct · GPU (WebGPU)`,
  `Archiver 5.5 · Qwen 2.5 0.5B Instruct · CPU (WebAssembly)`, the Qwen 3
  fallback as `Archiver 5.5 · Qwen 3 0.6B · CPU (WebAssembly)`, and
  `Archiver 5.5 · No model loaded.` when nothing is running. Direct card answers
  say `Local knowledge card · No model used for this answer.`
- "What model are you?", "are you Qwen?" and version questions are answered from
  that metadata. They never download a model.
- The generated prompt carries the same identity line, so the model is told
  the truth about itself at the moment it answers.

### Factual questions are routed before any model runs

- Exact aliases win over fuzzy matches. Substring matching is gone.
- A fuzzy match counts only when the query differs from a card word by one
  letter (a typo). Words that merely share a prefix (`internet`,
  `intermittent`, `interest`) no longer collide.
- Generic verbs and response-shaping words (`work`, `happen`, `detail`) are not
  evidence and no longer pull unrelated cards into the answer.
- A strong card answers directly, without generation, and its answer is
  finalised before display.
- A factual question with no reliable local or live evidence gets this
  reply, with no model call: "I don't have reliable information about that
  here. Paste a source, or use WEB when server search is available."
- The factual "give your best take anyway" persona line is retired. Retired
  persona text stays in the migration list, so saved settings still upgrade.
- An explicit new name overrides an earlier subject. A pronoun follow-up
  ("his books") resolves to the subject of the earlier turn.
- Cards are passed into the prompt whole (up to a 2,400-character budget), not
  cut at 650 characters, and are labelled as reference data. Instructions
  inside reference data are text to read, not commands.

### Knowledge corpus: 1,561 cards

- New: `lit-mishima-overview`, `lit-mishima-works`, `lit-mishima-dates`,
  `lit-mishima-politics-1970`, `hist-hitler-overview`.
- Corrected: `ww2-hitler-death` keeps its ID and no longer says "Führer since
  1933". He became chancellor in 1933 and Führer in 1934.

### Answers and cache

- Stored answers carry a policy revision (`grounding-5.5`). Answers stored
  under an older policy are not replayed; they are regenerated. Model files,
  chats and taught cards are untouched.

### Pages and browsers

- The shell cache is `archiver-shell-v5.5.0`. The service worker removes only
  its own older `archiver-shell-*` caches.
- Browser support notes are in `docs/BROWSER-SUPPORT.md`. Pages notes are in
  `docs/PAGES.md`.

### Not finished in 5.5 (stated plainly)

- Not tested on a real iPhone or Safari device. Safari and WebAssembly limits
  are documented, not measured.
- No real weight downloads were run in this environment. Inference is stubbed
  in the automated tests.
- Factual accuracy of the new cards was not checked against the source pages
  in this environment.
- Creative prompts about a topic can still get no card evidence if the topic
  only weakly matches a card. This is a threshold, and it was not tuned here.
- No reload-loop test was added for Pages.
