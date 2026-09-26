/* Optional end-to-end checks. Install Playwright separately, run the app, then:
   NODE_PATH=/path/to/node_modules node tests/browser.js
   CHROMIUM_EXECUTABLE and BASE_URL may override the browser and app URL. */
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const errors = [], external = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (!r.url().startsWith(process.env.BASE_URL || 'http://127.0.0.1:8000')) external.push(r.url()); });
    // A sleeping server must not hold up instant-mode replies.
    await page.route('**/api/chat/prepare', () => {});
    await page.goto(process.env.BASE_URL || 'http://127.0.0.1:8000');
    const send = async text => {
      await page.locator('#chatInput').fill(text);
      await page.locator('#sendBtn').click();
      await page.waitForFunction(() => document.querySelector('#sendBtn').dataset.stopping === 'false');
      return page.locator('.msg-row.ai .msg-body').last().textContent();
    };
    const start = Date.now();
    assert.match(await send('Compare Python and JavaScript'), /Python.*JavaScript/s);
    assert.ok(Date.now() - start < 2500, 'instant answer must not wait for blocked prepare request');
    assert.equal(await send('one sentence'), 'Python is a general-purpose programming language with readable syntax and a large library ecosystem.');
    assert.match(await send('What is 18% of 250?'), /45/);
    const answerCountBeforeRetry = await page.locator('.msg-row.ai').count();
    await page.locator('.msg-row.ai').last().locator('[data-act="retry"]').click();
    await page.waitForFunction(count => document.querySelectorAll('.msg-row.ai').length === count, answerCountBeforeRetry);
    await page.waitForFunction(() => document.querySelector('#sendBtn').dataset.stopping === 'false');
    assert.match(await page.locator('.msg-row.ai').last().locator('.msg-body').textContent(), /45/);
    assert.equal(external.length, 0, 'no implicit model/CDN download');
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.msg-row.ai').length >= 3);
    assert.match(await send('one sentence'), /45/);
    for (const [width, height] of [[320, 568], [390, 844], [768, 1024], [844, 390], [1440, 900]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const dimensions = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth, viewport: innerWidth,
        bottom: document.querySelector('#sendBtn').getBoundingClientRect().bottom, height: innerHeight,
      }));
      assert.ok(dimensions.width <= dimensions.viewport, `no horizontal overflow at ${width}`);
      assert.ok(dimensions.bottom <= dimensions.height, `composer visible at ${width}x${height}`);
    }
    // Explicit themes must change both surface and text, irrespective of OS.
    const themeColors = [];
    for (const theme of ['light', 'dark']) {
      themeColors.push(await page.evaluate(theme => {
        document.documentElement.dataset.theme = theme;
        const body = getComputedStyle(document.body);
        const input = getComputedStyle(document.querySelector('.input-box'));
        return [body.backgroundColor, body.color, input.backgroundColor];
      }, theme));
    }
    assert.notDeepEqual(themeColors[0], themeColors[1]);
    // Untrusted pasted text remains text, even in assistant extracts.
    await send('summarize: <img src=x onerror="window.__xss=1">. Safe sentence.');
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    // Stop a genuinely pending web lookup. No late answer may be saved/rendered.
    await page.route('**/api/search?*', () => {});
    await page.locator('#toggleSearch').click();
    await page.locator('#chatInput').fill('battle of kursk');
    const searchRequest = page.waitForRequest('**/api/search?*');
    await page.locator('#sendBtn').click();
    await searchRequest;
    await page.locator('#cbStop').click();
    await page.waitForFunction(() => document.querySelector('#sendBtn').dataset.stopping === 'false');
    assert.match(await page.locator('.msg-row.ai .msg-body').last().textContent(), /stopped/);
    await page.locator('#toggleSearch').click();
    assert.match(await send('2+2'), /4/);
    const download = page.waitForEvent('download');
    await page.locator('#exportBtn').click();
    assert.equal((await download).suggestedFilename(), 'archiver-conversation.md');
    assert.deepEqual(errors, []);
    console.log('Browser checks passed: local latency under blocked server, 5 viewports, themes, escaping, Stop, next turn, and local export.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
