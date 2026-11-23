#!/usr/bin/env python3
"""Assemble the static GitHub Pages site from web/ into a deploy-ready folder.

    python3 scripts/build_pages.py            # -> dist/pages/
    python3 scripts/build_pages.py --out site # CI artifact directory

The site frontend is already host-agnostic (document-relative asset refs, an
ABS() helper for fetches, root-finding manifest), so this build only lays the
files out for a project-pages host and appends the pieces that only make
sense there:

* `index.html`, `manifest.json`, the icons and the COI service worker live at
  the SITE ROOT; everything else lives under `static/` to mirror the URL
  layout the app already uses (`static/archiver-…`).
* A five-line bootstrap in <head> registers `archiver-coi-sw.js` and reloads
  the page once so GitHub Pages — which cannot send response headers — ends
  up cross-origin-isolated anyway, keeping the multithreaded WebAssembly
  runtime (SharedArrayBuffer) alive. Desktop Chrome and Edge gate
  SharedArrayBuffer behind isolation too, so every desktop browser takes the
  one-time reload on its first visit; the worker stamps worker scripts as well
  as documents, because an isolated page refuses a worker script without COEP.

SAFETY GATES — the build refuses to publish a site that is anything other
than the static frontend:
* no `*.db` (a memory bank must never reach a public bucket),
* no `.git`/`.env`/`*.pem`/`*.key`,
* no Python/app-server files (Pages is static; shipping backend source only
  advertises its internals),
* the emitted HTML/JS must not keep root-absolute `/static/` or `/api/`
  references, which would silently 404 under `/Archiver/`.

Only standard library; mirrors the no-build-step philosophy.
"""

from __future__ import annotations

import argparse
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"

# Files that live at the site root (everything else in web/ goes under static/).
ROOT_FILES = ("index.html", "manifest.json", "favicon.svg", "apple-touch-icon.png")

