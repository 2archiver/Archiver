/* ============================================================================
   ARCHIVER 2.6.2 — the in-browser engine

   Two parts, and this file never pretends they are the same kind of thing.

   PART 1 — the corpus. A retrieval engine over archiver-knowledge.js plus
            whatever the user teaches it. Instant, offline, no download. It
            handles talk as talk ("hey yo" is a greeting, not a wrestler),
            tolerates misspellings on a four-character prefix match, and says
            what it does know when it misses instead of dead-ending.

   PART 2 — the model. Qwen3 running on the visitor's GPU through WebLLM.
            It is a reasoning model: it thinks in a <think> block first, and
            that reasoning is streamed to the page. The corpus and (with WEB
            on) live sources are retrieved first and handed to it as notes —
            the model does the thinking, the notes keep it honest about
            dates and people. Nothing downloads until the user asks.

   2.6.2 undoes the 2.6/2.6.1 regressions: the model is back (it had been
   switched off), the keyword-picked "Additional Thoughts" that posed as
   reasoning are gone, and the Render/free-tier material that had leaked into
   identity, help and follow-up handling is removed.

   Public surface (window.Archiver):
     reply(text)                  -> {text, kind, score}        sync, corpus only
     chat(text, history, opts)    -> Promise<string>            streams deltas
         opts: {search, think, system, signal, onDelta, onThink, onStatus}
     load(modelKey)               -> Promise<{model,key,pretty,steppedDown}>
     unload(), onProgress(fn), models(), mode(), status()
     teach/forget/learned, sources(), thinking(), count(), taught()
   ========================================================================== */

