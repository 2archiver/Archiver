/* The on-device engine (web/archiver-engine.js) on top of the controller
   (web/archiver-prep.js), in a simulated browser (tests/harness.js).

   The answer behaviour, planning line, output shaping and audit trail are the
   engine's own. What is simulated: the WebGPU runtime (WebLLM) and the CPU runtime
   (wllama's inference worker). Storage, download, verification and the controller
   are the real modules, as in tests/prep.js.

   node --experimental-vm-modules tests/model.js */
'use strict';
const assert = require('node:assert/strict');
const { createBrowser, createOrigin, fakeGGUF, sha256Hex } = require('./harness.js');

const GPU_RUNTIME = '/static/vendor/web-llm-0.2.80.js';
const WASM_RUNTIME = '/static/vendor/wllama-3.6.1.js';
const WASM_BINARY = '/static/vendor/wllama-3.6.1.wasm';
const COMPAT_JS = '/static/vendor/wllama-compat-3.6.1.js';
const COMPAT_WASM = '/static/vendor/wllama-compat-3.6.1.wasm';
/* Qwen2.5-0.5B-Instruct is the primary model on both runtimes; Qwen3-0.6B is
   only an automatic fallback. The stub catalogue carries both, like the real one. */
const models = ['Qwen2.5-0.5B-Instruct-q4f16_1-MLC', 'Qwen2.5-0.5B-Instruct-q4f32_1-MLC'];
const fallbackModels = ['Qwen3-0.6B-q4f16_1-MLC', 'Qwen3-0.6B-q4f32_1-MLC'];
const Q4_0 = 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_0.gguf';
const Q4_K_M = 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf';
const WASM_SOURCES_PRIMARY = [Q4_0, Q4_K_M, 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q8_0.gguf'];

const normalise = (spec) => String(spec).replace(/^https?:\/\/[^/]+/, '');

/* A CPU runtime stand-in: records what the engine asked of it. Each instance is one
   attempt; loadModel() reads the stored model the way the real runtime does. */
function makeWllamaStub(opts, log) {
  return class WllamaStub {
    constructor(pathConfig, config) {
      this.pathConfig = pathConfig;
      this.config = config;
      this.compat = null;
      this.exited = false;
      this.id = log.instances.length;
      log.instances.push(this);
      log.events.push('new:' + this.id);
    }
    setCompat(compat, mode) { this.compat = compat; this.compatMode = mode; log.compat.push({ compat, mode }); }
    async loadModel(input, params) {
      this.params = params;
      this.input = input;
      log.loads.push({ id: this.id, input, params });
      log.events.push('load:' + this.id);
      if (opts.wllamaFailLoad && log.loads.length <= opts.wllamaFailLoad) {
        throw new Error('invalid model: unexpected end of file');
      }
      if (opts.wllamaHang) return new Promise(() => {});
      this.loaded = true;
    }
    async createChatCompletion(req) {
      log.payloads.push(req);
      const set = opts.nextChunks ? opts.nextChunks() : ['A generated answer.'];
      for (const c of set) req.onData({ choices: [{ delta: { content: c }, finish_reason: null }] });
    }
    async exit() { this.exited = true; log.events.push('exit:' + this.id); }
  };
}

async function fixture(options) {
  const opts = Object.assign({}, options || {});
  const origin = createOrigin();
  const chunks = opts.chunks || ['A generated ', 'answer.'];
  const queue = opts.chunkQueue ? opts.chunkQueue.slice() : null;
  opts.nextChunks = () => {
    if (queue && queue.length) return queue.length > 1 ? queue.shift() : queue[0];
    return chunks;
  };
  // Hub: the publisher serves the GGUF files (for the CPU runtime path).
  for (const url of WASM_SOURCES_PRIMARY) {
    const bytes = fakeGGUF(64 * 1024, url.length);
    origin.hub.set(url, { bytes, sha256: sha256Hex(bytes) });
  }
  if (opts.disabled) origin.local.set('archiver.ai.enabled', '0');
  if (opts.offline) origin.network.offline = true;
  const gpuNavigator = opts.noGPU ? { gpu: undefined } : { gpu: {
    requestAdapter: async (hint) => {
      if (opts.rejectAdapterHint && hint) throw new Error('unsupported power preference');
      if (opts.noAdapter) return null;
      const mib = opts.tinyLimits ? 64 : 256;
      return {
        features: new Set(opts.f32 ? [] : ['shader-f16']),
        limits: { maxStorageBufferBindingSize: mib * 1048576, maxBufferSize: mib * 1048576 },
        requestDevice: async () => ({
          pushErrorScope() {}, popErrorScope: async () => null,
          createBuffer: () => ({ destroy() {} }), destroy() {}
        })
      };
    }
  } };
  const navigatorOpts = Object.assign({
    onLine: !opts.offline,
    connection: { saveData: !!opts.saveData, effectiveType: '4g', downlink: 20 }
  }, gpuNavigator, opts.ua ? { userAgent: opts.ua } : {});
  const wllamaLog = { instances: [], compat: [], loads: [], payloads: [], events: [] };
  const b = await createBrowser({
    origin,
    baseURI: 'http://localhost/',
    navigator: navigatorOpts,
    visibility: opts.hidden ? 'hidden' : 'visible',
    wllamaStub: makeWllamaStub(opts, wllamaLog),
    gpuPlan: opts.gpuPlan || (opts.failOnce ? [{ match: /.*/, error: 'simulated network failure', once: true }] : null)
      || (opts.pending ? [{ match: /.*/, hang: true }] : null),
    plan: opts.plan || null,
    crossOriginIsolated: opts.noIsolation ? false : undefined,
    sharedArrayBuffer: opts.noIsolation ? false : undefined,
    noWasm: !!opts.noWasm,
    timeouts: opts.timeouts,
    nextChunks: opts.nextChunks
  });
  const stats = {
    get attempts() { return origin.webllm.ids.length; },
    get imports() { return b.imports.map(normalise); },
    get id() { return origin.webllm.ids[origin.webllm.ids.length - 1]; },
    get config() { return origin.webllm.configs[origin.webllm.configs.length - 1]; },
    get payload() { return origin.webllm.payloads[origin.webllm.payloads.length - 1]; },
    get interrupted() { return origin.webllm.interrupts; },
    get terminated() { return origin.workers.filter(w => w.terminated).length; },
    fetch: null,
    wasm: {
      get attempts() { return wllamaLog.instances.length; },
      get urls() { return wllamaLog.loads.map(l => l.input && (l.input.url || (l.input.files && l.input.files[0] && l.input.files[0].metadata && l.input.files[0].metadata.originalURL))); },
      get params() { return wllamaLog.loads.length ? wllamaLog.loads[wllamaLog.loads.length - 1].params : undefined; },
      get pathConfig() {
        const last = wllamaLog.instances.length ? wllamaLog.instances[wllamaLog.instances.length - 1].pathConfig : undefined;
        return last ? { default: normalise(last.default) } : undefined;
      },
      get payload() { return wllamaLog.payloads[wllamaLog.payloads.length - 1]; },
      get exited() { return wllamaLog.instances.filter(i => i.exited).length; },
      log: wllamaLog
    }
  };
  // Search (2.6) reads through the page's fetch; a test may replace it.
  const realFetch = b.ctx.fetch;
  b.ctx.fetch = (...args) => (stats.fetch ? stats.fetch(...args) : realFetch(...args));
  const storage = {
    get: (k) => origin.local.get(k),
    set: (k, v) => origin.local.set(k, String(v)),
    has: (k) => origin.local.has(k),
    delete: (k) => origin.local.delete(k)
  };
  return { A: b.Archiver, stats, storage, origin, b, Prep: b.Prep, ctx: b.ctx };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const GENERATIVE = 'write a poem about rain';
let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ok    ' + name); } catch (err) {
    failed++;
    console.log('  FAIL  ' + name + '\n        ' + String((err && err.stack) || err).split('\n').slice(0, 5).join('\n        '));
  }
}

