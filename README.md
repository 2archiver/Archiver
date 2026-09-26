# Archiver 3.1

**An everyday assistant with instant local tools, browser generation for open-ended work, and live web search when you ask.**

No account or model-provider API key. The inference runtime is bundled with the website; model assets are fetched and cached automatically in the browser when needed. No model server, deployment-time npm step, or model weights in Git.

## New in 3.1

- **Local answers do not wait for the server.** Conversation history is read from the browser cache; server synchronization runs in the background, in turn order.
- **Better offline handling:** comparisons between known topics, informal request cleanup, requested sentence/bullet formatting, extractive summaries and action items from pasted notes, and restored conversation context.
- **Corrected calculator:** parentheses, operator precedence, right-associative powers, unary signs, and percentages. No `eval`.
- **Browser generation:** requests that need open-ended writing, explanations, coding or plans initialize a compact 0.5B model when the device supports WebGPU. No Settings detour or manual installation. Inference runs in a browser worker, not on Render; local tools still answer immediately.
- **Transparent answer path:** every new answer can expose a concise “Thought process · answer path” showing which local tools, live sources, saved context and runtime were used. It is an audit trail, not a verbatim private reasoning transcript.
- **Responsive chat:** frame-batched streaming, working Stop and Retry for search/generation, larger touch targets, keyboard-aware layout, accessible zoom, corrected light/dark themes, and local transcript download.
- **Accurate capability reporting:** ask “who are you?” or “are you self-aware?” to see what is actually running, what is stored where, and its limits. This is software introspection, **not consciousness**.
- **Server regression fixes:** completed answers and extracted memories retain their owner, prepare-time recall is scoped to that browser, and the automatic-memory setting is respected.

3.1 is not a claim of Meta AI parity or a measured 10× comprehension improvement. The instant path is deterministic retrieval and text processing. Requests beyond it automatically try a small language model, which broadens the supported tasks but can still make mistakes.

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
On a supported device, Archiver initializes the model and answers the original
request—without a manual download button. Greetings, calculations, stored-topic
answers, and text extraction do not trigger an expensive model download.

- **Bundled runtime:** `web/vendor/web-llm-0.2.80.js`, shared by the page and worker, with its license and checksum-verified reproduction script. It is served precompressed with long-lived versioned caching. No inference-library CDN dependency at runtime.
- **Compact model:** Qwen2.5 **0.5B** Instruct Q4. Archiver chooses f16 or f32 based on the GPU's capabilities; it does not try a larger model.
- **Automatic assets:** the first generative request fetches a few hundred MB of weights, tokenizer, and GPU library directly from the upstream model/library hosts, not through Render. WebLLM uses the browser Cache API to reuse assets when storage permits. Clearing browser data or cache eviction can require another transfer.
- **Device requirements:** WebGPU in a supported browser, HTTPS (or localhost), and sufficient GPU memory. A small download does not imply an equally small runtime memory footprint; some phones will not support it.
- **Graceful fallback:** Data Saver, offline state, no usable GPU, or initialization errors leave instant tools available. Initialization is bounded; failed initialization is isolated and **Try browser generation again** starts a fresh worker. Stop cancels initialization as well as generation.
- **Browser generation:** always enabled and started on demand for open-ended tasks. Settings shows whether it is enabled, loading, active, or unavailable; a retry action is available when initialization fails. The first-use model download requires a supported WebGPU browser and a network connection. On mobile Safari, initialization is allowed up to eight minutes to accommodate slower downloads and compilation.
- **iPhone/Safari:** the interface uses safe-area insets, visual-viewport keyboard sizing, touch-sized controls, storage guards and an instant fallback when iOS Safari does not expose usable WebGPU. Add Archiver to the Home Screen for standalone mode.
- **Bounded context:** this is a small, 4K-context model. Very long generation requests may need splitting. History and notes are bounded rather than pretending to provide unlimited recall.

The actual bundled runtime is imported in Chromium in the browser tests. Weight
loading and generation are stubbed in automated lifecycle tests; those tests
verify integration, not live GPU performance or answer quality. External asset
hosts and browser storage policies remain dependencies.

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

Runs the existing conversation/search smoke checks, 3.1 offline and cancellation regressions, stub browser-generation lifecycle tests, and FastAPI storage/isolation tests. The VM-module test uses Node’s experimental VM modules; no model is downloaded.

Optional browser checks (with the app running): install Playwright in your development environment and run `node tests/browser.js` and `node tests/browser-ai.js`. `BASE_URL` defaults to `http://127.0.0.1:8000`; `CHROMIUM_EXECUTABLE` can select an existing browser. These cover a blocked sync server, five viewport sizes, themes, text escaping, Stop/recovery, local export, real bundled-runtime import, and browser-generation initialization/reuse/cancellation with stub inference. Playwright is not a runtime dependency.

MIT — see `LICENSE`.
