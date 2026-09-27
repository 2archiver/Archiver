/* WebKit navigation/download regression. No model weights or live search.
   npm install --no-save playwright
   npx playwright install --with-deps webkit
   Start app, then: node tests/browser-safari.js
   Linux WebKit is not a substitute for testing the affected iPhone/Mac. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { webkit, devices } = require('playwright');
const base = process.env.BASE_URL || 'http://127.0.0.1:8000';
(async () => {
  const browser = await webkit.launch({ headless: true });
  try {
    for (const device of [null, devices['iPhone 13']]) {
      const context = await browser.newContext({ ...(device || {}), acceptDownloads: true });
      const requests = [], errors = [];
      await context.route('**/*', route => {
        const url = route.request().url();
        if (/^https?:/.test(url) && !url.startsWith(base + '/')) return route.abort();
        return route.continue();
      });
      const page = await context.newPage();
      page.on('pageerror', e => errors.push(e.message));
      page.on('request', r => requests.push(r.url()));
      await page.goto(base);
      await page.waitForFunction(() => window.Archiver && document.querySelector('#setPersona').value);
      await page.waitForTimeout(1500); // pass the old boot prewarm timer
      assert.equal(await page.evaluate(() => Archiver.status().loading), false);
      assert.equal(requests.some(u => u.includes('/static/vendor/')), false);
      // A previous successful backend selection must not bypass Safari deferral.
      await page.evaluate(() => localStorage.setItem('archiver.engine.v1', JSON.stringify({
        backend: 'wasm', model: 'cached.gguf', ts: Date.now()
      })));
      await page.reload();
      await page.waitForFunction(() => window.Archiver && document.querySelector('#setPersona').value);
      assert.equal(await page.evaluate(() => Archiver.warm()), false);
      assert.equal(requests.some(u => u.includes('/static/vendor/')), false);
      const send = async text => {
        await page.locator('#chatInput').fill(text);
        await page.locator('#sendBtn').click();
        await page.waitForFunction(() => document.querySelector('#sendBtn').dataset.stopping === 'false');
      };
      await send('2+2');
      assert.match(await page.locator('.msg-row.ai .msg-body').last().textContent(), /4/);
      const downloadReady = page.waitForEvent('download');
      await page.locator('#exportBtn').click();
      const download = await downloadReady;
      assert.equal(download.suggestedFilename(), 'archiver-conversation.md');
      assert.match(await fs.readFile(await download.path(), 'utf8'), /2\+2/);
      assert.equal(new URL(page.url()).pathname, '/');
      assert.equal(new URL(page.url()).protocol, 'http:');
      await page.goto(base + '/api/health');
      await page.goBack();
      await page.waitForFunction(() => window.Archiver && document.querySelector('#setPersona').value);
      await send('What is the latest population of Zedland?');
      assert.match(await page.locator('.msg-row.ai .msg-body').last().textContent(), /Turn on WEB/);
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('Desktop/mobile WebKit: cold/cached startup, reload/back, local chat, evidence guard and blob export passed (no real inference).');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
