/* Quiet mode (web/archiver-quiet.js) — the policy that keeps the interface
   usable while a local model is loaded.

   The report this answers: "Edge on the laptop makes everything very slow while
   the local model is loaded." The policy pieces are small enough to test
   directly: the cooperative yielder, the CPU thread budget, and the gates that
   decide when local work may run at all. */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');

const Q = require(path.join(__dirname, '..', 'web', 'archiver-quiet.js'));

let checks = 0;
function check(ok, message) {
  if (!ok) process.stderr.write('  FAIL  ' + message + '\n');
  assert.ok(ok, message);
  checks++;
  process.stderr.write('  ok    ' + message + '\n');
}

(async () => {
  /* ---- the yielder hands the event loop back, and can be turned off ---- */
  {
    const order = [];
    let frames = 0;
    const y = Q.createYielder({
      budgetMs: 1,
      requestAnimationFrame: (fn) => { frames++; setTimeout(fn, 0); },
      setTimeout: (fn, ms) => setTimeout(fn, ms)
    });
    const busy = (ms) => { const until = Date.now() + ms; while (Date.now() < until) {} };
    for (let i = 0; i < 5; i++) {
      busy(3);                             // more than the 1 ms budget
      order.push('work' + i);
      await y.tick();
    }
    check(frames >= 5, 'quiet mode yields to a frame between work slices (' + frames + ')');
    check(order.length === 5, 'every slice still ran, in order');
  }

  {
    let frames = 0;
    const y = Q.createYielder({
      budgetMs: 1000,                       // effectively never over budget
      requestAnimationFrame: (fn) => { frames++; setTimeout(fn, 0); }
    });
    for (let i = 0; i < 5; i++) await y.tick();
    check(frames === 0, 'short work is not interrupted');
  }

  {
    let frames = 0;
    const y = Q.createYielder({
      budgetMs: 1,
      enabled: false,
      requestAnimationFrame: (fn) => { frames++; setTimeout(fn, 0); }
    });
    y.setEnabled(true);
    const until = Date.now() + 3; while (Date.now() < until) {}
    await y.tick();
    check(frames >= 1, 'the yielder can be switched on at runtime');
  }

  /* ---- CPU budget: the interface keeps cores to itself ---- */
  {
    check(Q.cpuThreads(8, false) === 4, 'an eight-core laptop gives the model four threads');
    check(Q.cpuThreads(4, false) === 2, 'a four-core laptop gives the model two threads');
    check(Q.cpuThreads(2, false) === 1, 'a two-core machine gives the model one thread');
    check(Q.cpuThreads(8, true) === 3, 'a phone is capped at three threads');
    check(Q.cpuThreads(4, true) === 3, 'a four-core phone still gets three');
    check(Q.cpuThreads(1, true) === 1, 'a single core is never asked for zero threads');
    check(Q.cpuThreads(0, false) === 1, 'an unreported core count falls back to one');
  }

  /* ---- memory pressure ---- */
  {
    check(Q.memoryTight({ deviceMemory: 1 }) === true, '1 GB device memory is tight');
    check(Q.memoryTight({ deviceMemory: 8 }) === false, '8 GB is not tight');
    check(Q.memoryTight({ userAgentData: { mobile: true } }) === true, 'a phone is treated as tight even without the hint');
    check(Q.memoryTight({}) === false, 'nothing reported is not treated as tight');
  }

  /* ---- idle work waits for a running answer ---- */
  check(Q.shouldRunIdle(true) === false, 'idle work does not compete with a running answer');
  check(Q.shouldRunIdle(false) === true, 'idle work runs when nothing is answering');

  /* ---- the switch and its one-line explanation ---- */
  check(Q.quiet === true, 'quiet mode is on by default');
  Q.setQuiet(false);
  check(Q.quiet === false && /Quiet mode is off/.test(Q.describe()), 'turning it off is reflected in the description');
  Q.setQuiet(true);
  check(/Quiet mode is on/.test(Q.describe()), 'turning it on is reflected in the description');

  process.stderr.write('\nquiet: ' + checks + ' checks passed\n');
})().catch((err) => {
  process.stderr.write('quiet suite failed: ' + ((err && err.stack) || err) + '\n');
  process.exit(1);
});
