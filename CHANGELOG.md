# Changelog

## 3.3 — 2026-09-26

### A read of the sources, not a stock paragraph

- **Removed `_synthesize_thoughts` and the “💡 Additional Thoughts & Lateral Angles” section.** It chose a paragraph by keyword bucket — influencer, Render, engineering, history, “compare … you” — and fell back to *“skip the headline — find the constraint that actually binds it. For X, ask who pays, what must stay on, and what the default is”* for everything else. The same sentences were returned for every topic in a bucket, and the fallback was nonsense for most subjects (it was shipped for Benito Mussolini).
- **New `app/take.py`.** The closing paragraph of a web answer is built from the retrieved extracts: the lead sentence is parsed for what the subject *is* (“an Italian politician, journalist, and dictator”; “a major World War II Eastern Front battle”; “a high-level, general-purpose programming language”), the extracts are scanned for the span of years and the sentence that carries the turning point, the consensus and date-conflict checks say what the sources agree on and how independent they are (two Wikipedia pages are “one editorial view from two angles”), and the question’s shape is compared with what the extracts contain. A “why” asked of sources that only narrate says so and refuses to invent a cause; a “when” with no dates says so; a yes-or-no whose key word never appears in the sources answers with that absence; a Stack Exchange thread is read as a practitioner answer with a version caveat.
- **It commits.** Archiver’s own sentences carry no hedges (`take.HEDGES` is checked in tests). Contested claims a source states as the subject’s own conduct are repeated as conduct — “the source does not hedge and neither will I” — and claims a source frames as allegations are repeated as allegations. Where a living figure’s long-form record is named in the extract (a show, a podcast), the read names it instead of advising the reader to “find a long-form source”.
- **No heading.** The read is the last paragraph of the answer body, before the source list — the way a grounded answer from any mainline assistant ends. `report.additional_thoughts` is replaced by `report.take`; `report.plan` is new.
- Two subjects cannot produce the same paragraph, and `tests/test_take.py` asserts that no sentence is shared between six unrelated subjects except the single-source caveat.

### Thinking on literally every prompt

- Every route states a one-line plan (`trace.thinking`, with `trace.planBy` saying whose it is): commands name the command, arithmetic names the expression and that it is evaluated with operator precedence, pasted-text work says it will add nothing that is not in the text, conversation says it retrieves nothing, a card match names the card and its strength, and the search path shows the server’s plan for the read. The Thought process panel opens on every answer and is labelled “Archiver’s plan” or “The model’s plan” accordingly.
- A generated answer whose model skipped the `Thinking:` line shows the pipeline’s plan — approach, evidence held, backend — instead of an empty panel. The audit step says that is what happened.

### The on-device model and the read

- For a web-grounded generation the system prompt carries the facts and the draft read separately (“my draft read … sharpen it, contradict it where the evidence does, never paste it”) and adds a closing rule: finish with one short paragraph of your own assessment, specific to the subject, committed, with no heading and no generic advice.
- The server persona (3.3) says the same, and untouched 3.2 personas are upgraded in place; customised ones are left alone as before.

### Smaller

- “What do you think?” after a search answers with the read built for that subject; without a grounded read it says it only has the local card and suggests WEB, instead of a rotating stock line.
- `interpret_question` recognises a bare yes-or-no (“was mussolini a socialist”) as a verdict question and restates it as one.
- Version 3.3 everywhere the version is stated: persona, default model label (with migration), `/api/health`, engine, corpus, page title, manifest, changelog panel.

### Tests

- `tests/test_take.py` (new): profile reading, the Mussolini regression, cross-subject distinctness, commitment and hedges, allegations vs conduct, why/when/yes-or-no shapes, events, Stack Exchange, `brief()` composition, and a source-level check that the 3.2 stock sentences are gone.
- `tests/model.js`: a plan line on every prompt and per route, the pipeline fallback when the model skips its line, the grounded prompt’s draft read and closing rule, the read appearing once in the no-model answer with no heading, and the opinion follow-up.

