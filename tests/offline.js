const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const A = require('./ui_check');
let checks = 0;
function check(ok, message) { assert.ok(ok, message); checks++; }
(async () => {
  check(A.version === '3.3' && A.status().version === '3.3' && A.name === 'Archiver 3.3', 'runtime version');
  check(A.__ctx.ARCHIVER_KB.version === '3.3', 'corpus version');
  for (const [query, expected] of [
    ['2 + 3 * 4', '14'], ['(2 + 3) * 4', '20'], ['2^3^2', '512'],
    ['-2^2', '-4'], ['(-2)^2', '4'], ['3 * -2', '-6'], ['2^-2', '0.25'],
    ['calculate 18% of 250', '45'], ['50% * 80', '40'], ['1,000 / 4', '250'],
    ['.5 + .25', '0.75'], ['2 × (3 + 4)', '14'], ['what is 8 ÷ 2?', '4'],
  ]) check(A.reply(query).text === `That's ${expected}.`, query);
  check(/undefined/.test(A.reply('1 / 0').text), 'undefined arithmetic');
  check(A.reply('what is time complexity').kind !== 'tool', 'not a clock query');
  check(A.reply('what date was d-day').kind !== 'tool', 'not today');
  check(A.reply('what time is it').kind === 'tool', 'actual clock query');
  for (const query of ['compare Python and JavaScript', 'RAM vs SSD', 'difference between mitosis and meiosis', 'compare HTTP with HTTPS']) {
    A.reset(); check(A.reply(query).kind === 'comparison', query);
  }
  check(A.reply('compare python and zzzzzzz').kind === 'clarify', 'no invented comparison');
  A.reset();
  check(A.reply('hey bro explain photosynthesis in one sentence').text.split(/(?<=[.!?])\s+/).length === 1, 'informal single-sentence instruction');
  check((A.reply('explain photosynthesis in 2 bullet points').text.match(/^- /gm) || []).length === 2, 'bullet count');
  const summary = A.reply('Summarize: The test failed. We need to fix the test. Kim will review the fix. Release is Friday.');
  check(summary.kind === 'reading' && summary.text.includes('Key sentences'), 'honest extractive summary');
  const tasks = A.reply('Extract action items: Kim will fix the bug. The sky is blue. We need to review the patch.');
  check(tasks.text.includes('Kim will fix') && !tasks.text.includes('sky'), 'task extraction');
  check(/could not identify/.test(A.reply('extract tasks: The sky is blue.').text), 'no fabricated action items');
  check(A.reply('count words: one two three').text === '3 words.', 'word count');
  check(A.reply('write a poem about rain').kind === 'capability', 'generation request never answered by unrelated lookup');
  A.reset(); check(A.reply('make it shorter').kind === 'clarify', 'empty follow-up clarification');
  A.reply('what was the battle of stalingrad');
  A.reset(); check(!/stalingrad/i.test(A.reply('why did it happen').text), 'reset clears subject');
  check(/not consciousness|not.*conscious/.test(A.reply('are you self aware').text), 'honest awareness');
  check(/not a running language model/.test(A.reply('who are you').text), 'honest unloaded status');
  check(A.reply('cards').text.includes(String(A.count())), 'dynamic corpus count');
  check(/server/.test(A.reply('your memory').text), 'accurate storage disclosure');

  let fetches = 0;
  A.__ctx.__fetch = () => { fetches++; throw Error('Unexpected network'); };
  const start = performance.now();
  for (const q of ['hey yo', '2+2', 'compare Python and JavaScript', 'summarize: One. Two. Three.', 'what is mitosis', 'write a poem about rain']) {
    let output = '';
    const answer = await A.chat(q, [], { search: false, onDelta: d => { output += d; } });
    check(answer === output, `delta integrity: ${q}`);
  }
  check(fetches === 0, 'WEB off means no engine network requests');
  console.log(`6 local turns: ${(performance.now() - start).toFixed(1)} ms (diagnostic, not a quality benchmark)`);
  check(await A.chat('make it shorter', [{ role: 'user', content: 'Notes' }, { role: 'archiver', content: 'First sentence. Second sentence. Third sentence. Fourth sentence.' }]) === 'First sentence. Second sentence. Third sentence.', 'restored local role/history');
  check(/nothing to continue|ask me something first/i.test(await A.chat('why?', [])), 'new history resets old chat');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => A.chat('hello', [], { signal: controller.signal }), { name: 'AbortError' }); checks++;
  A.__ctx.__fetch = (_, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')));
  });
  const during = new AbortController();
  const pending = A.chat('search battle of kursk', [], { signal: during.signal });
  during.abort();
  await assert.rejects(() => pending, { name: 'AbortError' }); checks++;
  check(A.sources().length === 0, 'stopped search has no stale sources');
  A.__ctx.__fetch = async () => { throw Error('offline'); };
  check((await A.chat('what is mitosis', [], { search: true })).includes('chromosome'), 'network failure keeps local answer');
  await assert.rejects(() => A.load(), /WebGPU/); checks++;
  check(!A.status().loading && A.mode() === 'grounded', 'unsupported GPU does not wedge instant mode');
  console.log(`${checks} offline/cancellation checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
