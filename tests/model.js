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
const models = ['Qwen2.5-0.5B-Instruct-q4f16_1-MLC', 'Qwen2.5-0.5B-Instruct-q4f32_1-MLC'];

async function fixture(options = {}) {
  const stats = {
    attempts: 0, imports: [], terminated: 0, interrupted: 0, payload: null,
    adapterCalls: 0, wasm: { attempts: 0, urls: [], exited: 0 }
  };
  const chunks = options.chunks || ['A generated ', 'answer.'];
  const model = {
    interruptGenerate() { stats.interrupted++; },
    chat: { completions: { create: async args => {
      stats.payload = args;
      return (async function* () { for (const c of chunks) yield { choices: [{ delta: { content: c } }] }; })();
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
      for (const c of chunks) opts.onData({ choices: [{ delta: { content: c }, finish_reason: null }] });
    }
    async exit() { stats.wasm.exited++; }
  }
  const storage = new Map(options.disabled ? [['archiver.ai.enabled', '0']] : []);
  const ctx = {
    console, clearTimeout, URL, AbortController, DOMException,
    setTimeout: (fn, ms) => setTimeout(fn, options.timeout && ms >= 8 * 60 * 1000 ? 15 : ms),
    // Present unless the test says this browser has no WebAssembly at all.
    WebAssembly: options.noWasm ? undefined : { instantiate: async () => ({}) },
    navigator: {
      onLine: options.offline ? false : true,
      hardwareConcurrency: 8,
      connection: { saveData: !!options.saveData },
      gpu: options.noGPU ? undefined : { requestAdapter: async hint => {
        stats.adapterCalls++;
        if (options.rejectAdapterHint && hint) throw Error('unsupported power preference');
        return options.noAdapter ? null : { features: new Set(options.f32 ? [] : ['shader-f16']) };
      } }
    },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    Worker: class { terminate() { stats.terminated++; } },
    fetch: () => { throw Error('unexpected fetch'); }
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
  assert.equal(A.version, '3.2');
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
  assert.match(stats.payload.messages[0].content, /Begin your reply with exactly one line of the form: Thinking:/);
  assert.equal(stats.payload.top_p, 0.9);
  assert.ok(stats.payload.presence_penalty > 0, 'repetition is discouraged for a small model');
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

  /* ---------------- thinking is on every prompt ---------------- */
  const thought = await fixture({ chunks: [
    'Thinking: The user wants a short poem about rain, so I will write four plain lines.',
    '\n\nRain falls', ' softly.'
  ] });
  let seen = '';
  const poem = await thought.A.chat(GENERATIVE, [], { onDelta: d => { seen += d; } });
  assert.equal(poem, 'Rain falls softly.', 'the planning line is lifted out of the visible answer');
  assert.equal(seen, poem, 'and never streamed to the reader either');
  assert.match(thought.A.trace().thinking, /four plain lines/);
  assert.match(thought.A.trace().steps.join(' | '), /planned in one line before answering/);

  const noThinking = await fixture({ chunks: ['Just an answer, no plan line.'] });
  const plain = await noThinking.A.chat(GENERATIVE, []);
  assert.equal(plain, 'Just an answer, no plan line.', 'a model that ignores the instruction still answers');
  assert.equal(noThinking.A.trace().thinking, '');
  assert.match(noThinking.A.trace().steps.join(' | '), /did not produce a separate planning line/);

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
  for (const [q, want] of cases) {
    await audit.A.chat(q, []);
    const tr = audit.A.trace();
    assert.ok(tr && tr.steps.length, `every prompt leaves an audit trail: ${q}`);
    assert.ok(tr.route, `every prompt records a route: ${q}`);
    assert.ok(tr.runtime, `every prompt records a runtime: ${q}`);
    assert.match(tr.steps.join(' | '), want, `the trail for "${q}" says what actually happened`);
    assert.match(tr.note, /Not a transcript of private reasoning/);
  }
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
    assert.ok(w.stats.wasm.params.n_threads >= 1 && w.stats.wasm.params.n_threads <= 4);
    assert.equal(w.stats.wasm.urls[0], w.A.WASM_SOURCES[0], 'weights come from the publisher, automatically');
    assert.match(w.A.reply('who are you').text, /WebAssembly/);
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

  console.log('Browser-generation checks passed: same-origin GPU and WASM runtimes, automatic backend choice, Safari CPU fallback, source retry, cache config, small model, enabled-by-default behavior, retry, timeout, cancellation, late results, prompt-specific instructions, visible one-line thinking, output shaping, per-turn audit trails, roles, and streaming (stub inference).');
})().catch(e => { console.error(e); process.exit(1); });