## 3.2 — 2026-09-26

### Generation on Safari without WebGPU

- **Ship a second inference runtime and choose between them automatically.** `wllama` 3.6.1 — llama.cpp compiled to WebAssembly — is vendored next to WebLLM and served same-origin, precompressed, as `application/wasm` so `instantiateStreaming` works instead of Safari buffering 8 MB before it can compile. When the browser returns no usable WebGPU adapter, generation runs on the CPU instead of not running at all. **No flag to enable, nothing to install, no download button.**
- This is the actual Safari fix. WebGPU is off by default on most iOS/iPadOS Safari versions and gated on desktop Firefox, so 3.1's only answer for those visitors was a message explaining that their browser could not help.
- Same model family on both paths: Qwen2.5 0.5B Instruct, as GGUF from `Qwen/Qwen2.5-0.5B-Instruct-GGUF`. Three published artifacts are tried in order, so one renamed file cannot disable the fallback. Weights land in the runtime's own browser cache.
- Loaded with `n_gpu_layers: 0` (no WebGPU shim on the fallback path), a 2048-token context, quantized unified KV cache and bounded threads — chosen so the model fits an iPhone's Safari tab instead of being killed.
- The runtime in use is reported everywhere it matters: Settings, the composer status line, `who are you?`, and every answer's audit trail. The CPU path is labelled slower rather than pretending to be the same thing.
- Reproducible vendoring with per-file SHA-256 verification: `scripts/vendor_wllama.py`.

### iOS keyboard, properly

- **The shell is now sized from the layout viewport, not the visual one.** Sizing it from `visualViewport.height` — what 3.1 did — is what made the thread collapse while typing and left the document scrolled after the keyboard closed, producing the blank gutter under the composer.
- The keyboard is tracked as separate state: `--kb-height`, `kb-open`, and a `kb-cramped` mode that gives up the runtime line and shortcut hint when the visible height drops under 460px.
- The document scroll iOS leaves behind is undone after an open→close transition, and only then, so it cannot fight the browser's own scroll restoration on reload.
- Pinch-zoom and a collapsing toolbar are no longer mistaken for a keyboard. The old `vv.scale === 1` guard froze the shell height at a stale value after any zoom.
- Fixed overlays (Settings, Changelog) give the keyboard its space back instead of letting it cover the focused field, and a focused field is scrolled into view once the keyboard settles.
- Events are frame-batched and settled on a debounce — the old handler called `scrollDown()` on every event of a 250 ms animation.
- All fields are 16px on touch devices. Anything smaller makes iOS Safari zoom the page on focus and leave it zoomed, which invalidates every measurement above. Zoom remains available; clamping the viewport scale would not be an accessibility trade worth making.
- Extracted to `web/archiver-viewport.js` as a factory over injected dependencies, with `tests/viewport.js` covering eleven keyboard, zoom and toolbar sequences in Node. This class of bug is a sequence of measurements over time and cannot be caught by reading CSS.

### Thinking on every prompt

- **Every answer now carries a real audit trail**, including `hi`, `2 + 3 * 4` and `help`. It is built from what the pipeline actually did: the matched card and its match strength, the comparison it assembled, the arithmetic it ran, the query it searched and which hosts answered, the backend it chose and why, the prompt it built, and tokens and seconds measured.
- **Generated answers start with one planning line.** The model is asked for a single `Thinking: …` sentence naming the task, the binding constraint and the plan. It is held out of the streamed reply, lifted into the Thought process panel, and the answer follows as normal. A model that ignores the instruction costs one short delay and nothing else.
- This is a deliberate, bounded change from 3.1.1's "no chain-of-thought at all": one visible line of planning per generated answer, disclosed as what it is. It is still not an unbounded reasoning transcript.
- A live "Thinking · …" line names the current step while a response is being produced, then is replaced by the permanent disclosure.
- Route names are translated into plain words — "answered from an honest capability limit", not "answered from local capability path".

### Better output from a small model

