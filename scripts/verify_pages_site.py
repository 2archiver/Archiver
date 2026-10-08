#!/usr/bin/env python3
"""Fail the run when the *published* Pages site is not the Archiver app.

A green ``actions/deploy-pages`` step only means GitHub accepted the artifact;
it says nothing about what the host serves afterwards. On 2026-10-02 the
repository's Pages source was on *Deploy from a branch* (``main`` / ``docs``),
so GitHub's built-in builder ran on the same push, finished two minutes after
the workflow, and replaced the app with its own build of ``docs/`` — five
rendered markdown files and no ``index.html``. ``/Archiver/`` answered the
"File not found … you must provide an index.html" page while every workflow run
and deployment status was green.

This check closes that gap: fetch the URL ``actions/deploy-pages`` reported,
require the app shell (the page that names ``static/archiver-engine.js`` — the
docs-only build and GitHub's 404 page do not), then require a 200 for the files
the app cannot start without. It retries, because a fresh Pages deployment can
take a minute to reach every edge.

    verify_pages_site.py https://2archiver.github.io/Archiver/

Exit status 0 means the app is live; 1 names what was served instead and points
at the Pages source setting. Stdlib only.
"""

from __future__ import annotations

import argparse
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urljoin

USER_AGENT = "archiver-pages-verify/1 (+https://github.com/2archiver/Archiver)"

# The app shell must name the engine script; nothing else that can be published
# to this project path (GitHub's 404 page, the docs-only Jekyll build) contains it.
PAGE_MARKER = "archiver-engine.js"

# Files the boot path needs. Kept in step with scripts/build_pages.py's required
# list by tests/test_pages_deploy.py, which builds the site and checks these exist.
REQUIRED_PATHS = (
    "manifest.json",
    "favicon.svg",
    "archiver-coi-sw.js",
    "static/archiver-engine.js",
    "static/archiver-prep.js",
    "static/archiver-worker.js",
    "static/vendor/wllama-3.6.1.wasm",
    "static/vendor/wllama-compat-3.6.1.wasm",
)


def _get(url: str, timeout: float, limit: "int | None" = None) -> "tuple[int, bytes]":
    """GET ``url``; return (status, body). Failures come back as status 0."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, (resp.read(limit) if limit else resp.read())
    except urllib.error.HTTPError as exc:
        return exc.code, b""
    except (urllib.error.URLError, OSError, ValueError):
        return 0, b""


def check_site(base: str, timeout: float) -> "tuple[list[str], list[str]]":
    """One pass over the site: (lines that were fine, problems found)."""
    ok: "list[str]" = []
    status, body = _get(base, timeout)
    if status != 200:
        return ok, [f"{base} answered {status or 'nothing'}, not 200"]
    text = body.decode("utf-8", "replace")
    if PAGE_MARKER not in text:
        return ok, [f"{base} answered 200 but is not the app (no {PAGE_MARKER!r} in the page; "
                    "the docs-only build and GitHub's 404 page both lack it)"]
    ok.append(f"200 {base} (the app shell)")

    problems = []
    for path in REQUIRED_PATHS:
        url = urljoin(base, path)
        status, _ = _get(url, timeout, limit=1)  # one byte: the vendored wasm is ~20 MB
        if status != 200:
            problems.append(f"{url} answered {status or 'nothing'}, not 200")
        else:
            ok.append(f"200 {url}")
    return ok, problems


def main(argv: "list[str] | None" = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("base_url", help="the page_url actions/deploy-pages reported")
    ap.add_argument("--attempts", type=int, default=20, help="tries before failing (default 20)")
    ap.add_argument("--delay", type=float, default=5.0, help="seconds between tries (default 5)")
    ap.add_argument("--timeout", type=float, default=15.0, help="per-request timeout in seconds")
    args = ap.parse_args(argv)

    base = args.base_url if args.base_url.endswith("/") else args.base_url + "/"
    attempts = max(1, args.attempts)
    problems: "list[str]" = []

    for attempt in range(1, attempts + 1):
        ok, problems = check_site(base, args.timeout)
        if not problems:
            print(f"verify_pages_site: {base} serves the app")
            for line in ok:
                print(f"  {line}")
            return 0
        if attempt < attempts:
            print(f"verify_pages_site: attempt {attempt}/{attempts}: {'; '.join(problems)} "
                  f"— retrying in {args.delay:g}s")
            time.sleep(args.delay)

    print(f"::error::{base} is not the Archiver app after {attempts} attempt(s): "
          f"{'; '.join(problems)}", file=sys.stderr)
    print("verify_pages_site: this workflow deployed _site, but the host is serving something "
          "else. The usual cause is the Pages source sitting on 'Deploy from a branch', where "
          "GitHub's own builder publishes that folder over the workflow artifact. Check "
          "Settings → Pages → Build and deployment → Source → GitHub Actions, then re-run the "
          "Pages workflow. See docs/PAGES.md.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
