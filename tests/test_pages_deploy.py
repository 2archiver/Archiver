"""The two guards that keep github.io serving the app rather than GitHub's
built-in branch builder's Jekyll output.

`scripts/ensure_pages_source.py` is exercised against a fake `gh` that reports
each Pages state — already-workflow, branch-sourced, not-enabled-at-all, and
refused/unreadable — and records the API calls the script makes, so "no-op" can
be asserted to really be a no-op.

`scripts/verify_pages_site.py` runs against a real HTTP server on 127.0.0.1
serving three sites in turn: an app-shaped one, the docs-only site that caused
the 2026-10-02 404 (no index.html, so the root answers 404 like Pages does), and
one whose page is fine but whose assets are not. A fourth test builds the real
site with `scripts/build_pages.py` and checks every path the verifier demands
still exists, so a rename cannot turn the post-deploy check into a false alarm.

No network beyond the loopback socket, no new dependency.
"""

from __future__ import annotations

import contextlib
import functools
import http.server
import importlib.util
import json
import subprocess
import sys
import threading
from collections import namedtuple
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
REPO = "2archiver/Archiver"

Done = namedtuple("Done", "args returncode stdout stderr")


def load(name):
    """Import a scripts/*.py file by path (scripts/ is not a package)."""
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ensure = load("ensure_pages_source")
verify = load("verify_pages_site")


class FakeGh:
    """Stand-in for `gh api`, driven by the Pages state it should report."""

    def __init__(self, build_type="workflow", write_error=None, get_error=None, ignores_writes=False):
        self.calls = []
        self.build_type = build_type          # "workflow" | "legacy" | None (no Pages site)
        self.write_error = write_error        # stderr for PUT/POST, e.g. an HTTP 403
        self.get_error = get_error            # stderr for GET, e.g. an HTTP 403
        self.ignores_writes = ignores_writes  # writes "succeed" but change nothing

    def __call__(self, cmd, capture_output=True, text=True, **_):
        self.calls.append(list(cmd))
        api = cmd[2:]                         # cmd is ["gh", "api", ...]
        if "-X" in api:
            if self.write_error:
                return Done(cmd, 1, "", self.write_error)
            if not self.ignores_writes:
                self.build_type = "workflow"
            return Done(cmd, 0, json.dumps({"build_type": "workflow"}), "")
        if self.get_error:
            return Done(cmd, 1, "", self.get_error)
        if self.build_type is None:
            return Done(cmd, 1, "", "gh: Not Found (HTTP 404)")
        return Done(cmd, 0, json.dumps({"build_type": self.build_type}), "")

    @property
    def writes(self):
        return [call for call in self.calls if "-X" in call]


@pytest.mark.parametrize(("build_type", "expected"), [
    ("workflow", "noop"),
    ("legacy", "switch"),
    (None, "create"),
])
def test_plan(build_type, expected):
    assert ensure.plan(build_type) == expected


def test_a_workflow_source_is_left_alone(monkeypatch, capsys):
    fake = FakeGh(build_type="workflow")
    monkeypatch.setattr(ensure.subprocess, "run", fake)

    assert ensure.main(["--repo", REPO]) == 0
    assert capsys.readouterr().out.startswith("already")
    assert fake.writes == []


def test_a_branch_sourced_site_is_switched(monkeypatch, capsys):
    fake = FakeGh(build_type="legacy")
    monkeypatch.setattr(ensure.subprocess, "run", fake)

    assert ensure.main(["--repo", REPO]) == 0
    assert capsys.readouterr().out.startswith("switched")
    assert len(fake.writes) == 1
    assert "-X" in fake.writes[0] and "PUT" in fake.writes[0]
    assert f"repos/{REPO}/pages" in fake.writes[0]
    assert "build_type=workflow" in fake.writes[0]
    assert fake.build_type == "workflow"


def test_a_missing_pages_site_is_created(monkeypatch, capsys):
    fake = FakeGh(build_type=None)
    monkeypatch.setattr(ensure.subprocess, "run", fake)

    assert ensure.main(["--repo", REPO]) == 0
    assert capsys.readouterr().out.startswith("created")
    assert len(fake.writes) == 1 and "POST" in fake.writes[0]


def test_the_repo_defaults_to_the_workflow_environment(monkeypatch, capsys):
    fake = FakeGh(build_type="workflow")
    monkeypatch.setattr(ensure.subprocess, "run", fake)
    monkeypatch.setenv("GITHUB_REPOSITORY", REPO)

    assert ensure.main([]) == 0
    assert fake.calls and f"repos/{REPO}/pages" in fake.calls[0]


def test_a_refused_write_names_the_setting(monkeypatch, capsys):
    refusal = "gh: Resource not accessible by integration (HTTP 403)"
    fake = FakeGh(build_type="legacy", write_error=refusal)
    monkeypatch.setattr(ensure.subprocess, "run", fake)

    assert ensure.main(["--repo", REPO]) == 1
    err = capsys.readouterr().err
    assert "403" in err
    assert "Settings → Pages" in err and "GitHub Actions" in err