- Eight task-specific response approaches (code, writing, planning, comparison, numerical, extraction, explanation, translation) instead of five, each naming what to do rather than what to be.
- Persona rewritten for a 0.5B model: short imperative lines, explicit markdown policy, explicit "never invent a source", explicit stop condition.
- `top_p` 0.9 and a mild presence penalty. Small models loop; this breaks the loop without drifting off-topic.
- **Output cleanup happens inside the stream**, so the deltas still add up to the final answer: filler openers ("Sure!", "As an AI…"), blank-line padding, trailing sign-offs and unclosed code fences. The head is held until it can be judged and the tail until it settles, so nothing already shown to the reader is contradicted.
- Context budget follows the backend (4096 on GPU, 2048 on CPU), and reference notes are dropped before the reader's request is ever truncated.

### Corrections to earlier entries

Reviewing the changelog against the code turned up claims that were not true as shipped. They are corrected here rather than quietly edited out of the old entries:

- **3.1 claimed Data Saver was honored. It was not** — nothing read `navigator.connection.saveData`. It is honored now: generation pauses and the reason is reported.
- **3.1's "persistent instant-only preference" was removed in 3.1.2** and the stored value is migrated away. The 3.1 bullet describes a feature that no longer exists.
- **3.1's 90-second initialization ceiling was raised to eight minutes in 3.1.2**; the WASM path gets twelve, because it compiles an 8 MB module before it can start on the weights.
- **3.1.1's "does not expose a private chain-of-thought transcript" is narrowed by 3.2** to one bounded, visible planning line per generated answer.
- The in-app changelog panel claimed "43 releases" beside ten entries, listed 3.1.1 as latest while `CHANGELOG.md` was already at 3.1.2, and put 2.5 above 2.6. It now counts what it actually renders, is ordered newest-first, and carries 3.2, 3.1.2 and 3.1.

### Tests

- `tests/viewport.js` (new): keyboard open/close, document-scroll restoration, pinch-zoom, toolbar collapse, event batching, field reveal, browsers without `visualViewport`, disposal, and the sub-16px field audit.
- `tests/model.js` extended: WASM backend selection and its load parameters, source retry, CPU/GPU context budgets, thinking-line extraction, output shaping under streaming, and audit trails for six prompt classes.
- `tests/test_api.py` extended: both runtimes served same-origin with the right media type, gzip and immutable caching, engine URLs matching the route table, licenses still reachable, unknown vendor paths 404.

### Limits

- The WASM path is **slower** — single-threaded llama.cpp on a phone, a few tokens per second. It is a real answer, not a fast one, and the UI says which path you are on.
- Neither backend has been benchmarked on a physical iOS device by these tests; the lifecycle is verified with stubs. Model-host availability remains an external dependency, and a GGUF that moves breaks that path until `WASM_SOURCES` is updated.
- Vendoring the WASM runtime adds ~8.5 MB (~2.3 MB gzipped) to the repository. It is served only to devices that need it.
- Nothing here changes the Render Free constraints: no model, no GPU and no inference on the server, and SQLite there is still not durable storage.

## 3.1.2 — 2026-09-26
- Fixed mobile Settings dialog scrolling and tap targets; opening Settings refreshes the runtime status and close/backdrop actions work on touch devices.
- Browser generation is now always enabled (no optional toggle); legacy instant-only preferences are migrated back to enabled. Settings continues to show live ready/loading/unavailable status and retry controls.
- Improved mobile Safari WebGPU adapter selection, including a retry without power hints, and extended the first-load timeout from 3.1's 90 seconds to eight minutes for slower downloads and compilation (the WASM path added in 3.2 allows twelve).
- Added task-specific response guidance for generated answers while keeping hidden chain-of-thought private.


## 3.1.1 — 2026-09-26

### Reliable controls, transparency & Safari polish