(async () => {
  console.log('On-device engine (tests/model.js)');
  /* ---------------- WebGPU backend (unchanged fast path) ---------------- */
  const { A, stats, storage } = await fixture();
  assert.equal(A.version, '5.4');
  assert.equal(A.name, 'Archiver 5.4');
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
  assert.equal(stats.payload.extra_body, undefined,
    'Qwen 2.5 has no hidden thinking pass; WebLLM would write an empty <think> block into its prompt as plain text, so the switch is not sent');
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
  assert.equal(thought.stats.payload.extra_body, undefined,
    'thinking:true adds the planning-line instruction, not a Qwen 3-only runtime switch, on the primary model');

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


  /* ---------------- CPU runtime: what Safari gets, through wllama ---------------- */
  for (const config of [{ noGPU: true }, { noAdapter: true }, { rejectAdapterHint: true, noAdapter: true }]) {
    const w = await fixture(config);
    let wd = '';
    const out = await w.A.chat(GENERATIVE, [], { onDelta: d => { wd += d; } });
    assert.equal(out, 'A generated answer.', `generation still works for ${JSON.stringify(config)}`);
    assert.equal(wd, out);
    assert.ok(w.stats.imports.includes(WASM_RUNTIME), 'the CPU runtime is loaded from this origin');
    assert.equal(w.stats.attempts, 0, 'the GPU runtime is never started on this device');
    assert.equal(w.A.mode(), 'neural');
    assert.equal(w.A.status().backend, 'wasm');
    assert.equal(w.A.status().contextBudget, 2048, 'a phone-sized context, not a pretend-unlimited one');
    assert.equal(w.stats.wasm.pathConfig.default, WASM_BINARY, 'the WASM binary is same-origin');
    assert.equal(w.stats.wasm.params.n_gpu_layers, 0, 'CPU-only: no WebGPU shim on the fallback path');
    assert.equal(w.stats.wasm.params.n_ctx, 2048);
    assert.ok([512, 1024].includes(w.stats.wasm.params.n_batch), 'batch sizes unchanged from 5.3 (512 desktop / 1024 Apple mobile)');
    assert.ok(w.stats.wasm.params.n_threads >= 1 && w.stats.wasm.params.n_threads <= 4);
    assert.equal(w.stats.wasm.params.kv_unified, true);
    assert.equal(w.stats.wasm.params.cache_type_k, 'q8_0');
    assert.ok(!/no_think/.test(w.stats.wasm.payload.messages[0].content), 'Qwen 2.5 is not sent a Qwen 3-only /no_think token');
    assert.equal(w.stats.wasm.payload.chat_template_kwargs, undefined, 'and no Qwen 3 template switch');
    assert.match(w.A.reply('who are you').text, /WebAssembly/);
    assert.match(w.A.trace().steps.join(' | '), /Safari\/CPU prompt compaction/, 'the trail notes Safari CPU prompt compaction');
    assert.match(w.A.trace().steps.join(' | '), /WebAssembly/, 'the trail says which runtime answered');
    assert.equal(w.A.trace().runtime, 'on-device cpu');
    assert.equal(w.stats.wasm.payload.stream, true);
    assert.equal(w.stats.wasm.payload.max_tokens <= 1024, true);
  }

  await check('the CPU runtime is offered both builds from this origin and never a CDN', async () => {
    const w = await fixture({ noGPU: true });
    await w.A.chat(GENERATIVE, []);
    const compat = w.stats.wasm.log.compat;
    assert.equal(compat.length, 1, 'setCompat is set per instance');
    assert.equal(compat[0].mode, 'firefox_safari');
    assert.equal(normalise(compat[0].compat.worker), COMPAT_JS);
    assert.equal(normalise(compat[0].compat.wasm), COMPAT_WASM);
    assert.ok(w.origin.fetchLog.every(f => !/jsdelivr|unpkg/.test(f.url)), 'no request to a CDN');
    const input = w.stats.wasm.log.loads[0].input;
    assert.equal(typeof input.open, 'function', 'the stored Model object is loaded, not a bare URL');
    assert.equal(input.url, Q4_0, 'and it is the first listed artifact');
  });

  await check('a failed CPU start is followed by a fresh instance, and the old one is released', async () => {
    const w = await fixture({ noGPU: true, wllamaFailLoad: 1 });
    await w.A.chat(GENERATIVE, []);            // the first start fails; instant tools answer
    assert.equal(w.A.mode(), 'grounded');
    await w.A.retryAI();                        // a fresh instance, the failed one released
    assert.equal(w.stats.wasm.attempts, 2, 'the failed attempt and a fresh one');
    assert.equal(w.stats.wasm.exited, 1, 'the failed instance was released before the retry');
    assert.equal(w.A.mode(), 'neural');
  });

  await check('a source that is not published falls through to the next quantization on a fresh start', async () => {
    const w = await fixture({ noGPU: true });
    w.origin.hub.delete(Q4_0);
    const out = await w.A.chat(GENERATIVE, []);
    assert.equal(out, 'A generated answer.');
    assert.equal(w.stats.wasm.log.loads.length, 1);
    assert.equal(w.stats.wasm.log.loads[0].input.files[0].metadata.originalURL, Q4_K_M, 'the next published artifact');
    assert.match(w.A.trace().steps.join(' | '), /Q4_K_M|Q4_0|artifact|source/i);
  });

  await check('without shared memory the CPU runtime is not started and the reason says why', async () => {
    const w = await fixture({ noGPU: true, noIsolation: true });
    const out = await w.A.chat(GENERATIVE, []);
    assert.ok(out.length > 0, 'instant tools still answer');
    assert.equal(w.stats.wasm.attempts, 0, 'no WebAssembly instance is created');
    assert.match(w.A.status().aiReason, /cross-origin isolated|isolation/i, 'the reason names isolation, not a generic failure');
    assert.equal(w.origin.fetchLog.filter(f => f.url.endsWith('.gguf')).length, 0, 'nothing is downloaded either');
  });

  await check('a model the CPU runtime cannot read is not retained, and the reader is told why', async () => {
    const w = await fixture({ noGPU: true, wllamaFailLoad: 99 });
    const out = await w.A.chat(GENERATIVE, []);
    assert.ok(out.length > 0);
    assert.equal(w.A.mode(), 'grounded');
    const status = w.A.status();
    assert.match(status.aiReason, /CPU runtime could not start|invalid model/i);
  });

  /* ---------------- GPU: one controlled transition, and no others ---------------- */

  await check('a GPU device lost during use moves to the CPU runtime once, stopping the GPU first', async () => {
    const g = await fixture({ chunks: ['Hello from the GPU.'] });
    await g.A.chat(GENERATIVE, []);
    assert.equal(g.A.status().backend, 'webgpu');
    const worker = g.origin.workers.find(w => !w.terminated && /archiver-worker\.js/.test(w.url));
    assert.ok(worker, 'the WebGPU worker exists');
    worker._emit('error', { message: 'WebGPU device was lost' });
    await until(() => g.A.status().backend === 'wasm' || g.A.status().aiState === 'error', 3000);
    assert.equal(g.A.status().backend, 'wasm', 'the answer now comes from the CPU runtime');
    const events = g.stats.wasm.log.events;
    assert.ok(g.origin.webllm.engines[0] && g.origin.webllm.unloads >= 1, 'the old GPU engine was unloaded first');
    assert.ok(g.origin.workers.find(w => /archiver-worker\.js/.test(w.url) && w.terminated), 'and its worker terminated');
    assert.equal(events[0], 'new:0', 'the transition begins with a new CPU instance only after the GPU stopped');
    assert.equal(g.A.mode(), 'neural');
  });

  await check('a GPU fault at start-up transitions to the CPU runtime without trying another GPU model', async () => {
    const g = await fixture({ gpuPlan: [{ match: /Qwen2\.5-0\.5B-Instruct-q4f16_1/, error: 'WebGPU device was lost during initialization', once: true }] });
    const answer = await g.A.chat(GENERATIVE, []);
    assert.ok(answer.length > 0);
    assert.equal(g.A.status().backend, 'wasm');
    assert.equal(g.origin.webllm.ids.filter(id => /Qwen3/.test(id)).length, 0, 'no Qwen3 attempt on the GPU for a GPU fault');
  });

  await check('a network failure while starting WebGPU tries the fallback model, not the CPU transition', async () => {
    const g = await fixture({ gpuPlan: [{ match: /Qwen2\.5-0\.5B-Instruct-q4f16_1/, error: 'Failed to fetch' }] });
    await g.A.chat(GENERATIVE, []);
    assert.equal(g.A.status().backend, 'webgpu', 'still on the GPU');
    assert.equal(g.origin.webllm.ids[1], fallbackModels[0], 'the fallback model was tried next');
    assert.equal(g.stats.wasm.attempts, 0, 'no CPU runtime was started');
  });

  await check('cancel during WebGPU start-up stops it, with no transition and no fallback', async () => {
    const g = await fixture({ pending: true });
    const ctl = new AbortController();
    const waiting = g.A.chat(GENERATIVE, [], { signal: ctl.signal });
    await until(() => g.origin.webllm.ids.length >= 1, 2000);
    g.A.cancelLoad();
    const answer = await waiting;
    assert.equal(typeof answer, 'string', 'the question still gets an answer from instant tools');
    assert.equal(g.origin.webllm.ids.length, 1, 'no second model attempt');
    assert.equal(g.stats.wasm.attempts, 0, 'no CPU transition after a cancel');
    assert.equal(g.A.mode(), 'grounded');
  });

  /* ---------------- stale completions never write into a newer answer ---------------- */

  await check('an answer that finishes after it was stopped is discarded, not returned', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const g = await fixture({ chunks: ['Stale ', 'answer.'] });
    await g.A.chat('hi', []);     // starts nothing: instant route
    const first = g.A.chat(GENERATIVE, []);     // starts the WebGPU engine
    await until(() => g.origin.webllm.engines.length >= 1, 3000);
    const eng = g.origin.webllm.engines[0];
    const realCreate = eng.chat.completions.create;
    eng.chat.completions.create = async (args) => {
      g.origin.webllm.payloads.push(args);
      await gate;
      return (async function* () { yield { choices: [{ delta: { content: 'Late text.' } }] }; })();
    };
    const pending = g.A.chat('write another poem about snow', []);
    await sleep(20);
    g.A.unload();                 // a stop: the generation counter moves on
    release();
    const result = await pending.then(v => ({ v }), e => ({ e }));
    const stoppedOrClean = (result.e && result.e.name === 'AbortError') || (result.v !== undefined && !/Late text/.test(result.v));
    assert.ok(stoppedOrClean, 'the late completion is not returned');
    eng.chat.completions.create = realCreate;
    await first.catch(() => {});
  });

  await check('a question after a stop gets a fresh answer, not the stopped one', async () => {
    const g = await fixture({ chunkQueue: [['Second ', 'answer.']] });
    await g.A.chat(GENERATIVE, []);
    g.A.unload();
    const next = await g.A.chat('write a fresh poem about the sea', []);
    assert.equal(next, 'Second answer.');
  });

  /* ---------------- gates: nothing downloads when it should not ---------------- */
  for (const config of [{ offline: true }, { saveData: true }, { noGPU: true, noWasm: true }]) {
    const f = await fixture(config);
    const response = await f.A.chat(GENERATIVE, []);
    assert.equal(f.stats.attempts, 0, `no GPU start for ${JSON.stringify(config)}`);
    assert.equal(f.origin.fetchLog.filter(x => x.url.endsWith('.gguf') && x.method === 'GET').length, 0, `no model download for ${JSON.stringify(config)}`);
    assert.ok(response.length);
    assert.equal(f.A.mode(), 'grounded');
    assert.ok(f.A.status().aiReason, `the reason is reported for ${JSON.stringify(config)}`);
  }
  const saver = await fixture({ saveData: true });
  await saver.A.chat(GENERATIVE, []);
  assert.match(saver.A.status().aiReason, /Data Saver/);

  const f32 = await fixture({ f32: true });
  await f32.A.chat(GENERATIVE, []);
  assert.equal(f32.stats.id, models[1], 'without shader-f16 the q4f32 artifact is used');

  /* ---------------- Qwen3-0.6B is a fallback, never the default ---------------- */
  const gpuFallback = await fixture({ gpuPlan: [{ match: /Qwen2\.5-0\.5B-Instruct-q4f16_1/, error: 'Failed to fetch' }, { match: /Qwen2\.5-0\.5B-Instruct-q4f32_1/, error: 'Failed to fetch' }] });
  assert.equal(await gpuFallback.A.chat(GENERATIVE, []), 'A generated answer.');
  assert.equal(gpuFallback.stats.id, fallbackModels[0], 'Qwen3 loads only when the Qwen2.5 artifacts cannot start');
  assert.match(gpuFallback.A.status().modelPretty, /Qwen 3/);

  /* The default is Qwen2.5 on the GPU runtime, and the labels never claim the model is ours. */
  const label = (await fixture()).A.pretty;
  assert.equal(label('Qwen2.5-0.5B-Instruct-q4f16_1-MLC'), 'Qwen 2.5 0.5B Instruct');
  assert.equal(label('Qwen3-0.6B-q4f16_1-MLC'), 'Qwen 3 0.6B');
  const persona = (await fixture()).A.PERSONA;
  assert.ok(!/Archiver\u2019s own|our own model/i.test(persona), 'the persona makes no ownership claim about the model');
  assert.match(persona, /open Qwen model/);

  /* ---------------- the status surface ---------------- */
  const idle = await fixture();
  const st = idle.A.status();
  assert.equal(st.version, '5.4');
  assert.ok(st.prep && st.prep.phase === 'idle', 'the controller state is reported');
  assert.equal(idle.stats.imports.length, 0, 'opening the page starts no runtime');
  const diag = await idle.A.diagnostics();
  assert.equal(diag.runtime.webgpuRuntime, 'WebLLM 0.2.80');
  assert.equal(diag.runtime.cpuRuntime, 'wllama 3.6.1 (llama.cpp WebAssembly)');
  assert.match(diag.runtime.models.primary, /not trained by Archiver/);
  assert.ok(diag.storage && Array.isArray(diag.storage.entries));

  console.log('\n' + passed + ' sections passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})().catch((err) => {
  console.error('model suite crashed', err);
  process.exit(1);
});

async function until(predicate, ms) {
  const end = Date.now() + (ms || 3000);
  while (Date.now() < end) { if (await predicate()) return true; await sleep(5); }
  throw new Error('timed out');
}
