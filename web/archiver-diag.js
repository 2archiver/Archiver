/* Archiver 4.3 — client diagnostics and storage-reset notice.

   Opens with #diag in the URL, Ctrl/Cmd+Shift+D, or the "Diagnostics" button
   in Settings. Prints what a bug report needs: browser, WebGPU adapter info and
   limits, WebAssembly features, cross-origin isolation, storage quota/usage,
   cached model bytes. Nothing here is sent anywhere; "Copy" puts the report on
   the clipboard for the user to paste.

   Deliberately passive on page open: it never requests a GPU device, never
   starts a model worker (Safari hotfix rule) and only runs the probes when the
   panel is opened. The only work on load is one cheap /api/health read that
   compares the server's database stamp with the one this browser last saw. */
(function () {
  'use strict';

  const SEEN_KEY = 'archiver.server.db_created_at';

  // Minimal wasm modules used purely as feature probes (from wasm-feature-detect).
  const SIMD = new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]);
  const THREADS = new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,5,4,1,3,1,1,10,11,1,9,0,65,0,254,16,2,0,26,11]);
  const BASIC = new Uint8Array([0,97,115,109,1,0,0,0]);

  const fmtBytes = (n) => {
    if (!(n >= 0)) return 'unknown';
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(i ? 1 : 0) + ' ' + u[i];
  };
  const safe = (fn, dflt) => { try { return fn(); } catch (_) { return dflt; } };

  function browserName() {
    const ua = navigator.userAgent || '';
    const brands = safe(() => (navigator.userAgentData && navigator.userAgentData.brands) || [], []);
    const brand = brands.map((b) => b.brand + ' ' + b.version).filter((b) => !/Not.?A.?Brand|Chromium/i.test(b)).join(', ');
    const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    let name = brand;
    if (!name) {
      const m = ua.match(/Edg\/([\d.]+)/) || ua.match(/Firefox\/([\d.]+)/) || ua.match(/Chrome\/([\d.]+)/);
      if (/Edg\//.test(ua)) name = 'Edge ' + m[1];
      else if (/Firefox\//.test(ua)) name = 'Firefox ' + m[1];
      else if (/Chrome\//.test(ua) && !/CriOS/.test(ua)) name = 'Chrome ' + m[1];
      else if (/Safari\//.test(ua)) name = 'Safari ' + ((ua.match(/Version\/([\d.]+)/) || [])[1] || '');
      else name = 'Unknown browser';
    }
    return { name, ios, ua };
  }

  async function gpuInfo() {
    if (!navigator.gpu || typeof navigator.gpu.requestAdapter !== 'function') return { available: false, note: 'navigator.gpu not exposed' };
    let adapter = null;
    try { adapter = await navigator.gpu.requestAdapter(); } catch (e) { return { available: false, note: 'requestAdapter threw: ' + (e && e.message) }; }
    if (!adapter) return { available: false, note: 'requestAdapter returned null' };
    const info = adapter.info || safe(() => null, null) || {};
    const lim = adapter.limits || {};
    return {
      available: true,
      vendor: info.vendor || '', architecture: info.architecture || '', description: info.description || '',
      fallback: !!(adapter.isFallbackAdapter || info.isFallbackAdapter),
      shaderF16: safe(() => adapter.features.has('shader-f16'), false),
      maxBufferSize: fmtBytes(lim.maxBufferSize),
      maxStorageBufferBindingSize: fmtBytes(lim.maxStorageBufferBindingSize),
      maxComputeWorkgroupStorageSize: lim.maxComputeWorkgroupStorageSize
    };
  }

  function wasmInfo() {
    const has = typeof WebAssembly === 'object';
    return {
      available: has,
      compiles: has && safe(() => WebAssembly.validate(BASIC), false),
      simd: has && safe(() => WebAssembly.validate(SIMD), false),
      threads: has && safe(() => WebAssembly.validate(THREADS), false) && typeof SharedArrayBuffer === 'function',
      sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
      hardwareConcurrency: navigator.hardwareConcurrency || 'unknown',
      deviceMemory: navigator.deviceMemory ? navigator.deviceMemory + ' GB (hint)' : 'not reported (Safari/Firefox never report it)'
    };
  }

  async function storageInfo() {
    const out = { persisted: 'unknown', quota: 'unknown', usage: 'unknown', caches: [], opfs: [] };
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const e = await navigator.storage.estimate();
        out.quota = fmtBytes(e.quota); out.usage = fmtBytes(e.usage);
      }
      if (navigator.storage && navigator.storage.persisted) out.persisted = await navigator.storage.persisted();
    } catch (_) {}
    try {
      if (self.caches) {
        for (const name of await caches.keys()) {
          const c = await caches.open(name);
          const keys = await c.keys();
          out.caches.push(name + ' (' + keys.length + ' entries)');
        }
      }
    } catch (_) {}
    try {
      if (navigator.storage && navigator.storage.getDirectory) {
        const root = await navigator.storage.getDirectory();
        for await (const [name, handle] of root.entries()) {
          let size = '';
          if (handle.kind === 'file') { try { size = ' ' + fmtBytes((await handle.getFile()).size); } catch (_) {} }
          out.opfs.push(name + size);
        }
      }
    } catch (_) {}
    return out;
  }

  async function report() {
    const b = browserName();
    const engine = safe(() => window.Archiver && window.Archiver.status && window.Archiver.status(), null);
    let persisted = null;
    try { persisted = JSON.parse(localStorage.getItem('archiver.engine.v1') || 'null'); } catch (_) {}
    const lines = [];
    const push = (k, v) => lines.push(k + ': ' + (typeof v === 'object' ? JSON.stringify(v) : v));
    push('Archiver', (window.Archiver && window.Archiver.version) || '4.3');
    push('Browser', b.name + (b.ios ? ' (iOS/iPadOS WebKit)' : ''));
    push('User agent', b.ua);
    push('Secure context', window.isSecureContext);
    push('Cross-origin isolated', window.crossOriginIsolated === true);
    push('Visibility', document.visibilityState);
    push('Online', navigator.onLine);
    push('Data saver', safe(() => !!navigator.connection.saveData, false));
    push('WebGPU', await gpuInfo());
    push('WebAssembly', wasmInfo());
    push('Storage', await storageInfo());
    push('Last runtime used', persisted || 'none yet');
    if (engine) push('Engine', engine);
    return lines.join('\n');
  }

  async function clearModels() {
    let removed = 0;
    try { for (const n of await caches.keys()) { await caches.delete(n); removed++; } } catch (_) {}
    try {
      const root = await navigator.storage.getDirectory();
      for await (const [name] of root.entries()) { await root.removeEntry(name, { recursive: true }); removed++; }
    } catch (_) {}
    try { localStorage.removeItem('archiver.engine.v1'); } catch (_) {}
    return removed;
  }

  function el(tag, attrs, text) {
    const e = document.createElement(tag);
    for (const k in attrs || {}) e.setAttribute(k, attrs[k]);
    if (text) e.textContent = text;
    return e;
  }

  let panel = null;
  async function open() {
    if (panel) { panel.remove(); panel = null; }
    panel = el('div', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'diagTitle', id: 'archiverDiag' });
    /* 4.3: use the app's theme tokens (surface/ink/line/accent) instead of
       hardcoded light colours — the old panel was blinding white in dark and
       OLED mode. Fallbacks keep it readable if the stylesheet failed to load. */
    panel.style.cssText = 'position:fixed;inset:5vh 5vw;z-index:9999;background:var(--surface,#FFFCF6);color:var(--ink,#202521);' +
      'border:1px solid var(--line-strong,#C9CEC5);border-radius:14px;padding:18px;display:flex;flex-direction:column;gap:10px;' +
      'box-shadow:0 10px 40px rgba(0,0,0,.35);font-family:var(--sans,system-ui,sans-serif)';
    const h = el('h2', { id: 'diagTitle' }, 'Diagnostics');
    h.style.cssText = 'margin:0;font-size:18px;font-family:var(--serif,Georgia,serif);letter-spacing:-.01em';
    const note = el('p', {}, 'Paste this into bug reports. It stays on your device until you copy it.');
    note.style.cssText = 'margin:0;font-size:13px;color:var(--ink-2,#626B63)';
    const pre = el('pre', { tabindex: '0', 'aria-live': 'polite' }, 'Collecting…');
    pre.style.cssText = 'flex:1;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:12px;margin:0;padding:12px;' +
      'border-radius:8px;border:1px solid var(--line,#DDDCD4);background:var(--surface-2,#ECE9E1);color:var(--ink,#202521);' +
      'font-family:var(--mono,monospace);line-height:1.6';
    const row = el('div'); row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
    const copy = el('button', { type: 'button', class: 'btn sm' }, 'Copy report');
    const clear = el('button', { type: 'button', class: 'btn sm' }, 'Clear cached model weights');
    const close = el('button', { type: 'button', class: 'btn sm' }, 'Close');
    row.append(copy, clear, close);
    panel.append(h, note, pre, row);
    document.body.appendChild(panel);
    close.focus();
    const done = () => { if (panel) { panel.remove(); panel = null; } if (location.hash === '#diag') history.replaceState(null, '', location.pathname + location.search); };
    close.onclick = done;
    panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(); });
    copy.onclick = async () => { try { await navigator.clipboard.writeText(pre.textContent); copy.textContent = 'Copied'; } catch (_) { copy.textContent = 'Select the text and copy'; } };
    clear.onclick = async () => {
      if (!confirm('Delete downloaded model weights from this browser? They will download again next time.')) return;
      const n = await clearModels();
      clear.textContent = 'Cleared ' + n + ' store' + (n === 1 ? '' : 's');
      pre.textContent = await report();
    };
    pre.textContent = await report();
  }

  /* Render free has no persistent disk: a restart or redeploy wipes the
     server database. If the server's stamp changed since this browser last
     synced, say so plainly instead of letting an empty archive look like loss. */
  function banner(text) {
    const b = el('div', { role: 'status', 'aria-live': 'polite', id: 'archiverResetBanner' });
    b.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:9998;max-width:560px;' +
      'background:var(--accent,#315D4D);color:var(--accent-ink,#FFFCF6);padding:10px 14px;border-radius:8px;font-size:13px;' +
      'display:flex;gap:10px;align-items:center;font-family:var(--sans,system-ui,sans-serif);box-shadow:0 4px 16px rgba(0,0,0,.3)';
    const t = el('span', {}, text);
    const x = el('button', { type: 'button', 'aria-label': 'Dismiss' }, '×');
    x.style.cssText = 'background:none;border:0;color:inherit;font-size:18px;cursor:pointer';
    x.onclick = () => b.remove();
    b.append(t, x);
    document.body.appendChild(b);
  }

  async function checkServerReset() {
    try {
      const r = await fetch('/api/health', { cache: 'no-store', credentials: 'same-origin' });
      if (!r.ok) return;
      const h = await r.json();
      const stamp = String(h.db_created_at || '');
      if (!stamp) return;
      const seen = localStorage.getItem(SEEN_KEY);
      const hadLocal = Object.keys(localStorage).some((k) => /^archiver_(sessions|msgs)_v\d/.test(k));
      if (seen && seen !== stamp && hadLocal) {
        banner('Server storage was reset (free hosting has no persistent disk). Your browser copy is intact and will sync back.');
      }
      localStorage.setItem(SEEN_KEY, stamp);
    } catch (_) {}
  }

  function wire() {
    if (location.hash === '#diag' || /[?&]diag\b/.test(location.search)) open();
    window.addEventListener('hashchange', () => { if (location.hash === '#diag') open(); });
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'D' || e.key === 'd')) { e.preventDefault(); open(); }
    });
    const btn = document.getElementById('openDiagnostics');
    if (btn) btn.addEventListener('click', open);
    // Defer so it never competes with first paint or the app's own boot.
    setTimeout(checkServerReset, 1500);
  }

  window.ArchiverDiag = { open, report, clearModels };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
