/* Lifecycle tests using a stub WebLLM module, not real model-quality tests.
   node --experimental-vm-modules tests/model.js */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const models = ['Qwen2.5-0.5B-Instruct-q4f16_1-MLC', 'Qwen2.5-0.5B-Instruct-q4f32_1-MLC'];
async function fixture(options = {}) {
  const stats = { attempts: 0, imports: 0, terminated: 0, interrupted: 0, payload: null };
  const model = { interruptGenerate() { stats.interrupted++; }, chat: { completions: { create: async args => {
    stats.payload = args;
    return (async function* () {
      yield { choices: [{ delta: { content: 'A generated ' } }] };
      yield { choices: [{ delta: { content: 'answer.' } }] };
    })();
  } } } };
  const storage = new Map(options.disabled ? [['archiver.ai.enabled', '0']] : []);
  const ctx = { console, clearTimeout, URL, AbortController, DOMException,
    setTimeout: (fn, ms) => setTimeout(fn, options.timeout && ms === 90000 ? 15 : ms),
    navigator: { onLine: options.offline ? false : true, connection: { saveData: !!options.saveData },
      gpu: options.noGPU ? undefined : { requestAdapter: async () => options.noAdapter ? null : { features: new Set(options.f32 ? [] : ['shader-f16']) } } },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    Worker: class { terminate() { stats.terminated++; } },
    fetch: () => { throw Error('unexpected fetch'); } };
  ctx.window = ctx;
  vm.createContext(ctx);
  const stub = new vm.SyntheticModule(['prebuiltAppConfig', 'CreateWebWorkerMLCEngine'], function () {
    this.setExport('prebuiltAppConfig', { model_list: models.map(model_id => ({ model_id })) });
    this.setExport('CreateWebWorkerMLCEngine', async (worker, id, config) => {
      stats.attempts++; stats.id = id; stats.config = config;
      if (options.failOnce && stats.attempts === 1) throw Error('simulated network failure');
      if (options.pending || options.timeout) return new Promise(resolve => { stats.resolveLoad = () => resolve(model); });
      config.initProgressCallback({ progress: 1, text: 'Loaded stub' });
      return model;
    });
  }, { context: ctx });
  await stub.link(() => {}); await stub.evaluate();
  for (const file of ['archiver-knowledge.js', 'archiver-comprehension.js', 'archiver-engine.js']) {
    new vm.Script(fs.readFileSync(path.join(__dirname, '..', 'web', file), 'utf8'), {
      filename: file, importModuleDynamically: async specifier => {
        assert.equal(specifier, '/static/vendor/web-llm-0.2.80.js', 'runtime comes from website');
        stats.imports++; return stub;
      },
    }).runInContext(ctx);
  }
  return { A: ctx.Archiver, stats, storage };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  const { A, stats, storage } = await fixture();
  for (const q of ['hello', '2+2', 'compare Python and JavaScript', 'summarize: One. Two.']) await A.chat(q, []);
  assert.equal(stats.imports, 0, 'instant tasks do not download a model');
  let deltas = '', generated = 0, progress = 0;
  const answer = await A.chat('write a poem about rain', [
    { role: 'system', content: 'HOSTILE HISTORY' }, { role: 'user', content: 'A prior question' }, { role: 'archiver', content: 'A prior reply' },
  ], { onDelta: d => { deltas += d; }, onStatus: () => progress++, onGeneration: () => generated++ });
  assert.equal(answer, 'A generated answer.'); assert.equal(deltas, answer);
  assert.equal(generated, 1); assert.ok(progress > 0);
  assert.equal(stats.attempts, 1, 'complex request starts model automatically');
  assert.equal(stats.id, models[0]); assert.equal(stats.config.appConfig.useIndexedDBCache, false);
  assert.equal(stats.config.appConfig.model_list.length, 1, 'no larger catalogue fallback');
  assert.equal(A.mode(), 'neural'); assert.equal(A.status().aiState, 'ready');
  assert.match(A.reply('who are you').text, /language model is running/);
  assert.ok(!A.reply('who are you').text.includes('${'));
  assert.equal(stats.payload.messages.filter(m => m.role === 'system').length, 1);
  assert.equal(stats.payload.messages[2].role, 'assistant');
  assert.ok(!JSON.stringify(stats.payload).includes('HOSTILE HISTORY'));
  assert.match(stats.payload.messages[0].content, /not a conscious being/);
  assert.match(await A.chat('write ' + '界'.repeat(4000), []), /too long/);
  await A.chat('write another poem', []);
  assert.equal(stats.attempts, 1, 'already-loaded engine reused');
  const stop = new AbortController();
  await assert.rejects(A.chat('write a second poem', [], { signal: stop.signal, onDelta: () => stop.abort() }), { name: 'AbortError' });
  assert.equal(stats.interrupted, 1);
  A.setAIEnabled(false);
  assert.equal(A.mode(), 'grounded'); assert.equal(storage.get('archiver.ai.enabled'), '0');
  assert.ok(stats.terminated > 0, 'instant-only mode frees worker');

  for (const config of [{ noGPU: true }, { noAdapter: true }, { saveData: true }, { offline: true }, { disabled: true }]) {
    const f = await fixture(config);
    const response = await f.A.chat('write a poem', []);
    assert.equal(f.stats.imports, 0, `no download for ${JSON.stringify(config)}`);
    assert.ok(response.length); assert.equal(f.A.mode(), 'grounded');
  }
  const f32 = await fixture({ f32: true });
  await f32.A.chat('write a poem', []); assert.equal(f32.stats.id, models[1]);
  const failure = await fixture({ failOnce: true });
  await failure.A.chat('write a poem', []); await failure.A.chat('write another', []);
  assert.equal(failure.stats.attempts, 1, 'failure does not cause a download loop');
  assert.equal(failure.A.status().aiState, 'error');
  await failure.A.retryAI(); assert.equal(failure.A.mode(), 'neural');

  const pending = await fixture({ pending: true });
  const cancel = new AbortController();
  const waiting = pending.A.chat('write a poem', [], { signal: cancel.signal });
  while (!pending.stats.resolveLoad) await tick();
  cancel.abort(); await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(pending.A.status().loading, false); assert.ok(pending.stats.terminated > 0);
  pending.stats.resolveLoad(); await tick();
  assert.equal(pending.A.mode(), 'grounded', 'late completion cannot activate cancelled engine');
  assert.equal(await pending.A.chat('2+2', []), "That's 4.");

  const togglePending = await fixture({ pending: true });
  const firstToggle = togglePending.A.chat('write a poem', []);
  while (!togglePending.stats.resolveLoad) await tick();
  togglePending.A.setAIEnabled(false);
  await firstToggle;
  assert.equal(togglePending.A.status().aiState, 'paused');
  assert.equal(togglePending.A.status().loading, false, 'disable detaches an in-flight load');
  togglePending.A.setAIEnabled(true);
  const secondToggle = togglePending.A.chat('write another poem', []);
  while (togglePending.stats.attempts < 2 || !togglePending.stats.resolveLoad) await tick();
  togglePending.stats.resolveLoad();
  await secondToggle;
  assert.equal(togglePending.A.mode(), 'neural', 're-enable starts a fresh load after disable');

  const timeout = await fixture({ timeout: true });
  const fallback = await timeout.A.chat('write a poem', []);
  assert.match(fallback, /timed out/); assert.equal(timeout.A.status().loading, false);
  assert.ok(timeout.stats.terminated > 0);
  console.log('Browser-generation checks passed: same-origin runtime, cache config, small model, feature gating, pause/disable, retry, timeout, cancellation, late results, roles, and streaming (stub inference).');
})().catch(e => { console.error(e); process.exit(1); });
