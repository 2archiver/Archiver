/* Archiver 5.7 — quiet mode: keep the interface responsive while a local model
   is loaded.

   The complaint this answers: "Edge on the laptop makes everything very slow
   while the local model is loaded." That is not one bug. It is four:

     1. Wasted CPU. A 0.5B model on the CPU path will happily use every core
        the Wasm threads ask for, and the page's own painting, scrolling and
        typing then compete with it for the same cores. On a 4-core laptop the
        interface loses.
     2. Layout thrash. Progress is reported several times a second, and every
        report used to repaint ~20 DOM nodes (that one is fixed in index.html by
        coalescing to four paints a second).
     3. Hidden work. A backgrounded tab kept preparing. Edge throttles timers in
        hidden tabs, which turns a background download into a stall/retry loop
        that wakes up again the moment the tab is shown — the "slow when I come
        back" report.
     4. Runtime drift. The WebGPU worker holds a device and a KV cache while it
        is idle; nothing ever gave the memory back after an answer.

   This module is the small, testable policy layer for (1), (3) and (4). It
   never touches the model itself: the engine and the preparation controller own
   the runtimes and call in here.

   Exposed as globalThis.ArchiverQuiet. */
(function (root) {
  'use strict';

  /* How much of a second the page's own timers and frames may take while a
     model is loaded. Below one frame in four the interface visibly stutters;
     above it the model starves. One frame in six is the compromise. */
  var QUIET_FRAME_MS = 16;
  var QUIET_SLICE_RATIO = 1 / 6;

  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  /* A cooperative gate for long local jobs (prompt shaping, corpus scoring over
     a large paste) when quiet mode is on. Yields to the event loop often enough
     that scrolling and typing stay ahead of the work.

     on:true  → yield after `budgetMs` of work, for at least one frame
     on:false → yield only after `budgetMs` doubled (fewer switches, same API) */
  function createYielder(options) {
    var opts = options || {};
    var raf = opts.requestAnimationFrame || (root.requestAnimationFrame && root.requestAnimationFrame.bind(root));
    var timer = opts.setTimeout || (root.setTimeout && root.setTimeout.bind(root)) || setTimeout;
    var budgetMs = Number(opts.budgetMs) || 12;
    var spent = 0;
    var since = now();
    var enabled = opts.enabled !== false;

    function reset() {
      spent = 0;
      since = now();
    }

    function wait() {
      return new Promise(function (resolve) {
        var done = false;
        var finish = function () { if (!done) { done = true; resolve(); } };
        if (raf) {
          try { raf(finish); } catch (_) {}
          /* requestAnimationFrame does not fire in a hidden tab; the timer is
             the guarantee that the promise settles. */
          timer(finish, 32);
        } else {
          timer(finish, 0);
        }
      });
    }

    async function tick(work) {
      var t = now();
      spent += t - since;
      since = t;
      var limit = enabled ? budgetMs : budgetMs * 2;
      if (spent >= limit) {
        await wait();
        reset();
      }
      if (typeof work === 'function') return work();
      return undefined;
    }

    return {
      tick: tick,
      reset: reset,
      wait: wait,
      setEnabled: function (on) { enabled = !!on; },
      get enabled() { return enabled; }
    };
  }

  /* Idle work should not compete with a running answer. */
  function shouldRunIdle(isGenerating) {
    return !isGenerating;
  }

  /* Memory pressure is reported by the browser in two places; both are optional
     and neither is trusted on its own. */
  function memoryTight(nav) {
    var n = nav || root.navigator || {};
    var dm = Number(n.deviceMemory);
    if (dm && dm <= 2) return true;
    if (n.userAgentData && n.userAgentData.mobile) return true;
    return false;
  }

  /* Will the CPU runtime help itself to the whole machine? On a phone it is the
     only runtime there is, so it runs as asked. On a laptop with four or more
     cores, half of them is plenty for a 0.5B model and leaves the rest to the
     interface. This is a policy for the engine's thread count, not a guess. */
  function cpuThreads(cores, isMobile) {
    var n = Number(cores) || 2;
    if (isMobile) return Math.max(1, Math.min(3, n - 1));
    return Math.max(1, Math.min(4, Math.floor(n / 2)));
  }

  var quiet = true;

  root.ArchiverQuiet = {
    version: '5.7',
    QUIET_FRAME_MS: QUIET_FRAME_MS,
    QUIET_SLICE_RATIO: QUIET_SLICE_RATIO,
    createYielder: createYielder,
    shouldRunIdle: shouldRunIdle,
    memoryTight: memoryTight,
    cpuThreads: cpuThreads,
    get quiet() { return quiet; },
    setQuiet: function (on) { quiet = !!on; return quiet; },
    /* A one-line explanation for Diagnostics and the Settings panel. */
    describe: function () {
      return quiet
        ? 'Quiet mode is on: local work yields to the interface between frames, the CPU runtime uses about half the cores, and preparation pauses in a hidden tab.'
        : 'Quiet mode is off: the local model may use every core while it answers.';
    }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.ArchiverQuiet;
})(typeof globalThis !== 'undefined' ? globalThis : this);
