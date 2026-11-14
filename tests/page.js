/* Page-level checks in a DOM: the real index.html, the real scripts, a static
   host (no backend), and the two things people reported in 5.7.

   Why this exists: the suites in this directory test modules. The bug that
   people actually hit — "search mode does not work at all" — only appeared when
   the whole page booted, because the search module is injected by another
   script and has to install over the engine's server-only search before the
   first question. That interaction is not visible to a module test.

   jsdom is not a repository dependency (the project ships no npm build step),
   so this suite SKIPS with a clear line when jsdom is not installed, and runs
   fully when it is:

       npm install --no-save jsdom && node tests/page.js
*/
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require('jsdom'));
} catch (_) {
  console.log('page: skipped (jsdom not installed — `npm install --no-save jsdom` to run it)');
  process.exit(0);
}

const ROOT = path.join(__dirname, '..', 'web');
let checks = 0;
function check(ok, message) {
  if (!ok) console.log('  FAIL  ' + message);
  assert.ok(ok, message);
  checks++;
  console.log('  ok    ' + message);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function loadPage(options) {
  const o = options || {};
  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
    .replace(/src="static\//g, 'src="file://' + ROOT + '/')
    .replace(/href="static\//g, 'href="file://' + ROOT + '/');
  const problems = [];
  const calls = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => problems.push(e.message || String(e)));
  vc.on('error', (...args) => problems.push('console.error: ' + args.join(' ')));
  const json = (value) => new Response(JSON.stringify(value), {
    status: 200, headers: { 'content-type': 'application/json' }
  });

  const dom = new JSDOM(html, {
    url: 'https://2archiver.github.io/Archiver/',
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(win) {
      Object.defineProperty(win.navigator, 'hardwareConcurrency', { value: o.cores || 8, configurable: true });
      win.fetch = async (input) => {
        const url = String(input && input.url !== undefined ? input.url : input);
        calls.push(url);
        if (/api\//.test(url)) return new Response('', { status: 404 });
        if (/wikipedia\.org/.test(url) && /list=search/.test(url)) {
          return json({ query: { search: [{ title: 'Silk Road', snippet: 'A network of <b>trade</b> routes.' }] } });
        }
        if (/wikipedia\.org/.test(url) && /prop=extracts/.test(url)) {
          return json({ query: { pages: { 1: {
            title: 'Silk Road',
            extract: 'The Silk Road was a network of Eurasian trade routes active from the second century BCE.',
            fullurl: 'https://en.wikipedia.org/wiki/Silk_Road'
          } } } });
        }
        if (/hn\.algolia/.test(url)) return json({ hits: [] });
        return new Response('', { status: 404 });
      };
      win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    }
  });
  return { dom, win: dom.window, doc: dom.window.document, problems, calls };
}

async function waitForAnswer(doc, pattern) {
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    const rows = doc.querySelectorAll('.msg-row.ai');
    if (rows.length && pattern.test(rows[rows.length - 1].textContent) && !doc.querySelector('.think-live')) {
      return rows[rows.length - 1];
    }
  }
  const rows = doc.querySelectorAll('.msg-row.ai');
  return rows.length ? rows[rows.length - 1] : null;
}

(async () => {
  const p = loadPage();
  await new Promise((r) => p.win.addEventListener('load', r));
  await sleep(400);
  const { win, doc, problems, calls } = p;

  /* ---- the page boots, with the browser search installed ---- */
  check(!!win.Archiver, 'the engine loaded');
  check(win.Archiver.__browserSearchWired === true, 'browser search installed over the server-only search');
  check(problems.length === 0, 'no script errors at boot' + (problems.length ? ': ' + problems[0] : ''));

  /* ---- SEARCH is a real control ---- */
  doc.getElementById('cbSearch').click();
  await sleep(30);
  check(doc.getElementById('cbSearch').getAttribute('aria-pressed') === 'true', 'SEARCH reports its pressed state');
  check(doc.getElementById('toggleSearch').getAttribute('aria-pressed') === 'true', 'both SEARCH controls agree');

  /* ---- a search on a static host answers from the web ---- */
  const input = doc.getElementById('chatInput');
  input.value = 'Search the web for the history of the Silk Road';
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  doc.getElementById('sendBtn').click();
  const row = await waitForAnswer(doc, /Eurasian trade routes/);
  check(!!row, 'the answer arrived');
  check(/Eurasian trade routes/.test(row.textContent), 'the answer carries the fetched text');
  const links = Array.from(row.querySelectorAll('a')).map((a) => a.getAttribute('href'));
  check(links.includes('https://en.wikipedia.org/wiki/Silk_Road'), 'the Wikipedia source is linked');
  check(calls.filter((u) => u.includes('wikipedia.org')).length >= 1, 'Wikipedia was called directly from the page');
  check(doc.querySelectorAll('.toast.err').length === 0, 'no error toast');
  check(!doc.querySelector('.think-live'), 'the thinking indicator was removed when the answer landed');

  /* ---- quiet mode: switch, persistence, coalesced paints ---- */
  const eco = doc.getElementById('ecoToggle');
  check(!!eco && eco.checked, 'quiet mode is on by default in Settings');
  eco.checked = false;
  eco.dispatchEvent(new win.Event('change', { bubbles: true }));
  await sleep(30);
  check(win.ArchiverPrep.snapshot().quiet === false, 'switching quiet mode off reaches the controller');
  check(win.Archiver.quietMode() === false, 'switching quiet mode off reaches the engine');
  check(win.localStorage.getItem('archiver.quiet') === 'off', 'the choice is stored');
  eco.checked = true;
  eco.dispatchEvent(new win.Event('change', { bubbles: true }));
  await sleep(30);
  check(win.ArchiverPrep.snapshot().quiet === true, 'switching it back on reaches the controller');

  let paints = 0;
  const status = win.Archiver.status;
  win.Archiver.status = function () { paints++; return status.apply(this, arguments); };
  await sleep(300);          // let any paint already scheduled by the last answer land
  const baseline = paints;
  /* Every controller emission is one progress tick; 40 of them in a burst is
     what a download produces in a second. */
  for (let i = 0; i < 40; i++) win.ArchiverPrep.setQuiet(true);
  await sleep(700);
  const burst = paints - baseline;
  check(burst >= 1, 'preparation ticks still repaint at least once (' + burst + ')');
  check(burst <= 6, 'a burst of preparation ticks repaints a handful of times, not forty (' + burst + ')');

  /* ---- streaming: plain text while it arrives, markdown once at the end ----
     This is the shape of the "Edge crawls while the model is loaded" report:
     the answer used to be re-parsed as markdown on every animation frame. */
  {
    const chat = win.Archiver.chat;
    win.Archiver.chat = async function (message, history, opts) {
      const pieces = ['The Silk Road ', 'was **a network** ', 'of routes.\n\n', '- one\n', '- two\n'];
      for (const piece of pieces) {
        opts.onDelta(piece);
        await new Promise((r) => setTimeout(r, 20));
      }
      return pieces.join('');
    };
    doc.getElementById('cbSearch').click();            // back off: no web call
    await sleep(20);
    const streamInput = doc.getElementById('chatInput');
    streamInput.value = 'Tell me about the Silk Road routes';
    streamInput.dispatchEvent(new win.Event('input', { bubbles: true }));
    doc.getElementById('sendBtn').click();
    /* Mid-stream: the bubble holds plain text (the ** is still literal) and a cursor. */
    let mid = null;
    for (let i = 0; i < 40; i++) {
      await sleep(25);
      const rows = doc.querySelectorAll('.msg-row.ai');
      const last = rows[rows.length - 1];
      if (last && /Silk Road was/.test(last.textContent) && !/one/.test(last.textContent)) { mid = last; break; }
    }
    check(!!mid, 'the answer is painted while it arrives');
    check(mid && /\*\*a network\*\*/.test(mid.textContent), 'mid-stream paint is plain text, not re-parsed markdown');
    check(mid && !!mid.querySelector('.cursor-blink'), 'the streaming cursor is present mid-answer');
    const done = await waitForAnswer(doc, /one/);
    check(!!done && !!done.querySelector('b'), 'the finished answer is rendered as markdown');
    check(!done || !done.querySelector('.cursor-blink'), 'the cursor is gone once the answer is complete');
    win.Archiver.chat = chat;
  }

  /* ---- a hidden tab gives the runtime back, after the delay ---- */
  Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => 'hidden' });
  doc.dispatchEvent(new win.Event('visibilitychange'));
  let unloaded = 0;
  const unload = win.Archiver.unload;
  win.Archiver.unload = function () { unloaded++; return unload.apply(this, arguments); };
  await sleep(200);
  check(unloaded === 0, 'nothing is released immediately when the tab is hidden');

  console.log('\npage: ' + checks + ' checks passed');
  process.exit(0);
})().catch((err) => {
  console.log('page suite failed: ' + ((err && err.stack) || err));
  process.exit(1);
});
