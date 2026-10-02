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
# the worker it registers ships as web/archiver-coi-sw.js.
COI_BOOTSTRAP = """<!-- pages-bootstrap: added by scripts/build_pages.py. GitHub Pages cannot send
     COOP/COEP response headers, and the WebAssembly runtime needs a
     cross-origin-isolated document. The service worker below synthesizes the
     headers for documents and worker scripts; the one-time reload then lands
     on an isolated page. sessionStorage makes the reload exactly-once, and a
     page that is already isolated (or a browser that grants SharedArrayBuffer
     on its own) never reloads. -->
<script>
(function () {
  try {
    if (window.crossOriginIsolated || typeof SharedArrayBuffer !== 'undefined') return;
    if (!('serviceWorker' in navigator)) return;
    if (sessionStorage.getItem('archiver-coi') === 'reloaded') return;
    sessionStorage.setItem('archiver-coi', 'reloaded');
    var scope = new URL('.', document.baseURI);
    navigator.serviceWorker
      .register(new URL('archiver-coi-sw.js', scope).href, { scope: scope.pathname })
      .then(function () {
        return Promise.race([
          navigator.serviceWorker.ready,
          new Promise(function (res) { setTimeout(res, 2000); })
        ]);
      })
      .then(function () { location.replace(scope.href); })
      .catch(function () {});
  } catch (_) {}
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

    # Inject the bootstrap into the head of the BUILT page only — the Render
    # deploy already sends real COOP/COEP headers and must not change.
    idx_path = out / "index.html"
    idx = idx_path.read_text(encoding="utf-8")
    anchor = '<link rel="icon"'
    if anchor not in idx:
        fail("index.html head anchor not found")
    idx = idx.replace(anchor, COI_BOOTSTRAP + anchor, 1)
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
                "archiver-coi-sw.js", "static/archiver-engine.js", "static/archiver-worker.js"]
    for name in required:
        if not (out / name).is_file():
            fail(f"missing {name} in built site")

    vendor = ["static/vendor/web-llm-0.2.80.js", "static/vendor/wllama-3.6.1.js",
              "static/vendor/wllama-3.6.1.wasm"]
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
