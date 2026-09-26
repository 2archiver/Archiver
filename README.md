# Archiver 3.3

**An everyday assistant with instant local tools, browser generation for open-ended work, and live web search when you ask.**

No account or model-provider API key. Two inference runtimes are bundled with the website — WebGPU where a browser offers it, WebAssembly where it does not — and model assets are fetched and cached automatically in the browser when needed. No model server, deployment-time npm step, or model weights in Git.

## New in 3.3

- **Web answers close with a read of the sources, not a stock paragraph.** 3.2 ended every web answer with a section headed “Additional Thoughts & Lateral Angles” whose text was chosen by keyword bucket — one paragraph for anything mentioning an influencer, one for anything mentioning Render, and a fallback (“ask who pays, what must stay on, and what the default is”) for everything else, Benito Mussolini included. That code is gone. The closing paragraph is now built in `app/take.py` from the retrieved text itself: what kind of thing the subject is comes from the lead sentence (“an Italian politician, journalist, and dictator”), the span of years and the turning-point sentence come from the extracts, agreement and disagreement come from comparing the sources, and a “why” asked of sources that only narrate is called out as unanswered instead of filled with a generic angle. Two subjects cannot produce the same paragraph. There is no heading, no emoji, and no hedging: a claim a source states as the subject’s own conduct is repeated as such, a claim it frames as an allegation is repeated as an allegation, and a yes-or-no whose key word never appears in the sources is answered with that absence.
- **Thinking on literally every prompt.** 3.2 showed a plan line only when the on-device model wrote one. Every route now states its own one-line plan in its own terms — the arithmetic to be evaluated, the command to be run, the pasted text to be worked from, the matched card and its strength, or the web read (“1 source (Wikipedia) describes the Battle of Kursk as an event … lead with the strongest line, then what the sources agree on, then my own read of the 1943 record”). A generated answer whose model skipped its planning line shows the pipeline’s plan instead of nothing, and the panel says whose plan it is.
- **The on-device model gets the read as a draft, not as fact.** For a web-grounded answer the prompt carries the facts and Archiver’s draft read separately, and asks the model to finish with its own specific, committed assessment — sharpening or contradicting the draft, never pasting it.
- **“What do you think?”** after a search answers with the read built for that subject, not one of three rotating stock lines.
- Yes-or-no questions (“was mussolini a socialist”) are recognised as such and restated honestly. Tests: `tests/test_take.py` (new) covers the read against real Wikipedia leads; `tests/model.js` covers the plan line on every route and the grounded prompt.

## New in 3.2

- **Generation works on Safari.** A second runtime, `wllama` 3.6.1 (llama.cpp compiled to WebAssembly), is bundled alongside WebLLM. When the browser has no usable WebGPU adapter — most iOS and iPadOS Safari versions, gated desktop Firefox — the same Qwen2.5 0.5B family runs on the CPU instead. Nothing to enable, install, or download by hand; it is slower, and the interface says so.
- **iOS keyboard behavior rewritten.** The shell is sized from the layout viewport rather than the visual one, so the thread no longer collapses while you type and no blank gutter is left under the composer. Pinch-zoom and a collapsing toolbar are no longer mistaken for a keyboard, overlays make room for it, focused fields are revealed, and every field is 16px on touch so iOS does not zoom the page on focus.
- **Thinking on every prompt.** Each answer carries an audit trail built from what the pipeline actually did — matched card and match strength, comparison, arithmetic, search query and hosts, chosen backend and why, prompt, tokens, seconds — including `hi` and `2 + 3 * 4`. Generated answers also open with one visible `Thinking:` planning line, lifted out of the reply into the disclosure. Route names are rendered in plain words.
- **Better output from a small model.** Eight task-specific response approaches instead of five, a persona written for a 0.5B model, `top_p` and presence-penalty tuning against looping, and output cleanup performed *inside* the stream (filler openers, padding, sign-offs, unclosed fences) so the deltas still add up to the final answer.
- **Data Saver is actually honored.** Generation pauses and reports why. Offline state still pauses it too.

## New in 3.1

- **Local answers do not wait for the server.** Conversation history is read from the browser cache; server synchronization runs in the background, in turn order.
- **Better offline handling:** comparisons between known topics, informal request cleanup, requested sentence/bullet formatting, extractive summaries and action items from pasted notes, and restored conversation context.
- **Corrected calculator:** parentheses, operator precedence, right-associative powers, unary signs, and percentages. No `eval`.
- **Browser generation:** requests that need open-ended writing, explanations, coding or plans initialize a compact 0.5B model when the device supports WebGPU. No Settings detour or manual installation. Inference runs in a browser worker, not on Render; local tools still answer immediately.
- **Transparent answer path:** every new answer can expose a concise “Thought process · answer path” showing which local tools, live sources, saved context and runtime were used. It is an audit trail, not a verbatim private reasoning transcript.
- **Responsive chat:** frame-batched streaming, working Stop and Retry for search/generation, larger touch targets, keyboard-aware layout, accessible zoom, corrected light/dark themes, and local transcript download.
- **Accurate capability reporting:** ask “who are you?” or “are you self-aware?” to see what is actually running, what is stored where, and its limits. This is software introspection, **not consciousness**.
- **Server regression fixes:** completed answers and extracted memories retain their owner, prepare-time recall is scoped to that browser, and the automatic-memory setting is respected.

