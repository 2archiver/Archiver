/* End-to-end check of the real page: web/index.html running in jsdom against a
   live Archiver server, with a fake WebLLM engine standing in for the GPU.

   Needs jsdom (not a runtime dependency):
       npm i --no-save jsdom
       ARCHIVER_DB=/tmp/check.db uvicorn app.main:app --port 8000 &
       node tests/page_check.js [http://127.0.0.1:8000]

   What it covers that smoke.js cannot: the DOM wiring — sending, streaming,
   the "Thought for Ns" block, STOP, retry, settings round-tripping to the
   server, and history re-rendering from local storage. */
let JSDOM, VirtualConsole;
try { ({ JSDOM, VirtualConsole } = require('jsdom')); }
catch (_) { console.log('jsdom not installed — skipping page check (npm i --no-save jsdom)'); process.exit(0); }

const BASE = (process.argv[2] || 'http://127.0.0.1:8000').replace(/\/$/, '');
let bad = 0;
const say = (ok, what, detail) => {
  if (!ok) bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail !== undefined ? '  [' + String(detail).slice(0, 90) + ']' : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { if (fn()) return true; } catch (_) {} await sleep(40); }
  return false;
}

(async () => {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(e.message + (e.detail ? ' ' + e.detail : '')));
  vc.on('error', (e) => errors.push(String(e)));

  let cookie = '';
  const html = await (await fetch(BASE + '/')).text();
  const dom = new JSDOM(html, {
    url: BASE + '/', runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.navigator.gpu = {};                       // pretend WebGPU exists
      w.fetch = async (url, opts = {}) => {
        const nc = new AbortController();
        if (opts.signal) {
          if (opts.signal.aborted) nc.abort();
          opts.signal.addEventListener('abort', () => nc.abort());
        }
        const headers = { ...(opts.headers || {}) };
        if (cookie) headers.cookie = cookie;
        const res = await fetch(new URL(url, BASE).href, { method: opts.method, body: opts.body, headers, signal: nc.signal });
        const sc = res.headers.get('set-cookie');
        if (sc) cookie = sc.split(';')[0];
        return res;
      };
      w.HTMLElement.prototype.scrollIntoView = () => {};
      w.confirm = () => true;
    }
  });
  const w = dom.window, d = w.document, $ = (s) => d.querySelector(s), $$ = (s) => [...d.querySelectorAll(s)];
  await until(() => w.Archiver && $('#modelSelect').options.length > 0, 10000);

  console.log('\n-- boot --');
  say(!!w.Archiver && w.Archiver.version === '2.6.2', 'engine loaded, 2.6.2');
  say($$('.version-tag').every((e) => e.textContent === '2.6.2'), 'every version tag says 2.6.2');
  say($('#idxMeter').textContent === w.Archiver.count().toLocaleString('en-GB'), 'INDEX meter shows the real card count', $('#idxMeter').textContent);
  say($('#modelSelect').options.length === 4 && $('#modelSelect').value === 'qwen3-4b', 'model picker defaults to Qwen3 4B');
  say(!$('#modelOffer').classList.contains('hidden'), 'opt-in banner offered when WebGPU exists');
  say($('#cbThink').style.display === 'none', 'THINK hidden until a model is loaded');
  say(/entries/.test($('#clCount').textContent), 'changelog count computed', $('#clCount').textContent);

  const send = async (text) => {
    const n = $$('.msg-row.ai').length;
    $('#chatInput').value = text;
    $('#chatInput').dispatchEvent(new w.Event('input'));
    $('#sendBtn').click();
    await until(() => $$('.msg-row.ai').length > n);
    await until(() => $('#cbStop').style.display === 'none', 10000);
    return $$('.msg-row.ai').at(-1);
  };

  console.log('\n-- library answer, no model --');
  let row = await send('what was the battle of stalingrad');
  say(/stalingrad/i.test(row.querySelector('.msg-body').textContent), 'answered from the library', row.querySelector('.msg-body').textContent.slice(0, 60));
  const sid = w.localStorage.getItem('archiver_active_sid_v3');
  const local = JSON.parse(w.localStorage.getItem('archiver_msgs_v3_' + sid) || '[]');
  say(local.length === 2 && local[1].role === 'assistant', 'saved locally with role assistant', local.map((m) => m.role).join(','));
  await sleep(400);
  const server = await w.fetch('/api/sessions/' + encodeURIComponent(sid)).then((r) => r.json());
  say((server.messages || []).filter((m) => m.role !== 'system').length === 2, 'committed to the server', (server.messages || []).length);

  console.log('\n-- with a (fake) reasoning model --');
  const script = { parts: ['<think>', 'The question is why it mattered. ', 'Notes: turning point, 1943.', '</think>', '\n\nIt was the **turning point** in the east.'], delay: 5 };
  const engine = {
    interrupted: 0,
    interruptGenerate() { this.interrupted++; },
    chat: { completions: { create: async () => (async function* () {
      for (const p of script.parts) { await sleep(script.delay); yield { choices: [{ delta: { content: p } }] }; }
    })() } }
  };
  w.Archiver._useEngine(engine, 'Qwen3-4B-q4f16_1-MLC');
  $('#settingsBtn').click(); $('#closeSettings').click();       // repaint
  say($('#cbThink').style.display === '' && $('#cbThink').classList.contains('on'), 'THINK shown and on once loaded');
  say($('#modelOffer').classList.contains('hidden'), 'banner hidden once loaded');
  say(/Qwen3 4B/.test($('#healthText').textContent), 'sidebar names the model', $('#healthText').textContent);

  row = await send('why did it matter?');
  const think = row.querySelector('details.think');
  say(!!think, 'reasoning block rendered');
  say(think && /Thought for/.test(think.querySelector('summary').textContent), '"Thought for …" label', think && think.querySelector('summary').textContent);
  say(think && /turning point, 1943/.test(think.querySelector('.think-body').textContent), 'reasoning text visible inside');
  const ans = row.querySelector('.msg-body').textContent;
  say(/turning point in the east/.test(ans) && !/Notes:/.test(ans), 'answer excludes the reasoning', ans);
  const saved = JSON.parse(w.localStorage.getItem('archiver_msgs_v3_' + w.localStorage.getItem('archiver_active_sid_v3'))).at(-1);
  say(saved.thinking && saved.thought_secs != null, 'reasoning saved with the message');

  console.log('\n-- retry --');
  const before = $$('.msg-row').length;
  row.querySelector('[data-act="retry"]').click();
  await until(() => $$('.msg-row').length >= before + 2);
  await until(() => $('#cbStop').style.display === 'none');
  say($$('.msg-row.user').at(-1).textContent.includes('why did it matter?'), 'retry re-asks the same question');

  console.log('\n-- STOP --');
  script.parts = ['<think>', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', '</think>', 'x'.repeat(10)];
  script.delay = 120;
  $('#chatInput').value = 'explain entropy slowly';
  $('#chatInput').dispatchEvent(new w.Event('input'));
  $('#sendBtn').click();
  await until(() => $('#cbStop').style.display === '');
  await sleep(350);
  $('#cbStop').click();
  await until(() => $('#cbStop').style.display === 'none', 4000);
  const stopped = $$('.msg-row.ai').at(-1);
  say(/stopped/.test(stopped.textContent), 'STOP ends the turn and says so');
  say(engine.interrupted >= 1, 'STOP interrupts the model');
  say(!stopped.querySelector('details.think.live'), 'no reasoning block left spinning');

  console.log('\n-- settings round-trip --');
  script.delay = 1;
  $('#settingsBtn').click();
  say($('#setTopK').value === '8', 'Memories per message shows the server value', $('#setTopK').value);
  $('#setTopK').value = '12';
  $('#setHalfLife').value = '30';
  $('#saveSettings').click();
  await until(() => !$('#settingsOverlay').classList.contains('on'));
  const st = await w.fetch('/api/settings').then((r) => r.json());
  say(st.max_memories === '12' && Number(st.half_life_days) === 30, 'saved values reach the server (no forced 500)', st.max_memories + ' / ' + st.half_life_days);
  $('#settingsBtn').click();
  $('#setTopK').value = '33';
  $('#cancelSettings').click();
  $('#settingsBtn').click();
  say($('#setTopK').value === '12', 'Cancel discards edits');
  $('#cancelSettings').click();

  console.log('\n-- history re-render --');
  const id = w.localStorage.getItem('archiver_active_sid_v3');
  const msgs = JSON.parse(w.localStorage.getItem('archiver_msgs_v3_' + id));
  msgs.push({ role: 'user', content: 'kursk?', created_at: Date.now() / 1000 });
  msgs.push({ role: 'archiver', content: 'July 1943.', created_at: Date.now() / 1000,
              sources: [{ title: 'Battle of Kursk', url: 'https://en.wikipedia.org/wiki/Battle_of_Kursk', source: 'Wikipedia' }] });
  w.localStorage.setItem('archiver_msgs_v3_' + id, JSON.stringify(msgs));
  $('#newChatBtn').click();
  $$('.side-item').find((e) => e.dataset.id === id).click();
  await until(() => $$('#chatThread .msg-row').length >= msgs.length);
  say($$('#chatThread details.think').length >= 1, 'reasoning survives re-opening the chat');
  say(!!$('#chatThread .src-pill[href*="Battle_of_Kursk"]'), 'sources survive re-opening the chat');
  say($$('#chatThread .msg-row.ai').at(-1).querySelector('.who').textContent === 'archiver', 'legacy "archiver" role still renders as the assistant');

  console.log('\n-- theme --');
  const sel = $('#themeSelect');
  sel.value = 'dark'; sel.dispatchEvent(new w.Event('change'));
  say(d.documentElement.getAttribute('data-theme') === 'dark', 'dark theme applies');
  sel.value = 'system'; sel.dispatchEvent(new w.Event('change'));
  say(!d.documentElement.hasAttribute('data-theme'), 'system theme clears the override');

  const real = errors.filter((e) => !/Could not parse CSS|Not implemented/.test(e));
  say(real.length === 0, 'no script errors on the page', real[0]);

  console.log(`\n${bad ? bad + ' FAILURES' : 'all page checks passed'}\n`);
  w.close();
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
