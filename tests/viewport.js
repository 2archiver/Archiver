/* Keyboard and viewport regressions, run in Node against the same module the
   page loads. iOS Safari is the reason this exists, and it cannot be tested by
   staring at the CSS: the bug is a sequence of viewport measurements over time.

   node tests/viewport.js */
const assert = require('node:assert/strict');
const path = require('node:path');
const { createViewportManager, auditFieldSizes } = require(path.join(__dirname, '..', 'web', 'archiver-viewport.js'));

function classList() {
  const set = new Set();
  return {
    set,
    add: n => set.add(n),
    remove: n => set.delete(n),
    contains: n => set.has(n),
    toggle(n, force) { if (force === undefined) force = !set.has(n); force ? set.add(n) : set.delete(n); return force; }
  };
}

function env(opts = {}) {
  const calls = { scrollTo: 0, scrollThread: 0, setProperty: 0, reveals: 0, states: 0 };
  const props = {};
  const root = {
    tagName: 'HTML',
    clientHeight: opts.innerHeight ?? 844,
    classList: classList(),
    style: { setProperty(k, v) { props[k] = v; calls.setProperty++; }, removeProperty(k) { delete props[k]; } }
  };
  const shell = { classList: classList() };
  const field = { tagName: 'TEXTAREA', id: 'chatInput', scrollIntoView: () => { calls.reveals++; } };
  const vvListeners = new Map();
  const winListeners = new Map();
  const docListeners = new Map();
  const add = (map, type, fn) => { if (!map.has(type)) map.set(type, []); map.get(type).push(fn); };
  const remove = (map, type, fn) => { if (map.has(type)) map.set(type, map.get(type).filter(f => f !== fn)); };
  const fire = (map, type, event) => { for (const fn of (map.get(type) || []).slice()) fn(event); };

  const vv = {
    height: opts.vvHeight ?? (opts.innerHeight ?? 844),
    offsetTop: opts.offsetTop ?? 0,
    scale: opts.scale ?? 1,
    addEventListener: (t, fn) => add(vvListeners, t, fn),
    removeEventListener: (t, fn) => remove(vvListeners, t, fn)
  };
  const win = {
    innerHeight: opts.innerHeight ?? 844,
    scrollY: opts.scrollY ?? 0,
    visualViewport: opts.noVisualViewport ? null : vv,
    scrollTo: (x, y) => { calls.scrollTo++; win.scrollY = y; },
    addEventListener: (t, fn) => add(winListeners, t, fn),
    removeEventListener: (t, fn) => remove(winListeners, t, fn)
  };
  const doc = {
    documentElement: root,
    activeElement: null,
    addEventListener: (t, fn) => add(docListeners, t, fn),
    removeEventListener: (t, fn) => remove(docListeners, t, fn),
    querySelectorAll: () => (opts.fields || [])
  };

  const manager = createViewportManager({
    window: win,
    document: doc,
    shell,
    thread: { id: 'chatContainer' },
    scrollThread: () => { calls.scrollThread++; },
    onState: () => { calls.states++; },
    requestAnimationFrame: fn => setTimeout(() => fn(Date.now()), 0),
    cancelAnimationFrame: id => clearTimeout(id),
    // Collapse the real 140 ms settle window so the suite stays fast; the
    // ordering behaviour under test is unchanged.
    setTimeout: (fn, ms) => setTimeout(fn, ms > 1 ? 1 : ms),
    clearTimeout: id => clearTimeout(id)
  });

  const settle = () => new Promise(resolve => setTimeout(resolve, 25));
  return {
    manager, calls, props, root, shell, win, vv, doc, field, settle,
    setKeyboard(height, extra = {}) {
      vv.height = height;
      if (extra.offsetTop !== undefined) vv.offsetTop = extra.offsetTop;
      if (extra.scale !== undefined) vv.scale = extra.scale;
      fire(vvListeners, 'resize', {});
    },
    setLayout(height) { win.innerHeight = height; root.clientHeight = height; fire(winListeners, 'resize', {}); },
    focus(el) { doc.activeElement = el; fire(docListeners, 'focusin', { target: el }); },
    blur() { doc.activeElement = null; fire(docListeners, 'focusout', {}); },
    fire
  };
}