3.3 is not a claim of Meta AI parity or a measured 10× comprehension improvement. The instant path is deterministic retrieval and text processing; the closing read of a web answer is assembled from the retrieved sentences by rules, not written by a model on the server. Requests beyond it automatically try a small language model, which broadens the supported tasks but can still make mistakes. Earlier releases are described in [CHANGELOG.md](CHANGELOG.md); the in-app changelog panel carries the same recent entries plus older releases, newest-first, and counts what it actually renders.

## Try it

| Request | What happens without a model |
|---|---|
| `Compare Python and JavaScript` | Side-by-side excerpts from local knowledge cards |
| `What is 18% of 250?` | Local calculation: 45 |
| `(2 + 3) * 4` | Local calculation: 20 |
| `Explain photosynthesis in 2 bullet points` | Formats a local answer |
| `one sentence` / `make it shorter` | Extracts a shorter version of the previous reply |
| `Summarize: …your notes…` | Selects key sentences; does not pretend to generate a new summary |
| `Extract action items: …your notes…` | Extracts explicitly signaled tasks; does not invent owners or deadlines |
| `count words: …` | Whitespace-separated word count |
| `teach: question = answer` | Saves a knowledge card in this browser |
| `forget: question` | Removes a taught card (not a memory-bank entry) |
| `help` | Lists commands |

The bundled corpus has 1,329 cards across history, science, language, technology, and everyday topics. `cards` reports the actual count, including taught cards. Coverage and depth vary. Weak matches are labeled; open-ended requests prepare browser generation when supported, rather than substituting an unrelated card. If browser generation cannot start, the response explains the limitation.

**WEB** enables live search. An explicit request such as `search …` also enables search for that turn. Greetings, exact tools, and pasted-text extraction do not need a search request. Search failures fall back to local knowledge. Citations are evidence to inspect, not guarantees of truth.

## Browser generation is part of the website

Just ask, for example, `write a short email asking to reschedule a meeting`.
Archiver initializes a model and answers the original request—without a manual
download button. Greetings, calculations, stored-topic answers, and text
extraction do not trigger an expensive model download.

- **Two bundled runtimes, chosen automatically:** `web/vendor/web-llm-0.2.80.js` when the browser exposes a usable WebGPU adapter, otherwise `web/vendor/wllama-3.6.1.js` plus `wllama-3.6.1.wasm` on the CPU. Both are unmodified upstream builds, shared by the page and worker, served same-origin, precompressed, with long-lived versioned caching, their licenses, and checksum-verified reproduction scripts. The WASM binary is served as `application/wasm` so streaming compilation works. No inference-library CDN dependency at runtime.
- **Compact model:** Qwen2.5 **0.5B** Instruct Q4 on both paths. The GPU path chooses f16 or f32 by adapter capability; the WASM path uses a GGUF of the same model, tried from three upstream artifacts in order so one renamed file cannot disable the fallback. It never tries a larger model.
- **Automatic assets:** the first generative request fetches weights directly from the upstream model/library hosts, not through Render — a few hundred MB on GPU, ~490 MB of GGUF on CPU. Each runtime caches them in browser storage and reuses them when storage permits. Clearing browser data or cache eviction can require another transfer.
- **Device requirements:** HTTPS (or localhost) and enough free memory. The GPU path additionally needs WebGPU and sufficient GPU memory; the WASM path needs neither, only WebAssembly workers, which every current browser has. Without `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` headers, wllama detects that and runs single-threaded — intended here, since COEP would put every cross-origin model fetch behind a CORP requirement.
- **Graceful fallback:** offline, Data Saver, or initialization errors leave instant tools available and say why. A missing or unusable GPU is no longer a dead end — it selects the WASM runtime. Initialization is bounded, failed initialization is isolated, and **Try browser generation again** starts a fresh worker. Stop cancels initialization as well as generation.
- **Browser generation:** always enabled and started on demand for open-ended tasks. Settings shows which runtime is enabled, loading, active, or unavailable; a retry action is available when initialization fails. The first-use model download requires a network connection. Initialization is allowed up to eight minutes on mobile Safari's GPU path and twelve on the WASM path, which compiles an 8 MB module before it can start on the weights.
- **iPhone/Safari:** safe-area insets, layout-viewport shell sizing with the keyboard tracked separately (`--kb-height`, `kb-open`, `kb-cramped`), document-scroll restoration only on a genuine keyboard close, pinch-zoom and toolbar-collapse guards, frame-batched and debounced measurement, overlays that make room for the keyboard, 16px fields on touch, storage guards, and CPU generation when iOS Safari does not expose usable WebGPU. Add Archiver to Home Screen for standalone mode. The logic lives in `web/archiver-viewport.js` and is tested in `tests/viewport.js`.
- **Bounded context:** this is a small model with a 4K context on GPU and 2K on CPU. Very long generation requests may need splitting, and reference notes are dropped before your request is ever truncated. History and notes are bounded rather than pretending to provide unlimited recall.

