/* Lifecycle tests for both on-device backends, using stub runtimes rather than
   real weights. These verify integration — backend choice, cancellation, retry,
   timeouts, prompt assembly, streaming integrity and the per-turn audit trail —
   not live GPU/CPU performance or answer quality.

   node --experimental-vm-modules tests/model.js */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const GPU_RUNTIME = '/static/vendor/web-llm-0.2.80.js';
const WASM_RUNTIME = '/static/vendor/wllama-3.6.1.js';
const WASM_BINARY = '/static/vendor/wllama-3.6.1.wasm';
const models = ['Qwen3-0.6B-q4f16_1-MLC', 'Qwen3-0.6B-q4f32_1-MLC'];

async function fixture(options = {}) {
  const stats = {
    attempts: 0, imports: [], terminated: 0, interrupted: 0, payload: null,
    events: {}, adapterCalls: 0, wasm: { attempts: 0, urls: [], exited: 0 }
  };
  const chunks = options.chunks || ['A generated ', 'answer.'];
  /* A queue of chunk sets: each inference call takes the next one, so a test can
     make the first pass blank and the retry succeed (5.2's recovery path). */
  const nextChunks = () => {
    if (options.chunkQueue && options.chunkQueue.length) {
      return options.chunkQueue.length > 1 ? options.chunkQueue.shift() : options.chunkQueue[0];
    }
    return chunks;
  };
  const model = {
    interruptGenerate() { stats.interrupted++; },
    chat: { completions: { create: async args => {
      stats.payload = args;
      const set = nextChunks();
      return (async function* () { for (const c of set) yield { choices: [{ delta: { content: c } }] }; })();
    } } }
  };
  class WllamaStub {
    constructor(pathConfig, config) { stats.wasm.pathConfig = pathConfig; stats.wasm.config = config; }
    async loadModelFromUrl(url, params) {
      stats.wasm.attempts++; stats.wasm.urls.push(url); stats.wasm.params = params;
      if (options.wasmFailFirst && stats.wasm.attempts === 1) throw Error('404 from the model host');
      if (options.wasmPending) return new Promise(resolve => { stats.wasm.resolveLoad = resolve; });
      if (params.progressCallback) params.progressCallback({ loaded: 10, total: 20 });
      if (params.progressCallback) params.progressCallback({ loaded: 20, total: 20 });
      stats.wasm.loaded = url;
    }
    async createChatCompletion(opts) {
      stats.wasm.payload = opts;
      for (const c of nextChunks()) opts.onData({ choices: [{ delta: { content: c }, finish_reason: null }] });
    }
    async exit() { stats.wasm.exited++; }
  }
  const storage = new Map(options.disabled ? [['archiver.ai.enabled', '0']] : []);
  if (options.cached) storage.set('archiver.engine.v1', JSON.stringify({ backend: 'wasm', model: 'cached.gguf', ts: Date.now() }));
  const ctx = {
    console, clearTimeout, URL, AbortController, DOMException,
    document: { visibilityState: options.hidden ? 'hidden' : 'visible' },
    addEventListener: (name, fn) => { stats.events[name] = fn; },
    setTimeout: (fn, ms) => setTimeout(fn, options.timeout && ms >= 8 * 60 * 1000 ? 15 : ms),
    // Present unless the test says this browser has no WebAssembly at all.
    // 4.3: the engine validates a minimal module (4.2's Edge-strict-mode guard),
    // so the stub must implement validate as well as instantiate.
    WebAssembly: options.noWasm ? undefined : { instantiate: async () => ({}), validate: () => true },
    navigator: {
      onLine: options.offline ? false : true,
      userAgent: options.ua || 'Mozilla/5.0 Chrome/130.0 Safari/537.36',
      hardwareConcurrency: 8,
      connection: { saveData: !!options.saveData },
      gpu: options.noGPU ? undefined : { requestAdapter: async hint => {
        stats.adapterCalls++;
        if (options.rejectAdapterHint && hint) throw Error('unsupported power preference');
        if (options.noAdapter) return null;
        // 4.3: the engine's capability check needs realistic limits (4.2) and a
        // working 64 MiB canary allocation, or it routes to WASM by design.
        const mib = options.tinyLimits ? 64 : 256;
        return {
          features: new Set(options.f32 ? [] : ['shader-f16']),
          limits: { maxStorageBufferBindingSize: mib * 1024 * 1024, maxBufferSize: mib * 1024 * 1024 },
          requestDevice: async () => ({
            pushErrorScope() {}, popErrorScope: async () => null,
            createBuffer: () => ({ destroy() {} }), destroy() {}
          })
        };
      } }
    },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    Worker: class { terminate() { stats.terminated++; } },
    // Throws unless a test installs a search stub on stats.fetch.
    fetch: (...args) => { if (stats.fetch) return stats.fetch(...args); throw Error('unexpected fetch'); }
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  const gpuStub = new vm.SyntheticModule(['prebuiltAppConfig', 'CreateWebWorkerMLCEngine'], function () {
    this.setExport('prebuiltAppConfig', { model_list: models.map(model_id => ({ model_id })) });
    this.setExport('CreateWebWorkerMLCEngine', async (worker, id, config) => {
      stats.attempts++; stats.id = id; stats.config = config;
      if (options.failOnce && stats.attempts === 1) throw Error('simulated network failure');
      if (options.pending || options.timeout) return new Promise(resolve => { stats.resolveLoad = () => resolve(model); });
      config.initProgressCallback({ progress: 1, text: 'Loaded stub' });
      return model;
    });
  }, { context: ctx });
  const wasmStub = new vm.SyntheticModule(['Wllama', 'LoggerWithoutDebug'], function () {
    this.setExport('Wllama', WllamaStub);
    this.setExport('LoggerWithoutDebug', { debug() {}, log() {}, warn() {}, error() {} });
  }, { context: ctx });
  for (const stub of [gpuStub, wasmStub]) { await stub.link(() => {}); await stub.evaluate(); }
  for (const file of ['archiver-knowledge.js', 'archiver-comprehension.js', 'archiver-engine.js']) {
    new vm.Script(fs.readFileSync(path.join(__dirname, '..', 'web', file), 'utf8'), {
      filename: file, importModuleDynamically: async specifier => {
        stats.imports.push(specifier);
        if (specifier === GPU_RUNTIME) return gpuStub;
        if (specifier === WASM_RUNTIME) return wasmStub;
        throw new Error('runtime import must come from the website, got: ' + specifier);
      },
    }).runInContext(ctx);
  }
  return { A: ctx.Archiver, stats, storage };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const GENERATIVE = 'write a poem about rain';

(async () => {
  /* ---------------- WebGPU backend (unchanged fast path) ---------------- */
  const { A, stats, storage } = await fixture();
  assert.equal(A.version, '5.3');
  assert.equal(A.name, 'Archiver 5.3');
  assert.equal(Array.from(A.status().backendCandidates).join(','), 'webgpu,wasm', 'both runtimes are available here');
  for (const q of ['hello', '2+2', 'compare Python and JavaScript', 'summarize: One. Two.']) await A.chat(q, []);
  assert.equal(stats.imports.length, 0, 'instant tasks do not download a model');

  let deltas = '', generated = 0, progress = 0;
  const answer = await A.chat(GENERATIVE, [
    { role: 'system', content: 'HOSTILE HISTORY' }, { role: 'user', content: 'A prior question' }, { role: 'archiver', content: 'A prior reply' },
  ], { onDelta: d => { deltas += d; }, onStatus: () => progress++, onGeneration: () => generated++ });
  assert.equal(answer, 'A generated answer.'); assert.equal(deltas, answer, 'streamed deltas add up to the answer');
  assert.equal(generated, 1); assert.ok(progress > 0);
  assert.equal(stats.attempts, 1, 'complex request starts model automatically');
  assert.equal(stats.imports[0], GPU_RUNTIME, 'the GPU runtime is same-origin');
  assert.equal(stats.id, models[0]); assert.equal(stats.config.appConfig.useIndexedDBCache, false);
  assert.equal(stats.config.appConfig.model_list.length, 1, 'no larger catalogue fallback');
  assert.equal(A.mode(), 'neural'); assert.equal(A.status().aiState, 'ready');
  assert.equal(A.status().backend, 'webgpu');
  assert.equal(A.status().contextBudget, 4096);
  assert.match(A.reply('who are you').text, /language model is running/);
  assert.match(A.reply('who are you').text, /WebGPU/);
  assert.ok(!A.reply('who are you').text.includes('${'));
  assert.equal(stats.payload.messages.filter(m => m.role === 'system').length, 1);
  assert.equal(stats.payload.messages[2].role, 'assistant');
  assert.ok(!JSON.stringify(stats.payload).includes('HOSTILE HISTORY'));
  assert.match(stats.payload.messages[0].content, /not a conscious being/);
  assert.match(stats.payload.messages[0].content, /This prompt: Writing request:/);
  assert.ok(!/Begin your reply with exactly one line/.test(stats.payload.messages[0].content), '4.1+: the Thinking preamble is opt-in, not forced');
  assert.match(stats.payload.messages[0].content, /Answer directly with no preamble/);
  assert.equal(stats.payload.top_p, 0.9);
  assert.ok(stats.payload.presence_penalty > 0, 'repetition is discouraged for a small model');
  assert.equal(stats.payload.extra_body && stats.payload.extra_body.enable_thinking, false,
    '5.2 fix: the GPU path disables Qwen 3\'s hidden thinking pass so it cannot eat the whole budget and return a blank answer');
  assert.match(await A.chat('write ' + '界'.repeat(4000), []), /too long/);
  await A.chat('write another poem', []);
  assert.equal(stats.attempts, 1, 'already-loaded engine reused');
  const stop = new AbortController();
  await assert.rejects(A.chat('write a second poem', [], { signal: stop.signal, onDelta: () => stop.abort() }), { name: 'AbortError' });
  assert.equal(stats.interrupted, 1);
  A.setAIEnabled(false);
  assert.equal(A.mode(), 'neural', 'the compatibility toggle cannot disable browser generation');
  assert.equal(storage.get('archiver.ai.enabled'), '1');
  assert.equal(stats.terminated, 0, 'an active engine remains available');

  /* ---------------- thinking is opt-in since 4.1 ---------------- */
  const thought = await fixture({ chunks: [
    'Thinking: The user wants a short poem about rain, so I will write four plain lines.',
    '\n\nRain falls', ' softly.'
  ] });
  let seen = '';
  const poem = await thought.A.chat(GENERATIVE, [], { thinking: true, onDelta: d => { seen += d; } });
  assert.equal(poem, 'Rain falls softly.', 'the planning line is lifted out of the visible answer');
  assert.equal(seen, poem, 'and never streamed to the reader either');
  assert.match(thought.A.trace().thinking, /four plain lines/);
  assert.equal(thought.A.trace().planBy, 'model');
  assert.match(thought.A.trace().steps.join(' | '), /planned in one line before answering/);
  assert.match(thought.stats.payload.messages[0].content, /Begin your reply with exactly one line of the form: Thinking:/,
    'thinking:true re-enables the planning-line instruction');
  assert.equal(thought.stats.payload.extra_body && thought.stats.payload.extra_body.enable_thinking, true,
    'thinking:true also reaches the GPU runtime as extra_body.enable_thinking');

  /* 3.3: a model that skips its planning line does not leave the panel empty —
     the pipeline's own plan (approach, evidence held, backend) stands in. */
  const noThinking = await fixture({ chunks: ['Just an answer, no plan line.'] });
  const plain = await noThinking.A.chat(GENERATIVE, [], { thinking: true });
  assert.equal(plain, 'Just an answer, no plan line.', 'a model that ignores the instruction still answers');
  assert.match(noThinking.A.trace().thinking, /^writing request: produce original wording/);
  assert.match(noThinking.A.trace().thinking, /Generate on the GPU path/);
  assert.equal(noThinking.A.trace().planBy, 'pipeline');
  assert.match(noThinking.A.trace().steps.join(' | '), /did not write a separate planning line.*pipeline’s own/);

  const optOut = await fixture({ chunks: ['Thinking: hidden\n\nAnswer.'] });
  assert.equal(await optOut.A.chat(GENERATIVE, [], { thinking: false }), 'Thinking: hidden\n\nAnswer.',
    'with thinking off the text is passed through untouched');
  assert.ok(!/Begin your reply with exactly one line/.test(optOut.stats.payload.messages[0].content));

  /* Output shaping keeps the streamed text identical to the returned text. */
  const messy = await fixture({ chunks: ['Sure! ', 'Here is the answer.\n\n\n\n', 'More text.', ' I hope this helps!'] });
  let messySeen = '';
  const cleaned = await messy.A.chat(GENERATIVE, [], { onDelta: d => { messySeen += d; } });
  assert.equal(cleaned, messySeen, 'cleaning happens inside the stream');
  assert.ok(!/^Sure!/i.test(cleaned), 'filler opener removed');
  assert.ok(!/\n{3,}/.test(cleaned), 'blank-line padding collapsed');
  assert.ok(!/i hope this helps/i.test(cleaned), 'sign-off removed');

  const fenced = await fixture({ chunks: ['Here is code:\n```js\nconst a = 1;'] });
  const closed = await fenced.A.chat('write a function', []);
  assert.equal((closed.match(/```/g) || []).length, 2, 'an unclosed code fence is closed');

  /* Qwen 3 <think>...</think> blocks are stripped from the visible answer and
     lifted into the Thought process panel. */
  const qwenThink = await fixture({ chunks: ['<think>\nPlan the haiku carefully.\n</think>\n\n', 'Silent winter snow\n', 'Blankets every quiet branch.'] });
  let qwenSeen = '';
  const qwenReply = await qwenThink.A.chat(GENERATIVE, [], { onDelta: d => { qwenSeen += d; } });
  assert.equal(qwenReply, 'Silent winter snow\nBlankets every quiet branch.', '<think> block stripped from visible output');
  assert.equal(qwenSeen, qwenReply, '<think> block never streamed to the reader');
  assert.match(qwenThink.A.trace().thinking, /Plan the haiku carefully/);
  assert.equal(qwenThink.A.trace().planBy, 'model');

  /* Trailing sentence repetition loop is suppressed on small models. */
  const repeated = await fixture({ chunks: ['Photosynthesis converts light into chemical energy. ', 'It happens inside chloroplasts. ', 'It happens inside chloroplasts.'] });
  let repSeen = '';
  const repReply = await repeated.A.chat(GENERATIVE, [], { onDelta: d => { repSeen += d; } });
  assert.equal(repReply, 'Photosynthesis converts light into chemical energy. It happens inside chloroplasts.', 'duplicate trailing sentence stripped');
  assert.equal(repSeen, repReply, 'streamed text matches deduplicated answer');

  /* ---------------- the audit trail covers every prompt ---------------- */
  const audit = await fixture();
  const cases = [
    ['hi', /conversation|Answered as conversation/],
    ['2 + 3 * 4', /deterministic local tool/],
    ['help', /command/],
    ['compare Python and JavaScript', /comparison/i],
    ['what is mitosis', /local knowledge card|No local card/],
    ['summarize: One. Two. Three.', /pasted-text work/],
  ];
  const plans = [];
  for (const [q, want] of cases) {
    await audit.A.chat(q, []);
    const tr = audit.A.trace();
    assert.ok(tr && tr.steps.length, `every prompt leaves an audit trail: ${q}`);
    assert.ok(tr.route, `every prompt records a route: ${q}`);
    assert.ok(tr.runtime, `every prompt records a runtime: ${q}`);
    assert.match(tr.steps.join(' | '), want, `the trail for "${q}" says what actually happened`);
    assert.match(tr.note, /Not a transcript of private reasoning/);
    /* 3.3: thinking on literally every prompt — a plan line for each route,
       stated in that route's own terms rather than one shared sentence. */
    assert.ok(tr.thinking && tr.thinking.length > 20, `every prompt states a plan: ${q} -> ${JSON.stringify(tr.thinking)}`);
    assert.equal(tr.planBy, 'pipeline', `an instant answer's plan is the pipeline's own: ${q}`);
    plans.push(tr.thinking);
  }
  assert.equal(new Set(plans).size, plans.length, 'the plans differ per route instead of being one recycled line');
  assert.match(plans[1], /2 \+ 3 \* 4.*operator precedence/, 'the arithmetic plan names the expression');
  assert.match(plans[2], /help/, 'the command plan names the command');
  assert.match(plans[5], /supplied text/, 'the pasted-text plan says it works only from the supplied text');

  /* ---------------- a web-grounded generated answer ---------------- */
  const grounded = await fixture({ chunks: ['Thinking: Answer from the two sources, then close with my own read.', '\n\nMussolini was a dictator. The read: the 1922 appointment is the hinge.'] });
  const REPORT = {
    reading: 'who benito mussolini is',
    headline: 'Benito Mussolini was an Italian politician, journalist, and dictator who led the Kingdom of Italy from 1922 until 1943.',
    voice: 'He founded fascism in 1919.\n\nRead Mussolini as an Italian politician, journalist, and dictator. The record here runs 1919–1945.',
    take: 'Read Mussolini as an Italian politician, journalist, and dictator. The record here runs 1919–1945.',
    plan: 'Read the question as who benito mussolini is; 1 source (Wikipedia) describes Mussolini as a person; lead with the strongest line, then my own read of the 1919–1945 record.',
    confidence: 'one source', sources: 1, consensus: ['National Fascist Party']
  };
  grounded.stats.fetch = async () => ({ ok: true, json: async () => ({
    results: [{ title: 'Benito Mussolini', extract: 'x', url: 'https://en.wikipedia.org/wiki/Benito_Mussolini', source: 'Wikipedia', confidence: 0.9, quote: REPORT.headline }],
    report: REPORT, confidence: 'single', corrected: '', query: 'benito mussolini'
  }) });
  /* Without a model: the read closes the answer, once, with no heading. */
  const readBack = await grounded.A.chat('who is benito mussolini', [], { search: true });
  assert.ok(readBack.includes(REPORT.take), 'the read is part of the answer body');
  assert.equal(readBack.split(REPORT.take).length - 1, 1, 'and appears exactly once');
  assert.ok(!/Additional Thoughts|Lateral Angles|💡/.test(readBack), 'no 3.2 heading, no emoji');
  assert.ok(readBack.indexOf(REPORT.take) < readBack.indexOf('**Sources**'), 'the read precedes the source list');
  assert.equal(grounded.A.trace().thinking, REPORT.plan, 'the search route shows the server’s plan as its thinking');
  assert.equal(grounded.A.trace().planBy, 'pipeline');
  /* "what do you think?" answers from that read, not a rotating stock line. */
  const opinion = await grounded.A.chat('what do you think?', []);
  assert.match(opinion, /Read Mussolini as an Italian politician/, 'the opinion follow-up reuses the grounded read');
  assert.ok(!/holds up, with one caveat|cleaner story than the evidence|which is not the same thing as settled/.test(opinion), 'and not the 3.2 stock lines');

  await grounded.A.load();
  const gOut = await grounded.A.chat('who is benito mussolini', [], { search: true, thinking: true });
  const gSys = grounded.stats.payload.messages[0].content;
  assert.match(gSys, /my draft read:\s+Read Mussolini as an Italian politician/, 'the model receives the server read as a draft');
  assert.match(gSys, /facts they carry: He founded fascism in 1919\.\s*\n/, 'the facts are passed without the draft read glued on');
  assert.match(gSys, /never paste it/, 'and is told what to do with the draft');
  assert.match(gSys, /finish with one short paragraph of your own assessment/, 'a grounded answer must close with the model’s own committed read');
  assert.ok(!/Additional Thoughts|Lateral Angles/.test(gSys + gOut), 'the 3.2 heading is gone from prompt and answer');
  assert.match(grounded.A.trace().thinking, /Answer from the two sources/, 'the model’s own plan line wins when it writes one');
  const gInterp = grounded.A.interpretation();
  assert.equal(gInterp.take, REPORT.take);
  assert.equal(gInterp.plan, REPORT.plan);
  assert.ok(!('additional_thoughts' in gInterp), 'the old field is not carried forward');
  await audit.A.chat(GENERATIVE, []);
  const genTrace = audit.A.trace();
  assert.equal(genTrace.route, 'generated');
  assert.equal(genTrace.backend, 'webgpu');
  assert.ok(genTrace.budget.context === 4096 && genTrace.budget.maxTokens > 0);
  assert.ok(genTrace.output.ms >= 0 && genTrace.output.tokens > 0);
  assert.match(genTrace.steps.join(' | '), /tokens\/second/);
  assert.match(genTrace.steps.join(' | '), /Built the prompt: 1 system block/);

  /* ---------------- WASM backend: what Safari actually gets ---------------- */
  for (const config of [{ noGPU: true }, { noAdapter: true }, { rejectAdapterHint: true, noAdapter: true }]) {
    const w = await fixture(config);
    let wd = '';
    const out = await w.A.chat(GENERATIVE, [], { onDelta: d => { wd += d; } });
    assert.equal(out, 'A generated answer.', `generation still works for ${JSON.stringify(config)}`);
    assert.equal(wd, out);
    assert.deepEqual(w.stats.imports, [WASM_RUNTIME], 'only the WASM runtime is fetched');
    assert.equal(w.stats.attempts, 0, 'the GPU runtime is never imported on this device');
    assert.equal(w.A.mode(), 'neural');
    assert.equal(w.A.status().backend, 'wasm');
    assert.equal(w.A.status().contextBudget, 2048, 'a phone-sized context, not a pretend-unlimited one');
    assert.equal(w.stats.wasm.pathConfig.default, WASM_BINARY, 'the WASM binary is same-origin');
    assert.equal(w.stats.wasm.params.n_gpu_layers, 0, 'CPU-only: no WebGPU shim on the fallback path');
    assert.ok(w.stats.wasm.params.n_ctx === 2048);
    assert.ok([512, 1024].includes(w.stats.wasm.params.n_batch), 'Safari WASM batch size tuned for faster prefill (5.2: 512 desktop / 1024 mobile)');
    assert.ok(w.stats.wasm.params.n_threads >= 1 && w.stats.wasm.params.n_threads <= 4);
    assert.equal(w.stats.wasm.urls[0], w.A.WASM_SOURCES[0], 'weights come from the publisher, automatically');
    assert.match(w.A.WASM_SOURCES[0], /Qwen3-0\.6B-Q4_0\.gguf/, 'Q4_0 prioritized first for fast Safari CPU SIMD decoding');
    assert.match(w.stats.wasm.payload.messages[0].content, /\/no_think/, 'Safari CPU path appends /no_think when thinking is not requested');
    assert.match(w.A.reply('who are you').text, /WebAssembly/);
    assert.match(w.A.trace().steps.join(' | '), /Safari\/CPU prompt compaction/, 'the trail notes Safari CPU prompt compaction');
    assert.match(w.A.trace().steps.join(' | '), /WebAssembly/, 'the trail says which runtime answered');
    assert.equal(w.A.trace().runtime, 'on-device cpu');
    assert.equal(w.stats.wasm.payload.stream, true);
    assert.equal(w.stats.wasm.payload.max_tokens <= 1024, true);
  }

  /* A missing artifact must not disable the fallback. */
  const retrySource = await fixture({ noGPU: true, wasmFailFirst: true });
  const retried = await retrySource.A.chat(GENERATIVE, []);
  assert.equal(retried, 'A generated answer.');
  assert.equal(retrySource.stats.wasm.urls.length, 2, 'the next published source is tried');
  assert.equal(retrySource.stats.wasm.urls[1], retrySource.A.WASM_SOURCES[1]);
  assert.match(retrySource.A.trace().steps.join(' | '), /Model source unavailable/);

  /* Safari cache recovery: if a cached WASM model fails on first open (e.g.
     corrupted OPFS entry), it clears the stale cache and retries the same URL
     with useCache: false before moving on. Also stale Qwen2.5 cache entries
     are automatically invalidated. */
  const staleCache = await fixture({ noGPU: true });
  staleCache.storage.set('archiver.engine.v1', JSON.stringify({
    model: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', backend: 'wasm', f16: false, ts: Date.now()
  }));
  assert.equal(staleCache.A.wasReadyBefore(), false, 'obsolete Qwen2.5 cache entry is invalidated');
  assert.equal(staleCache.storage.has('archiver.engine.v1'), false, 'stale entry removed from localStorage');
  const corruptedCache = await fixture({ noGPU: true, cached: true, wasmFailFirst: true });
  assert.equal(corruptedCache.A.wasReadyBefore(), true);
  assert.equal(await corruptedCache.A.chat(GENERATIVE, []), 'A generated answer.');
  assert.equal(corruptedCache.stats.wasm.urls[0], corruptedCache.A.WASM_SOURCES[0]);
  assert.equal(corruptedCache.stats.wasm.urls[1], corruptedCache.A.WASM_SOURCES[0], 'same URL retried with useCache:false after cache error');
  assert.equal(corruptedCache.stats.wasm.params.useCache, false, 'useCache:false passed on recovery retry');

  /* Cancellation and timeout on the WASM path. */
  const wasmCancel = await fixture({ noGPU: true, wasmPending: true });
  const cancelCtl = new AbortController();
  const waiting = wasmCancel.A.chat(GENERATIVE, [], { signal: cancelCtl.signal });
  while (!wasmCancel.stats.wasm.resolveLoad) await tick();
  cancelCtl.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(wasmCancel.A.status().loading, false);
  assert.equal(wasmCancel.A.mode(), 'grounded');
  wasmCancel.stats.wasm.resolveLoad(); await tick();
  assert.equal(wasmCancel.A.mode(), 'grounded', 'a late WASM load cannot activate a cancelled backend');
  assert.equal(await wasmCancel.A.chat('2+2', []), "That's 4.", 'instant tools survive a cancelled load');

  const wasmRetry = await fixture({ noGPU: true, wasmFailFirst: true });
  await wasmRetry.A.chat(GENERATIVE, []);
  await wasmRetry.A.retryAI();
  assert.equal(wasmRetry.A.mode(), 'neural', 'retry re-probes the device and reloads');
  assert.ok(wasmRetry.stats.wasm.exited > 0, 'the abandoned runtime is released');

  /* ---------------- things that must never download ---------------- */
  for (const config of [{ offline: true }, { saveData: true }, { noGPU: true, noWasm: true }]) {
    const f = await fixture(config);
    const response = await f.A.chat(GENERATIVE, []);
    assert.equal(f.stats.imports.length, 0, `no download for ${JSON.stringify(config)}`);
    assert.ok(response.length); assert.equal(f.A.mode(), 'grounded');
    assert.ok(f.A.status().aiReason, `the reason is reported for ${JSON.stringify(config)}`);
  }
  const saver = await fixture({ saveData: true });
  assert.match(saver.A.status().aiReason, /Data Saver/);

  const f32 = await fixture({ f32: true });
  await f32.A.chat(GENERATIVE, []); assert.equal(f32.stats.id, models[1]);
  const safariAdapter = await fixture({ rejectAdapterHint: true });
  await safariAdapter.A.chat(GENERATIVE, []);
  assert.equal(safariAdapter.stats.adapterCalls, 2, 'Safari adapter is retried without powerPreference');
  assert.equal(safariAdapter.A.mode(), 'neural');
  assert.equal(safariAdapter.A.status().backend, 'webgpu');
  const migratedPreference = await fixture({ disabled: true });
  assert.equal(migratedPreference.A.status().aiEnabled, true);
  assert.equal(migratedPreference.storage.get('archiver.ai.enabled'), '1', 'legacy instant-only preference is migrated');
  const failure = await fixture({ failOnce: true });
  await failure.A.chat(GENERATIVE, []); await failure.A.chat('write another', []);
  assert.equal(failure.stats.attempts, 1, 'failure does not cause a download loop');
  assert.equal(failure.A.status().aiState, 'error');
  await failure.A.retryAI(); assert.equal(failure.A.mode(), 'neural');

  const pending = await fixture({ pending: true });
  const cancel = new AbortController();
  const pendingWait = pending.A.chat(GENERATIVE, [], { signal: cancel.signal });
  while (!pending.stats.resolveLoad) await tick();
  cancel.abort(); await assert.rejects(pendingWait, { name: 'AbortError' });
  assert.equal(pending.A.status().loading, false); assert.ok(pending.stats.terminated > 0);
  pending.stats.resolveLoad(); await tick();
  assert.equal(pending.A.mode(), 'grounded', 'late completion cannot activate cancelled engine');
  assert.equal(await pending.A.chat('2+2', []), "That's 4.");

  const togglePending = await fixture({ pending: true });
  const firstToggle = togglePending.A.chat(GENERATIVE, []);
  while (!togglePending.stats.resolveLoad) await tick();
  togglePending.A.setAIEnabled(false);
  assert.equal(togglePending.A.status().aiEnabled, true, 'generation remains enabled during initialization');
  togglePending.stats.resolveLoad();
  await firstToggle;
  assert.equal(togglePending.A.status().aiState, 'ready');
  assert.equal(togglePending.stats.attempts, 1, 'no disable/reload cycle');

  const timeout = await fixture({ timeout: true });
  const fallback = await timeout.A.chat(GENERATIVE, []);
  assert.match(fallback, /timed out/); assert.equal(timeout.A.status().loading, false);
  assert.ok(timeout.stats.terminated > 0);

  /* 5.2 Safari: first-visit defers, cached warms on load. On-demand works in both. */
  for (const ua of [
    'Mozilla/5.0 (Macintosh) Version/18.0 Safari/605.1.15',
    'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/130 Mobile Safari/604.1',
    'Mozilla/5.0 (iPad) AppleWebKit/605.1.15 FxiOS/130 Mobile Safari/605.1.15'
  ]) {
    // First visit: no warm
    const safariCold = await fixture({ ua, cached: false, noGPU: true });
    assert.equal(await safariCold.A.warm(), false, 'first-visit Safari must not warm during navigation');
    assert.equal(safariCold.stats.imports.length, 0, 'opening Safari cold must not load blob workers/weights');
    await safariCold.A.chat(GENERATIVE, []);
    assert.equal(safariCold.A.mode(), 'neural', 'on-demand generation remains enabled');
    safariCold.stats.events.pagehide();
    assert.equal(safariCold.A.mode(), 'grounded', 'do not restore detached runtimes from bfcache');
    assert.ok(safariCold.stats.wasm.exited > 0);
    await safariCold.A.chat(GENERATIVE, []);
    assert.equal(safariCold.A.mode(), 'neural', 'restored page can initialize fresh workers');

    // Cached visit: 5.2 warms on load
    const safariCached = await fixture({ ua, cached: true, noGPU: true });
    assert.equal(await safariCached.A.warm(), true, 'cached Safari should warm on page load in 5.2');
    assert.ok(safariCached.stats.imports.length > 0, 'cached Safari loads from cache');
    safariCached.stats.events.pagehide();
    assert.equal(safariCached.A.mode(), 'grounded', 'do not restore detached runtimes from bfcache');
    assert.ok(safariCached.stats.wasm.exited > 0);
    await safariCached.A.chat(GENERATIVE, []);
    assert.equal(safariCached.A.mode(), 'neural', 'restored page can initialize fresh workers');
  }
  /* 5.2 — iPhone warms on intent and also on load when cached. */
  const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  const iphone = await fixture({ ua: IPHONE_UA, cached: true, noGPU: true });
  assert.equal(await iphone.A.warm(), true, 'cached Safari tab warms on load in 5.2');
  assert.ok(iphone.stats.imports.length > 0, 'and fetches from cache');

  const iphonePrepare = await fixture({ ua: IPHONE_UA, cached: true, noGPU: true });
  assert.equal(await iphonePrepare.A.prepare('2+2'), false, 'a calculation needs no model');
  assert.equal(await iphonePrepare.A.prepare('hi'), false, 'a greeting needs no model');
  assert.equal(iphonePrepare.stats.imports.length, 0, 'still nothing fetched for instant tasks');
  assert.equal(await iphonePrepare.A.prepare('Compare the causes of the first world war in detail'), true,
    'an open-ended question starts the already-cached load');
  assert.ok(iphonePrepare.stats.imports.length > 0, 'the runtime comes from our own origin');
  assert.equal(iphonePrepare.A.mode(), 'neural', 'and the model ends up serving');
  /* A first visit on the same device still waits: no surprise download. */
  const firstVisit = await fixture({ ua: IPHONE_UA, noGPU: true });
  assert.equal(await firstVisit.A.prepare('Compare the causes of the first world war in detail'), false,
    'a first visit does not download on a metered connection');
  assert.equal(firstVisit.stats.imports.length, 0);
  const hidden = await fixture({ hidden: true });
  assert.equal(await hidden.A.warm(), false);
  assert.equal(hidden.stats.imports.length, 0);
  const chromeWarm = await fixture();
  assert.equal(await chromeWarm.A.warm(), true);
  const abandoned = await fixture({ noGPU: true, wasmPending: true });
  const abandonedLoad = abandoned.A.load();
  while (!abandoned.stats.wasm.resolveLoad) await tick();
  abandoned.stats.events.pagehide();
  await assert.rejects(abandonedLoad, { name: 'AbortError' });
  assert.ok(abandoned.stats.wasm.exited > 0, 'release the pending instance, not only global wasm');
  abandoned.stats.wasm.resolveLoad(); await tick();
  assert.equal(abandoned.A.mode(), 'grounded');

  /* Evidence failures must not turn into generated guesses, with/without AI ready.
     4.3: since 4.1 only time-sensitive/source-requested questions fail closed;
     ordinary questions degrade to labelled-unverified or local answers. */
  const source = { title: 'Reference', url: 'https://example.org/reference', source: 'Example', extract: 'The object has two moons.' };
  for (const loaded of [false, true]) {
    for (const results of [[], [{ ...source, url: 'javascript:alert(1)' }], [{ ...source, extract: '' }]]) {
      const empty = await fixture();
      if (loaded) await empty.A.load();
      empty.stats.fetch = async () => ({ ok: true, json: async () => ({ results }) });
      let visible = '';
      const answer = await empty.A.chat('search the latest lunar discovery', [], { onDelta: d => visible += d });
      assert.match(answer, /cannot verify/);
      assert.equal(visible, answer);
      assert.equal(empty.stats.payload, null, 'no inference after an empty/invalid search');
      assert.equal(empty.A.trace().route, 'insufficient-evidence');
    }
  }
  /* Ordinary explicit searches degrade instead of refusing: a loaded model
     generates with the unverified flag in its prompt; without a model the
     local corpus answers. Neither path guesses dressed as verified. */
  for (const loaded of [false, true]) {
    const empty = await fixture();
    if (loaded) await empty.A.load();
    empty.stats.fetch = async () => ({ ok: true, json: async () => ({ results: [] }) });
    const answer = await empty.A.chat('search for the object', []);
    if (loaded) {
      assert.match(empty.stats.payload.messages[0].content, /UNVERIFIED ANSWER/,
        'empty search still generates, but flagged unverified in the prompt');
    } else {
      assert.ok(!/cannot verify/.test(answer), 'stable questions fall back to local knowledge, not a refusal');
      assert.equal(empty.stats.payload, null);
    }
  }
  const outage = await fixture();
  await outage.A.load();
  outage.stats.fetch = async () => { throw Error('offline'); };
  assert.match(await outage.A.chat('search the latest lunar discovery', []), /cannot verify/);
  assert.equal(outage.stats.payload, null);
  for (const q of ['What is the current population of Zedland?', 'Cite sources for the population of Zedland']) {
    const fresh = await fixture();
    await fresh.A.load();
    assert.match(await fresh.A.chat(q, []), /Turn on WEB/);
    assert.equal(fresh.stats.payload, null);
  }

  /* Withhold fabricated IDs/URLs before ANY generated answer text is emitted. */
  for (const chunks of [
    ['There are two moons according to [', '9].'],
    ['Read https://invented.example/', 'fake-study for proof.'],
    ['The result is in [C99].']
  ]) {
    const bad = await fixture({ chunks });
    await bad.A.load();
    bad.stats.fetch = async () => ({ ok: true, json: async () => ({ results: [source] }) });
    let visible = '';
    const answer = await bad.A.chat('Explain the object', [], { search: true, onDelta: d => visible += d });
    assert.match(answer, /withheld/);
    assert.equal(visible, answer);
    assert.ok(!visible.includes('invented.example'));
    assert.equal(bad.A.trace().route, 'citation-rejected');
  }
  const good = await fixture({ chunks: ['There are two moons [1].'] });
  await good.A.load();
  good.stats.fetch = async () => ({ ok: true, json: async () => ({ results: [source] }) });
  assert.equal(await good.A.chat('Explain the object', [], { search: true }), 'There are two moons [1].');
  assert.match(good.stats.payload.messages[0].content, /\[1\] Reference/);
  assert.equal(good.stats.payload.temperature, 0.15);
  assert.equal(good.A.trace().citationCheck, 'passed-membership-only');
  const fabricatedOffline = await fixture({ chunks: ['A study confirms this [1].'] });
  await fabricatedOffline.A.load();
  assert.match(await fabricatedOffline.A.chat('Explain the object', []), /withheld/);
  /* 5.2 — an empty model reply is recovered, never rendered as a blank bubble. */
  for (const chunks of [['   '], ['\n\n\n'], ['…'], []]) {
    const blank = await fixture({ chunks });
    await blank.A.load();
    let visible = '';
    const answer = await blank.A.chat(GENERATIVE, [], { onDelta: d => visible += d });
    assert.ok(answer.trim().length > 20, 'an empty model reply still produces text');
    assert.match(answer, /returned no text/);
    assert.equal(visible, answer, 'and the reader is shown exactly that text');
    assert.equal(blank.A.trace().route, 'generated');
  }
  /* …and when a retry recovers, the recovered text is the answer. */
  const recovers = await fixture({ chunkQueue: [['   '], ['A real answer about rain.']] });
  await recovers.A.load();
  let recoveredVisible = '';
  const recovered = await recovers.A.chat(GENERATIVE, [], { onDelta: d => recoveredVisible += d });
  assert.equal(recovered, 'A real answer about rain.', 'the compact retry produced the answer');
  assert.equal(recoveredVisible, recovered);
  assert.match(recovers.A.trace().steps.join(' '), /Retrying once with a compact direct-answer prompt/,
    'and the trail says the first pass was empty and a retry ran');

  /* 5.2 — the answer cache serves a repeat without running the model again. */
  const cache = await fixture({ chunks: ['Rain falls softly on the window and the day holds still for a moment.'] });
  await cache.A.load();
  const first = await cache.A.chat('write a short line about rain', [], { onDelta: () => {} });
  const callsBefore = cache.stats.attempts;
  const payloadsBefore = cache.stats.payload;
  let cachedVisible = '';
  const secondAnswer = await cache.A.chat('Write a short line about rain.', [], { onDelta: d => cachedVisible += d });
  assert.equal(secondAnswer, first, 'the same question returns the stored answer');
  assert.equal(cachedVisible, secondAnswer, 'and streams it to the reader');
  assert.equal(cache.stats.payload, payloadsBefore, 'no inference ran on the cache hit');
  assert.equal(cache.A.trace().route, 'generated-cache');
  assert.match(cache.A.trace().runtime, /cache/);
  assert.equal(cache.A.status().cachedAnswers, 1, 'one entry is stored');
  assert.equal(callsBefore, cache.stats.attempts, 'the model load was not repeated either');
  /* A different persona is a different answer, so it must miss and re-run —
     the stub always returns the same text, so the observable difference is that
     inference ran again and a second entry was stored. */
  const personaPayloadBefore = cache.stats.payload;
  const withPersona = await cache.A.chat('write a short line about rain', [], { system: 'Answer like a pirate.' });
  assert.notEqual(cache.stats.payload, personaPayloadBefore, 'a changed persona invalidates the cached answer');
  assert.match(String(cache.stats.payload.messages[0].content), /Answer like a pirate/, 'and the new persona reached the model');
  assert.equal(cache.A.status().cachedAnswers, 2, 'and is stored under its own key');
  /* A differently worded question is also a miss: the key is the prompt. */
  const other = await cache.A.chat('write a long line about snow', [], {});
  assert.notEqual(cache.A.status().cachedAnswers, 2, 'a different question is stored separately');
  void other;
  assert.equal(cache.A.clearAnswerCache(), true);
  assert.equal(cache.A.status().cachedAnswers, 0, 'clearing empties the cache');

  /* 5.2 — answers that could go stale are never cached or replayed. */
  const live = await fixture({ chunks: ['The answer is live.'] });
  await live.A.load();
  live.stats.fetch = async () => ({ ok: true, json: async () => ({ results: [source] }) });
  await live.A.chat('search the current price of oil', [], { search: true });
  assert.equal(live.A.status().cachedAnswers, 0, 'a web-grounded answer is not stored');

  const codeExample = await fixture({ chunks: ['Use `items[9]` or:\n```js\nfetch("https://example.org/api");\n```'] });
  await codeExample.A.load();
  assert.match(await codeExample.A.chat('Write code to read a list', []), /items\[9\]/);

  /* Phone-size contexts retain evidence instead of silently dropping it. */
  const compact = await fixture({ noGPU: true, chunks: ['There are two moons [1].'] });
  await compact.A.load();
  compact.stats.fetch = async () => ({ ok: true, json: async () => ({ results: [source] }) });
  assert.equal(await compact.A.chat('Explain the object', [], { search: true, system: 'preference '.repeat(400) }), 'There are two moons [1].');
  assert.match(compact.stats.wasm.payload.messages[0].content, /two moons/);
  assert.match(compact.A.trace().steps.join(' '), /compact evidence-first/);
  compact.stats.wasm.payload = null;
  assert.match(await compact.A.chat('Explain ' + 'object '.repeat(1300), [], { search: true }), /do not fit/);
  assert.equal(compact.stats.wasm.payload, null, 'never run after evidence is dropped');

  console.log('Browser-generation checks passed: same-origin GPU and WASM runtimes, automatic backend choice, Safari CPU fallback, source retry, cache config, small model, enabled-by-default behavior, retry, timeout, cancellation, late results, prompt-specific instructions, a plan line on every prompt, grounded read in prompt and answer, output shaping, per-turn audit trails, roles, and streaming (stub inference).');
})().catch(e => { console.error(e); process.exit(1); });
