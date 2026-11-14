/* Browser-side search (web/archiver-browser-search.js), run against a model of
   the network instead of a browser.

   What this suite exists to pin — the 5.7 "search mode does not work at all"
   report:

   * a static host (GitHub Pages) is probed ONCE per page session, and the
     browser path answers immediately on every later search. Before 5.7 each
     search waited up to 6 s on that probe first;
   * a hanging source cannot hold the answer: each leg has its own deadline;
   * a dropped connection is retried once, and a source that stays broken is
     reported by category, not as "nothing found";
   * the search command itself ("search the web for …") is not sent to
     Wikipedia;
   * aborting a search aborts the requests under it.

   Real browsers are covered by tests/browser-safari.js; this suite is the
   logic. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'archiver-browser-search.js'), 'utf8');

let checks = 0;
function check(ok, message) {
  if (!ok) process.stderr.write('  FAIL  ' + message + '\n');
  assert.ok(ok, message);
  checks++;
  process.stderr.write('  ok    ' + message + '\n');
}

function json(value, status) {
  return {
    ok: (status || 200) < 400,
    status: status || 200,
    headers: { get: () => 'application/json' },
    json: async () => value
  };
}

function makeContext(fetchImpl) {
  const store = new Map();
  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    AbortController,
    DOMException,
    navigator: { onLine: true, connection: { effectiveType: '4g', downlink: 10 } },
    location: { href: 'https://2archiver.github.io/Archiver/' },
    document: { baseURI: 'https://2archiver.github.io/Archiver/', readyState: 'complete', addEventListener() {} },
    sessionStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    },
    fetch: fetchImpl,
    __store: store
  };
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(source, ctx, { filename: 'archiver-browser-search.js' });
  return ctx;
}

const WIKI_SEARCH = 'https://en.wikipedia.org/w/api.php';
const HN = 'https://hn.algolia.com';

function wikiFixture(calls, opts) {
  const o = opts || {};
  return async (url, init) => {
    calls.push(String(url));
    if (String(url).includes('/api/search')) return json({ detail: 'Not Found' }, 404);
    if (String(url).includes(WIKI_SEARCH) && String(url).includes('list=search')) {
      /* A real fetch rejects with AbortError when its signal fires; the stub
         has to as well, or the deadline in the module would look ineffective. */
      if (o.wikiHangs) return new Promise((resolve, reject) => {
        const signal = init && init.signal;
        const timer = setTimeout(() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), 60000);
        if (signal) signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
      if (o.wikiDropsOnce && !o.dropped) {
        o.dropped = true;
        throw new TypeError('Load failed');           // what Safari reports for a dropped connection
      }
      return json({ query: { search: [{ title: 'Silk Road', snippet: 'A network of <b>trade</b> routes.' }] } });
    }
    if (String(url).includes(WIKI_SEARCH) && String(url).includes('prop=extracts')) {
      return json({ query: { pages: { 1: {
        title: 'Silk Road',
        extract: 'The Silk Road was a network of Eurasian trade routes active from the second century BCE.',
        fullurl: 'https://en.wikipedia.org/wiki/Silk_Road'
      } } } });
    }
    if (String(url).includes(HN)) return json({ hits: [] });
    return json({}, 404);
  };
}

