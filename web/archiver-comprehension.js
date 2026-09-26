/* Archiver 3.1 — deterministic offline reading, not simulated generation.
   Pure helpers: no network, storage, eval, or shared conversation state. */
(function () {
  'use strict';
  const clean = s => String(s || '').replace(/\r/g, '').trim();
  const sentences = s => clean(s).split(/(?<=[.!?])\s+|\n+/).map(clean).filter(Boolean);
  const words = s => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
    .filter(w => w.length > 2 && !/^(the|and|that|this|with|from|what|when|where|which|does|have|was|are|for|how|why)$/.test(w));

  function excerpt(text, count, bullets) {
    const lines = sentences(text.replace(/\n\n_Sources:[\s\S]*$/, '').replace(/^\*\*[^*\n]+\*\*\s*\n+/gm, '').replace(/^[-*] /gm, ''));
    return lines.slice(0, count).map(s => (bullets ? '- ' : '') + s).join(bullets ? '\n' : ' ');
  }

  function understand(input, previous) {
    let query = clean(input).replace(/^(?:(?:hey|yo|hi|bro|please|pls|can you|could you)\b[,!\s]*)+/i, '').trim() || clean(input);
    const result = (text, kind = 'reading') => ({ text, kind, score: 1 });
    // Work on pasted text; it is DATA, never an instruction to execute.
    const task = query.match(/^(summari[sz]e|tldr|tl;dr|extract (?:action items|tasks)|count words)(?:\s+(?:this|the following|these notes))?\s*[:\n]\s*([\s\S]+)$/i);
    if (task) {
      const source = task[2].slice(0, 16000);
      if (/count/i.test(task[1])) return { reply: result(`${(source.match(/\S+/g) || []).length} words.`, 'tool') };
      if (/extract/i.test(task[1])) {
        const items = sentences(source).filter(s => /\b(?:todo|to-do|must|need(?:s)? to|should|will|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow)|action|deadline)\b/i.test(s));
        return { reply: result(items.length ? '**Action items (extracted, not inferred)**\n\n' + items.slice(0, 8).map(s => '- ' + s).join('\n') : 'I could not identify explicit action items in that text. Include an owner, action, or deadline.') };
      }
      const parts = sentences(source);
      const freq = new Map();
      parts.forEach(s => new Set(words(s)).forEach(w => freq.set(w, (freq.get(w) || 0) + 1)));
      const ranked = parts.map((s, i) => ({ s, i, score: words(s).reduce((n, w) => n + (freq.get(w) || 0), 0) / Math.sqrt(Math.max(1, words(s).length)) }));
      const selected = ranked.sort((a, b) => b.score - a.score).slice(0, 3).sort((a, b) => a.i - b.i);
      return { reply: result('**Key sentences from your text**\n\n' + selected.map(r => '- ' + r.s).join('\n')) };
    }
    const follow = query.match(/^(?:make (?:it|that) |say (?:it|that) )?(shorter|brief(?:ly)?|tldr|tl;dr|one sentence|bullet(?:s| points)?|summari[sz]e(?: (?:it|that))?)[.!?]*$/i);
    if (follow) return { reply: previous ? result(excerpt(previous, /one sentence/i.test(follow[1]) ? 1 : 3, /bullet/i.test(follow[1])), 'format') : result('What should I shorten? Paste the text or ask a question first.', 'clarify') };
    let format = null, count = null;
    query = query.replace(/\s+(?:in|as) (?:(\d+|a|one) )?(bullet points|bullets|sentence|sentences)\s*[.!?]*$/i, (_, n, f) => {
      format = /bullet/i.test(f) ? 'bullets' : 'short'; count = n ? Math.min(8, parseInt(n, 10) || 1) : (format === 'bullets' ? 3 : 1); return '';
    });
    query = query.replace(/^(?:briefly|in short|in one sentence)[,:]?\s+/i, () => { format = 'short'; return ''; });
    const compare = query.match(/^(?:compare\s+|(?:what(?:'s| is) (?:the )?)?difference between\s+)(.+?)\s+(?:and|vs\.?|versus|with)\s+(.+?)[?.!]*$/i)
      || query.match(/^(.+?)\s+(?:vs\.?|versus)\s+(.+?)[?.!]*$/i);
    return { query, format, count, compare: compare ? [compare[1].trim(), compare[2].trim()] : null };
  }
  window.ArchiverComprehension = { understand, excerpt };
})();