The bundled runtimes are imported in Chromium in the browser tests. Weight
loading and generation are stubbed in automated lifecycle tests; those tests
verify integration, not live GPU performance or answer quality. Neither backend
has been benchmarked on a physical iOS device, and the GGUF fetch is an external
dependency that cannot be exercised from a sandbox without outbound access to the
model host. External asset hosts and browser storage policies remain dependencies.

### Why this fits a free Render web service

Render serves FastAPI, SQLite-backed APIs, and the website's static files. It does
**not** load an LLM, require a GPU, download model weights at boot/build time,
or proxy hundreds of MB of model assets per visitor. Browser workers do inference;
the runtime is a small, cacheable website asset. `render.yaml` explicitly selects
`plan: free` and keeps the existing Python-only build/start commands.

Bundling all the weights into the Render deployment would not remove the browser
transfer. It would instead increase deploy size and consume Render outbound
bandwidth. Putting inference in the free service would add model/runtime memory
pressure and CPU latency. Neither is required for this architecture.

According to [Render's Free-instance documentation](https://render.com/docs/free),
free services spin down after idle periods, have an ephemeral filesystem, and
cannot attach persistent disks. **SQLite memories on Render Free are therefore
not durable across restarts, spin-downs, or redeployments.** Keep exports; use a
suitable external durable database or a paid service with a persistent disk if
permanent server-side archives are required. This release does not claim to solve
Render Free's storage limits.

Full release notes: [CHANGELOG.md](CHANGELOG.md).

## Privacy and storage — precisely

- **Answers:** calculated/retrieved in the browser, or generated by the browser model. Prompts are not sent to a hosted model inference API.
- **Conversations:** cached in browser storage and synchronized to this app’s server in the background. Sync is best effort, not a durable offline delivery queue. Keep a local transcript export if the server is unavailable.
- **Memory bank:** stored in SQLite **on the app server**, associated with a browser cookie. Relevant cached memories can inform browser generation; instant lookup does not generate personalized answers from memory.
- **Settings:** the explicit **Restore defaults** action confirms before replacing custom server-backed settings; chats and memories are kept.
- **Taught cards:** browser local storage only. Clearing browser data removes them.
- **WEB:** sends search queries through the app server to search services.

The loaded page’s local tools work without a network connection; loading the page from scratch is not an offline/PWA guarantee. There is no service worker.

**No account authentication.** Cookie-associated archives are not a substitute for access control. Use this as a personal app; do not expose sensitive archives publicly. Clearing cookies can lose access to the corresponding server archive.

## Run it

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
./run.sh
```

Open <http://localhost:8000>.

| Environment variable | Default | Purpose |
|---|---|---|
| `PORT` | `8000` | HTTP port |
| `ARCHIVER_DB` | `archiver.db` | Server-side SQLite archive |

For Render Free: build `pip install -r requirements.txt`, start `./run.sh`. The Blueprint selects the free plan; no inference service or extra process is needed. Free instances cannot attach a persistent disk (see the storage warning above). The app binds to `0.0.0.0` and uses relative browser API URLs.

## Tests

Node 18+ and Python 3.10+:

```bash
.venv/bin/pip install pytest
make test
```

Runs the conversation/search smoke checks, offline and cancellation regressions, viewport and iOS-keyboard lifecycle checks (`tests/viewport.js`), stub browser-generation lifecycle tests covering both runtimes, and FastAPI storage/isolation/vendor-serving tests. The VM-module test uses Node's experimental VM modules; no model is downloaded.

Optional browser checks (with the app running): install Playwright in your development environment and run `node tests/browser.js` and `node tests/browser-ai.js`. `BASE_URL` defaults to `http://127.0.0.1:8000`; `CHROMIUM_EXECUTABLE` can select an existing browser. These cover a blocked sync server, five viewport sizes, themes, text escaping, Stop/recovery, local export, real bundled-runtime import, and browser-generation initialization/reuse/cancellation with stub inference. Playwright is not a runtime dependency.

MIT — see `LICENSE`.