def test_an_unreadable_pages_state_names_the_setting(monkeypatch, capsys):
    fake = FakeGh(get_error="gh: Resource not accessible by integration (HTTP 403)")
    monkeypatch.setattr(ensure.subprocess, "run", fake)

    assert ensure.main(["--repo", REPO]) == 1
    assert "Settings → Pages" in capsys.readouterr().err


def test_a_write_that_does_not_take_is_a_failure(monkeypatch, capsys):
    fake = FakeGh(build_type="legacy", ignores_writes=True)
    monkeypatch.setattr(ensure.subprocess, "run", fake)

    assert ensure.main(["--repo", REPO]) == 1
    assert "still reports" in capsys.readouterr().err


def test_without_a_repository_it_refuses_to_guess(monkeypatch, capsys):
    fake = FakeGh()
    monkeypatch.setattr(ensure.subprocess, "run", fake)
    monkeypatch.delenv("GITHUB_REPOSITORY", raising=False)

    assert ensure.main([]) == 2
    assert "--repo" in capsys.readouterr().err
    assert fake.calls == []


class NoListingHandler(http.server.SimpleHTTPRequestHandler):
    """A static host without directory listings: unknown paths 404, as on Pages."""

    def log_message(self, *args):  # keep the pytest output clean
        pass

    def list_directory(self, path):
        self.send_error(404, "Not Found")
        return None


@contextlib.contextmanager
def serve(root: Path, handler=NoListingHandler):
    """Serve `root` as the site root on an ephemeral loopback port."""
    httpd = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0), functools.partial(handler, directory=str(root)))
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}"
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=5)


def build_app_site(root: Path) -> None:
    """The shape scripts/build_pages.py emits: an app shell plus its assets."""
    (root / "index.html").write_text(
        '<!doctype html><title>Archiver</title><script src="static/archiver-engine.js"></script>')
    for path in verify.REQUIRED_PATHS:
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"ok")


def run_script(name, *args):
    return subprocess.run([sys.executable, str(SCRIPTS / name), *args],
                          capture_output=True, text=True, timeout=120)


def test_the_verifier_checks_files_the_builder_actually_emits(tmp_path):
    """A stale path here would fail a deploy that is perfectly fine."""
    out = tmp_path / "site"
    built = subprocess.run([sys.executable, str(SCRIPTS / "build_pages.py"), "--out", str(out)],
                           capture_output=True, text=True, timeout=300)
    assert built.returncode == 0, built.stderr
    assert [path for path in verify.REQUIRED_PATHS if not (out / path).is_file()] == []


def test_the_published_app_passes(tmp_path):
    build_app_site(tmp_path)
    with serve(tmp_path) as base:
        proc = run_script("verify_pages_site.py", base, "--attempts", "1", "--delay", "0")
    assert proc.returncode == 0, proc.stderr
    assert "serves the app" in proc.stdout


def test_the_docs_only_site_is_rejected(tmp_path):
    # What GitHub's built-in builder published on 2026-10-02: rendered markdown
    # from docs/, and no index.html, so the project root answers 404.
    (tmp_path / "PAGES.html").write_text("<h1>Archiver on GitHub Pages — the static preview</h1>")
    with serve(tmp_path) as base:
        proc = run_script("verify_pages_site.py", base, "--attempts", "1", "--delay", "0")
    assert proc.returncode == 1
    assert "::error::" in proc.stderr
    assert "Settings → Pages" in proc.stderr and "Deploy from a branch" in proc.stderr


def test_a_page_without_the_app_shell_is_rejected(tmp_path):
    # Somebody else's index.html, served 200: the marker check still refuses it.
    (tmp_path / "index.html").write_text("<!doctype html><title>Not Archiver</title>")
    with serve(tmp_path) as base:
        proc = run_script("verify_pages_site.py", base, "--attempts", "1", "--delay", "0")
    assert proc.returncode == 1
    assert "not the app" in proc.stderr


def test_a_missing_asset_is_rejected(tmp_path):
    build_app_site(tmp_path)
    (tmp_path / "static" / "archiver-worker.js").unlink()
    with serve(tmp_path) as base:
        proc = run_script("verify_pages_site.py", base, "--attempts", "1", "--delay", "0")
    assert proc.returncode == 1
    assert "archiver-worker.js" in proc.stderr


def test_a_propagating_deployment_is_retried(tmp_path):
    build_app_site(tmp_path)
    state = {"hits": 0}

    class StillPropagating(NoListingHandler):
        def do_GET(self):
            state["hits"] += 1
            if state["hits"] <= 2:
                self.send_error(404, "Not Found")
                return
            super().do_GET()

    with serve(tmp_path, handler=StillPropagating) as base:
        proc = run_script("verify_pages_site.py", base, "--attempts", "5", "--delay", "0")
    assert proc.returncode == 0, proc.stderr
    assert state["hits"] > 2, "the first, failed attempts were not retried"


def test_an_unreachable_host_is_reported(tmp_path):
    build_app_site(tmp_path)
    # Port 1 is never listening for an unprivileged client: connection refused.
    proc = run_script("verify_pages_site.py", "http://127.0.0.1:1", "--attempts", "1", "--timeout", "2")
    assert proc.returncode == 1
    assert "nothing" in proc.stderr