# Injected into <head> of the built index.html only. Kept deliberately small;
# the worker it registers ships as web/archiver-coi-sw.js. Contract (tested by
# tests/pages.js in a VM with fake navigator/sessionStorage/location):
#   * an isolated page never registers or reloads;
#   * a browser with no service worker, no secure context or no sessionStorage
#     registers nothing, reloads nothing and says why;
#   * a browser that cannot expose SharedArrayBuffer even when isolated gets
#     `not-supported` and no reload, so the one-time reload cannot loop on a
#     device the reload could never help;
#   * the worker is registered at the app scope, then the page waits for it to be
#     *activated* (or to already control this document) before reloading once,
#     keeping the exact URL — query and hash included;
#   * WebKit (Safari, and every browser on iOS, which are all WebKit) gets a much
#     longer deadline than Chromium and does NOT spend its one reload when the
#     worker is still starting. iOS Safari activates a new worker slowly, and a
#     reload that arrives first lands on an uncontrolled page, is marked
#     `reloaded`, and can never be isolated again in that tab — the "works on my
#     laptop, not on my iPhone" report;
#   * at most ONE automatic reload per tab, guarded by sessionStorage written
#     BEFORE the reload; a timeout that did not reload keeps the one reload.
COI_BOOTSTRAP = """<!-- pages-bootstrap: added by scripts/build_pages.py. GitHub Pages cannot send
     COOP/COEP headers, and the WebAssembly runtime needs a cross-origin-isolated
     document. The service worker synthesizes those headers; this script reloads
     the current URL at most once per tab so the reload lands on an isolated page. -->
<script>
(function () {
  var KEY = 'archiver-coi';
  var WAIT_MS = 6000;
  /* WebKit is slower to activate, claim and intercept, and it is where a wasted
     reload costs the tab its only chance. Give it twice the room. */
  var WEBKIT_WAIT_MS = 14000;
  var DONE = 'reloaded';
  function set(state, reason) {
    try { window.__archiverIsolation = { state: state, reason: reason, at: Date.now() }; } catch (_) {}
  }
  try {
    if (window.crossOriginIsolated === true) { set('isolated', 'native'); return; }
    if (!window.isSecureContext || !('serviceWorker' in navigator)) { set('unavailable', 'no-service-worker'); return; }
    /* Nothing to isolate for: a browser that cannot create shared memory on a
       secure page cannot run the CPU runtime whether or not it reloads. Search,
       the corpus and the interface still work. */
    if (typeof SharedArrayBuffer === 'undefined' &&
        typeof WebAssembly !== 'undefined' &&
        (function () {
          try { return !WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 4, 1, 3, 1, 1])); }
          catch (_) { return true; }
        })()) {
      set('not-supported', 'no-shared-memory');
      return;
    }
    var store = null;
    try { store = window.sessionStorage; store.getItem(KEY); } catch (_) { store = null; }
    if (!store) { set('unavailable', 'storage-denied'); return; }
    if (store.getItem(KEY) === DONE) { set('unavailable', 'not-isolated-after-reload'); return; }
    var ua = String(navigator.userAgent || '');
    /* AppleWebKit, but not one of its Chromium relatives: Safari on macOS and
       iOS, and every other browser on iOS, which all run WebKit. */
    var webkit = /AppleWebKit/.test(ua) && !/Chrom(e|ium)|CriOS|Edg|OPR/i.test(ua);
    var waitMs = webkit ? WEBKIT_WAIT_MS : WAIT_MS;
    var scope = new URL('.', document.baseURI);
    var swUrl = new URL('archiver-coi-sw.js', scope).href;
    var finished = false;

    function reloadOnce() {
      if (finished) return;
      finished = true;
      try { store.setItem(KEY, DONE); } catch (_) { set('unavailable', 'storage-denied'); return; }
      location.reload();
    }
    /* A worker that has activated will control the next navigation even before
       it claims this document, so either of these makes the reload worthwhile. */
    function ready(reg) {
      if (navigator.serviceWorker.controller) return true;
      return !!(reg && reg.active && reg.active.state === 'activated');
    }

    set('reloading', 'service-worker');
    navigator.serviceWorker.register(swUrl, { scope: scope.pathname }).then(function (reg) {
      var timer = setTimeout(function () {
        if (finished) return;
        if (ready(reg)) { reloadOnce(); return; }
        finished = true;
        /* WebKit keeps its one automatic reload for a worker that is actually
           ready; the page says so and a manual reload tries again. */
        set('unavailable', webkit ? 'worker-still-starting' : 'worker-not-ready');
      }, waitMs);
      var check = function () {
        if (finished || !ready(reg)) return;
        try { clearTimeout(timer); } catch (_) {}
        reloadOnce();
      };
      navigator.serviceWorker.addEventListener('controllerchange', check);
      if (reg) {
        if (reg.active && reg.active.state !== 'activated') reg.active.addEventListener('statechange', check);
        if (typeof reg.addEventListener === 'function') reg.addEventListener('updatefound', check);
      }
      check();
    }, function () {
      finished = true;
      set('unavailable', 'sw-register-failed');
    });
  } catch (_) { set('unavailable', 'bootstrap-error'); }
})();
</script>
"""

FORBIDDEN_RE = re.compile(
    r"(?:^|/)(?:\.env|\.git$)|\.(?:db|db-wal|db-shm|py|pem|key|sqlite3?)$",
)

# References that would silently 404 under a project-pages subpath: network
# primitives fed root-absolute literals, and HTML attributes pointing at the
# host root. (api() call sites take '/api/…' strings deliberately — ABS()
# rebases them at runtime.)
BAD_REF_PATTERNS = [
    re.compile(r"""\bfetch\(\s*['"`]/"""),
    re.compile(r"""\bimport\(\s*['"`]/"""),
    re.compile(r"""\bnew Worker\(\s*['"`]/"""),
    re.compile(r"""location\.href\s*=\s*['"`]/"""),
    re.compile(r"""(?:href|src)\s*=\s*["']/[^/"']"""),
]


