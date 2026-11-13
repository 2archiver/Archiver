/* Archiver 5.6 — browser-side search for GitHub Pages (no backend).
   Wikipedia (CORS origin=*) and Hacker News Algolia. Same result shape as server search. */
(function (root) {
  'use strict';

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
    let q = String(raw || '').trim();
    q = q.replace(/^(?:please\s+)?(?:search(?:\s+the\s+web|\s+online|\s+internet)?\s+(?:for|about)\s+|search\s+|look\s+up\s+|lookup\s+|google\s+|find\s+(?:out\s+about|info(?:rmation)?\s+(?:on|about)|me)\s+|browse\s+(?:for\s+)?)/i, '');
    q = q.replace(/^["'“”]+|["'“”]+$/g, '').trim();
    return q || String(raw || '').trim();
  }

  function extractSubject(q) {
    let s = String(q || '').trim().replace(/[?!.]+$/, '').trim();
    s = s.replace(/^(?:who|what|where|when)\s+(?:is|was|were|are|did)\s+(?:the\s+)?/i, '');
    s = s.replace(/^(?:tell\s+me\s+about|what\s+do\s+you\s+know\s+about|info(?:rmation)?\s+on|biography\s+of|bio\s+of|history\s+of)\s+(?:the\s+)?/i, '');
    s = s.trim();
    return s && s.toLowerCase() !== String(q || '').trim().toLowerCase() ? s : '';
  }

  function splitSentences(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return [];
    const parts = clean.match(/[^.!?]+(?:[.!?]+|$)/g) || [clean];
    return parts.map(p => p.trim()).filter(Boolean);
  }

  function trimAtWord(text, maxLen) {
    const s = String(text || '').trim();
    if (s.length <= maxLen) return s;
    const cut = s.slice(0, maxLen);
    const sp = cut.lastIndexOf(' ');
    return (sp > maxLen * 0.55 ? cut.slice(0, sp) : cut).replace(/[,;:\s]+$/, '') + '…';
  }

  function isAborted(signal, err) {
    return (signal && signal.aborted) || (err && err.name === 'AbortError');
  }

  async function clientSearch(query, limit, signal, onStatus) {
    if (signal && signal.aborted) throw new DOMException('Stopped', 'AbortError');
    const n = Math.max(1, Math.min(Number(limit) || 3, 5));
    const raw = String(query || '').trim();
    const q = cleanSearchQuery(raw);
    if (!q) return { results: [], error: 'Empty query', providers: {}, errors: [] };
    if (onStatus) onStatus('Searching the web from this browser…');
    const results = [];
    const providers = {};
    const errors = [];
    const seen = new Set();
    const fetchOpts = { signal, cache: 'no-store', mode: 'cors', credentials: 'omit' };

    function add(item) {
      if (!item || !item.url || !item.title) return;
      const key = String(item.url).replace(/#.*$/, '').toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      const quote = decodeHtml(item.quote || item.short || item.extract || '');
      const extract = decodeHtml(item.extract || item.quote || '');
      const short = trimAtWord(decodeHtml(item.short || quote || extract || item.title), 280);
      results.push({
        title: String(item.title).slice(0, 200),
        url: String(item.url),
        source: item.source || 'web',
        quote: quote.slice(0, 1200),
        short,
        extract: extract.slice(0, 1200)
      });
    }

    async function wikiQuery(term) {
      const url = 'https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch='
        + encodeURIComponent(term) + '&srlimit=' + n + '&srprop=snippet&format=json&origin=*';
      const res = await fetch(url, fetchOpts);
      if (!res.ok) throw new Error('wikipedia ' + res.status);
      const data = await res.json();
      return (data && data.query && data.query.search) || [];
    }

    async function wikiSearch() {
      let hits = await wikiQuery(q);
      if (!hits.length) {
        const subject = extractSubject(q);
        if (subject) hits = await wikiQuery(subject);
      }
      providers.wikipedia = hits.length;
      const titles = hits.map(h => h.title).filter(Boolean).slice(0, n);
      if (!titles.length) return;
      const exUrl = 'https://en.wikipedia.org/w/api.php?action=query&prop=extracts|info&exintro=1&explaintext=1&inprop=url&titles='
        + titles.map(t => encodeURIComponent(t)).join('|') + '&format=json&origin=*';
      let pages = {};
      try {
        const er = await fetch(exUrl, fetchOpts);
        if (er.ok) {
          const ed = await er.json();
          pages = (ed && ed.query && ed.query.pages) || {};
        }
      } catch (err) {
        if (isAborted(signal, err)) throw err;
      }
      const byTitle = {};
      Object.keys(pages).forEach(id => {
        const p = pages[id];
        if (p && p.title) byTitle[p.title] = p;
      });
      hits.forEach(h => {
        const p = byTitle[h.title] || {};
        const extract = String(p.extract || '').replace(/\s+/g, ' ').trim();
        const snippet = decodeHtml(h.snippet || '');
        const body = extract || snippet;
        const pageUrl = p.fullurl || ('https://en.wikipedia.org/wiki/' + encodeURIComponent(String(h.title).replace(/ /g, '_')));
        add({ title: h.title, url: pageUrl, source: 'Wikipedia', quote: body, short: body, extract: body });
      });
    }

    async function hnSearch() {
      const term = extractSubject(q) || q;
      const url = 'https://hn.algolia.com/api/v1/search?query=' + encodeURIComponent(term)
        + '&tags=story&hitsPerPage=' + Math.min(n, 3);
      const res = await fetch(url, fetchOpts);
      if (!res.ok) throw new Error('hn ' + res.status);
      const data = await res.json();
      const hits = (data && data.hits) || [];
      providers.hackernews = hits.length;
      hits.forEach(h => {
        const title = decodeHtml(h.title || h.story_title || '');
        const link = h.url || ('https://news.ycombinator.com/item?id=' + h.objectID);
        if (!title || !link) return;
        const body = decodeHtml(h.story_text || h.comment_text || '') || title;
        add({ title, url: link, source: 'Hacker News', quote: body.slice(0, 480), short: title, extract: body.slice(0, 480) });
      });
    }

    async function wikiOpenSearch() {
      if (results.length >= n) return;
      const term = extractSubject(q) || q;
      const url = 'https://en.wikipedia.org/w/api.php?action=opensearch&search='
        + encodeURIComponent(term) + '&limit=' + n + '&namespace=0&format=json&origin=*';
      const res = await fetch(url, fetchOpts);
      if (!res.ok) return;
      const data = await res.json();
      const titles = (data && data[1]) || [];
      const descs = (data && data[2]) || [];
      const links = (data && data[3]) || [];
      providers.wikipedia_opensearch = titles.length;
      for (let i = 0; i < titles.length && results.length < n; i++) {
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

    try {
      await wikiSearch();
    } catch (e) {
      if (isAborted(signal, e)) throw new DOMException('Stopped', 'AbortError');
      errors.push('wikipedia: ' + (e && e.message ? e.message : e));
      try { await wikiOpenSearch(); } catch (e2) {
        if (isAborted(signal, e2)) throw new DOMException('Stopped', 'AbortError');
        errors.push('wikipedia-opensearch: ' + (e2 && e2.message ? e2.message : e2));
      }
    }
    if (results.length < n) {
      try { await hnSearch(); } catch (e) {
        if (isAborted(signal, e)) throw new DOMException('Stopped', 'AbortError');
        errors.push('hackernews: ' + (e && e.message ? e.message : e));
      }
    }
    if (!results.length) {
      return {
        results: [], report: null, confidence: '', corrected: '', query: q, unverified: true,
        providers, errors,
        error: errors.length ? ('Browser search found nothing (' + errors[0] + ')') : 'No usable sources from browser search.'
      };
    }
    const top = results.slice(0, n);
    const first = top[0];
    const sents = splitSentences(first.extract || first.quote || first.short || '');
    const headline = sents.length ? trimAtWord(sents[0], 320) : trimAtWord(first.quote || first.short || first.title, 320);
    const extraParts = [];
    if (sents.length > 1) extraParts.push(trimAtWord(sents.slice(1, 3).join(' '), 420));
    if (top.length > 1) {
      const second = top[1];
      const s2 = splitSentences(second.extract || second.quote || '');
      if (s2.length && s2[0].toLowerCase() !== headline.toLowerCase()) {
        extraParts.push('Related (' + second.title + '): ' + trimAtWord(s2[0], 240));
      }
    }
    const voice = extraParts.join(' ') || (top.length > 1
      ? ('From ' + top.length + ' sources, led by ' + (first.source || 'the web') + '.')
      : ('From ' + (first.source || 'the web') + '.'));
    const report = {
      reading: first.title || q,
      headline,
      voice,
      take: '',
      plan: 'Browser search on GitHub Pages: query Wikipedia and Hacker News directly, lead with the strongest source, and cite the rest.',
      confidence: top.length >= 2 ? 'moderate' : 'low',
      consensus: [],
      sources: top.length,
      corrected: ''
    };
    return {
      results: top, report, confidence: report.confidence, corrected: '', query: q,
      unverified: false, providers, errors, error: null, client: true
    };
  }

  var serverSearchUnavailable = false;

  root.ArchiverBrowserSearch = {
    search: clientSearch,
    cleanQuery: cleanSearchQuery,
    resetHostCache: function () { serverSearchUnavailable = false; }
  };

  function install() {
    var A = root.Archiver;
    if (!A || typeof A.webSearch !== 'function') return false;
    if (A.__browserSearchWired) return true;
    A.webSearch = async function (query, limit, signal, onStatus) {
      if (signal && signal.aborted) throw new DOMException('Stopped', 'AbortError');
      if (!serverSearchUnavailable) {
        var controller = new AbortController();
        var cancel = function () { controller.abort(); };
        if (signal) signal.addEventListener('abort', cancel, { once: true });
        var timer = setTimeout(cancel, 6000);
        try {
          var base = (root.document && root.document.baseURI) || (root.location && root.location.href) || 'http://localhost/';
          var res = await fetch(new URL('api/search?limit=' + (limit || 3) + '&q=' + encodeURIComponent(query), base).href, {
            signal: controller.signal, cache: 'no-store'
          });
          clearTimeout(timer);
          if (res.ok) {
            var ct = (res.headers && typeof res.headers.get === 'function') ? String(res.headers.get('content-type') || '') : 'application/json';
            if (!ct || /json/i.test(ct)) {
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
            }
          } else if (res.status === 404 || res.status === 405) {
            serverSearchUnavailable = true;
          }
        } catch (e) {
          clearTimeout(timer);
          if (signal && signal.aborted) throw new DOMException('Stopped', 'AbortError');
        } finally {
          if (signal) signal.removeEventListener('abort', cancel);
        }
      }
      if (onStatus) onStatus('Searching the web from this browser…');
      if (root.ArchiverBrowserSearch && root.ArchiverBrowserSearch.search) {
        return root.ArchiverBrowserSearch.search(query, limit, signal, onStatus);
      }
      return { results: [], error: 'Browser search not available.', providers: null, errors: [] };
    };
    A.__browserSearchWired = true;
    return true;
  }

  function boot() {
    if (install()) return;
    var n = 0;
    var t = setInterval(function () { if (install() || ++n > 40) clearInterval(t); }, 250);
  }
  if (root.document && root.document.readyState === 'loading') {
    root.document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof self !== 'undefined' ? self : this);
