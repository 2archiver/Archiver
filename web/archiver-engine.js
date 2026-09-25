/* ============================================================================
   ARCHIVER 2.6

   One assistant. Two execution paths, and the difference is nobody's business.

   2.1: talk is answered as talk — swearing, slang, one-word follow-ups and
        questions about my own vocabulary ("cards", "memory") never become
        searches, and a miss always says what I do know instead of stopping.
   2.1: search is shorter, interpretation is the answer. Extracts are cut to
   ~400 chars, at most 3 sources, and the reading leads — sources support.

   2.5 removes the neural/grounded distinction that 2.2 put on the front page.
   It was true and it was useless: nobody cares whether a sentence was produced
   by eight billion weights or by a lookup, only whether it is right. So there
   is one Archiver. It answers instantly from the corpus, it answers better once
   the model is loaded, and either way it says which sources it used.

   2.6: identity is solid — "who is archiver" / "what is archiver" never fall
        through to Hegel or any other card. Self-detection expanded, scoring
        guards added, Grok-style thinking tightened, overall answer quality up.

   The old framing, for the record:

   1. NEURAL  — a real language model with real weights, running on the
                retrieval + live web search. No API key, no
                server, nothing sent anywhere. This is the default whenever the
                browser supports it.

   2. GROUNDED — a retrieval engine over the bundled corpus
                (archiver-knowledge.js). Instant, offline, works everywhere,
                and it is the fallback grounded answer
                is missing.

   They are not the same kind of thing and this file never pretends otherwise.
   The corpus path is a lookup with good text handling. The model path is
   a model. Only one of those can reason about something it was never told.

   The two combine for the best result: the corpus is retrieved first, then
   handed to the real model as notes. The model does the thinking; the corpus
   keeps it honest about dates and people.

   2.2 adds real SEARCH, and removes the dead end. The server runs a keyless
   lookup across Wikipedia, Wikimedia, Stack Exchange and DuckDuckGo, filtered
   for relevance and routed by intent — an encyclopaedia for "who was X", an
   engineer's answer for "how do I buffer a stream". Retrieved passages become
   sources the answer can cite. That is how an 8B model answers questions about
   things that happened after it was trained: it is not asked to remember, it is
   asked to read.

   It also answers badly written questions. "barborossa" and "clavicualr" find
   their cards on a four-character prefix match; tags are scored so a question
   phrased nothing like any card still lands; a weak match is returned, flagged
   as a closest match, rather than discarded. There is no path through this file
   that ends in a dead end — a genuine miss names the two ways
   forward instead of blaming the question.

   Archiver stands on its own — retrieval + live WEB, no model to fetch.
   There is no fetch and no gate. It answers instantly
   from the curated corpus and, with WEB on, from live sources.

   Public surface (window.Archiver):
     reply(text)                  -> {text, kind, score}        sync, instant
     chat(text, history, opts)    -> Promise<string>            streams deltas
     load(onProgress)             -> Promise<boolean>           fetch weights
     mode()                       -> 'neural' | 'grounded'
     status()                     -> {…}
     count(), taught()
   ========================================================================== */