- Wire the per-message **retry** action and make model retry start from a clean worker/promise state after timeout, cancellation or a failed initialization.
- Rename the broad Auto AI wording to **browser generation** for its real scope: open-ended writing, explanations, coding and plans. Settings now explicitly confirms whether it is enabled or active in the current browser.
- Add **Restore defaults** with confirmation and a server-side reset that removes retired provider settings without deleting chats or memories.
- Add an accessible **Thought process · answer path** disclosure to responses. It lists the actual tools, sources, saved context and runtime used; it intentionally does not expose a private chain-of-thought transcript.
- Harden iPhone Safari behavior: safe-area is applied once, visual-viewport sizing survives the keyboard, storage failures degrade safely, settings scroll correctly, and unsupported WebGPU falls back to instant tools.

## 3.1 — 2026-09-26

### Built-in AI, designed for Render Free

- Ship the pinned WebLLM 0.2.80 runtime and license with the website. The page and inference worker use the same same-origin asset; there is no inference-library CDN dependency or deployment-time npm step.
- Automatically initialize Qwen2.5 **0.5B** for requests that need generation. Visitors no longer open Settings or manually download/install a model to ask for writing and reasoning. Known-topic answers, calculations, commands, and text extraction stay instant without downloading weights.
- Select the compact f16/f32 variant based on GPU capabilities instead of starting with a 1.5B model or silently selecting a larger catalog entry.
- Fetch model weights, tokenizer, and compiled GPU library directly into the browser from their upstream hosts. Use WebLLM's browser Cache API for reuse, subject to storage availability and eviction. Do not store or run a model on the Render service.
- Serve the bundled runtime precompressed, with versioned immutable caching. Include checksum-verified tooling to reproduce the vendored files.
- Show automatic initialization progress and disclose the first-use transfer (a few hundred MB). Honor Data Saver, offline state, unsupported GPUs, and a persistent instant-only preference.
- Limit initialization to 90 seconds, terminate abandoned workers, prevent repeated failed downloads, and offer retry after a failure. Stop cancels initialization or generation; late initialization cannot answer a cancelled request.
- Set the Render Blueprint to `plan: free`. Document that Render Free cannot attach persistent disks and that SQLite on its ephemeral filesystem is not durable storage.

### Better local comprehension and chat

- Remove server preparation from the response-critical path. Read conversation context from the browser cache and synchronize completed turns in the background.
- Add deterministic topic comparisons, informal-input cleanup, requested sentence/bullet formatting, extractive summaries, explicit action-item extraction, and word counting.
- Correct arithmetic precedence, parentheses, unary signs, powers, and percentages without using `eval`.
- Add 20 focused knowledge cards; report the actual card count rather than a hard-coded claim.
- Restore context for reopened chats, normalize model history roles, bound model context, and clear subjects when starting a new conversation.
- Distinguish deterministic tools, loaded AI, unavailable AI, browser storage, server-backed memory, and search. Capability reporting is not consciousness; no unmeasured Meta AI parity or “10×” quality claim.

### Interface and reliability

- Batch streamed rendering per animation frame. Make Stop functional for search, initialization, and generation.
- Improve touch targets, mobile keyboard sizing, accessible zoom, readable light/dark themes, code overflow, and local transcript export.
- Preserve browser ownership when saving answers/memories and preparing memory recall; respect automatic-memory extraction settings.
- Add offline regression checks, automatic-model lifecycle tests, API ownership/integrity tests, and real-browser tests across five viewport sizes. Import the actual bundled runtime in Chromium; use stub weights/inference for lifecycle tests.

### Limits

- Integrating the runtime does **not** eliminate the initial model download or the device's WebGPU/memory requirements. Cached assets can be evicted. Small models can be wrong.
- Live GPU inference and answer quality have not been benchmarked by the automated tests. Model-host availability remains an external dependency.
- Server chat synchronization is best effort, not a durable offline-delivery queue. Browser caches and transcript exports remain important on a free, ephemeral host.

## 2.6 / 2.6.1 — 2026-09-25

- Expanded Archiver identity detection to avoid unrelated retrieval matches.
- Refined the thinking prompt and updated version labels/header.
- Earlier release notes remain available in the website's changelog panel.