(async () => {
  /* ---- a static host is probed once, and the browser path answers ---- */
  {
    const calls = [];
    const ctx = makeContext(wikiFixture(calls));
    const first = await ctx.ArchiverBrowserSearch.search('history of the Silk Road', 3);
    check(first.results.length === 1, 'Wikipedia result');
    check(first.results[0].url === 'https://en.wikipedia.org/wiki/Silk_Road', 'canonical URL');
    check(/Eurasian trade routes/.test(first.report.headline), 'report headline from the extract');
    check(first.unverified === false, 'sourced answer is not marked unverified');

    const before = calls.length;
    await ctx.ArchiverBrowserSearch.search('Silk Road traders', 3);
    check(calls.length > before, 'the second search still runs');
    check(calls.slice(before).every((u) => !u.includes('/api/search')), 'the browser module never calls the server endpoint itself');
  }

  /* ---- the search command is not sent to Wikipedia ---- */
  {
    const calls = [];
    const ctx = makeContext(wikiFixture(calls));
    await ctx.ArchiverBrowserSearch.search('search the web for the history of the Silk Road', 3);
    const searchUrl = calls.find((u) => u.includes('list=search'));
    const term = new URL(searchUrl).searchParams.get('srsearch');
    check(!/search the web/i.test(term), 'command boilerplate stripped: ' + term);
    check(/Silk Road/i.test(term), 'the subject survives: ' + term);
  }

  /* ---- a hanging source does not hold the answer ---- */
  {
    const calls = [];
    const ctx = makeContext(wikiFixture(calls, { wikiHangs: true }));
    const started = Date.now();
    const out = await ctx.ArchiverBrowserSearch.search('something obscure', 3);
    const took = Date.now() - started;
    check(out.results.length === 0, 'no results when the only source hangs');
    check(took < 9500, 'the search gave up on its own deadline (' + took + 'ms)');
    check(/timeout|timed out/.test(out.error || ''), 'the failure is named as a timeout: ' + out.error);
  }

  /* ---- a dropped connection is retried once ---- */
  {
    const calls = [];
    const ctx = makeContext(wikiFixture(calls, { wikiDropsOnce: true }));
    const out = await ctx.ArchiverBrowserSearch.search('history of the Silk Road', 3);
    check(out.results.length === 1, 'the retry recovered the Wikipedia result');
    check(calls.filter((u) => u.includes('list=search')).length === 2, 'exactly one retry');
  }

  /* ---- a blocked source is reported as blocked, not as empty ---- */
  {
    const ctx = makeContext(async (url) => {
      if (String(url).includes('/api/search')) return json({}, 404);
      return json({}, 403);
    });
    const out = await ctx.ArchiverBrowserSearch.search('anything', 3);
    check(out.results.length === 0, 'nothing usable');
    check(/blocked|HTTP 403/.test(out.error || ''), 'the 403 is named as blocked: ' + out.error);
  }

  /* ---- aborting stops the requests underneath ---- */
  {
    let aborted = 0;
    const ctx = makeContext(async (url, init) => {
      if (String(url).includes('/api/search')) return json({}, 404);
      if (init && init.signal) {
        init.signal.addEventListener('abort', () => { aborted++; });
      }
      /* A real fetch rejects with AbortError; a promise that never settles
         would hide a search that ignores its signal. */
      return new Promise((resolve, reject) => {
        if (init && init.signal) {
          init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }
      });
    });
    const ctl = new AbortController();
    const p = ctx.ArchiverBrowserSearch.search('history of the Silk Road', 3, ctl.signal);
    setTimeout(() => ctl.abort(), 30);
    await assert.rejects(p, (e) => e.name === 'AbortError');
    check(aborted >= 1, 'the in-flight request was aborted, not left running');
    checks++;
  }

  /* ---- the engine's webSearch: server first, then the browser, memoized ---- */
  {
    const calls = [];
    let installed = null;
    const ctx = makeContext(wikiFixture(calls));
    ctx.Archiver = {
      webSearch: async () => ({ results: [], error: 'the engine default' })
    };
    // Re-run the module now that there is an engine to wire into.
    vm.runInContext(source, ctx, { filename: 'archiver-browser-search.js' });
    installed = ctx.Archiver;
    const one = await installed.webSearch('history of the Silk Road', 3);
    check(one.results.length === 1, 'no server: the browser path answered');
    check(calls.filter((u) => u.includes('/api/search')).length === 1, 'the server was probed exactly once');

    const two = await installed.webSearch('more Silk Road', 3);
    check(two.results.length === 1, 'the second search answered from the browser');
    check(calls.filter((u) => u.includes('/api/search')).length === 1, 'the static host is remembered, not re-probed');
    check(JSON.parse(ctx.__store.get('archiver.search.server')).online === false, 'the probe result is stored for the session');
  }

  /* ---- a live server wins, and is not replaced by the browser path ---- */
  {
    const calls = [];
    const ctx = makeContext(async (url) => {
      calls.push(String(url));
      if (String(url).includes('/api/search')) {
        return json({ results: [{ title: 'Server result', url: 'https://example.com/a', source: 'server', quote: 'from the server' }], report: null, error: null });
      }
      return json({ query: { search: [] } });
    });
    ctx.Archiver = { webSearch: async () => ({}) };
    vm.runInContext(source, ctx, { filename: 'archiver-browser-search.js' });
    const out = await ctx.Archiver.webSearch('anything at all', 3);
    check(out.results.length === 1 && out.results[0].title === 'Server result', 'the server result is used when there is a server');
    check(!calls.some((u) => u.includes('wikipedia.org')), 'no third-party request when the server answered');
  }

  /* The module keeps a 250 ms boot poll alive when there is no engine to wire
     into yet; the assertions are done, so do not wait it out. Written
     synchronously because a pending pipe write is dropped by process.exit(). */
  require('node:fs').writeSync(1, '\nsearch: ' + checks + ' checks passed\n');
  process.exit(0);
})().catch((err) => {
  process.stderr.write('search suite failed: ' + ((err && err.stack) || err) + '\n');
  process.exit(1);
});
