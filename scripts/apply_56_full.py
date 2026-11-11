#!/usr/bin/env python3
"""Archiver 5.6 full fix — run from repo root."""
from pathlib import Path
import re

ROOT = Path(".")

def read(p):
    return (ROOT / p).read_text(encoding="utf-8")

def write(p, t):
    (ROOT / p).write_text(t, encoding="utf-8")
    print(f"wrote {p} ({len(t)} bytes)")

# ---- engine: VERSION 5.6 ----
eng = read("web/archiver-engine.js")
eng = eng.replace("const VERSION = '5.5';", "const VERSION = '5.6';", 1)
eng = eng.replace("/* Archiver 5.5:", "/* Archiver 5.6:", 1)
eng = eng.replace("Archiver 5.5. The MODEL", "Archiver 5.6. The MODEL", 1)
eng = eng.replace("The APP is Archiver 5.5.", "The APP is Archiver 5.6.")
write("web/archiver-engine.js", eng)

# ---- prep: VERSION 5.6 + auto-init on touch ----
prep = read("web/archiver-prep.js")
prep = prep.replace("/* Archiver 5.5 —", "/* Archiver 5.6 —", 1)
prep = prep.replace("var VERSION = '5.5';", "var VERSION = '5.6';", 1)
old_touch = """    if (isTouchFirst()) {
      // Phones and tablets: store the file now, start the runtime on the first question.
      return ensure({ source: 'auto', allowDownload: true, allowInit: false });
    }"""
new_touch = """    if (isTouchFirst()) {
      // 5.6: phones/tablets also init on open so github.io visitors get a ready model.
      return ensure({ source: 'auto', allowDownload: true, allowInit: true });
    }"""
if old_touch not in prep:
    raise SystemExit("touch-first block not found in prep.js")
prep = prep.replace(old_touch, new_touch, 1)
prep = prep.replace(
    "return ensure({ source: 'auto', allowDownload: false, allowInit: !isTouchFirst(), pausedReason: g.reason });",
    "return ensure({ source: 'auto', allowDownload: false, allowInit: true, pausedReason: g.reason });",
    1,
)
prep = prep.replace(
    "if (typeof root.requestIdleCallback === 'function') root.requestIdleCallback(run1, { timeout: 2000 });\n    else setTimeout(run1, 1200);",
    "if (typeof root.requestIdleCallback === 'function') root.requestIdleCallback(run1, { timeout: 800 });\n    else setTimeout(run1, 400);",
    1,
)
write("web/archiver-prep.js", prep)

# ---- SW cache 5.6.0 ----
sw = read("web/archiver-coi-sw.js")
sw = sw.replace("var CACHE_VERSION = '5.5.0';", "var CACHE_VERSION = '5.6.0';", 1)
write("web/archiver-coi-sw.js", sw)

# ---- index.html cleanup ----
html = read("web/index.html")
html = html.replace(
    '<span class="model-name" id="modelLabel">Archiver <span class="version-tag">5.5</span></span>',
    '<span class="model-name" id="modelLabel">Archiver <span class="version-tag">5.6</span></span>',
    1,
)
html = html.replace("st.appVersion || '5.5'", "st.appVersion || '5.6'")
html = html.replace("plain(st.appVersion || '5.5')", "plain(st.appVersion || '5.6')")
html = html.replace(
    'Private answers from an open model, <b id="disclosureModel">an open Qwen model</b>, running in this browser. Archiver did not train that model. No third-party AI provider receives your prompts. Web search and chat sync need the Archiver server; the static GitHub Pages copy cannot run them. Runs on WebGPU, or on the CPU through WebAssembly.',
    'Private answers from an open model running in this browser. No third-party AI provider receives your prompts. On the static GitHub Pages copy, web search runs in the browser. Runs on WebGPU, or on the CPU through WebAssembly. <span id="disclosureModel" style="font-size:11px;color:var(--ink-3)"></span>',
    1,
)
if ".mtag" in html and "font-size:11px" not in html[html.find(".mtag"):html.find(".mtag")+200]:
    html = html.replace(".mtag{", ".mtag{font-size:11px;opacity:.75;", 1) if ".mtag{" in html else html

gen_fs = re.search(
    r'\s*<fieldset>\s*<legend>Generation</legend>\s*<details>.*?</details>\s*</fieldset>',
    html,
    re.S,
)
if gen_fs:
    html = html[:gen_fs.start()] + html[gen_fs.end():]
    print("removed Generation tuning fieldset")
else:
    print("WARN: Generation fieldset not found")

comm = re.search(
    r'\s*<fieldset>\s*<legend>Community</legend>.*?</fieldset>',
    html,
    re.S,
)
if comm:
    html = html[:comm.start()] + html[comm.end():]
    print("removed Community fieldset")
else:
    print("WARN: Community fieldset not found")

dw = re.search(
    r'<div class="discord-widget" id="discordWidget"[\s\S]*?</button>\s*</div>',
    html,
)
if dw:
    html = html[:dw.start()] + html[dw.end():]
    print("removed discord-widget markup")
