/* Card-level checks for the 5.5 factual routing: the Mishima and Hitler cards,
   the corrected 1933 dating, and the integrity of the bundled corpus.
   Runs the same engine the page runs (tests/ui_check.js), with no model. */
const assert = require('assert');
const A = require('./ui_check');
const KB = A.__ctx.ARCHIVER_KB;
const GAP = 'I don\'t have reliable information about that here. Paste a source, or use WEB when server search is available.';

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok    ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + '\n        ' + (e.message || e).toString().split('\n').join('\n        ')); }
}
const byId = (id) => KB.cards.find((c) => c.id === id);

check('the corpus has 1561 cards with unique IDs and a 5.5 version', () => {
  assert.equal(KB.cards.length, 1561);
  assert.equal(new Set(KB.cards.map((c) => c.id)).size, KB.cards.length);
  assert.equal(KB.version, '5.5');
});

check('the four Mishima cards and the Hitler overview are bundled', () => {
  for (const id of ['lit-mishima-overview', 'lit-mishima-works', 'lit-mishima-dates', 'lit-mishima-politics-1970', 'hist-hitler-overview']) {
    assert.ok(byId(id), id);
  }
});

check('ww2-hitler-death keeps its ID and drops the "Führer since 1933" dating error', () => {
  const c = byId('ww2-hitler-death');
  assert.ok(c, 'the ID is kept');
  assert.ok(!/Führer (of Germany )?since 1933/.test(c.a), 'no 1933 Führer claim');
  assert.match(c.a, /30 April 1945/);
  assert.match(c.a, /chancellor in 1933/);
  assert.match(c.a, /Führer in 1934/);
});

check('"Mishima" resolves to the overview card, not a fuzzy neighbour', () => {
  assert.match(A.reply('Mishima').text, /^Yukio Mishima \(1925–1970\)/);
});

check('the Mishima sub-questions route to their own cards', () => {
  assert.match(A.reply('Mishima books').text, /Confessions of a Mask/);
  assert.match(A.reply('when was Mishima born').text, /14 January 1925/);
  assert.match(A.reply('why did Mishima die').text, /Tatenokai/);
});

check('bare "Hitler" is the overview; the death question is the corrected card', () => {
  assert.match(A.reply('Hitler').text, /Austrian-born leader of the Nazi Party/);
  assert.match(A.reply('when did Hitler die').text, /30 April 1945/);
});

check('an unknown person gets the evidence gap, with no invented biography', () => {
  for (const q of ['who was Jan Varga?', 'when was Jan Varga born?', 'what awards did Jan Varga win?', 'list the books by Jan Varga']) {
    assert.equal(A.reply(q).text, GAP, q);
  }
});

check('the stopword list does not let a generic verb pick an unrelated card', () => {
  assert.doesNotMatch(A.reply('explain how the internet works').text, /intermittent fasting|compound interest/i);
  assert.match(A.reply('explain how the internet works').text, /global network of networks/);
});

check('one-letter typos still match; words that only share a prefix do not', () => {
  assert.match(A.reply('barborossa').text, /German|Barbarossa/i);
  assert.match(A.reply('what is the internet').text, /global network/);
  assert.doesNotMatch(A.reply('what is the internet').text, /intermittent/i);
});

console.log('\n' + passed + ' grounding checks passed' + (failed ? ', ' + failed + ' failed' : ''));
if (failed) process.exit(1);