(function () {
  'use strict';

  const VERSION = '2.6.2';

  /* ======================================================================== */
  /* PART 1 — the corpus (instant, offline, no weights)                       */
  /* ======================================================================== */

  const STOP = new Set((
    'a an the is are was were be been being am do does did done doing to of in on at for from by with about as into over than ' +
    'that this these those it its and or but so if then me my mine you your yours i we us our ours he she they them his her their ' +
    'can could would should will shall may might must please tell say explain define give show what which whom whose there here ' +
    'who when where why how just really very some any also too like want need let lets ok okay yes no not lot much good ' +
    'dont doesnt didnt cant cannot wont isnt arent wasnt werent ' +
    'archiver stand stands mean means called thing things'
  ).split(' '));

  /* Words collapsed to a canonical form so "biggest"/"largest" hit the same card. */
  const ALIAS = {
    hi: 'greet', hello: 'greet', hey: 'greet', heya: 'greet', hiya: 'greet', yo: 'greet', sup: 'greet',
    wassup: 'greet', howdy: 'greet', greetings: 'greet', morning: 'greet', afternoon: 'greet', evening: 'greet',
    bye: 'farewell', goodbye: 'farewell', cya: 'farewell', goodnight: 'farewell', farewell: 'farewell',
    thanks: 'thanks', thank: 'thanks', thx: 'thanks', ty: 'thanks', cheers: 'thanks',
    made: 'make', built: 'make', created: 'make', wrote: 'make', developed: 'make', programmed: 'make',
    creator: 'make', developer: 'make', author: 'make', maker: 'make',
    biggest: 'large', largest: 'large', big: 'large', bigger: 'large',
    highest: 'tall', tallest: 'tall', high: 'tall',
    /* domain aliases */
    wwii: 'ww2', 'wwii.': 'ww2', 'world': 'world', ww: 'ww2', nazis: 'nazi', nazism: 'nazi',
    hitlers: 'hitler', stalins: 'stalin', churchills: 'churchill', holocausts: 'holocaust',
    allies: 'ally', soviets: 'soviet', russians: 'russia', americans: 'america', german: 'germany',
    japanese: 'japan', italians: 'italy', british: 'britain', brits: 'britain', us: 'america', usa: 'america',
    fights: 'fight', fought: 'fight', foughts: 'fight', died: 'die', deaths: 'death', dead: 'die',
    started: 'start', begins: 'start', began: 'start', ended: 'end', ends: 'end', finishes: 'end', finished: 'end',
    clavs: 'clavicular', clav: 'clavicular', peters: 'clavicular',
    fuenteses: 'fuentes', groypers: 'groyper', groyperss: 'groyper'
  };

  const norm = (s) => String(s).toLowerCase()
    .replace(/[\u2018\u2019`]/g, "'")
    .replace(/\b(what|who|how|where|when|why|that|there|it|here|let|he|she)'s\b/g, '$1 is')
    .replace(/\b(whats|hows|wheres|whos|whens)\b/g, (m) => m.slice(0, -1) + ' is')
    .replace(/'s\b/g, '')
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  const stem = (w) => {
    if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
    if (w.length > 4 && /(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
    if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
    return w;
  };

  const tokens = (s) => {
    const out = [];
    for (const raw of norm(s).split(' ')) {
      if (!raw || (raw.length < 2 && !/\d/.test(raw)) || STOP.has(raw)) continue;
      out.push(ALIAS[raw] || stem(raw));
    }
    const set = new Set(out);
    if (set.size > 1) { set.delete('greet'); set.delete('thanks'); set.delete('farewell'); }
    return set;
  };

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---- corpus ------------------------------------------------------------ */

  const KB = (window.ARCHIVER_KB && window.ARCHIVER_KB.cards) || [];

  let taught = [];
  const KEY = 'archiver.taught.v2';

  try { taught = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (_) { taught = []; }
  if (!Array.isArray(taught)) taught = [];

  const persist = () => {
    try { localStorage.setItem(KEY, JSON.stringify(taught.slice(-200))); } catch (_) {}
  };

  /* Every card becomes a searchable unit: phrase tokens + answer tokens. */
  let index = [];

  function build() {
    index = [];
    const push = (q, a, meta) => {
      const phraseSets = (Array.isArray(q) ? q : [q]).map((p) => tokens(p));
      const phraseText = (Array.isArray(q) ? q : [q]).filter(Boolean);
      if (!phraseText.length) return;
      const answerTokens = tokens(a);
      index.push({
        q: phraseText,
        a,
        pt: phraseSets,
        at: answerTokens,
        tags: (meta && meta.tags) || [],
        id: (meta && meta.id) || null,
        src: (meta && meta.src) || null,
        taught: !!(meta && meta.taught)
      });
    };
    for (const c of KB) push(c.q, c.a, c);
    for (const t of taught) push(t.q, t.a, { taught: true });
    /* idf over the corpus */
    const df = Object.create(null);
    for (const e of index) for (const t of e.at) df[t] = (df[t] || 0) + 1;
    const N = index.length || 1;
    for (const e of index) {
      e.vec = Object.create(null);
      let max = 0;
      for (const t of e.at) { const w = Math.log(1 + N / (1 + (df[t] || 0))); e.vec[t] = w; if (w > max) max = w; }
      e.norm = max || 1;
    }
  }

  /* ---- scoring ----------------------------------------------------------- */
  /* Phrase match dominates; TF-IDF similarity breaks ties. Deliberately not a
     single blended number, because a strong exact phrase hit should not be
     diluted by a long surrounding question. */

  const ANSWER_AT = 0.52;   /* confident enough to answer directly */
  const WEAK_AT   = 0.20;   /* imperfect, but answer anyway and say so */
  const QWORD = new Set(('what who when where why how which whose is are was were did does do ' +
    'the a an of in on at to for from by with about tell me explain define show').split(' '));

  /* Scoring rewards three separate things, because any one of them alone gets
     the wrong card:
       phraseCov — how much of the stored phrase the question contains
       queryCov  — how much of the QUESTION that phrase accounts for
       spec      — how long the matched phrase is
     Without queryCov, a broad card like "what was world war 2" beats
     "when did world war 2 end", because its short generic phrase matches
     perfectly. Without spec, a single shared word beats a full sentence. */
  /* A token matches if it is exact, or if it shares a five-character prefix
     with something in the question. The prefix rule is what lets "barborossa"
     or "clavicualr" still find their cards. Misspellings were the most common
     cause of the old "I don't know that one" dead end. */
  function fuzz(t, qset, qprefix) {
    if (qset.has(t)) return 1;
    if (!qprefix) return 0;
    /* Four characters, not five: "barborossa" and "barbarossa" already differ
       at the fifth letter, so a five-char rule missed the typo it existed to
       catch. The length guard keeps short common words from colliding. */
    if (t.length >= 5 && qprefix.has(t.slice(0, 4))) return 0.68;
    return 0;
  }

  function score(e, qset, rawNorm, qprefix) {
    let best = null;
    for (const pt of e.pt) {
      if (!pt.size) continue;
      let hit = 0;
      const matched = new Set();
      for (const t of pt) {
        const w = fuzz(t, qset, qprefix);
        if (w > 0) { hit += w; matched.add(t); }
      }
      if (!hit) continue;
      const phraseCov = hit / pt.size;
      const queryCov = matched.size / qset.size;
      const spec = Math.min(1, pt.size / 5);
      const total = phraseCov * 0.5 + queryCov * 0.34 + spec * 0.16;
      /* prefer the phrase that explains the most of the question */
      if (!best || total > best.total) best = { phraseCov, queryCov, spec, size: pt.size, total };
    }
    if (!best) return { score: 0 };

    /* Only an exact whole-question match earns the bonus. Substring matching
       was what let the broad overview card win on specific questions. */
    let exact = 0;
    for (const q of e.q) {
      const nq = norm(q);
      if (nq.length > 3 && nq === rawNorm) { exact = 1; break; }
    }

    let sim = 0, s1 = 0, s2 = 0;
    for (const t of qset) s1 += e.vec[t] ? 1 : 0;
    for (const t of Object.keys(e.vec)) if (qset.has(t)) s2 += e.vec[t];
    if (s1 && s2) sim = (s2 / e.norm) * Math.min(1, s1 / Math.max(1, qset.size));

    /* Tags are a topical hint — "ww2", "holocaust", "llm" — and they catch
       questions phrased nothing like any stored card. */
    let tagHits = 0;
    for (const t of (e.tags || [])) if (fuzz(t, qset, qprefix) > 0) tagHits++;
    const tagScore = (e.tags && e.tags.length) ? tagHits / e.tags.length : 0;

    let s = best.phraseCov * 0.40 + best.queryCov * 0.28 + best.spec * 0.13
          + sim * 0.13 + exact * 0.15 + tagScore * 0.11;
    if (e.taught) s += 0.14;                             /* what the user taught wins */
    if (best.size === 1 && !exact) s *= 0.78;            /* one generic word is weak */
    return { score: Math.min(1, s), exact, size: best.size, tagScore };
  }

  function search(text, topN) {
    const qset = tokens(text);
    if (!qset.size) return { empty: true, ranked: [] };
    const rawNorm = norm(text);
    const qprefix = new Set();
    for (const t of qset) if (t.length >= 5) qprefix.add(t.slice(0, 4));

    const all = [];
    for (const e of index) {
      const s = score(e, qset, rawNorm, qprefix);
      if (s.score > 0) all.push({ entry: e, score: s.score });
    }
    all.sort((a, b) => b.score - a.score);
    return {
      empty: false,
      entry: all.length ? all[0].entry : null,
      score: all.length ? all[0].score : 0,
      ranked: all.slice(0, topN || 5)
    };
  }

  /* ---- tools ------------------------------------------------------------- */

  const EXPR_RE = /^[\s\d+\-*/^%().]+$/;
  /* Recursive descent with the usual precedence: parentheses, unary minus,
     right-associative ^, then * / %, then + -. The 2.6 version parsed
     multiplication below exponentiation (2*3^2 gave 36), ignored brackets
     and silently dropped %. */
  function calc(src) {
    const s = String(src).trim().replace(/[=?]\s*$/, '')
      .replace(/(\d)\s*[×xX]\s*(?=[\d(-])/g, '$1*').replace(/÷/g, '/').replace(/(\d),(?=\d{3}\b)/g, '$1');
    if (!EXPR_RE.test(s) || !/\d/.test(s) || !/\d\s*[+\-*/^%]\s*[-(]*\s*\d|\)\s*[+\-*/^%]|\d\s*[+\-*/^%]\s*\(/.test(s)) return null;
    let i = 0;
    let bad = false;
    const ws = () => { while (s[i] === ' ') i++; };
    const atom = () => {
      ws();
      if (s[i] === '(') {
        i++;
        const v = sum();
        ws();
        if (s[i] !== ')') { bad = true; return NaN; }
        i++;
        return v;
      }
      const st = i;
      while (i < s.length && /[\d.]/.test(s[i])) i++;
      const txt = s.slice(st, i);
      if (!txt || (txt.match(/\./g) || []).length > 1) { bad = true; return NaN; }
      return parseFloat(txt);
    };
    const unary = () => { ws(); if (s[i] === '-') { i++; return -unary(); } if (s[i] === '+') { i++; return unary(); } return power(); };
    const power = () => { const b = atom(); ws(); if (s[i] === '^') { i++; return Math.pow(b, unary()); } return b; };
    const product = () => {
      let v = unary();
      for (;;) {
        ws();
        const op = s[i];
        if (op !== '*' && op !== '/' && op !== '%') break;
        i++;
        const r = unary();
        v = op === '*' ? v * r : op === '/' ? v / r : v % r;
      }
      return v;
    };
    function sum() {
      let v = product();
      for (;;) {
        ws();
        if (s[i] === '+') { i++; v += product(); }
        else if (s[i] === '-') { i++; v -= product(); }
        else break;
      }
      return v;
    }
    const v = sum();
    ws();
    if (bad || i !== s.length) return null;
    if (!isFinite(v)) return /\/\s*0(?![\d.])/.test(s) ? "That divides by zero, so there's no answer." : null;
    const rounded = Math.round(v * 1e10) / 1e10;
    return `That's ${rounded.toLocaleString('en-GB', { maximumFractionDigits: 10 })}.`;
  }
  function tool(t) {
    const c = calc(t);
    if (c) return c;

    /* Work on the normalised text: "d-day" becomes "d day", and a naive
       /day/ test then answers "what was D-Day?" with today's date. Strip the
       known hyphenated tokens first. */
    const nt = norm(t).replace(/\bd day\b/g, ' dday ').replace(/\bve day\b/g, ' veday ').replace(/\bvj day\b/g, ' vjday ');
    const d = new Date();

    const wantsDate = /^(what|which)\b[^?]{0,24}\b(date|day)\b/.test(nt) ||
                      /\b(todays date|date today|what day is it|what is the date)\b/.test(nt);
    if (wantsDate) {
      return `Today is ${d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}.`;
    }
    if (/\b(what|tell|got)\b[^?]{0,24}\btime\b/.test(nt) || /\btime is it\b/.test(nt)) {
      return `It's ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} (your device's local time).`;
    }
    if (/\b(flip|toss)\b.*\bcoin\b|\bcoin\b.*\bflip\b/i.test(t)) {
      return `I flipped a coin: **${Math.random() < 0.5 ? 'heads' : 'tails'}**.`;
    }
    const dice = t.match(/\broll\b.*?\b(\d+)?\s*d\s*(\d+)\b|\broll\b.*?\b(\d+)\b/i);
    if (dice) {
      const n = Math.min(10, parseInt(dice[1] || dice[3] || '1', 10) || 1);
      const faces = parseInt(dice[2] || '6', 10) || 6;
      const rolls = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * faces));
      return `🎲 ${rolls.join(', ')} — total **${rolls.reduce((a, b) => a + b, 0)}**.`;
    }
    return null;
  }

  /* ---- commands ---------------------------------------------------------- */

  function help() {
    const n = index.length ? index.length.toLocaleString('en-GB') : 'a thousand-odd';
    return [
      "I'm **Archiver** — a private research assistant that runs in your browser.",
      '',
      `**What I know offline** — ${n} curated topics: history (WW2 in depth), science, health, tech, philosophy, nature, culture and practical life. Instant, no download.`,
      '',
      '**Real reasoning** — load the model (Settings → Engine) and a Qwen3 reasoning model runs on your own GPU. It thinks before it answers, and you can open its reasoning under each reply. The first load downloads the weights once; after that they come from your browser cache.',
      '',
      "**WEB** — with it on I look things up live and cite 1–3 sources. That's how I answer about things after my training or outside the corpus.",
      '',
      '**Talk like a person** — `hi`, `thanks`, `why?`, `what do you think?` are answered as conversation, not turned into searches. Follow-ups carry the subject over.',
      '',
      '**Commands** `teach: q = a` · `forget: q` · `what have you learned` · `help` · simple maths like `(3+4)*2^3`',
      '',
      '_Memories and chats are stored by the Archiver server you are using, tied to this browser by a cookie — no account. Things you `teach:` stay in this browser only._'
    ].join('\n');
  }

  /* Narrowed to data that genuinely cannot be known without a live lookup.
     "who won" and "score of" used to be here, which wrongly blocked historical
     questions like "who won the 1998 world cup". */
  const LIVE_RE = /\b(weather|forecast|temperature (?:today|now|outside)|price of|stock price|share price|exchange rate|current (?:news|price|score)|today'?s (?:news|price|weather)|right now|tonight's|bus times?|live traffic|opening hours today)\b/i;

  function teach(t) {
    const m = t.match(/^\s*(?:teach|learn)\s*:\s*([\s\S]+?)\s*(?:=>|->|=)\s*([\s\S]+)$/i)
      || t.match(/^\s*(?:teach|learn)\s+([\s\S]+?)\s*(?:=>|->|=)\s*([\s\S]+)$/i);
    if (!m) return { text: "Format it like this:\n\n`teach: capital of Peru = Lima`", kind: 'command' };
    const q = m[1].trim(), a = m[2].trim();
    if (q.length < 2 || a.length < 1) return { text: 'I need both a question and an answer.', kind: 'command' };
    const i = taught.findIndex((x) => norm(x.q) === norm(q));
    if (i >= 0) taught[i].a = a; else taught.push({ q, a, at: Date.now() });
    persist(); build();
    return { text: `Learned: “${esc(q)}” → ${esc(a)}\n\n_Kept in this browser only._`, kind: 'command' };
  }

  function forget(t) {
    const m = t.match(/^\s*forget\s*:\s*([\s\S]+)$/i) || t.match(/^\s*forget\s+([\s\S]+)$/i);
    if (!m) return { text: 'Use `forget: question`.', kind: 'command' };
    const q = norm(m[1]);
    const before = taught.length;
    /* Exact match only. The old substring test meant "forget: war" wiped
       every taught question containing "war". */
    taught = taught.filter((x) => norm(x.q) !== q);
    if (taught.length === before) return { text: "I haven't been taught that, so there's nothing to forget.", kind: 'command' };
    persist(); build();
    return { text: `Forgotten: “${esc(m[1].trim())}”.`, kind: 'command' };
  }

  function learned() {
    if (!taught.length) return { text: "You haven't taught me anything yet. Try `teach: capital of Peru = Lima`.", kind: 'command' };
    const list = taught.slice(-10).map((t) => `• “${t.q}” → ${t.a}`).join('\n');
    return { text: `You've taught me ${taught.length} thing${taught.length === 1 ? '' : 's'}${taught.length > 10 ? ' (latest 10 shown)' : ''}:\n\n${list}`, kind: 'command' };
  }

  /* ---- conversation memory (topic carry-over) ---------------------------- */
  /* "and when did it end?" has no content words of its own. Hold the last
     subject so a follow-up resolves instead of failing. */

  let topic = null;

  function resolve(text) {
    const q = tokens(text);
    const hasPron = /\b(it|that|this|they|them|there|then|he|she|his|her|their)\b/i.test(text);
    const weakPron = hasPron && q.size <= 4;
    const weak = (q.size <= 2 && hasPron) || weakPron;
    if ((q.size === 0 || weak) && topic && topic.q) {
      const merged = topic.q + ' ' + text;
      return { text: merged, carried: topic.q };
    }
    return { text, carried: null };
  }

  /* ---- related cards: what to offer when nothing matched cleanly ---------- */

  function related(text, n) {
    const qset = tokens(text);
    if (!qset.size) return [];

    const scored = [];
    for (const e of index) {
      let hits = 0;
      // Tags are the strongest signal of topical kinship.
      for (const tag of (e.tags || [])) if (qset.has(tag)) hits += 3;
      // Overlap with the card's own questions, not its whole answer body.
      // Matching against every answer token made "capital" hit "Capitol".
      for (const phrase of e.q) {
        const pt = tokens(phrase);
        for (const t of pt) {
          if (qset.has(t)) { hits += 2; continue; }
          for (const q of qset) {
            if (t.length >= 5 && q.length >= 5 && t.slice(0, 4) === q.slice(0, 4)) { hits += 0.75; break; }
          }
        }
      }
      if (hits >= 2) scored.push({ e, hits });
    }
    scored.sort((a, b) => b.hits - a.hits);
    const out = [], seen = new Set();
    for (const item of scored) {
      if (seen.has(item.e.id)) continue;
      seen.add(item.e.id);
      out.push(item.e);
      if (out.length >= (n || 4)) break;
    }
    return out;
  }

  /* ---- the fallback ------------------------------------------------------
     The old version ended at "I don't know that one. I have ~1300 topics and none
     of them fit." That is a dead end: it answers nothing, offers nothing, and
     blames its own index. This one always produces something usable — an
     imperfect answer, a set of related cards, or a search — and says which. */

  function fallback(text, res) {
    const ranked = (res && res.ranked) || [];

    // 1. A weak match is still a match. Answer with it, flagged honestly.
    if (ranked.length && ranked[0].score >= WEAK_AT) {
      const e = ranked[0].entry;
      topic = e;
      let out = '_Closest match to what you asked — I may have read the question differently._\n\n' + e.a;
      const others = ranked.slice(1, 3).filter(r => r.score >= WEAK_AT * 0.6);
      if (others.length) out += '\n\n**Also relevant**\n' + others.map(r => '• ' + r.entry.q[0]).join('\n');
      if (e.src && e.src.length) out += '\n\n_Sources: ' + e.src.join(', ') + '._';
      return { text: out, kind: 'fuzzy', score: ranked[0].score };
    }

    // 2. Nothing scored, but the topic is recognisable: offer the neighbourhood.
    const rel = related(text, 4);
    if (rel.length) {
      return {
        text: "Nothing answers that directly. Nearby, though:\n\n"
          + rel.map(e => '• **' + e.q[0] + '**').join('\n')
          + '\n\nAsk about any of those and you will get a proper answer. '
          + 'Or teach me: `teach: your question = the answer`.',
        kind: 'related', score: 0
      };
    }

    // 3. Genuinely nothing. One line, no blame, and never a dead end: say what
    //    it *does* hold so the next message has somewhere to go.
    return {
      text: pick(text, [
        "I don't have a strong match for that. Try rephrasing with specific names or dates — or turn on **WEB** and I will read live sources.",
        "Nothing close in immediate knowledge. **WEB** can fetch it live, or ask about history, engineering, or internet figures which I hold locally.",
        "Blank on that. I would rather say so than invent something. Rephrase, or flip **WEB** on and I will read for you.",
      ]),
      kind: 'miss', score: 0
    };
  }

  /* ---- sync reply (used by the instant path and by tests) ---------------- */

  /* ======================================================================== */
  /* conversation — greetings, slang, follow-ups                              */
  /* ======================================================================== */

  /* The transcript that prompted this: someone typed "hey yo" and got a
     Japanese professional wrestler named Yo-Hey, because the web search ran
     before anything asked whether the input was a question at all. Same for
     "based?", which came back as an encyclopedia entry on freebase cocaine.

     So: a classifier that runs FIRST — before search, before the corpus, before
     anything. If the input is talk rather than a question it gets answered as
     talk, and nothing is retrieved. Going to Wikipedia for "yo" is not a
     knowledge problem, it is a failure to notice that a person said hello. */
  const CONVO = [
    // Greetings with repeat letter normalization ("helloooo", "heyyyy", "total hi", "whats up", etc.)
    { k: 'greeting', re: /^(?:(?:total|totally|just|saying|well|oh|ah)\s+)?(?:yo+|h+e+l+l*o+|h+e+y+|h+i+|h+i+y+a+|h+e+y+a+|s+u+p+|h+u+l+l+o+|h+o+w+d+y+|g+r+e+e+t+i+n+g+s*|w+a+s+s+u+p+|w+a+z+z+u+p+|w+h+a+t+s*u+p+|h+o+l+a+|b+o+n+j+o+u+r+|o+i+|a+y+y*|m+o+r+n+i+n+g|g+o+o+d\s*(?:morning|afternoon|evening|day)|what(?:s|'s|\s+is)?\s*up)(?:\s+(?:there|folks|everyone|all|friend|dude|bro|man|archiver|yo+|hey+|hi+|hello+|what(?:s|'s|\s+is)?\s*up|wassup|again|you|yall|y'all|buddy))*[\s!.?,]*$/i },
    { k: 'thanks', re: /^(?:thanks|thank you|ta|cheers|ty|thx|cheers mate|appreciate (?:it|that)|much appreciated|nice one)[\s!.?,]*$/i },
    { k: 'bye', re: /^(?:bye|byebye|goodbye|cya|see ya|see you|later|laterz|night|good ?night|peace|peace out|catch you later)[\s!.?,]*$/i },
    // Short reactions. Not questions — a person reacting. The reply reacts back
    // instead of defining the word.
    /* Reactions, split by what they actually mean. Treating them as one class
       made "sheesh" get the etymology of "based", which is its own small
       embarrassment. */
    { k: 'laugh', re: /^(?:lol|lmao|lmfao|lolol|haha+|hehe+|hah|dead|im dead|i'm dead)[\s!.?,]*$/i },
    { k: 'based', re: /^(?:based|baste|based and redpilled)[\s!.?,]*$/i },
    { k: 'agree', re: /^(?:bet|word|facts|real|true|valid|fair|mood|fr|for real|no cap|on god|say less|deadass|lowkey|highkey|i agree|agreed|exactly|preach|respect|yessir|yesss|this)[\s!.?,]*$/i },
    { k: 'doubt', re: /^(?:sus|cap|mid|nah|nope|naw|lies|doubt|you sure|source\?*|proof\?*)[\s!.?,]*$/i },
    { k: 'sympathy', re: /^(?:rip|oof|yikes|damn|oh no|that sucks|brutal|yeesh|grim)[\s!.?,]*$/i },
    { k: 'react', re: /^(?:wild|crazy|insane|sheesh|goated|goat|fire|sick|slay|interesting|noted|oh wow|hell yeah|dope|mad|mental|unhinged|foul|nice|cool|shit|holy shit|damn it)[\s!.?,]*$/i },
    /* Swearing at it. "fu" used to fall through every class, reach retrieval and
       come back as "outside what I have indexed", which reads as if a person
       had typed a question. Two letters with nothing behind them are not a
       query, and pretending otherwise is the whole bug. */
    { k: 'rude', re: /^(?:(?:you|u|your|you're|youre|this|that|it)(?:'s| is| are| r|s)?\s+)?(?:fu|f\s?u|fk|fck|ffs|wtf|wth|stfu|shut (?:up|it)|screw (?:you|this|that)|f+\s?off|f+uck(?:ing)?(?: off| this| you)?|bullshit|bs|suck|useless|garbage|trash|stupid|dumb|dumbass|nonsense|wrong|bad|terrible|awful)[\s!.?,]*$/i },
    { k: 'ack', re: /^(?:ok|okay|k|kk|cool|got it|understood|right|sure|yeah|yea|yep|yup|yh|nah|nope|naw|alright|aight|fine|makes sense|i see|fair enough|sounds good|go on|continue|carry on|and|so|then|why|how|really|more|tell me more|elaborate|explain more|go deeper|keep going|what else|anything else)[\s!.?,]*$/i },
    { k: 'self', re: /^(?:who|what) (?:are|r|is) (?:you|u|archiver|the archiver)\b|^what (?:can|do) you do\b|^are you (?:an? )?(?:ai|robot|bot|chatbot|gpt|chatgpt|claude|grok|human|real)\b|^what (?:model|llm) (?:are|r) (?:you|u)\b|^(?:do you|can you) remember\b|^how do you work\b|^tell me about (?:yourself|archiver)\b/i },
    { k: 'opinion', re: /^(?:what do you (?:think|reckon|make of)|your (?:thoughts|take|opinion)|do you agree|thoughts|you reckon)\b/i },
  ];

  /* Words that belong to Archiver rather than to the world. When somebody
     types one on its own they are not asking Google a question, they are asking
     about the thing that just spoke — after the greeting mentions what it knows,
     "cards" is the obvious next message and it must not become a search for the
     concept of a card. */
  const CARDS_LINE = () => `${index.length.toLocaleString('en-GB')} curated topics — history, science, health, tech, philosophy, nature, culture — held in this page, no download. Anything else comes off the web when **WEB** is on, or from the model once it is loaded.`;
  const MEMORY_LINE = 'Things I have picked up about you. They are stored by the Archiver server you are using (your own machine, if you run it yourself), tied to this browser by a cookie — no account. The **MEMORY** button under the chat box opens them; you can edit or delete any of them.';
  const SELFREF = {
    card: CARDS_LINE,
    cards: CARDS_LINE,
    knowledge: CARDS_LINE,
    memory: MEMORY_LINE,
    memories: MEMORY_LINE,
    mem: MEMORY_LINE,
    web: 'The switch. Off, I answer from what I know and what the model knows. On, I read live sources and cite them.',
    sources: 'Wikipedia, Wikimedia, Stack Exchange and DuckDuckGo, three at most per answer. Anything that does not answer the question is dropped rather than padding the list.',
    index: 'What I know cold, plus the web when **WEB** is on. Outside both I say so rather than guess.',
    model: () => 'Qwen3, a reasoning model, running on your own GPU through WebLLM — no API key, and your messages are not sent to a model provider. ' + (webllmReady() ? `Loaded now: **${pretty(activeModel)}**.` : 'It is not loaded yet: Settings → Engine.'),
    ai: () => SELFREF.model(),
    teach: '`teach: question = answer` — kept in this browser (localStorage), not on the server.',
    offline: 'The corpus and a loaded model run in this browser. **WEB** goes out to search, and memories and chats are saved by the Archiver server.',
    private: 'Your messages never go to a model provider — the model runs in this browser. Memories and chats are kept by the Archiver server you are using, not shared with anyone else.',
  };

  /* "cards", "what are cards", "your memory" — one of my own nouns on its own.
     Strips the dressing and answers it about me. */
  function selfRef(norm) {
    const stripped = String(norm || '')
      .replace(/^(?:what|which)\s+(?:are|is|r|do you mean by)\s+(?:the|a|an|your|these|those)?\s*/i, '')
      .replace(/^(?:the|a|an|your|these|those)\s+/i, '')
      .replace(/^(?:explain|define|tell me about|meaning of)\s+/i, '')
      .replace(/[?.!,\s]+$/, '')
      .trim();
    if (!stripped || stripped.split(/\s+/).length > 2) return null;
    for (const w of stripped.split(/\s+/)) {
      const v = SELFREF[w];
      if (v) return { text: typeof v === 'function' ? v() : v, kind: 'conversation', score: 1 };
    }
    return null;
  }

  /* Words that carry no information in a query, including the informal half of
     the language. "what's the deal with X" was searching for "deal"; "ngl X is
     wild" was searching for "ngl". */
  const NOISE = new Set(('a an the and or but if of in on at to for with from by as is was were are be been being do does did ' +
    'so just really very much many more most some any all this that these those it its there their they them he she his her ' +
    'me my mine you your yours u ur i im we us our ours what which who whom whose when where why how ' +
    'can could would should will shall may might must about into than then too also get got go going gonna wanna gotta kinda sorta ' +
    'know think say said tell ask like well ok okay right yeah yep sure hey hi yo hello sup plz please pls thx thanks ' +
    'lol lmao lmfao omg ngl tbh fr idk tbf imo imho btw bruh bro dude man yall gotta lemme gimme dunno ' +
    'actually basically literally honestly seriously anyway anyways something anything everything nothing someone somebody ' +
    'stuff thing things way ways lot lots bit little keep let lets make makes making made take takes put puts see sees show shows ' +
    'else again still yet ever never').split(' '));

  /* Expand what people actually type before anything is matched. */
  function normalise(text) {
    let t = ' ' + String(text || '').toLowerCase() + ' ';
    const swaps = [
      [/\bwhats\b|\bwhat's\b/g, ' what is '], [/\bhows\b|\bhow's\b/g, ' how is '],
      [/\bwheres\b|\bwhere's\b/g, ' where is '], [/\bwhos\b|\bwho's\b/g, ' who is '],
      [/\bwhens\b|\bwhen's\b/g, ' when is '], [/\bthats\b|\bthat's\b/g, ' that is '],
      [/\bdont\b|\bdon't\b/g, ' do not '], [/\bdoesnt\b|\bdoesn't\b/g, ' does not '],
      [/\bdidnt\b|\bdidn't\b/g, ' did not '], [/\bisnt\b|\bisn't\b/g, ' is not '],
      [/\bwasnt\b|\bwasn't\b/g, ' was not '], [/\bwont\b|\bwon't\b/g, ' will not '],
      [/\bcant\b|\bcan't\b/g, ' can not '], [/\bcouldnt\b|\bcouldn't\b/g, ' could not '],
      [/\bshouldnt\b|\bshouldn't\b/g, ' should not '], [/\bwouldnt\b|\bwouldn't\b/g, ' would not '],
      [/\bive\b|\bi've\b/g, ' i have '], [/\bim\b|\bi'm\b/g, ' i am '],
      [/\bgonna\b/g, ' going to '], [/\bwanna\b/g, ' want to '], [/\bgotta\b/g, ' got to '],
      [/\bkinda\b/g, ' kind of '], [/\bsorta\b/g, ' sort of '], [/\blemme\b/g, ' let me '],
      [/\bgimme\b/g, ' give me '], [/\bcuz\b|\bcos\b|\bbcos\b/g, ' because '],
      [/\bur\b/g, ' your '], [/\bpls\b|\bplz\b/g, ' please '], [/\btho\b/g, ' though '],
      [/\brite\b/g, ' right '], [/\bwud\b/g, ' would '], [/\bwat\b/g, ' what '],
    ];
    for (const pair of swaps) t = t.replace(pair[0], pair[1]);
    return t.replace(/\s+/g, ' ').trim();
  }

  /* How much of a question is actually in there once the filler is stripped. */
  function informationWords(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9'\s-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1 && !NOISE.has(w));
  }

  let lastTurn = null;   // { q, subject, gist, kind }

  /* Talk, not a question. Returns a reply, or null to continue to retrieval. */
  let convoHit = null;
  const SOFT = new Set(['ack', 'laugh', 'based', 'agree', 'doubt', 'sympathy', 'react', 'opinion', 'rude', 'none']);
  function converse(raw) {
    convoHit = null;
    const r = _converse(raw);
    if (r && SOFT.has(convoHit)) r.soft = true;
    return r;
  }

  function _converse(raw) {
    const t = String(raw || '').trim();
    if (!t) return null;
    const norm = normalise(t);
    const collapsed = norm.replace(/([a-z])\1{2,}/g, '$1$1');
    let hit = null;
    for (const c of CONVO) {
      if (c.re.test(norm) || c.re.test(collapsed) || c.re.test(t)) {
        hit = c.k;
        break;
      }
    }

    convoHit = hit;
    const words = informationWords(norm);
    const prior = lastTurn;

    /* My own vocabulary, asked about directly. Before the classes, so that a
       bare "cards" is never mistaken for a topic. */
    // Identity outranks greeting — "hi who are you" is a who-are-you, not a hello.
    // 2.6: catch "who is archiver", "what is archiver", bare "archiver", etc.
    // so they never fall through to Hegel / empty / random cards.
    const isIdentity = /\b(?:who|what) (?:are|r|is) (?:you|u|archiver|the archiver)\b|\bwho r u\b|\btell me about (?:yourself|archiver)\b|\bwhat (?:are|is) (?:you|archiver) (?:about|for)\b|^archiver\s*$/i.test(norm)
        || /\b(?:who|what) (?:are|r|is) (?:you|u|archiver|the archiver)\b|^archiver\s*$/i.test(t);
    if (isIdentity) {
      convoHit = 'self';
      return { text: self(), kind: 'conversation', score: 1 };
    }
    const about = selfRef(norm);
    if (about) { convoHit = 'self'; return about; }

    if (hit === 'greeting') {
      return { text: pick(t, [
        'Hey. What are we looking into?',
        'Hello — ask me anything, or flip **WEB** on for live sources.',
        'Hi. History, science, tech, philosophy — or anything else once the model is loaded. Go ahead.',
        'Hey there. Try `help`, or just ask.',
      ]), kind: 'conversation', score: 1 };
    }
    if (hit === 'thanks') {
      return { text: pick(t, ['Any time.', 'No worries.', 'That is what I am here for.']), kind: 'conversation', score: 1 };
    }
    if (hit === 'bye') {
      return { text: pick(t, ['See you.', 'Later. Your memories stay put unless you clear them.']), kind: 'conversation', score: 1 };
    }
    if (hit === 'ack') {
      /* "and?" / "why?" / "go on" is a request to keep talking about the last
         thing, which is a real thing to answer and not a search query. */
      if (/^(?:and|so|then|why|how|really|more|go on|continue|carry on|tell me more|elaborate|explain more|go deeper|keep going|what else|anything else)/i.test(norm)) {
        if (prior) {
          return { text: pick(t, [
            'Still on **' + prior.subject + '**. Ask it narrower and I will go deeper — without the model loaded I need a specific, not a nudge.',
            'On **' + prior.subject + '** — what specifically? "why" and "when" go to different places.',
          ]), kind: 'conversation', score: 1 };
        }
        return { text: 'Nothing to continue from. Ask me something first.', kind: 'conversation', score: 1 };
      }
      return { text: pick(t, ['Right.', 'Noted.', 'Fine.']), kind: 'conversation', score: 1 };
    }
    if (hit === 'self') return { text: self(), kind: 'conversation', score: 1 };

    /* A reaction with a judgement attached. This is where the previous message
       earns its keep: "based?" after a statement is a verdict on that
       statement, and a dictionary entry answers a question nobody asked. */
    const on = prior ? ' **' + prior.subject + '**' : '';

    if (hit === 'laugh') {
      return { text: pick(t, ['Good.', 'Glad it landed.',
        'You are easily amused. I will take it.']), kind: 'conversation', score: 1 };
    }
    if (hit === 'based') {
      const base = 'The word came out of 1970s California hip-hop by way of "freebase", and it has drifted a long way from the chemistry since. Now it just means you approve.';
      return { text: base + (prior
        ? ' On' + on + ': ' + pick(t, ['I would not go that far, but I will not argue either.',
                                       'broadly yes, and the details are where it gets messy.',
                                       'the instinct is right. The version people repeat online usually is not.'])
        : ' ' + pick(t, ['Your move.', 'What are we applying it to?', 'Carry on.'])),
        kind: 'conversation', score: 1 };
    }
    if (hit === 'agree') {
      return { text: prior
        ? 'On' + on + ', then we agree — ' + pick(t, ['though the interesting part is the bit nobody repeats.',
                                                      'with the usual caveat that the primary sources are messier than the summary.',
                                                      'and I would still check the date before quoting it.'])
        : pick(t, ['Agreed. What are we agreeing about?', 'Right. Ask me something.']),
        kind: 'conversation', score: 1 };
    }
    if (hit === 'doubt') {
      return { text: prior
        ? 'Fair to push back on' + on + '. Do not take my word for it — the sources are listed on the answer and you should read the first one yourself.'
        : 'Fair. Push back on something specific and I will show you where it came from.',
        kind: 'conversation', score: 1 };
    }
    if (hit === 'rude') {
      return { text: pick(t, [
        'Charming. I will answer it anyway — what do you want to know?',
        'Noted, and ignored. Ask me a question.',
        'I have been rated worse than that by better. Go on.',
      ]), kind: 'conversation', score: 1 };
    }
    if (hit === 'sympathy') {
      return { text: on ? 'Grim, yeah.' + on + ' is not a cheerful corner of the record.'
                        : 'Grim, yeah.',
        kind: 'conversation', score: 1 };
    }
    if (hit === 'react') {
      return { text: prior
        ? pick(t, [
            'It is. On' + on + ', the part people usually miss is the boring one underneath it.',
            'Quite. What gets told about' + on + ' is the tidy version.',
            'It is — though on' + on + ' I would read the source rather than the summary.',
          ])
        : 'It is. Ask me something and I will show you why.',
        kind: 'conversation', score: 1 };
    }

    if (hit === 'opinion') {
      /* 2.6 answered this with one of three canned verdicts picked by a hash
         of the message — an opinion-shaped sentence with no thought behind
         it. With the model loaded this never runs (see chat()); without it,
         say plainly what is missing. */
      return { text: prior
        ? 'On **' + prior.subject + '**: a real view needs the reasoning model, and it is not loaded — Settings → Engine. '
          + 'Without it I can only give you what the notes and sources say, which is the answer above.'
        : 'Ask me something first and I will have an opinion about it.', kind: 'conversation', score: 1 };
    }

    /* Nothing matched by name. If almost nothing survives stripping the filler,
       it is talk, not a question — one stray word is not a topic, and sending
       it to a search engine is how you get wrestlers. */
    if (words.length === 0) {
      /* A pronoun or a question word with a turn behind it — "why did they do
         it" — is a real follow-up, not smalltalk. Retrieval gets it, with the
         previous subject folded in by resolveAnaphora. */
      if (prior && /\b(it|its|that|this|they|them|he|she|those|these)\b/i.test(norm)) return null;
      if (prior && /^(?:why|how|when|where|who|what|which)\b/i.test(norm)) return null;
      convoHit = 'none';
      return { text: pick(t, [
        'I am listening, but there is no question in that. Ask me something.',
        'Not much to go on. Give me a subject.',
      ]), kind: 'conversation', score: 1 };
    }
    return null;
  }

  /* Same question, same answer, every time — but not the same sentence for
     every question. Deterministic, not random. */
  function pick(seed, options) {
    let h = 0;
    const s = String(seed || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return options[Math.abs(h) % options.length];
  }

  /* A follow-up like "and the aftermath?" or "why did that happen" has no
     subject of its own. Searching its literal words looks up "aftermath" and
     "happen", which is how a question about Stalingrad becomes a page about the
     concept of aftermath. Fold the previous subject in instead. */
  function resolveAnaphora(text) {
    const norm = normalise(text);
    if (!lastTurn || !lastTurn.subject) return text;
    const lead = /^(?:and|so|then|but|also|plus|what about|how about|why|who else|what else|tell me about the)\b/i;
    const pronoun = /\b(it|its|that|this|they|them|he|she|those|these|their)\b/i;
    if (lead.test(norm)) {
      const rest = norm.replace(lead, '').replace(/^\s*(?:the|a|an)\s+/i, '').trim();
      return (lastTurn.subject + ' ' + rest).trim();
    }
    /* A pronoun with almost nothing else attached — "why did they do it" — is
       about the last thing, not a new subject. */
    if (pronoun.test(norm) && informationWords(norm).length <= 5) {
      return (lastTurn.subject + ' ' + norm).trim();
    }
    return text;
  }

  /* Remember what was just said, so the next message can lean on it. Without
     this every turn starts from nothing and a follow-up like "why?" is
     unanswerable. */
  function noteTurn(q, r) {
    const sub = subjectOf(q);
    /* A follow-up has no subject of its own. Without this the subject drifts —
       "battle of stalingrad" became "and aftermath", and the next question
       inherited that — so a weak subject inherits the previous one instead of
       replacing it. */
    /* A message carries its own subject if it has content words of its own.
       A follow-up does not: "and the aftermath?" has one, "why did they do it"
       has none. Testing for a leading question word instead was wrong — it
       made "what was the battle of stalingrad" a follow-up. */
    const norm = normalise(q);
    const ownWords = informationWords(norm).length;
    const continues = /^(?:and|so|then|but|also|plus|why|how|it|that|this|they|more)\b/i.test(norm);
    const weak = !sub || ownWords === 0 || (continues && ownWords <= 1);
    const carried = lastTurn && lastTurn.subject ? lastTurn.subject : '';
    lastTurn = {
      q: q,
      subject: (weak && carried) ? carried : (sub || (r && r.topic ? String(r.topic) : '') || q.slice(0, 48)),
      gist: r && r.text ? String(r.text).replace(/[*_>#`]/g, '').split(/[.!?]/)[0].slice(0, 120) : '',
      kind: (r && r.kind) || 'answer',
    };
  }

  /* The thing being talked about, with the scaffolding stripped. */
  function subjectOf(text) {
    const norm = normalise(text).replace(/[?!.]+$/, '');
    const lead = /^(?:who|what|when|where|why|how|is|was|are|were|did|does|do|the|a|an|tell|me|about|explain|on|regarding|and|so|then|but|also|plus|it|that|this|they|them)$/i;
    const words = norm.split(/\s+/).filter(w => w && !lead.test(w));
    const out = words.join(' ').trim();
    return out.length > 2 ? out : '';
  }

  function self() {
    const model = webllmReady()
      ? `Right now I am thinking with **${pretty(activeModel)}**, a reasoning model running on your GPU — open "Thought for…" under a reply to read how I got there.`
      : 'Load the reasoning model (Settings → Engine) and I think before I answer, on your own GPU. Until then I answer from the corpus and, with **WEB** on, from live sources.';
    return [
      "I'm **Archiver** — a private research assistant that runs in your browser.",
      '',
      `I know ${index.length.toLocaleString('en-GB')} curated topics offline. ${model}`,
      '',
      'I lead with the answer, keep what is established apart from what I infer, and say when I do not know. Memories are stored by the Archiver server you are using, tied to this browser — no account, no API key. Try `help`.',
    ].join('\n');
  }

  function reply(text) {
    const r = _reply(text);
    /* Every answer that is an answer updates what we were just talking about,
       so the next message can lean on it. Conversation does not: greeting
       somebody should not overwrite the subject under discussion. */
    if (r && r.kind !== 'conversation') noteTurn(text, r);
    return r;
  }

  function _reply(text) {
    const t = String(text || '').trim();
    if (!t) return { text: 'Type a question and I will see if I know it.', kind: 'empty', score: 0 };
    if (/^(?:teach|learn)\s*:/i.test(t) || /^(?:teach|learn)\b[\s\S]*(?:=>|->|=)/i.test(t)) return { ...teach(t), score: 1 };
    if (/^forget\s*:/i.test(t) || /^forget\s+(?!(?:it|that|this|about)\b)\S/i.test(t)) return { ...forget(t), score: 1 };
    if (/^(?:what|show|list)\b.*\b(?:learned|learnt|taught|teach)\b/i.test(t)) return { ...learned(), score: 1 };
    if (/^(?:help|\?)\s*$/i.test(t) || /^what can you do\b/i.test(t)) return { text: help(), kind: 'command', score: 1 };

    const tl = tool(t);
    if (tl) return { text: tl, kind: 'tool', score: 1 };

    /* Talk before knowledge. Anything that is a person talking rather than
       asking is answered here and never reaches retrieval. */
    const talk = converse(t);
    if (talk) return talk;

    if (LIVE_RE.test(t)) return { text: "Live data — weather, news, prices, scores — needs web search. Turn on **WEB** and I will fetch it rather than guess.", kind: 'live', score: 0 };

    const r = resolve(t);
    const best = search(r.text, 5);
    if (best.empty) {
      return { text: "I could not pick any words out of that. Try a full question — `what was the Battle of Stalingrad?` — or type `help`.", kind: 'miss', score: 0 };
    }
    if (best.entry && best.score >= ANSWER_AT) {
      let out = best.entry.a;
      if (r.carried && best.entry.q) out = `_(on **${esc(best.entry.q[0])}**)_\n\n` + out;
      if (best.entry.src && best.entry.src.length) out += `\n\n_Sources: ${best.entry.src.join(', ')}._`;
      topic = best.entry;
      return { text: out, kind: best.entry.taught ? 'taught' : 'kb', score: best.score };
    }
    return fallback(t, best);
  }

  /* ======================================================================== */
  /* PART 2 — the reasoning model (real weights, in your browser)            */
  /* ======================================================================== */

  /* 2.6.1 switched the model off ("retrieval only") and papered over the gap
     with canned "Additional Thoughts" picked by keyword. That was the opposite
     of thinking. This is the real thing: Qwen3, a reasoning model, running on
     the visitor's GPU through WebLLM. It reasons in a <think> block before it
     answers, and that reasoning is streamed to the page so you can read it.

     Weights are the user's bandwidth, so nothing downloads until they ask.
     After the first load the browser caches them and later visits reload
     from disk. */
  const WEBLLM_CDN = 'https://esm.run/@mlc-ai/web-llm@0.2.85';

  const MODELS = [
    { key: 'qwen3-8b',   base: 'Qwen3-8B',   name: 'Qwen3 8B',   size: '≈5.7 GB', note: 'Strongest. Desktop GPU with 8 GB+.' },
    { key: 'qwen3-4b',   base: 'Qwen3-4B',   name: 'Qwen3 4B',   size: '≈3.4 GB', note: 'Recommended for most laptops.' },
    { key: 'qwen3-1.7b', base: 'Qwen3-1.7B', name: 'Qwen3 1.7B', size: '≈2.0 GB', note: 'Lighter: older laptops, tablets.' },
    { key: 'qwen3-0.6b', base: 'Qwen3-0.6B', name: 'Qwen3 0.6B', size: '≈1.4 GB', note: 'Smallest: phones. Noticeably weaker.' },
  ];
  const DEFAULT_MODEL = 'qwen3-4b';
  /* Every Qwen3 build in WebLLM ships a 4096-token window. The prompt, the
     reasoning and the answer all have to fit inside it. */
  const CONTEXT_TOKENS = 4096;

  const modelByKey = (k) => MODELS.find((m) => m.key === k) || null;
  const pretty = (id) => {
    const m = MODELS.find((x) => String(id || '').startsWith(x.base + '-'));
    return m ? m.name : (String(id || '').replace(/-q4f(16|32)_1-MLC$/, '') || 'model');
  };
  const estTokens = (s) => Math.ceil(String(s || '').length / 3.6);

  /* Fallback persona, used only when the server could not be reached. The
     server's copy (app/main.py PERSONA) is the one the user can edit. */
  const PERSONA = [
    'You are Archiver, a private research assistant running in the user\'s own browser.',
    '',
    'How you think: work out what is actually being asked; weigh notes and sources over recollection and say when they disagree; keep what is established apart from what you infer, and say how sure you are.',
    '',
    'How you answer: lead with the answer, then only the reasoning that supports it. Match length to the question. When asked for a view, give one; on contested questions give the strongest version of each side, then say which you find more convincing. Never invent a second side for balance. Dry and direct, no fawning, no sermons.',
    '',
    'Accuracy: never invent a date, number, quotation, citation or source. If you do not know, say so. The Holocaust is documented fact; denial is a fringe political movement. On living people keep charges, allegations and proven facts distinct.'
  ].join('\n');

  const THINKING_GUIDE = 'Before answering, think it through: what is being asked, what the notes actually support, what is missing, and how confident you are. Then give the answer on its own, without repeating your reasoning.';

  let engine = null;
  let activeModel = null;
  let activeKey = null;
  let lastSources = [];
  let lastReport = null;
  let lastCorrected = '';
  let loading = null;
  let progress = { text: '', pct: 0 };
  const progressSubs = new Set();

  const webgpu = () => {
    try { return typeof navigator !== 'undefined' && !!navigator.gpu; } catch (_) { return false; }
  };
  const webllmReady = () => !!engine && !!activeModel;
  const mode = () => (webllmReady() ? 'neural' : 'grounded');

  function onProgress(fn) { progressSubs.add(fn); return () => progressSubs.delete(fn); }
  function emitProgress(text, pct) {
    progress = { text, pct: Math.max(0, Math.min(100, pct || 0)) };
    for (const fn of progressSubs) { try { fn(progress); } catch (_) {} }
  }

  async function gpuInfo() {
    if (!webgpu()) return { ok: false };
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return { ok: false };
      return { ok: true, f16: !!(adapter.features && adapter.features.has('shader-f16')) };
    } catch (_) { return { ok: false }; }
  }

  /* Load the requested size, stepping down a size at a time if the GPU runs
     out of memory. Only ever called because the user asked for it. */
  async function load(key) {
    if (loading) return loading;
    const want = modelByKey(key) || modelByKey(DEFAULT_MODEL);
    if (webllmReady() && activeKey === want.key) {
      return { model: activeModel, key: activeKey, pretty: want.name, steppedDown: false };
    }
    loading = (async () => {
      const gpu = await gpuInfo();
      if (!gpu.ok) {
        throw new Error('This browser has no WebGPU, so the reasoning model cannot run here. ' +
          'Chrome, Edge and Safari 26+ have it. Everything else in Archiver still works.');
      }
      emitProgress('Fetching the inference engine…', 1);
      let mod;
      try {
        mod = await import(/* webpackIgnore: true */ WEBLLM_CDN);
      } catch (err) {
        throw new Error('Could not load the inference library (' + (err && err.message || err) + ').');
      }
      if (engine) {
        try { await engine.unload(); } catch (_) {}
        engine = null; activeModel = null; activeKey = null;
      }
      const quant = gpu.f16 ? 'q4f16_1' : 'q4f32_1';
      const catalogue = new Set(((mod.prebuiltAppConfig && mod.prebuiltAppConfig.model_list) || []).map((m) => m.model_id));
      const order = MODELS.slice(MODELS.indexOf(want))
        .map((m) => ({ m, id: m.base + '-' + quant + '-MLC' }))
        .filter((x) => catalogue.has(x.id));
      if (!order.length) throw new Error('This WebLLM build has no Qwen3 models.');

      let lastError = null;
      for (let i = 0; i < order.length; i++) {
        const { m, id } = order[i];
        try {
          emitProgress((i ? 'Not enough GPU memory — trying ' : 'Loading ') + m.name + ' (' + m.size + ')…', 2);
          engine = await mod.CreateMLCEngine(id, {
            initProgressCallback: (r) => emitProgress(r.text || 'Loading…', Math.round((r.progress || 0) * 100))
          });
          activeModel = id;
          activeKey = m.key;
          emitProgress('Ready — ' + m.name, 100);
          return { model: id, key: m.key, pretty: m.name, steppedDown: i > 0 };
        } catch (err) {
          lastError = err && err.message ? err.message : String(err);
          engine = null;
        }
      }
      throw new Error('No model could be loaded on this device. Last error: ' + lastError);
    })();
    try { return await loading; }
    finally { loading = null; }
  }

  async function unload() {
    if (!engine) return;
    try { await engine.unload(); } catch (_) {}
    engine = null; activeModel = null; activeKey = null;
    emitProgress('', 0);
  }

  /* ---- web grounding ----------------------------------------------------- */

  /* Queries the app's own server, which does the lookup without a key and
     without the browser talking to a third party directly. Never throws — a
     search outage degrades the answer, it does not break it. */
  async function webSearch(query, limit, signal) {
    try {
      const res = await fetch('/api/search?limit=' + (limit || 3) + '&q=' + encodeURIComponent(query), { signal });
      if (!res.ok) return { results: [], error: 'search endpoint returned ' + res.status };
      const data = await res.json();
      return {
        results: (data && data.results) || [],
        report: (data && data.report) || null,
        confidence: (data && data.confidence) || '',
        corrected: (data && data.corrected) || '',
        query: (data && data.query) || query,
        error: null
      };
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      return { results: [], error: 'search failed: ' + (err && err.message || err) };
    }
  }

  /* What the sources say, read back without a model. Only sentences the
     sources contain — no invented opinion on top. */
  function reportBlock(report) {
    if (!report || (!report.headline && !report.voice)) return '';
    const lines = [];
    if (report.reading) lines.push('**Archiver reads this as — ' + report.reading + '**');
    if (report.headline) lines.push(report.headline.replace(/^>\s*/, ''));
    if (report.voice) lines.push(report.voice);
    return lines.join('\n\n');
  }

  function reportStructured(report, n) {
    if (!report) return null;
    return {
      reading: report.reading || '',
      headline: report.headline || '',
      voice: report.voice || '',
      confidence: report.confidence || '',
      consensus: report.consensus || [],
      sources: n || 0,
      corrected: lastCorrected || ''
    };
  }

  function webNotes(results) {
    return results.map((r, i) => {
      const snippet = (r.quote || r.short || r.extract || '').slice(0, 320).trim();
      return `[${i + 1}] ${r.title} (${r.source})\n    ${snippet}`;
    }).join('\n');
  }

  /* Retrieved cards become the NOTES block. This is what stops the model
     drifting on dates and people. */
  function notesFor(text, max) {
    const q = tokens(text);
    if (!q.size) return { notes: '', cards: [] };
    const qpre = new Set();
    for (const t of q) if (t.length >= 5) qpre.add(t.slice(0, 4));
    const scored = [];
    for (const e of index) {
      const s = score(e, q, norm(text), qpre);
      if (s.score > 0.3) scored.push({ e, s: s.score });
    }
    scored.sort((a, b) => b.s - a.s);
    const top = scored.slice(0, max || 3);
    if (!top.length) return { notes: '', cards: [] };
    const notes = top.map(({ e }, i) => `(${String.fromCharCode(97 + i)}) ${e.q[0]}\n    ${e.a}`).join('\n');
    return { notes, cards: top.map((t) => t.e) };
  }

  /* Qwen3 writes "<think> … </think>" and then the answer. Split the stream
     into the two as it arrives, so the page can show reasoning live. */
  function splitThinking(raw) {
    const s = String(raw || '').replace(/^\s+/, '');
    if (!s) return { thinking: '', answer: '', open: false };
    if (!s.startsWith('<think>')) {
      if ('<think>'.startsWith(s)) return { thinking: '', answer: '', open: true };
      return { thinking: '', answer: String(raw), open: false };
    }
    const end = s.indexOf('</think>');
    if (end < 0) return { thinking: s.slice(7).replace(/^\s+/, ''), answer: '', open: true };
    return { thinking: s.slice(7, end).trim(), answer: s.slice(end + 8).replace(/^\s+/, ''), open: false };
  }

  /* Previous answers go back to the model without their reasoning — it is the
     conclusion that matters, and the window is small. */
  const stripThinking = (t) => String(t || '').replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
  const normRole = (r) => (r === 'user' ? 'user' : (r === 'system' ? null : 'assistant'));

  /* Keep the newest turns that fit. Oldest history goes first, then notes
     shrink — the question itself is never dropped. */
  function fitToWindow(system, history, user, reserve) {
    const budget = CONTEXT_TOKENS - reserve - 64;
    const turns = [];
    for (const m of (history || []).slice(-8)) {
      const role = m && normRole(m.role);
      const content = m && stripThinking(m.content);
      if (!role || !content) continue;
      turns.push({ role, content: content.length > 900 ? content.slice(0, 900) + ' …' : content });
    }
    let used = estTokens(system) + estTokens(user);
    const kept = [];
    for (let i = turns.length - 1; i >= 0; i--) {
      const cost = estTokens(turns[i].content) + 4;
      if (used + cost > budget) break;
      kept.unshift(turns[i]);
      used += cost;
    }
    /* Chat templates want the first non-system turn to be the user's. */
    while (kept.length && kept[0].role !== 'user') kept.shift();
    return { messages: [{ role: 'system', content: system }, ...kept, { role: 'user', content: user }], used };
  }

  async function generate(messages, opts, think, maxTokens, onPiece) {
    const request = {
      messages,
      temperature: think ? 0.6 : 0.4,
      top_p: think ? 0.95 : 0.8,
      max_tokens: maxTokens,
      stream: true,
      extra_body: { enable_thinking: !!think }
    };
    const stream = await engine.chat.completions.create(request);
    let raw = '';
    let finish = null;
    for await (const chunk of stream) {
      const c = chunk && chunk.choices && chunk.choices[0];
      const piece = c && c.delta && c.delta.content;
      if (piece) { raw += piece; onPiece(raw); }
      if (c && c.finish_reason) finish = c.finish_reason;
      if (opts.signal && opts.signal.aborted) break;
    }
    return { raw, finish };
  }

  /* Async streaming chat. History is [{role, content}].
     opts: { search, think, system, searchLimit, signal,
             onDelta(piece), onThink(text, done), onStatus(text) } */
  async function chat(text, history, opts) {
    opts = opts || {};
    const onDelta = opts.onDelta || (() => {});
    const onThink = opts.onThink || (() => {});
    const status = opts.onStatus || (() => {});
    const t = String(text || '').trim();
    if (!t) return '';

    // Reset per turn so sources never bleed into an unrelated answer.
    lastSources = [];
    lastReport = null;
    lastCorrected = '';

    /* Commands and tools never reach the model — they are exact by nature. */
    if (/^(?:teach|learn|forget)\s*:/i.test(t) || /^(?:what|show|list)\b.*\b(?:learned|learnt|taught)\b/i.test(t) || /^(?:help|\?)\s*$/i.test(t)) {
      const r = reply(t);
      onDelta(r.text);
      return r.text;
    }
    const tl = tool(t);
    if (tl) { onDelta(tl); return tl; }

    /* Talk is answered as talk, before any retrieval — that is how "hey yo"
       stopped becoming a wrestler. Reactions and follow-ups ("why?", "what do
       you think") go to the model when it is loaded, because it can actually
       see the previous answer and reason about it. */
    const talk = converse(t);
    if (talk && !(talk.soft && webllmReady())) { onDelta(talk.text); return talk.text; }

    const isExplicitSearch = /^(?:search|lookup|look up|google|find out about|find me|browse)\b/i.test(t);
    const searchEnabled = Boolean(opts.search || isExplicitSearch);
    const query = resolveAnaphora(t);
    const { notes, cards } = notesFor(query, webllmReady() ? 3 : 4);
    let web = [];
    if (searchEnabled && !(talk && talk.soft)) {
      status('Searching…');
      const got = await webSearch(query, Math.min(opts.searchLimit || 3, 3), opts.signal);
      web = got.results || [];
      lastReport = got.report || null;
      lastCorrected = got.corrected || '';
      status(got.error || '');
    }
    lastSources = web.map((w) => ({ title: w.title, url: w.url, source: w.source, short: (w.quote || w.short || '').slice(0, 200) }));

    /* No model loaded: answer from the corpus and read the web back directly. */
    if (!webllmReady()) {
      const r = reply(t);
      if (web.length) {
        const corpusHelped = r.kind === 'kb' || r.kind === 'taught';
        let out = '';
        const read = reportBlock(lastReport);
        if (read) out += read + '\n\n';
        if (corpusHelped) out += r.text + '\n\n';
        out += '**Sources** · ' + web.map((w, i) => `[${i + 1}] **[${w.title}](${w.url})** _(${w.source})_`).join(' · ');
        onDelta(out);
        return out;
      }
      onDelta(r.text);
      return r.text;
    }

    /* ---- the model path ---- */
    const think = opts.think !== false;
    const blocks = [];
    if (notes) blocks.push('LOCAL NOTES (curated; trust them for dates and names):\n' + notes);
    if (web.length) blocks.push('WEB SOURCES (retrieved just now; cite as [1], [2] in this order):\n' + webNotes(web));
    if (lastReport && lastReport.confidence === 'nothing worth citing') {
      blocks.push('The web search found nothing that answers this. Say so rather than stretching a source.');
    }
    const base = String(opts.system || '').trim() || PERSONA;
    const system = base
      + (think ? '\n\n' + THINKING_GUIDE : '')
      + '\n\n---\n'
      + (blocks.length
        ? blocks.join('\n\n') + '\n\nUse these where they answer the question; they beat recollection. Cite only sources listed above.'
        : 'No notes matched this question. Answer from your own knowledge and flag uncertainty plainly.');

    const reserve = think ? 1800 : 800;
    const fitted = fitToWindow(system, history, t, reserve);
    const maxTokens = Math.max(256, Math.min(reserve, CONTEXT_TOKENS - fitted.used - 64));

    const stop = () => { try { engine.interruptGenerate(); } catch (_) {} };
    if (opts.signal) opts.signal.addEventListener('abort', stop, { once: true });

    let shown = 0;
    let thinking = '';
    let thinkDone = false;
    const push = (raw) => {
      const part = splitThinking(raw);
      if (part.thinking !== thinking || (!part.open && !thinkDone && part.thinking)) {
        thinking = part.thinking;
        if (!part.open) thinkDone = true;
        onThink(thinking, !part.open);
      }
      if (part.answer.length > shown) {
        onDelta(part.answer.slice(shown));
        shown = part.answer.length;
      }
    };

    status(think ? 'Thinking…' : 'Writing…');
    let answer = '';
    try {
      const first = await generate(fitted.messages, opts, think, maxTokens, push);
      answer = splitThinking(first.raw).answer.trim();
      /* A small model can spend its whole budget reasoning. Rather than hand
         back nothing, answer once more without the scratchpad. */
      if (!answer && think && !(opts.signal && opts.signal.aborted)) {
        status('Out of room while thinking — answering directly…');
        if (!thinkDone) onThink(thinking, true);
        shown = 0;
        const again = await generate(fitToWindow(base + '\n\n---\n' + (blocks.join('\n\n') || ''), history, t, 800).messages,
          opts, false, 800, (raw) => {
            const a = splitThinking(raw).answer;
            if (a.length > shown) { onDelta(a.slice(shown)); shown = a.length; }
          });
        answer = splitThinking(again.raw).answer.trim();
      }
    } finally {
      if (opts.signal) opts.signal.removeEventListener('abort', stop);
      status('');
    }
    if (!answer && !(opts.signal && opts.signal.aborted)) {
      answer = '(the model returned nothing — try rephrasing, or turn THINK off)';
      onDelta(answer);
    }
    if (cards.length) topic = cards[0];
    noteTurn(t, { text: answer, topic: cards[0] ? cards[0].q[0] : '' });
    lastThinking = thinking;
    return answer;
  }
  let lastThinking = '';

  /* ======================================================================== */
  /* boot                                                                     */
  /* ======================================================================== */

  build();

  window.Archiver = {
    name: 'Archiver',
    version: VERSION,
    pretty,
    reply,
    chat,
    load,
    unload,
    onProgress,
    mode,
    models: () => MODELS.map((m) => ({ ...m, default: m.key === DEFAULT_MODEL })),
    defaultModel: DEFAULT_MODEL,
    status: () => ({
      engine: mode(),
      model: activeModel,
      modelKey: activeKey,
      modelPretty: activeModel ? pretty(activeModel) : null,
      webgpu: webgpu(),
      loading: !!loading,
      progress: progress.pct,
      progressText: progress.text,
      cards: index.length,
      kb: KB.length,
      taught: taught.length
    }),
    reset: () => {
      lastSources = [];
      lastReport = null;
      lastCorrected = '';
      lastTurn = null;
      topic = null;
    },
    teach, forget, learned, help: () => help(),
    webSearch, sources: () => lastSources.slice(),
    thinking: () => lastThinking,
    interpretation: () => reportStructured(lastReport, lastSources.length),
    report: () => lastReport,
    search: (q) => { const r = search(q); return r && r.entry ? { q: r.entry.q, a: r.entry.a, score: r.score } : null; },
    count: () => index.length,
    taught: () => taught.slice(),
    splitThinking,
    PERSONA,
    /* Test seam: lets tests/smoke.js drive the model path with a fake engine
       that has the WebLLM chat.completions shape. Not used by the page. */
    _useEngine: (e, id) => { engine = e; activeModel = e ? (id || 'Qwen3-4B-q4f16_1-MLC') : null; activeKey = e ? 'qwen3-4b' : null; }
  };
})();