def fail(msg: str) -> "None":
    print(f"build_pages: {msg}", file=sys.stderr)
    raise SystemExit(1)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default=str(ROOT / "dist" / "pages"), help="output directory (recreated)")
    ap.add_argument("--allow-absent", action="store_true",
                    help="tolerate missing vendor .wasm/.gz files (source checkout without them)")
    args = ap.parse_args()

    out = Path(args.out).resolve()
    if out == ROOT or out.parent == out or str(out) in ("", "/", str(Path.home())):
        fail(f"refusing to build into {out}")

    if not (WEB / "index.html").is_file():
        fail(f"{WEB} does not look like the web/ directory")

    # Fresh output directory.
    if out.exists():
        shutil.rmtree(out)
    (out / "static").mkdir(parents=True)

    # Everything goes under static/, mirroring the /static mount of the app.
    for src in sorted(WEB.rglob("*")):
        if src.is_dir() or src.name == ".DS_Store":
            continue
        rel = src.relative_to(WEB)
        dst = out / "static" / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)

    # Root copies of the entry files. (index.html and manifest.json also exist
    # under static/ as harmless duplicates; the mount serves them too.)
    for name in ROOT_FILES:
        shutil.copy2(WEB / name, out / name)

    # The COI worker must sit at the site root: a service worker's scope is
    # limited to its own directory.
    sw_src = WEB / "archiver-coi-sw.js"
    if not sw_src.is_file():
        fail("web/archiver-coi-sw.js is missing")
    shutil.copy2(sw_src, out / "archiver-coi-sw.js")

    # Inject the bootstrap into the head of the BUILT page only — the server
    # deploy already sends real COOP/COEP headers and must not change.
    idx_path = out / "index.html"
    idx = idx_path.read_text(encoding="utf-8")
    anchor = '<link rel="icon"'
    if anchor not in idx:
        fail("index.html head anchor not found")
    idx = idx.replace(anchor, COI_BOOTSTRAP + anchor, 1)
    if idx.count("pages-bootstrap:") != 1:
        fail("the Pages bootstrap must be injected exactly once")
    idx_path.write_text(idx, encoding="utf-8")

    # ---- verification ----------------------------------------------------
    files = [p for p in sorted(out.rglob("*")) if p.is_file()]
    if not files:
        fail("produced an empty site")

    for p in files:
        rel = p.relative_to(out)
        name = rel.as_posix()
        if FORBIDDEN_RE.search(name):
            fail(f"refusing to publish {name} — the Pages site is the static frontend only")

    required = ["index.html", "manifest.json", "favicon.svg", "apple-touch-icon.png",
                "archiver-coi-sw.js", "static/archiver-engine.js", "static/archiver-worker.js",
                "static/archiver-prep.js", "static/archiver-quiet.js",
                "static/archiver-sha256.js", "static/archiver-hash-worker.js",
                "static/archiver-browser-search.js"]
    for name in required:
        if not (out / name).is_file():
            fail(f"missing {name} in built site")

    vendor = ["static/vendor/web-llm-0.2.80.js", "static/vendor/wllama-3.6.1.js",
              "static/vendor/wllama-3.6.1.wasm", "static/vendor/wllama-compat-3.6.1.js",
              "static/vendor/wllama-compat-3.6.1.wasm"]
    for name in vendor:
        if not (out / name).is_file():
            if args.allow_absent:
                print(f"build_pages: warning — {name} absent (--allow-absent)")
            else:
                fail(f"missing {name}; run scripts/vendor_wllama.py / vendor_webllm.py first")

    # No root-absolute references may survive in the HTML or our own JS.
    offenders = []
    for p in files:
        name = p.relative_to(out).as_posix()
        if not re.search(r"\.(?:html|js|json)$", name):
            continue
        if name.startswith("static/vendor/"):
            continue  # third-party runtimes are served verbatim; wllama
                      # resolves its locateFile paths relative to us
        text = p.read_text(encoding="utf-8", errors="replace")
        for rx in BAD_REF_PATTERNS:
            for m in rx.finditer(text):
                line_no = text.count("\n", 0, m.start()) + 1
                offenders.append(f"{name}:{line_no}: {m.group(0).strip()[:60]}")
    if offenders:
        fail("root-absolute refs would 404 under a project-pages subpath:\n  " + "\n  ".join(offenders[:8]))

    total = sum(p.stat().st_size for p in files)
    print(f"built {out}: {len(files)} files, {total:,} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
