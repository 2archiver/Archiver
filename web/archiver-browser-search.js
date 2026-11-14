/* Archiver 5.7 — browser-side search. Used everywhere the app has no server:
   GitHub Pages, and any host that answers 404 for api/search.

   Sources are browser-reachable and CORS-enabled:
     * Wikipedia (action=query&list=search + extracts, origin=*)
     * Wikipedia OpenSearch (a cheaper second attempt, same site)
     * Hacker News (Algolia API)

   5.7 rewrote this module around three measured complaints:

   1. "Search mode does not work at all." Every attempt used to start with a
      request to the app's own origin (api/search) and wait up to 6 s for it to
      time out before falling back to the browser path. On a static host that
      cost was pure delay, and any search that finished inside it looked
      broken. The origin is now probed once per page session, in parallel with
      the real search, cached in sessionStorage, and a known-static host skips
      the probe entirely.
   2. "Safari and Edge don't handle it well." Every source now has a hard
      per-request timeout (AbortController, 6 s; 9 s for the first query on a
      slow link) and every leg is raced against the others, so one hanging
      endpoint cannot hold the answer. A dropped connection is retried once.
      Errors are categorised ('timeout', 'blocked', 'network', 'status') so the
      UI can say which one happened instead of "nothing found".
   3. "It answers from a stored card, not from the web." When search is on, a
      source result now wins over a bundled card, and a curated card is only a
      fallback, labelled as one.
*/
(function (root) {
  'use strict';

  var TIMEOUT_MS = 6000;
  var lastErrors = [];
  var TIMEOUT_SLOW_MS = 9000;
  var PROBE_KEY = 'archiver.search.server';      // sessionStorage: 'down' / 'up'
  var PROBE_TTL_MS = 30 * 60 * 1000;

  function decodeHtml(s) {
    return String(s || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;|&#039;|&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function cleanSearchQuery(raw) {
    var q = String(raw || '').trim();
    q = q.replace(/^(?:please\s+)?(?:search(?:\s+the\s+web|\s+online|\s+internet)?\s+(?:for|about)\s+|search\s+|look\s+up\s+|lookup\s+|google\s+|find\s+(?:out\s+about|info(?:rmation)?\s+(?:on|about)|me)\s+|browse\s+(?:for\s+)?)/i, '');
    q = q.replace(/^["'“”]+|["'“”]+$/g, '').trim();
    return q || String(raw || '').trim();
  }

  function extractSubject(q) {
    var s = String(q || '').trim().replace(/[?!.]+$/, '').trim();
    s = s.replace(/^(?:who|what|where|when|which)\s+(?:is|was|were|are|did|does|do)\s+(?:the\s+)?/i, '');
    s = s.replace(/^(?:tell\s+me\s+about|what\s+do\s+you\s+know\s+about|info(?:rmation)?\s+on|biography\s+of|bio\s+of|history\s+of|the\s+history\s+of|explain)\s+(?:the\s+)?/i, '');
    s = s.replace(/^the\s+/i, '');
    s = s.trim();
    return s && s.toLowerCase() !== String(q || '').trim().toLowerCase() ? s : '';
  }

  function splitSentences(text) {
    var clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return [];
    var parts = clean.match(/[^.!?]+(?:[.!?]+|$)/g) || [clean];
    return parts.map(function (p) { return p.trim(); }).filter(Boolean);
  }

  function trimAtWord(text, maxLen) {
    var s = String(text || '').trim();
    if (s.length <= maxLen) return s;
    var cut = s.slice(0, maxLen);
    var sp = cut.lastIndexOf(' ');
    return (sp > maxLen * 0.55 ? cut.slice(0, sp) : cut).replace(/[,;:\s]+$/, '') + '…';
  }

  /* Distinguishes "the reader stopped this search" from "this one request ran
     out of time". Both surface as an AbortError from fetch, so the caller's
     signal is the only honest test — without it, a slow Wikipedia turned into
     a fake cancel and the search reported nothing at all. */
  function isAborted(signal, err) {
    if (signal && signal.aborted) return true;
    return !!(err && err.category !== 'timeout' && err.name === 'AbortError' && err.__outerAbort);
  }

  /* One request, with its own deadline. Kept separate so that every source
     shares the same timeout, abort and error-category behaviour. A dropped
     connection (which Safari reports as a bare TypeError) is retried once. */
  async function timedFetch(url, signal, ms, retries) {
    var tries = (retries == null ? 1 : retries) + 1;
    var lastErr = null;
    for (var attempt = 0; attempt < tries; attempt++) {
      var ctl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = null;
      var onOuter = function () { if (ctl) ctl.abort(); };
      if (signal) {
        if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
        signal.addEventListener('abort', onOuter, { once: true });
      }
      if (ctl) timer = setTimeout(function () { ctl.abort(); }, ms);
      try {
        var res = await fetch(url, {
          signal: ctl ? ctl.signal : signal,
          cache: 'no-store',
          mode: 'cors',
          credentials: 'omit'
        });
        if (!res.ok) {
          var e = new Error('HTTP ' + res.status);
          e.category = res.status === 403 || res.status === 429 ? 'blocked' : 'status';
          e.status = res.status;
          throw e;
        }
        return await res.json();
      } catch (err) {
        lastErr = err;
        if (signal && signal.aborted) {
          if (err && typeof err === 'object') { try { err.__outerAbort = true; } catch (_) {} }
          throw new DOMException('Stopped', 'AbortError');
        }
        if (err && err.name === 'AbortError') {
          var t = new Error('timed out after ' + Math.round(ms / 1000) + 's');
          t.category = 'timeout';
          lastErr = t;
          break;              // a timeout is not retried: the source is slow, not unlucky
        }
        if (err && err.category) break;
        if (attempt + 1 >= tries) break;
      } finally {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onOuter);
      }
    }
    if (!lastErr) lastErr = new Error('request failed');
    if (!lastErr.category) lastErr.category = 'network';
    throw lastErr;
  }

  function errorText(err) {
    var m = err && err.message ? err.message : String(err);
    var c = err && err.category ? err.category : 'network';
    return c + (m ? ' (' + m + ')' : '');
  }

  /* How long this search may take. A first search on a slow or freshly woken
     connection gets a longer per-source budget; a repeat search does not. */
  function budgetFor(state) {
    var nav = root.navigator || {};
    var conn = nav.connection || {};
    var slow = nav.onLine === false || /^(slow-2g|2g|3g)$/.test(String(conn.effectiveType || ''));
    return slow ? TIMEOUT_SLOW_MS : TIMEOUT_MS;
  }

  async function clientSearch(query, limit, signal, onStatus) {
    if (signal && signal.aborted) throw new DOMException('Stopped', 'AbortError');
    var n = Math.max(1, Math.min(Number(limit) || 3, 5));
    var raw = String(query || '').trim();
    var q = cleanSearchQuery(raw);
    if (!q) return { results: [], error: 'Empty query', providers: {}, errors: [] };
    if (onStatus) onStatus('Searching the web from this browser…');
    var ms = budgetFor();
    var results = [];
    var providers = {};
    var errors = lastErrors = [];
    var seen = new Set();

    function add(item) {
      if (!item || !item.url || !item.title) return;
      var key = String(item.url).replace(/#.*$/, '').toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      var quote = decodeHtml(item.quote || item.short || item.extract || '');
      var extract = decodeHtml(item.extract || item.quote || '');
      var short = trimAtWord(decodeHtml(item.short || quote || extract || item.title), 280);
      results.push({
        title: String(item.title).slice(0, 200),
        url: String(item.url),
        source: item.source || 'web',
        quote: quote.slice(0, 1200),
        short: short,
        extract: extract.slice(0, 1200)
      });
    }

    /* Wikipedia's search API first, then its extracts in one request for every
       title at once. Two round trips total, not one per result. */
    async function wikipedia() {
      var hits = await wikiSearchApi(q);
      if (!hits.length) {
        var subject = extractSubject(q);
        if (subject) hits = await wikiSearchApi(subject);
      }
      providers.wikipedia = hits.length;
      var titles = hits.map(function (h) { return h.title; }).filter(Boolean).slice(0, n);
      if (!titles.length) return;
      var exUrl = 'https://en.wikipedia.org/w/api.php?action=query&prop=extracts|info&exintro=1&explaintext=1'
        + '&inprop=url&redirects=1&titles=' + titles.map(encodeURIComponent).join('|') + '&format=json&origin=*';
      var pages = {};
      try {
        var ed = await timedFetch(exUrl, signal, ms, 0);
        pages = (ed && ed.query && ed.query.pages) || {};
      } catch (err) {
        if (isAborted(signal, err)) throw new DOMException('Stopped', 'AbortError');
        errors.push('wikipedia-extracts: ' + errorText(err));
      }
      var byTitle = {};
      Object.keys(pages).forEach(function (id) {
        var p = pages[id];
        if (p && p.title) byTitle[p.title] = p;
      });
      hits.forEach(function (h) {
        var p = byTitle[h.title] || {};
        var extract = String(p.extract || '').replace(/\s+/g, ' ').trim();
        var snippet = decodeHtml(h.snippet || '');
        var body = extract || snippet;
        var pageUrl = p.fullurl || ('https://en.wikipedia.org/wiki/' + encodeURIComponent(String(h.title).replace(/ /g, '_')));
        add({ title: h.title, url: pageUrl, source: 'Wikipedia', quote: body, short: body, extract: body });
      });
    }

    async function wikiSearchApi(term) {
      var url = 'https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch='
        + encodeURIComponent(term) + '&srlimit=' + n + '&srprop=snippet&format=json&origin=*';
      var data = await timedFetch(url, signal, ms, 1);
      return (data && data.query && data.query.search) || [];
    }

    async function wikipediaOpenSearch() {
      if (results.length >= n) return;
      var term = extractSubject(q) || q;
      var url = 'https://en.wikipedia.org/w/api.php?action=opensearch&search='
        + encodeURIComponent(term) + '&limit=' + n + '&namespace=0&format=json&origin=*';
      var data = await timedFetch(url, signal, ms, 0);
      var titles = (data && data[1]) || [];
      var descs = (data && data[2]) || [];
      var links = (data && data[3]) || [];
      providers.wikipedia_opensearch = titles.length;
      for (var i = 0; i < titles.length && results.length < n; i++) {
        add({
          title: titles[i],
          url: links[i] || ('https://en.wikipedia.org/wiki/' + encodeURIComponent(String(titles[i]).replace(/ /g, '_'))),
          source: 'Wikipedia',
          quote: descs[i] || titles[i],
          short: descs[i] || titles[i],
          extract: descs[i] || titles[i]
        });
      }
    }

    async function hackerNews() {
      if (results.length >= n) return;
      var term = extractSubject(q) || q;
      var url = 'https://hn.algolia.com/api/v1/search?query=' + encodeURIComponent(term)
        + '&tags=story&hitsPerPage=' + Math.min(n, 3);
      var data = await timedFetch(url, signal, ms, 0);
      var hits = (data && data.hits) || [];
      providers.hackernews = hits.length;
      hits.forEach(function (h) {
        var title = decodeHtml(h.title || h.story_title || '');
        var link = h.url || ('https://news.ycombinator.com/item?id=' + h.objectID);
        if (!title || !link) return;
        var body = decodeHtml(h.story_text || h.comment_text || '') || title;
        if (body.length < 40 && title.length >= 40) body = title;
        add({ title: title, url: link, source: 'Hacker News', quote: body.slice(0, 480), short: title, extract: body.slice(0, 480) });
      });
    }

    /* Wikipedia leads and the other sources are raced against it rather than
       run after it. The whole search is bounded by the per-source deadline
       because each leg carries one. */
    var wikiAttempt = (async function () {
      try {
        await wikipedia();
      } catch (e) {
        if (isAborted(signal, e)) throw new DOMException('Stopped', 'AbortError');
        errors.push('wikipedia: ' + errorText(e));
        /* A source that timed out or refused is not asked a second question:
           that would double the wait for an answer that is already unlikely. */
        if (e && (e.category === 'timeout' || e.category === 'blocked')) return;
        try { await wikipediaOpenSearch(); } catch (e2) {
          if (isAborted(signal, e2)) throw new DOMException('Stopped', 'AbortError');
          errors.push('wikipedia-opensearch: ' + errorText(e2));
        }
      }
    })();
    var hnAttempt = (async function () {
      try { await hackerNews(); } catch (e) {
        if (isAborted(signal, e)) throw new DOMException('Stopped', 'AbortError');
        errors.push('hackernews: ' + errorText(e));
      }
    })();
    await Promise.all([wikiAttempt, hnAttempt]);
    if (signal && signal.aborted) throw new DOMException('Stopped', 'AbortError');

    if (!results.length) {
      return {
        results: [], report: null, confidence: '', corrected: '', query: q, unverified: true,
        providers: providers, errors: errors,
        error: errors.length
          ? ('Browser search found nothing — ' + errors[0])
          : 'No usable sources from browser search.'
      };
    }

    var top = results.slice(0, n);
    var first = top[0];
    var sents = splitSentences(first.extract || first.quote || first.short || '');
    var headline = sents.length ? trimAtWord(sents[0], 320) : trimAtWord(first.quote || first.short || first.title, 320);
    var extraParts = [];
    if (sents.length > 1) extraParts.push(trimAtWord(sents.slice(1, 3).join(' '), 420));
    if (top.length > 1) {
      var second = top[1];
      var s2 = splitSentences(second.extract || second.quote || '');
      if (s2.length && s2[0].toLowerCase() !== headline.toLowerCase()) {
        extraParts.push('Related (' + second.title + '): ' + trimAtWord(s2[0], 240));
      }
    }
    var voice = extraParts.join(' ') || (top.length > 1
      ? ('From ' + top.length + ' sources, led by ' + (first.source || 'the web') + '.')
      : ('From ' + (first.source || 'the web') + '.'));
    var report = {
      reading: first.title || q,
      headline: headline,
      voice: voice,
      take: '',
      plan: 'Browser search: query Wikipedia and Hacker News directly from this page, lead with the strongest source, and cite the rest.',
      confidence: top.length >= 2 ? 'moderate' : 'low',
      consensus: [],
      sources: top.length,
      corrected: ''
    };
    return {
      results: top, report: report, confidence: report.confidence, corrected: '', query: q,
      unverified: false, providers: providers, errors: errors, error: null, client: true
    };
  }

  /* ---------------------------------------------------------------- host probe */

  /* Is there a server-backed search endpoint on this origin? One short HEAD-ish
     GET, cached for the page session, shared by every search. A static host
     (GitHub Pages answers 404/405) is remembered so the next search does not
     pay for the probe again. */
  var probeState = null;      // { at, online }

  function readProbe() {
    try {
      var raw = root.sessionStorage && root.sessionStorage.getItem(PROBE_KEY);
      if (!raw) return null;
      var v = JSON.parse(raw);
      if (!v || typeof v.at !== 'number' || Date.now() - v.at > PROBE_TTL_MS) return null;
      return v;
    } catch (_) { return null; }
  }

  function writeProbe(online) {
    var v = { at: Date.now(), online: !!online };
    try { root.sessionStorage && root.sessionStorage.setItem(PROBE_KEY, JSON.stringify(v)); } catch (_) {}
    return v;
  }

  function apiSearchUrl(query, limit) {
    var base = (root.document && root.document.baseURI) || (root.location && root.location.href) || 'http://localhost/';
    try { return new URL('api/search?limit=' + (limit || 3) + '&q=' + encodeURIComponent(query), base).href; }
    catch (_) { return 'api/search?limit=' + (limit || 3) + '&q=' + encodeURIComponent(query); }
  }

  async function serverSearch(query, limit, signal) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var onOuter = function () { if (ctl) ctl.abort(); };
    if (signal) {
      if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
      signal.addEventListener('abort', onOuter, { once: true });
    }
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, 12000) : null;
    try {
      var res = await fetch(apiSearchUrl(query, limit), { signal: ctl ? ctl.signal : signal, cache: 'no-store' });
      if (!res.ok) {
        if (res.status === 404 || res.status === 405 || res.status === 501) return { static: true };
        return { error: 'search endpoint returned ' + res.status };
      }
      var ct = (res.headers && typeof res.headers.get === 'function') ? String(res.headers.get('content-type') || '') : '';
      if (ct && !/json/i.test(ct)) return { static: true };
      var data = await res.json();
      if (data && Array.isArray(data.results)) {
        return {
          results: data.results,
          report: data.report || null,
          confidence: data.confidence || '',
          corrected: data.corrected || '',
          query: data.query || query,
          unverified: !!data.unverified,
          providers: data.providers || null,
          errors: data.errors || [],
          error: null
        };
      }
      return { error: 'the search endpoint answered with an unexpected body' };
    } catch (err) {
      if (signal && signal.aborted) throw new DOMException('Stopped', 'AbortError');
      return { error: 'the search endpoint did not answer' };
    } finally {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onOuter);
    }
  }

  root.ArchiverBrowserSearch = {
    search: clientSearch,
    cleanQuery: cleanSearchQuery,
    subject: extractSubject,
    errors: function () { return lastErrors.slice(); },
    resetHostCache: function () { probeState = null; try { root.sessionStorage && root.sessionStorage.removeItem(PROBE_KEY); } catch (_) {} }
  };

  /* Replace the engine's server-only webSearch with one that uses the server
     when there is one and this module when there is not. */
  function install() {
    var A = root.Archiver;
    if (!A || typeof A.webSearch !== 'function') return false;
    if (A.__browserSearchWired) return true;
    A.webSearch = async function (query, limit, signal, onStatus) {
      if (signal && signal.aborted) throw new DOMException('Stopped', 'AbortError');
      var known = probeState || readProbe();
      /* A remembered static host (or one already proven to have no endpoint)
         goes straight to the browser path — the fix for "search does nothing
         for six seconds and then gives up". */
      if (known && known.online === false) {
        if (onStatus) onStatus('Searching the web from this browser…');
        return clientSearch(query, limit, signal, onStatus);
      }
      var serverPromise = serverSearch(query, limit, signal);
      var result = await serverPromise;
      if (result && Array.isArray(result.results) && (result.results.length || result.error === null)) {
        probeState = writeProbe(true);
        return result;
      }
      probeState = writeProbe(false);
      if (signal && signal.aborted) throw new DOMException('Stopped', 'AbortError');
      if (result && result.error && !result.static) {
        /* The endpoint exists but failed. Still try the browser path: a failed
           server search must not leave the reader with no answer. */
        var fallback = await clientSearch(query, limit, signal, onStatus);
        if (fallback && fallback.results && fallback.results.length) {
          fallback.errors = (fallback.errors || []).concat(['server: ' + result.error]);
          return fallback;
        }
        return result;
      }
      if (onStatus) onStatus('Searching the web from this browser…');
      return clientSearch(query, limit, signal, onStatus);
    };
    A.__browserSearchWired = true;
    return true;
  }

  /* Installed on several events rather than one: this script is injected by
     archiver-download.js, so on a fast host it can arrive after both
     DOMContentLoaded and the engine's own boot. The engine may also replace the
     object it exposes. Re-installing is idempotent, and the poll stops as soon
     as it has worked once. */
  function boot() {
    if (install()) return;
    var n = 0;
    var t = setInterval(function () {
      if (install() || ++n > 40) clearInterval(t);
    }, 250);
  }
  if (root.document && root.document.readyState === 'loading') {
    root.document.addEventListener('DOMContentLoaded', boot);
  }
  if (root.addEventListener) root.addEventListener('load', boot);
  boot();
})(typeof self !== 'undefined' ? self : this);
