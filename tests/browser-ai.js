/* Optional browser integration test. Model inference is stubbed; the actual
   vendored runtime is also imported separately to validate browser packaging. */
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const base = process.env.BASE_URL || 'http://127.0.0.1:8000';
const runtime = '/static/vendor/web-llm-0.2.80.js';
const mockRuntime = `
export const prebuiltAppConfig = { model_list: [
  { model_id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC' },
  { model_id: 'Qwen2.5-0.5B-Instruct-q4f32_1-MLC' }
] };
export class WebWorkerMLCEngineHandler { onmessage() {} }
export async function CreateWebWorkerMLCEngine(worker, model, config) {
  globalThis.__modelLoads = (globalThis.__modelLoads || 0) + 1;
  config.initProgressCallback({ progress: .2, text: 'Preparing browser-generation test model' });
  await new Promise(resolve => setTimeout(resolve, 600));
  return { interruptGenerate() {}, chat: { completions: {
    create: async () => (async function* () {
      yield { choices: [{ delta: { content: 'Browser-generated ' } }] };
      yield { choices: [{ delta: { content: 'answer.' } }] };
    })()
  } } };
}`;
(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  try {
    const real = await browser.newPage();
    await real.goto(base);
    const packaged = await real.evaluate(async url => {
      const mod = await import(url);
      return { create: typeof mod.CreateWebWorkerMLCEngine, worker: typeof mod.WebWorkerMLCEngineHandler,
        small: mod.prebuiltAppConfig.model_list.some(m => m.model_id === 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC') };
    }, runtime);
    assert.deepEqual(packaged, { create: 'function', worker: 'function', small: true });
    await real.close();
    const context = await browser.newContext();
    await context.addInitScript(() => Object.defineProperty(navigator, 'gpu', { configurable: true,
      value: { requestAdapter: async () => ({ features: new Set(['shader-f16']) }) } }));
    await context.route('**/static/vendor/web-llm-0.2.80.js', route => route.fulfill({ contentType: 'application/javascript', body: mockRuntime }));
    await context.route('**/api/chat/prepare', () => {});
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base);
    assert.equal(await page.locator('#autoAI').count(), 0, 'browser generation is not an optional setting');
    assert.equal(await page.evaluate(() => window.Archiver.status().aiEnabled), true);
    assert.equal(await page.evaluate(() => globalThis.__modelLoads || 0), 0);
    await page.waitForFunction(() => document.querySelector('#setPersona').value.length > 0);
    await page.locator('#settingsBtn').click();
    assert.equal(await page.locator('#settingsOverlay').evaluate(el => el.classList.contains('on')), true);
    await page.locator('#closeSettings').click();
    assert.equal(await page.locator('#settingsOverlay').evaluate(el => el.classList.contains('on')), false);
    await page.locator('#settingsBtn').click();
    await page.locator('#saveSettings').click();
    await page.waitForFunction(() => document.querySelector('#toastBox').textContent.includes('Settings applied'));
    assert.equal(await page.locator('#settingsOverlay').evaluate(el => el.classList.contains('on')), false);
    const send = async text => { await page.locator('#chatInput').fill(text); await page.locator('#sendBtn').click(); };
    await send('write a poem about rain');
    await page.waitForFunction(() => window.Archiver.status().loading);
    assert.match(await page.locator('#aiRuntimeStatus').textContent(), /Preparing/);
    await page.waitForFunction(() => document.querySelector('#sendBtn').dataset.stopping === 'false');
    assert.match(await page.locator('.msg-row.ai .msg-body').last().textContent(), /Browser-generated answer/);
    assert.equal(await page.evaluate(() => globalThis.__modelLoads), 1);
    await send('write another poem');
    await page.waitForFunction(() => document.querySelector('#sendBtn').dataset.stopping === 'false');
    assert.equal(await page.evaluate(() => globalThis.__modelLoads), 1);

    // Reload resets the live worker but not the automatic preference. Stop must
    // cancel the pending original request, not let a late answer appear.
    await page.reload();
    await send('write a story about rain');
    await page.waitForFunction(() => window.Archiver.status().loading);
    await page.locator('#cbStop').click();
    await page.waitForFunction(() => document.querySelector('#sendBtn').dataset.stopping === 'false');
    assert.match(await page.locator('.msg-row.ai .msg-body').last().textContent(), /stopped/);
    await page.waitForTimeout(700); // deliberately beyond mocked initialization to catch stale completion
    assert.equal(await page.evaluate(() => window.Archiver.mode()), 'grounded');
    assert.match(await page.locator('.msg-row.ai .msg-body').last().textContent(), /stopped/);
    await page.evaluate(() => window.Archiver.setAIEnabled(false));
    await page.reload();
    assert.equal(await page.evaluate(() => window.Archiver.status().aiEnabled), true);
    await send('write a poem');
    await page.waitForFunction(() => document.querySelector('#sendBtn').dataset.stopping === 'false');
    assert.match(await page.locator('.msg-row.ai .msg-body').last().textContent(), /Browser-generated answer/);
    assert.equal(await page.evaluate(() => globalThis.__modelLoads), 1, 'the legacy toggle cannot turn generation off');
    assert.deepEqual(errors, []);
    console.log('Browser-generation checks passed: real bundled-runtime import, settings controls, first generation, engine reuse, startup progress, Stop/late-result protection, always-on setting (stub weights/inference).');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