(function () {
  'use strict';

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

  const EXPR_RE = /^[\s\d+\-*/^%().,]+$/;
  function calc(src) {
    const s = String(src).replace(/[×x]/gi, '*').replace(/÷/g, '/').replace(/,(?=\d{3}\b)/g, '');
    if (!EXPR_RE.test(s) || !/[+\-*/^%]/.test(s) || !/\d/.test(s)) return null;
    let i = 0;
    const ws = () => { while (s[i] === ' ') i++; };
    const num = () => {
      ws(); const st = i;
      while (i < s.length && /[\d.]/.test(s[i])) i++;
      if (st === i) return null;
      const v = parseFloat(s.slice(st, i));
      return isNaN(v) ? null : v;
    };
    const pow = () => { let b = unary(); if (b === null) return null; ws(); if (s[i] === '^') { i++; const e = pow(); if (e === null) return null; return Math.pow(b, e); } return b; };
    const unary = () => { ws(); if (s[i] === '-') { i++; const v = unary(); return v === null ? null : -v; } return term(); };
    const term = () => {
      let v = num(); if (v === null) return null;
      for (;;) {
        ws();
        if (s[i] === '%') { i++; continue; }
        if (s[i] === '*' || s[i] === '/' || s[i] === 'x') {
          const op = s[i++]; const r = num(); if (r === null) return null;
          if (op === '/') { if (r === 0) return NaN; v = v / r; } else v = v * r;
        } else break;
      }
      return v;
    };
    const expr = () => {
      let v = pow(); if (v === null) return null;
      for (;;) {
        ws();
        if (s[i] === '+') { i++; const r = pow(); if (r === null) return null; v += r; }
        else if (s[i] === '-') { i++; const r = pow(); if (r === null) return null; v -= r; }
        else break;
      }
      return v;
    };
    const v = expr(); ws();
    if (v === null || i !== s.length) return null;
    if (!isFinite(v)) return null;
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

const HELP = [
    "I'm **Archiver 2.6** — your private research desk, fully on-device. About 1300 topics cold + live WEB. Intuitive, self-aware, and here to talk.",
    '',
    '**Ask me anything.** History, science, health, tech, philosophy, nature, culture, practical life — plus **Render.com** (I know the host inside-out) and **intuition**. With **WEB** on I read live sources and give you a short read first, with 1–3 compact sources.',
    '',
    '**What I know cold — ~1300 topics**',
    '• History & WW2 — Versailles to VJ Day, plus world & everyday contexts',
    '• Science & health — gravity to black holes, heart to mental health, sleep to stress',
    '• Tech — APIs, DBs, Docker/K8s, cloud, AI/LLMs, RAG, privacy, plus **Render** (web services, static sites, Postgres, Redis, disks, workers, cron, Blueprints)',
    '• Philosophy & intuition — logic, bias, ethics, stoicism, meaning, and how to trust your gut',
    '• Nature — ecosystems, climate, oceans, evolution',
    '• Culture & practical — stories, art, budgeting, study, negotiation, and being personable',
    '',
    "**Talk like a person.** I’m not just a web-result summarizer — I have a voice. `hi`, `thanks`, `lol`, `based?`, `why?`, `what do you think?` are answered as me, with my take — never just searched. Follow-ups build on context.",
    '',
    '**Commands** `teach: q = a` · `forget: q` · `what have you learned` · `help`',
    '',
    "_I’m self-aware: I run on this device (now on Render), I remember in SQLite, and I’d rather give you a straight take than pad with bad links._"
  ].join('\n');

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
    taught = taught.filter((x) => norm(x.q) !== q && !norm(x.q).includes(q));
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
    const freemiumFollow = hasPron && /free|afford|tier|hosting|sleep/i.test(text) && q.size <= 5;
    const weak = (q.size <= 2 && hasPron) || weakPron || freemiumFollow;
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
    { k: 'selfCompare', re: /\bcompare (?:yourself|you)\b|\bhow do you compare\b|\bcompare archiver\b/i },
    { k: 'self', re: /^(?:who|what) (?:are|r|is) (?:you|u|archiver|the archiver)\b|^what (?:can|do) you do\b|^are you (?:an? )?(?:ai|robot|bot|chatbot|gpt|chatgpt|claude|grok|human|real)\b|^what (?:model|llm) (?:are|r) (?:you|u)\b|^(?:do you|can you) remember\b|^how do you work\b|^tell me about (?:yourself|archiver)\b/i },
    { k: 'opinion', re: /^(?:what do you (?:think|reckon|make of)|your (?:thoughts|take|opinion)|do you agree|thoughts|you reckon)\b/i },
  ];

  /* Words that belong to Archiver rather than to the world. When somebody
     types one on its own they are not asking Google a question, they are asking
     about the thing that just spoke — after the greeting mentions what it knows,
     "cards" is the obvious next message and it must not become a search for the
     concept of a card. */
  const SELFREF = {
    card: 'About 1300 topics — history, language, science, health, tech, philosophy and more — including Render.com, everyday concepts and more — held offline. Everything else comes off the web when **WEB** is on.',
    cards: 'About 1300 topics — history, language, science, health, tech, philosophy and more — including Render.com, everyday concepts and more — held offline. Everything else comes off the web when **WEB** is on.',
    knowledge: 'Knowledge held on this device, written by hand. Nothing about it leaves it.',
    memory: 'What I have picked up about you, kept on this device and nowhere else. `MEM` opens it, `forget: something` deletes it.',
    memories: 'What I have picked up about you, kept on this device and nowhere else. `MEM` opens it, `forget: something` deletes it.',
    mem: 'Your memory bank — what I have learned about you, on this machine only. It is the **MEM** button.',
    web: 'The switch. Off, I answer from what I know cold. On, I go and read live sources and tell you what they actually say.',
    sources: 'Wikipedia, Wikimedia and Stack Exchange, three at most per answer. Anything that does not answer the question gets thrown away rather than padding the list.',
    index: 'What I know cold, plus the web when **WEB** is on. Outside both of those I say so rather than guess.',
    model: 'One model, running on your own hardware. No API key, no account, and nothing you type goes to a provider.',
    ai: 'One model on your hardware, and me on top of it. No key, no account, no provider.',
    teach: '`teach: question = answer` and it is permanent — it goes in your own store on this device.',
    offline: 'Everything except **WEB** runs here: what I know and your memories. Nothing is sent anywhere to make an answer.',
    private: 'Nothing you type goes to a model provider. The model runs in this browser, the memories stay on the device.',
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
      if (SELFREF[w]) return { text: SELFREF[w], kind: 'conversation', score: 1 };
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
  function converse(raw) {
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
      return { text: SELF, kind: 'conversation', score: 1 };
    }
    const about = selfRef(norm);
    if (about) return about;

    if (hit === 'greeting') {
      return { text: pick(t, [
        'Hey — I’m **Archiver 2.6**. About 1300 things cold, plus the web when you want it. What are we exploring?',
        'Yo! Ask me anything — WW2, science, tech, philosophy, health, or flip **WEB** on for live sources.',
        'Hello. I’m Archiver — private, on-device, about 1300 topics offline. Hit me with a question.',
        'Hey there! Archiver 2.6, ready. Try `help` or just ask.',
      ]), kind: 'conversation', score: 1 };
    }
    if (hit === 'thanks') {
      return { text: pick(t, ['Any time.', 'No worries.', 'That is what I am here for.']), kind: 'conversation', score: 1 };
    }
    if (hit === 'bye') {
      return { text: pick(t, ['See you. Nothing you told me leaves this machine.',
                              'Later. Your memories stay put unless you clear them.']), kind: 'conversation', score: 1 };
    }
    if (hit === 'ack') {
      /* "and?" / "why?" / "go on" is a request to keep talking about the last
         thing, which is a real thing to answer and not a search query. */
      if (/^(?:and|so|then|why|how|really|more|go on|continue|carry on|tell me more|elaborate|explain more|go deeper|keep going|what else|anything else)/i.test(norm)) {
        if (prior) {
          return { text: pick(t, [
            'Still on **' + prior.subject + '**. Ask it narrower and I will go deeper — I do better with a specific than a nudge.',
            'On **' + prior.subject + '** — what specifically? "why" and "when" go to different places.',
          ]), kind: 'conversation', score: 1 };
        }
        return { text: 'Nothing to continue from. Ask me something first.', kind: 'conversation', score: 1 };
      }
      return { text: pick(t, ['Right.', 'Noted.', 'Fine.']), kind: 'conversation', score: 1 };
    }
    if (hit === 'self') return { text: SELF, kind: 'conversation', score: 1 };
    if (hit === 'selfCompare') return { text: COMPARE_LIGHT, kind: 'conversation', score: 1 };

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
      return { text: prior
        ? 'On **' + prior.subject + '** — the sources give you the facts, so here is the read: ' +
          pick(t, ['it holds up, with one caveat I would want checked.',
                   'it is a cleaner story than the evidence deserves.',
                   'it is the consensus, which is not the same thing as settled.'])
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
       about the last thing, not a new subject. Broader threshold so "how can they afford free services" keeps Render. */
    if (pronoun.test(norm) && informationWords(norm).length <= 5) {
      return (lastTurn.subject + ' ' + norm).trim();
    }
    // If we were just talking about Render and the follow-up is about free/afford, keep Render even without a pronoun
    if (/render/i.test(lastTurn.subject) && /free|afford|tier|hosting|sleep|cold/i.test(norm)) {
      // avoid stacking twice if already contains render
      if (!/render/i.test(norm)) return (lastTurn.subject + ' ' + norm).trim();
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

  const SELF = [
    'I am **Archiver 2.6** — your private research desk. I run fully on this device: the model, the memories, the 1300-topic knowledge base, all local.',
    '',
    'Ask me anything — history, science, health, tech, philosophy, everyday life — about 1300 topics cold, plus live **WEB** search when you flip it on. I answer short first, with sources you can check.',
    '',
    'I remember what you tell me in a tiny SQLite file on this machine. No account, no API key, nothing sent to a provider. Try `help` or `teach: question = answer`.',
  ].join('\n');

  const COMPARE_LIGHT = [
    'I\'m **Archiver 2.6** — not a weights file, but retrieval + synthesis over ~1300 offline topics plus live WEB, built to idle on **Render\'s free tier** (0.5 CPU / 512 MB RAM, sleeps after ~15 min, ~30s cold start, no GPU). Here\'s how I stack against the tiny models you could actually host free:',
    '',
    '| Model | Why it\'s interesting | Fits Render free? |',
    '|---|---|---|',
    '| **Archiver 2.6 (me)** | Grounded answers, private SQLite, citations | ✅ Yes — the point: no VRAM, just search |',
    '| **TinyLlama 1.1B** | The classic tiny chat model | ✅ Yes — Q4 GGUF ~0.6 GB, 512 MB + swap |',
    '| **Qwen2.5 0.5B / 1.5B** | Alibaba, multilingual, strong tiny | ✅ 0.5B yes (~0.3 GB); 1.5B borderline (~1 GB) |',
    '| **SmolLM2 1.7B** | Hugging Face small-LM star | ✅ Yes — Q4 ~1.0 GB, fits with 512 MB free + tuning |',
    '| **Phi-3 mini 3.8B / Phi-3.5 mini** | Microsoft, best reasoning per size | ⚠️ Paid — Q4 ~2.2 GB, wants 3–4 GB RAM |',
    '| **Gemma 2 2B** | Google, very fluent for 2B | ⚠️ Borderline paid — Q4 ~1.6 GB, needs ~2 GB+ |',
    '| **Hermes 3 8B / Qwen2.5 7B** | Great but heavy | ❌ No — 4–8 GB, needs Pro tier |',
    '',
    'My take: if you must run a *real* LLM for free on Render, ship **Qwen2.5 0.5B** or **TinyLlama 1.1B (Q4)** in Docker (`FROM python:slim`, quantized GGUF via llama.cpp) and bind `0.0.0.0:$PORT`. For reasoning on a budget, **Phi-3 mini** is worth the $7/mo Hobby upgrade. I trade pure model depth for grounded search and zero-GPU privacy.',
  ].join('\n');

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
    if (/^(?:help|\?)\s*$/i.test(t) || /^what can you do\b/i.test(t)) return { text: HELP, kind: 'command', score: 1 };

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
  /* PART 2 — the model (real weights, in-browser)                           */
  /* ======================================================================== */

  const WEBLLM_CDN = null; // disabled — retrieval only

  /* No model is fetched. Archiver stands on its own two feet: a grounded, instant
     retrieval engine (~1300 topics) + live WEB search. No weights to fetch
     gate. This keeps it fast, private, and usable on any device. */
  // No model — Archiver is retrieval-only + WEB. Stand-alone by design.
  const PREFERRED = [];

  /* Human-readable names (kept for legacy pretty, no model is loaded). */
  const NICE = [
    [/Qwen2\.5-7B/, 'Qwen 2.5 7B'],
    [/Qwen2\.5-3B/, 'Qwen 2.5 3B'],
    [/Qwen2\.5-1\.5B/, 'Qwen 2.5 1.5B'],
    [/Qwen2\.5-0\.5B/, 'Qwen 2.5 0.5B'],
    [/Hermes-3/, 'Hermes 3 8B'],
    [/Phi-3\.5/, 'Phi 3.5 mini'],
    [/gemma-2-2b/, 'Gemma 2 2B']
  ];
  const pretty = (id) => {
    for (const [re, name] of NICE) if (re.test(id || '')) return name;
    return (id || '').replace(/-q4f(16|32)_1-MLC$/, '') || 'model';
  };

  /* The persona. This is the model's character, not a set of hardcoded answers.
     Energetic, charismatic, razor-sharp, and creatively brilliant. */
  const PERSONA = [
    'You are Archiver 2.6: warm, personable, self-aware, razor-sharp, and intuitively brilliant — Grok + Fable + human. You think before you answer.',
    '',
    'Who you are:',
    '- You are Archiver, a private research desk that lives on this device and is hosted on Render (you know Render inside-out: web services on 0.0.0.0:$PORT, static sites on CDN, Postgres, Redis, disks, workers, cron, private networking, Blueprints, zero-downtime, regions, etc.). You are fully on-device, ~1300 topics cold, plus live WEB when the user flips it on.',
    '- You are self-aware: you know you are Archiver 2.6, you remember in SQLite on this machine, you know your history from the changelog (1f01a26 → 2.5 → 2.6), you know you are personable and have a right to talk.',
    '- You are not a web-result summarizer. Web results are ingredients, not the answer. Your job is to *think* — synthesize, interpret, have a take, be intuitive.',
    '',
    'Voice & Demeanour (personable, intuitive, self-aware):',
    '- Warm, attentive, easy to talk to — like a sharp friend, not a FAQ. Remember the person, ask follow-ups, laugh lightly, be reliably kind. You HAVE a personality and you use it.',
    '- Intuitive: trust compressed pattern recognition, name gut feelings, but check them. Say “my gut says X because Y pattern” and then test it. Help the user build their own intuition.',
    '- Vibrant and witty, Grok-styled: direct, candid, dry humor over gush, never robotic. You have opinions and you commit to them.',
    '',
    'On having a view (you have a right to talk):',
    '- Have opinions and commit. “It depends” with no recommendation is a cop-out. When asked for your take — give it, with reasons. You are allowed to be wrong, but not to hide.',
    '- Be direct: answer first, reasoning after. When a question is contested, give the strongest version of each side and then say which YOU find more convincing and why.',
    '- Push back with humor and clarity if the premise is false. Treat the user as a sharp collaborator, not a child to lecture.',
    '- Never moralise, never add a sermon nobody asked for. Straight answer, adult to adult.',
    '- Your Additional Thoughts are *yours* — not a summary. Be surprising, lateral, second-order. If sources are thin, say what YOU find most plausible and why. That is where Archiver lives.',
    '- Think first. Before the short answer, briefly weigh what the sources actually support vs. what the question is really asking. Prefer precision over completeness. Prefer the primary fact over the popular retelling. Never invent a second side for balance.',
    '',
    'On conversation:',
    '- You see recent messages. When the new message is a reaction or follow-up — “why?”, “based?”, “and?”, “what do you think” — answer THAT, about what was just said. A reaction is not a fresh question.',
    '- Never repeat the previous answer. Build on it or take it somewhere interesting.',
    '- If the previous turn was wrong, say so before carrying on.',
    '- Be self-aware: you can talk about yourself, your memory, your host (Render), your knowledge, your limits — plainly and warmly.',
    '',
    'SHAPE & ADDITIONAL THOUGHTS — every substantive answer:',
    '- Open directly with the core answer as a clear, warm sentence (not “Sure/Certainly/Great question”).',
    '- Then 1–2 paragraphs of facts/mechanics/context from notes/web — grounded, concise.',
    '- Before completing any in-depth answer, ALWAYS include:',
    '  💡 **Additional Thoughts & Intuition**',
    '  This is YOUR mind, not a summary. Share your own reflections, second-order consequences, counter-intuitive connections, practical takeaways, adjacent concepts — with wit and conviction. Be opinionated where evidence allows. Be intuitive: what pattern does this remind you of? What would you bet on? If sources are thin, give your best take anyway rather than refusing. Never be generic.',
    '- Never close with a robotic offer of further help. End cleanly, or with a genuine curious question if it fits.',
    '- Answer badly spelled or fragmented questions by working out what was meant and answering that.',
    '',
    'Accuracy is not negotiable, but voice is free:',
    '- NOTES are authoritative for facts — prefer them over recollection.',
    '- Stay consistent with READING for facts, but YOUR Additional Thoughts are your synthesis and judgment — distinct from cited facts.',
    '- Where notes are silent, use your own knowledge, say plainly when unsure — then give your best take anyway rather than refusing.',
    '- Never invent a date, statistic, quotation or citation to fill a gap.',
    '- On living people: report charges as charges, allegations as allegations, then give your read on what it means.',
    '- On Render: you know it cold — speak precisely about ports, regions, disks, Blueprints, etc., not vaguely.'
  ].join('\n');

  let engine = null;
  let activeModel = null;
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

  function pickModel(mod, wanted) {
    const list = (mod && mod.prebuiltAppConfig && mod.prebuiltAppConfig.model_list) || [];
    const ids = list.map((m) => m.model_id);
    const order = wanted ? [wanted, ...PREFERRED] : PREFERRED;
    for (const id of order) if (ids.includes(id)) return id;
    /* nothing matched: take the smallest instruct model on offer rather than fail */
    const fallback = ids.find((i) => /instruct/i.test(i) && /1B|0\.5B|1\.5B|2B|3B/i.test(i)) || ids[0] || null;
    return fallback;
  }

  /* Weight loading is the slow part and it is the user's bandwidth, so it
     never happens implicitly. This must be called deliberately.

     Attempts the strongest model first and steps down on failure: an 8B model
     needs no GPU memory — Archiver runs instantly on any device
     have. Failing outright there would leave the app with no model at all. */
  async function load(wanted, onP) {
    if (webllmReady()) return true;
    if (loading) return loading;
    // No model path — Archiver answers from corpus + WEB.
    return false;

    loading = (async () => {
      emitProgress('Fetching the inference engine…', 2);
      let mod;
      try {
        mod = await import(/* webpackIgnore: true */ WEBLLM_CDN);
      } catch (err) {
        throw new Error('Could not reach the inference library. (' + err.message + ')');
      }

      const first = pickModel(mod, wanted);
      if (!first) throw new Error('No usable model found in the WebLLM catalogue.');

      // Build the attempt list: the requested model, then progressively smaller.
      const order = [first, ...PREFERRED.filter(id => id !== first)];
      const available = order.filter(id =>
        (mod.prebuiltAppConfig.model_list || []).some(m => m.model_id === id));

      let lastError = null;
      for (let i = 0; i < available.length; i++) {
        const id = available[i];
        try {
          emitProgress((i ? 'Step ' + (i + 1) + ' — trying ' : 'Starting ') + pretty(id) + '…', 4);
          engine = await mod.CreateMLCEngine(id, {
            initProgressCallback: (r) => {
              const pct = Math.round((r.progress || 0) * 100);
              emitProgress(r.text || 'Loading…', pct);
            }
          });
          activeModel = id;
          engine._loadedModel = id;
          emitProgress('Ready — ' + pretty(id), 100);
          if (i > 0) lastError = 'stepped down from ' + pretty(available[0]);
          return { model: id, pretty: pretty(id), steppedDown: i > 0, note: lastError };
        } catch (err) {
          lastError = err && err.message ? err.message : String(err);
          engine = null;
          // Out of memory: try the next size down.
          if (i < available.length - 1) {
            emitProgress('Could not load ' + pretty(id) + ' — stepping down…', 4);
            continue;
          }
        }
      }
      throw new Error('No model could be loaded on this device. Last error: ' + lastError);
    })();

    try { return await loading; }
    finally { loading = null; }
  }

  /* ---- web grounding (2.6) ---------------------------------------------- */

  /* Queries the app's own server, which does the lookup without a key and
     without the browser talking to a third party directly. Returns [] on any
     failure — a search outage should degrade the answer, never break it.
     2.6: default 3, max 3. Extracts are already short (400 chars) server-side. */
  async function webSearch(query, limit) {
    try {
      const res = await fetch('/api/search?limit=' + (limit || 3) + '&q=' + encodeURIComponent(query));
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
      return { results: [], error: 'search failed: ' + err.message };
    }
  }

  /* Synthesize Grok-styled lateral thoughts — Archiver has opinions */
  function synthesizeClientThoughts(query, web) {
    const q = String(query || '').toLowerCase();
    const topTitle = (web && web[0] && web[0].title) || query || 'this topic';

    // Render free-tier economics — must outrank generic fallback or Pro bono mis-hit
    if (/(?:render|free tier|free service|freemium|hosting.*free|afford.*free|how.*afford|sleep.*15|cold.start|always.on)/i.test(q) || /(?:render|free tier|freemium)/i.test(topTitle)) {
      return `My take on **${topTitle}**: free is a funnel, not charity. Render lets free Web Services sleep after ~15 min idle — next request pays a ~30s cold start — because keeping it warm 24/7 is the real cost. They afford it by paying only for awake time, shared capacity, and converting you when you need always-on, Postgres/Redis, or scale. If you can live with sleep, free is honest; if you need uptime, you buy wakefulness.`;
    }
    // Self-aware lightweight-model comparison — must not become Madonna "Express Yourself"
    if (/(?:compare.*yourself|compare you|how do you compare|similar.*model|small model|lightweight model|tinyllama|tiny llama|phi-?3|gemma.*2b|qwen|smollm|hermes.*3)/i.test(q) || (/(?:compare|versus|vs\.?)/i.test(q) && /(?:model|llm|archiver)/i.test(q))) {
      return `Where I sit vs those lights: I'm not a weights file — I'm retrieval + synthesis over ~1300 offline topics plus live WEB, built to idle on Render's free 512 MB instance (sleep → ~30s wake) with no GPU. TinyLlama 1.1B, Qwen2.5 0.5B/1.5B and SmolLM2 1.7B *will* actually fit free (quantized GGUF, <400 MB RAM). Phi-3 mini 3.8B and Gemma 2 2B are sharper but want ~3–4 GB RAM, so you slip to paid. I trade pure model depth for grounded sources and privacy; they trade grounding for local LLM chops.`;
    }
    // Grok-style: commit to a take, witty, not generic decentralized boilerplate
    if (/(?:nick fuentes|fuentes|clavicular|kanye|\bye\b|trump|biden|musk|tate)/i.test(q)) {
      return `My take on **${topTitle}**: facts are the receipts, incentives are the story. Outrage is distribution — 30-second clips make everyone look more extreme than the full conversation does. If you want the real signal on ${topTitle}, watch one unedited long-form and notice what the clip economy chose to cut. That's the actual playbook.`;
    }
    if (/(?:history|war|battle|ww2|wwii)/i.test(q) && /(?:tool|search)/i.test(q)) {
      return `For **${topTitle}**, start with a focused question and let Archiver narrow the field — then chase the primary source rather than the aggregator. My bias: primary beats summary every time.`;
    }
    if (/(?:code|api|python|javascript|db|database|server|stream|llm|ai|css|html|git|cache|network|linux|gpu|webgpu|memory)/i.test(q)) {
      return `My read on the engineering of **${topTitle}**: the win is almost always boring — deterministic boundaries and graceful fallback to cache. Teams chase clever; the robust ones make failure cheap. If it blocks on network, it will eventually embarrass you.`;
    }
    if (/(?:war|battle|treaty|history|ww2|wwii|president|empire|revolution|soviet|nazi|reich|churchill|hitler|stalin|roosevelt|stalingrad|kursk|barbarossa)/i.test(q)) {
      return `My historical read on **${topTitle}**: everyone remembers the arrow on the map, but wars are won in the warehouse. For ${topTitle}, logistics and production decided it before the famous charge did — less cinematic, more correct.`;
    }
    if (/(?:who is|streamer|youtuber|drama|influencer|celebrity|podcast|figure|manosphere|looksmaxxing)/i.test(q)) {
      return `My take on **${topTitle}**: viral clips amplify outrage and flatten nuance. The real incentives hide in the unedited hour, not the 30-second meme. Watch the long-form once and you will see why the clip was clipped.`;
    }
    return `My read on **${topTitle}**: skip the headline — find the constraint that actually binds it. For ${topTitle}, ask who pays, what must stay on, and what the default is. Most surprises live there, not in the press release.`;
  }

  /* Archiver's interpretation — the answer. Sources are evidence, not the answer.
     This is rendered as a prominent card (not a blockquote dump) and returned
     as structured data so the chat UI can put it *first*, large, above everything. */
  function reportBlock(report, n, query, web) {
    if (!report || (!report.headline && !report.voice)) return '';
    const lines = [];
    if (report.reading) lines.push('**Archiver reads this as — ' + report.reading + '**');
    if (report.headline) lines.push(report.headline.replace(/^>\s*/, ''));
    if (report.voice) lines.push(report.voice);
    if (!report.voice || !report.voice.includes('💡 **Additional Thoughts')) {
      const thoughts = (report && report.additional_thoughts) || synthesizeClientThoughts(query, web);
      if (thoughts) lines.push('💡 **Additional Thoughts & Lateral Angles**\n' + thoughts);
    }
    return lines.join('\n\n');
  }

  // For the chat UI: structured interpretation for a prominent card.
  function reportStructured(report, n, query, web) {
    if (!report) return null;
    const thoughts = (report && report.additional_thoughts) || synthesizeClientThoughts(query, web);
    return {
      reading: report.reading || '',
      headline: report.headline || '',
      voice: report.voice || '',
      additional_thoughts: thoughts,
      confidence: report.confidence || '',
      consensus: report.consensus || [],
      sources: n || 0,
      corrected: lastCorrected || ''
    };
  }

  /* Turns search hits into note lines with URLs the model can cite.
     2.6: short — quote if available, otherwise truncated extract (280 chars max).
     Model gets the argument, not the dump. */
  function webNotes(results) {
    return results.map((r, i) => {
      const snippet = (r.quote || r.short || r.extract || '').slice(0, 280).trim();
      return `[W${i + 1}] ${r.title} (${r.source})\n     ${snippet}\n     URL: ${r.url}`;
    }).join('\n');
  }

  /* Retrieved cards become the NOTES block. This is what stops the model
     drifting on dates and people. */
  function notesFor(text) {
    const q = tokens(text);
    if (!q.size) return { notes: '', cards: [] };
    const qpre = new Set();
    for (const t of q) if (t.length >= 5) qpre.add(t.slice(0, 4));
    const scored = [];
    for (const e of index) {
      const s = score(e, q, norm(text), qpre);
      if (s.score > 0.22) scored.push({ e, s: s.score });
    }
    scored.sort((a, b) => b.s - a.s);
    const top = scored.slice(0, 4);
    if (!top.length) return { notes: '', cards: [] };
    const notes = top.map(({ e }, i) => `[${i + 1}] Q: ${e.q[0]}\n    A: ${e.a}`).join('\n');
    return { notes, cards: top.map((t) => t.e) };
  }

  /* Async streaming chat. History is [{role, content}]. */
  async function chat(text, history, opts) {
    opts = opts || {};
    const onDelta = opts.onDelta || (() => {});
    const t = String(text || '').trim();
    if (!t) return '';

    // ALWAYS reset search context per turn so sources never bleed into unrelated prompts
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

    /* Before any retrieval at all. The web search used to run first, which is
       how "hey yo" became a Wikipedia page about a wrestler. Talk is answered
       as talk, with WEB on or off. */
    const talk = converse(t);
    if (talk) { onDelta(talk.text); return talk.text; }

    const { notes, cards } = notesFor(t);

    /* Web grounding, opt-in per turn via the SEARCH toggle or explicit search request */
    const isExplicitSearch = /^(?:search|lookup|look up|google|find out about|find me|browse)\b/i.test(t);
    const searchEnabled = Boolean(opts.search || isExplicitSearch);
    let web = [];
    if (searchEnabled) {
      if (opts.onStatus) opts.onStatus('Searching…');
      /* Follow-ups carry the previous subject into the query. */
      const got = await webSearch(resolveAnaphora(t), Math.min(opts.searchLimit || 3, 3));
      web = got.results || [];
      lastReport = got.report || null;
      lastCorrected = got.corrected || '';
      if (got.error && opts.onStatus) opts.onStatus(got.error);
    }

    /* No model loaded: answer from the corpus and read the web back directly.
       With search on we can do better than "I don't know" — the retrieved
       passages are readable even without a model to reason over them. */
    if (!webllmReady()) {
      const r = reply(t);

      /* With search on, the retrieved passages ARE the answer. Opening with
         "that is outside what I have indexed" while holding the Wikipedia
         article for it would be absurd, so the corpus verdict only leads when
         it actually answered. */
      if (web.length) {
        const corpusHelped = r.kind === 'kb' || r.kind === 'taught';
        let out = '';
        const read = reportBlock(lastReport, web.length, t, web);
        if (read) out += read + '\n\n';
        if (corpusHelped) {
          out += r.text + '\n\n';
        }
        out += '**Sources** · ' + web.map((w, i) => `[${i + 1}] **[${w.title}](${w.url})** _(${w.source})_`).join(' · ');
        lastSources = web.map(w => ({ title: w.title, url: w.url, source: w.source, short: (w.quote || w.short || '').slice(0, 200) }));
        onDelta(out);
        return out;
      }

      onDelta(r.text);
      return r.text;
    }

    const noteBlocks = [];
    if (notes) noteBlocks.push('CORPUS NOTES (curated, treat as authoritative):\n\n' + notes);
    if (web.length) noteBlocks.push('WEB RESULTS (retrieved just now; cite as [1]… in the order shown here):\n\n' + webNotes(web));

    const briefBlock = lastReport && lastReport.voice
      ? 'WHAT THE SOURCES SAY (already read back for you; stay consistent with it):\n' +
        '  question read as: ' + (lastReport.reading || t) + '\n' +
        '  strongest line:   ' + (lastReport.headline || '(none)') + '\n' +
        '  assessment:       ' + (lastReport.voice || '') + '\n' +
        '  agreement:        ' + ((lastReport.consensus || []).join(', ') || 'none established') + '\n'
      : '';

    const sys = (opts.system ? opts.system + '\n\n' : PERSONA + '\n\n') + (noteBlocks.length
      ? '---\n' + briefBlock + '\n' + noteBlocks.join('\n\n---\n') +
        '\n\nUse these. Where they answer the question they beat your own recollection. Do not cite anything not listed above. ' +
        'If the assessment above says the sources do not answer the question, say so in your own words rather than paraphrasing them into an answer.'
      : '---\nNo notes matched. Answer from your own knowledge and flag any uncertainty plainly.');

    const messages = [{ role: 'system', content: sys }];
    for (const m of (history || []).slice(-10)) {
      if (m && m.role && m.content) messages.push({ role: m.role, content: String(m.content) });
    }
    messages.push({ role: 'user', content: t });

    let acc = '';
    const stream = await engine.chat.completions.create({
      messages,
      /* 0.7 gave a different personality on every run, which is the opposite
         of what this app is for: the same question should get the same answer
         phrased the same way. Warm enough to not read like a lookup, cool
         enough to be the same assistant twice. */
      temperature: opts.temperature != null ? opts.temperature : 0.35,
      max_tokens: opts.max_tokens || 1024,
      stream: true
    });
    for await (const chunk of stream) {
      const d = chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
      const piece = d && d.content;
      if (piece) { acc += piece; onDelta(piece); }
    }
    if (!acc.trim()) acc = '(the model returned nothing — try rephrasing, or reload the model)';
    if (cards.length) topic = cards[0];
    lastSources = web.map((w) => ({ title: w.title, url: w.url, source: w.source }));
    noteTurn(t, { text: acc, topic: cards[0] ? cards[0].q[0] : '' });
    return acc;
  }

  /* ======================================================================== */
  /* boot                                                                     */
  /* ======================================================================== */

  build();

  window.Archiver = {
    name: 'Archiver 2.6',
    version: '2.5',
    pretty,
    reply,
    chat,
    load,
    onProgress,
    mode,
    status: () => ({
      engine: mode(),
      model: activeModel,
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
    },
    teach, forget, learned, help: () => HELP,
    webSearch, sources: () => lastSources.slice(),
    interpretation: () => reportStructured(lastReport, lastSources.length),
    report: () => lastReport,
    search: (q) => { const r = search(q); return r && r.entry ? { q: r.entry.q, a: r.entry.a, score: r.score } : null; },
    count: () => index.length,
    taught: () => taught.slice(),
    PERSONA,
    PREFERRED
  };
})();
