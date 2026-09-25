const A = require('./ui_check.js');
let bad = 0;
const say = (ok, label, extra) => {
  if (!ok) bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${extra ? '  [' + extra + ']' : ''}`);
};

console.log(`\n=== ${A.name} ${A.version} — ${A.count()} cards ===\n`);

console.log('-- every question gets an answer --');
const Q = [
  // corpus coverage — the three areas the cards actually cover
  'stalingrad battle', 'tell me about the eastern front', 'how many died in wwii',
  'explain the holocaust', 'operation barbarossa', 'battle of kursk', 'what happened to hitler',
  'who is clavicular', 'looksmaxxing', 'who is nick fuentes',
  'how to buffer an sse stream', 'python rate limiter decorator',
  // misspellings that must still find the card
  'barborossa', 'clavicualr', 'stalingard',
  // things outside the corpus, which must miss honestly rather than invent
  'asdfghjkl qwerty', 'who won the 1998 world cup', 'what is a rolex',
];
for (const q of Q) {
  const r = A.reply(q);
  const t = (r.text || '').replace(/\s+/g, ' ');
  say(!!t && t.length > 4, q, `${r.kind} ${(r.score || 0).toFixed(2)}`);
  say(!/none of them fit/i.test(t), '   no dead-end language');
}

console.log('\n-- talk is talk, not a search query --');
/* The failures that prompted this: "hey yo" returned a Japanese wrestler named
   Yo-Hey, and "based?" returned an encyclopedia entry on freebase cocaine. */
const TALK = {
  'hey yo': 'conversation', 'yo': 'conversation', 'hi hi': 'conversation',
  'helloooo': 'conversation', 'heyyyy': 'conversation', 'total hi': 'conversation',
  'whats up': 'conversation', 'hello there': 'conversation', 'sup': 'conversation', 'morning': 'conversation',
  'based?': 'conversation', 'bet': 'conversation', 'lol': 'conversation',
  'rip': 'conversation', 'nah': 'conversation', 'fr': 'conversation',
  'ok': 'conversation', 'go on': 'conversation', 'tell me more': 'conversation',
  'who are you': 'conversation', 'are you an ai': 'conversation',
  'what do you think': 'conversation', 'thanks': 'conversation', 'bye': 'conversation',
};
for (const [q, want] of Object.entries(TALK)) {
  const r = A.reply(q);
  say(r.kind === want, q, r.kind + ' :: ' + (r.text || '').replace(/\s+/g, ' ').slice(0, 46));
}
/* A greeting must never be turned into an entity. */
{
  const t = A.reply('hey yo').text;
  say(!/wrestl|Wikipedia|sources/i.test(t), 'a greeting retrieves nothing');
  say(!/Yo-Hey/i.test(t), 'a greeting is not a wrestler');
}

console.log('\n-- a follow-up leans on the previous turn --');
{
  A.reply('what was the battle of stalingrad');
  const why = A.reply('why?').text;
  say(/stalingrad/i.test(why), 'a bare "why?" stays on the subject', why.slice(0, 60));
  const based = A.reply('based?').text;
  say(/stalingrad/i.test(based), '"based?" answers about the last thing said');
  const thoughts = A.reply('what do you think').text;
  say(/stalingrad/i.test(thoughts), 'an opinion request uses the current subject');
}

console.log('\n-- swearing is talk, not a query --');
/* Live transcript sbba890cb81d5: "fu" reached retrieval and came back as
   "That is outside what I have indexed", reading as if two letters were a
   question about the world. */
for (const q of ['fu', 'f u', 'wtf', 'stfu', 'shut up', 'you are useless', 'youre trash', 'bs', 'ffs']) {
  const r = A.reply(q);
  say(r.kind === 'conversation', q, (r.text || '').replace(/\s+/g, ' ').slice(0, 50));
  say(!/indexed|outside what/i.test(r.text), q + ' is not a dead end');
}
/* ...but a real query that happens to contain the word still searches. */
say(A.reply('garbage collection in python').kind !== 'conversation', 'a real "garbage" query still searches');

console.log('\n-- "cards" means my cards --');
/* Same transcript: the greeting mentioned ~300 topics, the user typed "cards",
   and got a miss. Ask about my own vocabulary and the answer is about me. */
for (const q of ['cards', 'card', 'memory', 'web', 'sources', 'teach', 'what are cards', 'your memory']) {
  const r = A.reply(q);
  say(r.kind === 'conversation', q, (r.text || '').replace(/\s+/g, ' ').slice(0, 52));
}
say(new RegExp(A.count().toLocaleString('en-GB')).test(A.reply('cards').text), '"cards" says how many there are');
say(/MEM/.test(A.reply('memory').text), '"memory" points at MEM');

console.log('\n-- a miss always leaves a door open --');
{
  let doors = 0;
  /* "fu" is deliberately not in here — it is talk now, so it never misses. */
  for (const q of ['zxcvbnm', 'what is a rolex', 'asdfghjkl qwerty', 'flibbertigibbet']) {
    const r = A.reply(q);
    if (/WEB|war|engineering/i.test(r.text)) doors++;
  }
  say(doors === 4, 'every miss says what it does know', doors + '/4');
}

console.log('\n-- one model, nothing to choose --');
const st = A.status();
say(!('models' in st) || !Array.isArray(st.models), 'status exposes no model list');

console.log('\n-- answer style --');
{
  const t = A.reply('stalingrad battle').text;
  say(!/^(sure|certainly|of course|absolutely|great question)/i.test(t), 'no chatbot opener');
  say(!/(let me know if|anything else\?|hope (this|that) helps)/i.test(t), 'no chatbot sign-off');
  say(!/\n#{1,4}\s/.test(t), 'no headings inside an answer');
}

console.log('\n-- chat with search, no model loaded --');
(async () => {
  let pieces = 0;
  A.__ctx.__fetch = async () => ({ ok: true, json: async () => ({
    results: [{ title: 'Battle of Kursk', extract: 'x', url: 'https://en.wikipedia.org/wiki/Battle_of_Kursk',
                source: 'Wikipedia', confidence: 0.9, quote: 'The Battle of Kursk was a major battle.' }],
    report: { reading: 'battle of kursk', headline: 'The Battle of Kursk was a major battle.',
              voice: 'One source cleared the bar.', confidence: 'well supported', sources: 1, consensus: [] },
    confidence: 'high', corrected: '', query: 'kursk'
  })});
  const out = await A.chat('battle of kursk', [], { search: true, onDelta: () => pieces++ });
  say(pieces > 0, 'streamed at least one delta');
  say(/\*\*Sources\*\*/.test(out), 'fixed source heading');
  say(/\[1\] \*\*/.test(out), 'numbered source lines');
  say(out.includes('en.wikipedia.org'), 'source carries its url');
  say(!/From the web/i.test(out), 'old heading gone');

  const iRead = out.search(/Archiver reads this as|I read that as/);
  const iSrc = out.indexOf('**Sources**');
  say(iRead >= 0 && iSrc > iRead, 'interpretation precedes its sources', `read@${iRead} src@${iSrc}`);


  console.log('\n-- 2.6.2: arithmetic, forget, honesty --');
  const calcs = { '2*3^2': '18', '(3+4)*2': '14', '10 - 2 - 3': '5', '-2^2': '-4', '2^3^2': '512', '7 % 3': '1', '1,000 + 1': '1,001', '6 x 7': '42' };
  for (const [q, want] of Object.entries(calcs)) {
    const r = A.reply(q).text;
    say(r === `That's ${want}.`, 'calc ' + q, r);
  }
  say(A.reply('(2+3').kind !== 'tool', 'unbalanced bracket is not maths');
  say(/divides by zero/.test(A.reply('5/0').text), 'division by zero is named');
  say(A.reply('1939').kind !== 'tool', 'a bare year is not arithmetic');

  A.reply('teach: war poem = Dulce et Decorum Est');
  A.reply('teach: war = conflict');
  A.reply('forget: war');
  const left = A.taught().map((x) => x.q);
  say(left.includes('war poem') && !left.includes('war'), 'forget removes only the exact question', left.join('|'));
  A.reply('forget: war poem');

  const blob = [A.reply('help').text, A.reply('who are you').text, A.reply('cards').text, A.reply('hi').text].join('\n');
  say(!/render/i.test(blob), 'no Render persona in identity or help');
  say(!/on this machine|on this device only|SQLite file/i.test(blob), 'no false claim that memories are local');
  say(!/2\.5|2\.6\b(?!\.2)/.test(blob), 'no stale version in the copy');
  say(A.version === '2.6.2', 'engine version is 2.6.2');
  say(!('synthesizeClientThoughts' in A) && !/Additional Thoughts/.test(blob), 'no canned thoughts');

  console.log('\n-- 2.6.2: thinking split --');
  const st1 = A.splitThinking('<think>weigh it</think>\n\nThe answer.');
  say(st1.thinking === 'weigh it' && st1.answer === 'The answer.' && !st1.open, 'closed think block splits');
  const st2 = A.splitThinking('<think>still going');
  say(st2.open && st2.thinking === 'still going' && st2.answer === '', 'open think block streams as thinking');
  say(A.splitThinking('<thi').open && A.splitThinking('<thi').answer === '', 'partial tag is not shown as answer');
  say(A.splitThinking('Plain answer').answer === 'Plain answer', 'no think block is all answer');

  console.log('\n-- 2.6.2: model path with a fake engine --');
  const calls = [];
  const fake = (script) => ({
    interrupted: 0,
    interruptGenerate() { this.interrupted++; },
    chat: { completions: { create: async (req) => {
      calls.push(req);
      const parts = script(req);
      return (async function* () { for (const p of parts) yield { choices: [{ delta: { content: p }, finish_reason: null }] }; })();
    } } }
  });
  A.reset();
  A._useEngine(fake(() => ['<think>', 'Kursk was 1943; ', 'the notes agree.', '</think>', '\n\nIn **1943**.']));
  let thought = '', done = false, ans = '';
  const out2 = await A.chat('when was the battle of kursk', [{ role: 'archiver', content: 'earlier' }, { role: 'user', content: 'hi' }], {
    think: true, onDelta: (p) => { ans += p; }, onThink: (t, d) => { thought = t; if (d) done = true; }
  });
  say(out2 === 'In **1943**.' && ans === out2, 'answer excludes the reasoning', JSON.stringify(out2));
  say(/notes agree/.test(thought) && done, 'reasoning streamed and closed', thought);
  say(calls[0].extra_body && calls[0].extra_body.enable_thinking === true, 'thinking requested from the model');
  say(calls[0].messages[0].role === 'system' && /LOCAL NOTES/.test(calls[0].messages[0].content), 'corpus notes reach the model');
  say(calls[0].messages.every((m) => ['system', 'user', 'assistant'].includes(m.role)), 'roles are normalised for the template');
  say(A.thinking() === thought, 'last reasoning is retrievable');

  calls.length = 0;
  A._useEngine(fake((req) => req.extra_body.enable_thinking ? ['<think>', 'endless…'] : ['Direct answer.']));
  const out3 = await A.chat('explain entropy', [], { think: true, onDelta: () => {} });
  say(out3 === 'Direct answer.' && calls.length === 2 && calls[1].extra_body.enable_thinking === false, 'reasoning that never concludes falls back to a direct answer');

  calls.length = 0;
  A._useEngine(fake(() => ['A real view on it.']));
  A.reply('battle of stalingrad');
  const talked = await A.chat('what do you think?', [], { think: false, onDelta: () => {} });
  say(talked === 'A real view on it.' && calls.length === 1, 'opinion goes to the model when loaded, not a canned verdict');
  say(calls[0].extra_body.enable_thinking === false, 'THINK off is honoured');
  const greet = await A.chat('hey', [], { onDelta: () => {} });
  say(calls.length === 1 && !/real view/.test(greet), 'greetings stay local even with the model');

  const ac = new AbortController();
  const eng = fake(() => { ac.abort(); return ['partial']; });
  A._useEngine(eng);
  await A.chat('explain gravity', [], { think: false, signal: ac.signal, onDelta: () => {} }).catch(() => {});
  say(eng.interrupted >= 1, 'STOP interrupts generation');
  A._useEngine(null);
  say(A.mode() === 'grounded', 'unloading returns to the corpus');

  console.log(`\n${bad ? bad + ' FAILURES' : 'all checks passed'}\n`);
  process.exit(bad ? 1 : 0);
})();
