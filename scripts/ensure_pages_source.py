#!/usr/bin/env python3
"""Put the repository's Pages source back on *this workflow* — idempotently.

GitHub Pages publishes through exactly one of two builders:

* ``workflow`` — the ``Pages`` workflow uploads the built static site and
  deploys it with ``actions/deploy-pages``. This is what every path in
  docs/PAGES.md assumes.
* ``legacy`` — GitHub's built-in builder runs by itself on every push and
  publishes one branch folder through Jekyll. With ``main`` / ``docs`` that is
  five rendered markdown files and **no index.html**, so ``/Archiver/`` answers
  GitHub's "The site configured at this address does not contain the requested
  file … you must provide an index.html" 404 — the page the app's users saw on
  2026-10-02, while this workflow's own deploy job was green.

``actions/configure-pages`` with ``enablement: true`` looks like the standard
way to assert this and is not: it calls ``getPagesSite()`` first and returns the
existing site when there is one, so ``build_type: workflow`` is only ever sent
when Pages is off entirely. Against a branch-sourced site it succeeds in about
a second having changed nothing. The API call therefore happens here.

The call is safe to run on every push: with the source already on the workflow
it issues a single GET and stops.

Stack: stdlib only, `gh api` for transport (``GH_TOKEN``/``GITHUB_TOKEN`` from
the environment, as the workflow provides them). The first word on stdout is
the machine-readable result — ``already`` | ``switched`` | ``created`` — which
``.github/workflows/pages.yml`` uses to decide whether a built-in build queued
for the same commit needs to settle before the deploy.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

SETTINGS = "Settings → Pages → Build and deployment → Source → GitHub Actions"


class GhError(RuntimeError):
    """`gh api` could not read or change the Pages site."""


def plan(build_type: "str | None") -> str:
    """What to do for the build type the API reported (``None``: no Pages site)."""
    if build_type == "workflow":
        return "noop"
    if build_type is None:
        return "create"
    return "switch"


def _gh_api(args: "list[str]") -> "subprocess.CompletedProcess[str]":
    """Run ``gh api ARGS`` and hand back the completed process."""
    try:
        return subprocess.run(["gh", "api", *args], capture_output=True, text=True)
    except FileNotFoundError as exc:
        raise GhError("the gh CLI is not installed") from exc


def read_build_type(repo: str) -> "str | None":
    """The live ``build_type``, or ``None`` when Pages is not enabled at all."""
    proc = _gh_api([f"repos/{repo}/pages"])
    if proc.returncode == 0:
        try:
            return json.loads(proc.stdout or "{}").get("build_type")
        except json.JSONDecodeError as exc:
            raise GhError(f"unreadable Pages response: {proc.stdout.strip()[:200]}") from exc
    if "404" in proc.stderr:
        return None
    raise GhError(proc.stderr.strip() or proc.stdout.strip() or f"gh exited {proc.returncode}")


def set_workflow_source(repo: str, action: str) -> None:
    """PUT the build type (or POST the site, when Pages has to be created)."""
    verb = "PUT" if action == "switch" else "POST"
    proc = _gh_api(["-X", verb, f"repos/{repo}/pages", "-f", "build_type=workflow"])
    if proc.returncode != 0:
        raise GhError(proc.stderr.strip() or proc.stdout.strip() or f"gh exited {proc.returncode}")


def main(argv: "list[str] | None" = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY", ""),
                    help="owner/name (default: $GITHUB_REPOSITORY)")
    args = ap.parse_args(argv)

    if not args.repo:
        print("ensure_pages_source: no repository — pass --repo owner/name or set GITHUB_REPOSITORY",
              file=sys.stderr)
        return 2

    try:
        build_type = read_build_type(args.repo)
        action = plan(build_type)
        if action == "noop":
            print(f"already: the Pages source is this workflow ({args.repo})")
            return 0
        set_workflow_source(args.repo, action)
        confirmed = read_build_type(args.repo)
        if confirmed != "workflow":
            raise GhError(f"the API still reports build_type={confirmed!r} after the change")
    except GhError as exc:
        print(f"ensure_pages_source: {exc}", file=sys.stderr)
        print("ensure_pages_source: the Pages source must be GitHub Actions — "
              f"{SETTINGS} — or GitHub's built-in branch builder publishes its own folder "
              "on every push, replacing the workflow artifact on the live site "
              "(with main /docs that is five markdown files and no index.html, "
              "so the project page 404s). See docs/PAGES.md.", file=sys.stderr)
        return 1

    if action == "switch":
        print(f"switched: the Pages source is now this workflow ({args.repo}, was {build_type!r})")
    else:
        print(f"created: the Pages site now publishes from this workflow ({args.repo}, Pages was not enabled)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