else:
    print("WARN: discord-widget not found")

if ".discord-widget{" in html and "5.6 discord removed" not in html:
    html = re.sub(
        r'/\* ---------- Discord — unintrusive floating invite \(like Chatwave\) ---------- \*/[\s\S]*?/\* Community card in Settings',
        '/* 5.6 discord removed */\n.discord-widget,.discord-fab,.discord-card,.discord-embed,.btn-discord{display:none!important}\n/* Community card in Settings',
        html,
        count=1,
    )
    print("collapsed Discord CSS")

html = html.replace(
    "$('#disclosureModel').textContent = named || 'an open Qwen model';",
    "$('#disclosureModel').textContent = named ? ('Model: ' + named) : '';",
)

if 'cl-ver">5.5<' in html and 'cl-ver">5.6<' not in html:
    html = html.replace(
        '<div class="cl-head"><span class="cl-ver">5.5</span><span class="cl-date">2026-10-08</span></div>\n          <div class="cl-title">5.5 — consistent identity, grounded answers, Mishima cards, corrected Hitler cards</div>',
        '<div class="cl-head"><span class="cl-ver">5.6</span><span class="cl-date">2026-11-11</span></div>\n          <div class="cl-title">5.6 — github.io browser search, cleanup, auto model on open</div>\n          <div class="cl-head"><span class="cl-ver">5.5</span><span class="cl-date">2026-10-08</span></div>\n          <div class="cl-title">5.5 — consistent identity, grounded answers, Mishima cards, corrected Hitler cards</div>',
        1,
    )
    print("added in-page 5.6 changelog entry")

write("web/index.html", html)

# ---- diag ----
diag = read("web/archiver-diag.js")
if "100dvh" not in diag and "safe-area-inset" not in diag:
    if "overflow-y" in diag:
        diag = diag.replace("overflow-y:auto", "overflow-y:auto;-webkit-overflow-scrolling:touch;max-height:min(90vh,100dvh)")
        write("web/archiver-diag.js", diag)
        print("diag scroll tweak")
    else:
        print("diag: no overflow-y found, leave as-is")
else:
    print("diag already has safe-area/dvh")

print("DONE 5.6 apply")

# ---- tests/sw.js cache name ----
sw_test = read("tests/sw.js")
if "archiver-shell-v5.5.0" in sw_test:
    write("tests/sw.js", sw_test.replace("archiver-shell-v5.5.0", "archiver-shell-v5.6.0"))
    print("sw test cache name updated")

# ---- tests/prep.js touch expectation ----
prep_test = read("tests/prep.js")
old = """  await test('on a touch-first device auto-prep stores the file and starts the runtime on open', async () => {
    const origin = createOrigin();
    hubFile(origin, Q4_0, bytes);
    const log = [];
    const b = await createBrowser({ origin, touch: true });
    b.Prep.configure(runtimeHooks(log));
    await b.Prep.maybeAuto();
    assert.equal(b.Prep.snapshot().phase, 'cached');
    assert.equal(log.length, 0, 'not started before a question');
    assert.equal(await b.Prep.ensureReady({ source: 'send', allowDownload: true, allowInit: true }), true);
    assert.equal(log.length, 1);
  });"""
new = """  await test('on a touch-first device auto-prep stores the file and starts the runtime on open', async () => {
    const origin = createOrigin();
    hubFile(origin, Q4_0, bytes);
    const log = [];
    const b = await createBrowser({ origin, touch: true });
    b.Prep.configure(runtimeHooks(log));
    await b.Prep.maybeAuto();
    await until(() => b.Prep.snapshot().phase === 'ready', 4000, 'ready on touch');
    assert.equal(b.Prep.snapshot().phase, 'ready');
    assert.equal(log.length, 1, 'runtime started on open (5.6)');
  });"""
if old in prep_test:
    write("tests/prep.js", prep_test.replace(old, new))
    print("prep touch test updated")
elif "not started before a question" in prep_test:
    m = re.search(r"await test\('on a touch-first device[\s\S]*?\n  \}\);", prep_test)
    if m and "not started before a question" in m.group(0):
        write("tests/prep.js", prep_test[:m.start()] + new.strip() + prep_test[m.end():])
        print("prep touch test replaced via regex")
    else:
        print("prep touch test: unexpected form")
else:
    print("prep touch test already ok or different")

# Changelog
cl = read("CHANGELOG.md")
cl = cl.replace("Shell cache bumped to `archiver-shell-v5.6.0`.", "Shell cache `archiver-shell-v5.6.0` (aligned with engine 5.6).")
if "engine **5.6**" not in cl:
    cl = cl.replace(
        "## 5.6 — 2026-11-11\n\nCleanup release focused on the public GitHub Pages experience.\n",
        "## 5.6 — 2026-11-11\n\nCleanup release focused on the public GitHub Pages experience. Engine, prep, and shell are **Archiver 5.6**.\n",
    )
write("CHANGELOG.md", cl)
print('ALL 5.6 FIXES APPLIED')
