/* Archiver 5.6 — browser-side search for GitHub Pages (no backend).
   Wikipedia (CORS origin=*) and Hacker News Algolia. Same result shape as server search. */
(function (root) {
  'use strict';

  async function clientSearch(query, limit, signal, onStatus) {
    const n = Math.max(1, Math.min(Number(limit) || 3, 5));
    const q = String(query || '').trim();
    if (!q) return { results: [], error: 'Empty query', providers: {}, errors: [] };
    if (onStatus) onStatus('Searching the web from this browser…');
    const results = [];
    const providers = {};
    const errors = [];
    const seen = new Set();

    function add(item) {
      if (!item || !item.url || !item.title) return;
      const key = String(item.url).replace(/#.*$/, '').toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      results.push({
        title: String(item.title).slice(0, 200),
        url: String(item.url),
        source: item.source || 'web',
        quote: String(item.quote || item.short || item.extract || '').slice(0, 1200),
        short: String(item.short || item.quote || item.extract || '').slice(0, 280),
        extract: String(item.extract || item.quote || '').slice(0, 1200)
      });
    }

    async function wikiSearch() {
      const url = 'https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch='
        + encodeURIComponent(q) + '&srlimit=' + n + '&srprop=snippet&format=json&origin=*';
      const res = await fetch(url, { signal, cache: 'no-store' });
      if (!res.ok) throw new Error('wikipedia ' + res.status);
      const data = await res.json();
      const hits = (data && data.query && data.query.search) || [];
      providers.wikipedia = hits.length;
      const titles = hits.map(h => h.title).filter(Boolean).slice(0, n);
      if (!titles.length) return;
      const exUrl = 'https://en.wikipedia.org/w/api.php?action=query&prop=extracts|info&exintro=1&explaintext=1&inprop=url&titles='
        + titles.map(t => encodeURIComponent(t)).join('|') + '&format=json&origin=*';
      let pages = {};
      try {
        const er = await fetch(exUrl, { signal, cache: 'no-store' });
        if (er.ok) {
          const ed = await er.json();
          pages = (ed && ed.query && ed.query.pages) || {};
        }
      } catch (_) {}
      const byTitle = {};
      Object.keys(pages).forEach(id => {
        const p = pages[id];
        if (p && p.title) byTitle[p.title] = p;
      });
      hits.forEach(h => {
        const p = byTitle[h.title] || {};
        const extract = (p.extract || '').trim();
        const snippet = String(h.snippet || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const body = extract || snippet;
        const pageUrl = p.fullurl || ('https://en.wikipedia.org/wiki/' + encodeURIComponent(String(h.title).replace(/ /g, '_')));
        add({ title: h.title, url: pageUrl, source: 'Wikipedia', quote: body, short: body.slice(0, 280), extract: body });
      });
    }

    async function hnSearch() {
      const url = 'https://hn.algolia.com/api/v1/search?query=' + encodeURIComponent(q)
        + '&tags=story&hitsPerPage=' + Math.min(n, 3);
      const res = await fetch(url, { signal, cache: 'no-store' });
      if (!res.ok) throw new Error('hn ' + res.status);
      const data = await res.json();
      const hits = (data && data.hits) || [];
      providers.hackernews = hits.length;
      hits.forEach(h => {
        const title = h.title || h.story_title;
        const link = h.url || ('https://news.ycombinator.com/item?id=' + h.objectID);
        if (!title || !link) return;
        add({ title: title, url: link, source: 'Hacker News', quote: (h.story_text || h.comment_text || title || '').slice(0, 400), short: title });
      });
    }

    async function wikiOpenSearch() {
      if (results.length >= n) return;
      const url = 'https://en.wikipedia.org/w/api.php?action=opensearch&search='
        + encodeURIComponent(q) + '&limit=' + n + '&namespace=0&format=json&origin=*';
      const res = await fetch(url, { signal, cache: 'no-store' });
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
          quote: descs[i] || '',
          short: descs[i] || titles[i]
        });
      }
    }

    try {
      await wikiSearch();
    } catch (e) {
      errors.push('wikipedia: ' + (e && e.message ? e.message : e));
      try { await wikiOpenSearch(); } catch (e2) { errors.push('wikipedia-opensearch: ' + (e2 && e2.message ? e2.message : e2)); }
    }
    if (results.length < n) {
      try { await hnSearch(); } catch (e) { errors.push('hackernews: ' + (e && e.message ? e.message : e)); }
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
    const report = {
      reading: first.title || q,
      headline: (first.quote || first.short || '').slice(0, 240),
      voice: top.length > 1
        ? ('From ' + top.length + ' sources, led by ' + (first.source || 'the web') + '.')
        : ('From ' + (first.source || 'the web') + '.'),
      take: '',
      plan: 'Browser search on GitHub Pages: lead with the strongest source, then cite the rest.',
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

  root.ArchiverBrowserSearch = { search: clientSearch };
})(typeof self !== 'undefined' ? self : this);

(function () {
  function install() {
    var A = window.Archiver;
    if (!A || typeof A.webSearch !== 'function') return false;
    if (A.__browserSearchWired) return true;
    A.webSearch = async function (query, limit, signal, onStatus) {
      var controller = new AbortController();
      var cancel = function () { controller.abort(); };
      if (signal) {
        if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
        signal.addEventListener('abort', cancel, { once: true });
      }
      var timer = setTimeout(cancel, 6000);
      try {
        var res = await fetch(new URL('api/search?limit=' + (limit || 3) + '&q=' + encodeURIComponent(query), document.baseURI).href, {
          signal: controller.signal, cache: 'no-store'
        });
        clearTimeout(timer);
        if (res.ok) {
          var data = await res.json();
          return {
            results: (data && data.results) || [],
            report: (data && data.report) || null,
            confidence: (data && data.confidence) || '',
            corrected: (data && data.corrected) || '',
            query: (data && data.query) || query,
            unverified: !!(data && data.unverified),
            providers: (data && data.providers) || null,
            errors: (data && data.errors) || [],
            error: null
          };
        }
      } catch (e) {
        clearTimeout(timer);
        if (signal && signal.aborted) throw new DOMException('Stopped', 'AbortError');
      } finally {
        if (signal) signal.removeEventListener('abort', cancel);
      }
      if (onStatus) onStatus('Server search unavailable — searching from this browser…');
      if (window.ArchiverBrowserSearch && window.ArchiverBrowserSearch.search) {
        return window.ArchiverBrowserSearch.search(query, limit, signal, onStatus);
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
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