const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  /* 1. The shell follows the layout viewport, and only that. */
  {
    const e = env();
    await e.settle();
    assert.equal(e.props['--viewport-height'], '844px');
    assert.equal(e.props['--kb-height'], '0px');
    assert.equal(e.root.classList.contains('kb-open'), false);
    e.manager.dispose();
  }

  /* 2. THE Safari bug: the keyboard must not resize the shell. */
  {
    const e = env();
    await e.settle();
    e.setKeyboard(500);
    await e.settle();
    assert.equal(e.props['--viewport-height'], '844px', 'the shell keeps its full height while typing');
    assert.equal(e.props['--kb-height'], '344px');
    assert.equal(e.root.classList.contains('kb-open'), true);
    assert.equal(e.shell.classList.contains('kb-open'), true);
    assert.equal(e.manager.state().keyboardOpen, true);
    assert.ok(e.calls.scrollThread >= 1, 'the thread is kept at the newest line');
    e.manager.dispose();
  }

  /* 3. Closing the keyboard puts the document back — no blank gutter. */
  {
    const e = env({ scrollY: 132 });
    await e.settle();
    e.setKeyboard(500);
    await e.settle();
    assert.equal(e.calls.scrollTo, 0, 'nothing is forced while the keyboard is up');
    e.setKeyboard(844);
    await e.settle();
    assert.ok(e.calls.scrollTo >= 1, 'the document scroll iOS left behind is undone');
    assert.equal(e.win.scrollY, 0);
    assert.equal(e.root.classList.contains('kb-open'), false);
    assert.equal(e.root.classList.contains('kb-closed'), true);
    assert.equal(e.props['--kb-height'], '0px');
    e.manager.dispose();
  }

  /* 4. Pinch zoom is respected, not read as a keyboard. */
  {
    const e = env();
    await e.settle();
    e.setKeyboard(420, { scale: 2 });
    await e.settle();
    assert.equal(e.manager.state().zoomed, true);
    assert.equal(e.manager.state().keyboardHeight, 0);
    assert.equal(e.root.classList.contains('kb-open'), false, 'a zoomed page is not a keyboard');
    assert.equal(e.props['--viewport-height'], '844px');
    e.manager.dispose();
  }

  /* 5. A collapsing toolbar is not a keyboard either. */
  {
    const e = env();
    await e.settle();
    e.setKeyboard(800); // 44px — Safari's URL bar
    await e.settle();
    assert.equal(e.root.classList.contains('kb-open'), false);
    assert.equal(e.props['--kb-height'], '0px');
    e.manager.dispose();
  }

  /* 6. Android resizes the layout viewport; the shell follows it. */
  {
    const e = env();
    await e.settle();
    e.setLayout(520);
    await e.settle();
    assert.equal(e.props['--viewport-height'], '520px');
    e.manager.dispose();
  }

  /* 7. An animation's worth of events produces one settled measurement. */
  {
    const e = env();
    await e.settle();
    const before = e.calls.scrollThread;
    for (const h of [800, 740, 680, 620, 560, 520, 500, 500, 500]) { e.setKeyboard(h); }
    await e.settle();
    assert.equal(e.calls.scrollThread - before, 1, 'frame-batched, not once per event');
    assert.equal(e.props['--kb-height'], '344px');
    e.manager.dispose();
  }

  /* 8. A focused overlay field is revealed once the keyboard settles. */
  {
    const e = env();
    await e.settle();
    e.focus(e.field);
    e.setKeyboard(500);
    await e.settle();
    await wait(20);
    assert.ok(e.calls.reveals >= 1, 'the field is scrolled into the visible viewport');
    e.blur();
    e.setKeyboard(844);
    await e.settle();
    assert.equal(e.root.classList.contains('kb-open'), false);
    e.manager.dispose();
  }

  /* 9. Browsers with no visualViewport still get a sized shell and no crash. */
  {
    const e = env({ noVisualViewport: true });
    await e.settle();
    assert.equal(e.props['--viewport-height'], '844px');
    assert.equal(e.manager.state().keyboardOpen, false);
    e.setKeyboard(500); // no-op: there is nothing to listen to
    await e.settle();
    assert.equal(e.root.classList.contains('kb-open'), false);
    e.manager.dispose();
  }

  /* 10. dispose really detaches. */
  {
    const e = env();
    await e.settle();
    e.manager.dispose();
    e.setKeyboard(400);
    await e.settle();
    assert.equal(e.root.classList.contains('kb-open'), false, 'a disposed manager stops reacting');
  }

  /* 11. Fields under 16px are what makes iOS zoom on focus. */
  {
    const fields = [
      { id: 'chatInput', style: { fontSize: '16px' } },
      { id: 'searchSessions', style: { fontSize: '13px' } },
      { tagName: 'INPUT', name: 'persona', style: { fontSize: '12.5px' } }
    ];
    const doc = {
      querySelectorAll: () => fields,
      defaultView: { getComputedStyle: el => ({ fontSize: el.style.fontSize }) }
    };
    const small = auditFieldSizes(doc);
    assert.equal(small.length, 2);
    assert.deepEqual(small.map(f => f.id || f.name).sort(), ['persona', 'searchSessions']);
    assert.equal(auditFieldSizes(null).length, 0);
  }

  console.log('Viewport/keyboard checks passed: shell sized from the layout viewport, keyboard tracked separately, document scroll restored on close, pinch-zoom and toolbar collapse ignored, events frame-batched, focused fields revealed, no-visualViewport browsers safe, disposal clean, and sub-16px field audit.');
})().catch(e => { console.error(e); process.exit(1); });
