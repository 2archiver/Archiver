/* Archiver 3.3 — viewport and software-keyboard manager.

   iOS Safari does not shrink the *layout* viewport when the software keyboard
   opens. It shrinks the *visual* viewport and then scrolls the whole document
   to keep the caret in view. Two consequences break a chat layout:

     1. A shell sized from `visualViewport.height` collapses while you type,
        squeezing the thread and pushing the top bar off screen.
     2. When the keyboard closes, the document is often left scrolled. The shell
        is back to full height but the window is offset, which is the blank gap
        under the composer that people keep reporting as "the keyboard bug".

   So this module sizes the shell from the layout viewport only, tracks the
   keyboard as a separate piece of state, and puts the document back where it
   belongs once the keyboard has finished animating. Pinch-zoom is respected
   rather than fought: while the visual viewport is scaled we report no keyboard
   and change nothing, because any height we computed would be wrong.

   It is a factory over injected dependencies so the whole thing can be
   exercised in Node (tests/viewport.js) without a browser. */
(function () {
  'use strict';

  /* Below this much lost height it is a toolbar collapsing, not a keyboard. */
  const KEYBOARD_THRESHOLD = 100;
  /* iOS animates the keyboard over roughly 250 ms and fires resize and scroll
     events throughout. Act on the settled value, not on every frame. */
  const SETTLE_MS = 140;
  /* Overlay fields get scrolled into view once the keyboard has stopped moving. */
  const REVEAL_MS = SETTLE_MS + 60;

  function createViewportManager(deps) {
    deps = deps || {};
    const win = deps.window || {};
    const doc = deps.document || {};
    const root = (doc.documentElement) || { style: { setProperty() {}, removeProperty() {} }, classList: null };
    const shell = deps.shell || null;
    const thread = deps.thread || null;
    const onState = typeof deps.onState === 'function' ? deps.onState : () => {};
    const raf = deps.requestAnimationFrame || (fn => deps.setTimeout(() => fn(Date.now()), 16));
    const cancelRaf = deps.cancelAnimationFrame || deps.clearTimeout || (() => {});
    const setTimer = deps.setTimeout || setTimeout;
    const clearTimer = deps.clearTimeout || clearTimeout;
    const vv = win.visualViewport || null;

    let frame = null;
    let settleTimer = null;
    let revealTimer = null;
    let layoutHeight = 0;
    let keyboardHeight = 0;
    let keyboardOpen = false;
    let zoomed = false;
    let disposed = false;
    let initialised = false;
    let wasOpen = false;
    let lastFocus = null;

    const state = () => ({
      layoutHeight,
      keyboardHeight,
      keyboardOpen,
      zoomed,
      /* What the visual viewport reports, for diagnostics and tests. */
      visualHeight: vv ? vv.height : layoutHeight,
      offsetTop: vv ? vv.offsetTop : 0,
      scale: vv ? vv.scale : 1
    });

    const setVar = (name, value) => {
      try { root.style.setProperty(name, value); } catch (_) {}
    };

    const publish = () => {
      try { onState(state()); } catch (_) {}
    };

    /* The document, not the visual viewport, is the thing the shell must match.
       On Android with `interactive-widget=resizes-content` innerHeight already
       excludes the keyboard, which is also correct: the shell then really is
       that tall. */
    const measureLayout = () => {
      const h = Math.round(win.innerHeight || root.clientHeight || 0);
      if (h > 0 && h !== layoutHeight) {
        layoutHeight = h;
        setVar('--viewport-height', h + 'px');
      }
      return layoutHeight;
    };

    const measureKeyboard = () => {
      if (!vv) return 0;
      const scale = typeof vv.scale === 'number' ? vv.scale : 1;
      zoomed = Math.abs(scale - 1) > 0.02;
      // A pinched page reports a smaller visual viewport for a reason that has
      // nothing to do with the keyboard. Do not guess from it.
      if (zoomed) return 0;
      const visual = Math.round(vv.height || 0);
      const offset = Math.round(vv.offsetTop || 0);
      if (!visual) return 0;
      return Math.max(0, layoutHeight - visual - offset);
    };

    const applyKeyboardClass = (open, height) => {
      const targets = [root, shell].filter(Boolean);
      for (const el of targets) {
        if (!el.classList) continue;
        try {
          el.classList.toggle('kb-open', open);
          el.classList.toggle('kb-closed', !open);
        } catch (_) {}
      }
      /* Only a real keyboard is published. A 44px toolbar collapse is already
         accounted for by the layout viewport, so exposing it as an inset would
         pad the composer twice. */
      setVar('--kb-height', (open ? height : 0) + 'px');
    };

    /* iOS leaves the window scrolled after the keyboard closes. Undo it, or the
       shell sits above an empty gutter for the rest of the session. Only ever
       after a real open/close transition: doing it at load would fight the
       browser's own scroll restoration on reload. */
    const restoreDocumentScroll = () => {
      const y = win.scrollY != null ? win.scrollY : (win.pageYOffset || 0);
      if (y > 0 && typeof win.scrollTo === 'function') {
        try { win.scrollTo(0, 0); } catch (_) {}
      }
    };

    const revealFocused = () => {
      const el = lastFocus || (doc.activeElement && isField(doc.activeElement) ? doc.activeElement : null);
      if (!el || typeof el.scrollIntoView !== 'function') return;
      // Inside a scrolling overlay this scrolls the overlay; in the composer it
      // is a no-op because the field is already pinned to the bottom.
      try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) {
        try { el.scrollIntoView(false); } catch (__) {}
      }
    };

    const settle = () => {
      if (disposed) return;
      const kb = measureKeyboard();
      const open = kb >= KEYBOARD_THRESHOLD;
      /* The first pass always writes, so the custom properties exist (and the
         stylesheet can rely on them) even when nothing has changed yet. */
      if (!initialised || open !== keyboardOpen || kb !== keyboardHeight) {
        initialised = true;
        keyboardOpen = open;
        keyboardHeight = kb;
        applyKeyboardClass(open, kb);
        publish();
      }
      if (!open) {
        if (wasOpen) restoreDocumentScroll();
        wasOpen = false;
      } else {
        wasOpen = true;
        if (thread && typeof deps.scrollThread === 'function') {
          // The thread has its own scroller; keeping the newest line visible is
          // ours to do, and it must not fight the document scroll above.
          try { deps.scrollThread(); } catch (_) {}
        }
      }
      if (open) {
        clearTimer(revealTimer);
        revealTimer = setTimer(revealFocused, REVEAL_MS);
      }
    };

    /* One measurement per frame no matter how many events iOS sends. */
    const schedule = () => {
      if (disposed) return;
      if (frame !== null) return;
      frame = raf(() => {
        frame = null;
        measureLayout();
        clearTimer(settleTimer);
        settleTimer = setTimer(settle, SETTLE_MS);
      });
    };

    const immediate = () => {
      if (disposed) return;
      measureLayout();
      settle();
    };

    const isField = el => !!el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || '');

    const onFocusIn = e => {
      const el = e && e.target;
      lastFocus = isField(el) ? el : null;
      if (!lastFocus) return;
      // iOS raises the keyboard asynchronously after focus. Measuring now would
      // read the pre-keyboard viewport, so wait for it to arrive.
      schedule();
      clearTimer(settleTimer);
      settleTimer = setTimer(settle, SETTLE_MS);
    };
    const onFocusOut = () => {
      lastFocus = null;
      clearTimer(revealTimer);
      schedule();
    };

    const listeners = [];
    const on = (target, type, fn, opts) => {
      if (!target || typeof target.addEventListener !== 'function') return;
      target.addEventListener(type, fn, opts);
      listeners.push([target, type, fn, opts]);
    };

    if (vv) {
      on(vv, 'resize', schedule);
      on(vv, 'scroll', schedule);
    }
    on(win, 'resize', schedule);
    on(win, 'orientationchange', () => { setTimer(immediate, 220); });
    on(doc, 'focusin', onFocusIn, true);
    on(doc, 'focusout', onFocusOut, true);

    immediate();

    return {
      state,
      refresh: immediate,
      /* Exposed for tests and for a manual "the layout is wrong" recovery. */
      measure: () => { measureLayout(); return { keyboard: measureKeyboard(), zoomed }; },
      dispose() {
        disposed = true;
        if (frame !== null) { cancelRaf(frame); frame = null; }
        clearTimer(settleTimer);
        clearTimer(revealTimer);
        for (const [target, type, fn, opts] of listeners) {
          try { target.removeEventListener(type, fn, opts); } catch (_) {}
        }
        listeners.length = 0;
      },
      KEYBOARD_THRESHOLD,
      SETTLE_MS
    };
  }

  /* iOS Safari zooms the page on focus for any field whose computed font size is
     under 16px, and then leaves it zoomed — which in turn makes every viewport
     measurement wrong. Rather than disabling zoom (an accessibility failure),
     the stylesheet raises field text to 16px on touch devices; this reports
     whether that rule is actually in effect so a regression is visible. */
  function auditFieldSizes(doc) {
    const out = [];
    if (!doc || typeof doc.querySelectorAll !== 'function') return out;
    const fields = doc.querySelectorAll('input, textarea, select');
    for (const el of fields) {
      let size = 0;
      try { size = parseFloat((doc.defaultView || {}).getComputedStyle
        ? doc.defaultView.getComputedStyle(el).fontSize : (el.style && el.style.fontSize)) || 0; } catch (_) {}
      if (size && size < 16) out.push({ id: el.id || el.name || el.tagName, size });
    }
    return out;
  }

  const api = { createViewportManager, auditFieldSizes, KEYBOARD_THRESHOLD, SETTLE_MS, REVEAL_MS };
  if (typeof window !== 'undefined') window.ArchiverViewport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
