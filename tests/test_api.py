"""4.1 browser-chat sync regression tests; no external requests or model calls."""
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from app import main


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DB_PATH", str(tmp_path / "test.db"))
    with TestClient(main.app) as c:
        c.get("/api/health")  # establish browser identity
        yield c


def test_release_assets(client):
    assert client.get("/api/health").json()["version"] == "5.2"
    for asset in ("archiver-comprehension.js", "archiver-engine.js", "archiver-worker.js",
                  "archiver-viewport.js", "archiver-download.js"):
        assert client.get("/static/" + asset).status_code == 200
    page = client.get("/").text
    assert 'maximum-scale=1' not in page
    assert 'id="autoAI"' not in page
    assert 'id="retryModel"' in page
    assert 'Archiver 5.2 is always enabled' in page
    # 5.1: settings apply as they change, so there is nothing to press.
    assert 'id="saveSettings"' not in page
    assert 'Apply settings' not in page
    # 5.1: the start page carries the badge, not a second copy of the logo.
    assert 'start-emblem' not in page
    assert 'id="brandMark"' in page, 'the sidebar logo stays'
    assert 'class="topbar-mark"' in page, 'and so does the top bar logo'
    # 5.1: one loading indicator, not the dots and the status line together.
    assert 'typing-dots' not in page
    assert 'id="setSaved"' in page, 'settings confirm themselves when saved'


def test_both_inference_runtimes_are_shipped(client):
    """The GPU runtime alone means 'no generation' on most Safari installs, so
    the WASM runtime has to be served from the same origin with the MIME type
    WebAssembly.instantiateStreaming requires."""
    for name, media in (
        ("web-llm-0.2.80.js", "application/javascript"),
        ("wllama-3.6.1.js", "application/javascript"),
        ("wllama-3.6.1.wasm", "application/wasm"),
    ):
        plain = client.get(f"/static/vendor/{name}", headers={"accept-encoding": "identity"})
        assert plain.status_code == 200, name
        assert plain.headers["content-type"].startswith(media), name
        assert plain.headers["cache-control"] == "public, max-age=31536000, immutable"
        assert len(plain.content) > 1000, name
        gzipped = client.get(f"/static/vendor/{name}", headers={"accept-encoding": "gzip"})
        assert gzipped.status_code == 200, name
        assert gzipped.headers["vary"] == "Accept-Encoding"
        assert gzipped.headers.get("content-encoding") == "gzip", name
        assert len(gzipped.content) == len(plain.content), name
    # The engine must point at exactly the assets this server ships.
    engine = client.get("/static/archiver-engine.js").text
    for name in ("web-llm-0.2.80.js", "wllama-3.6.1.js", "wllama-3.6.1.wasm"):
        assert f"/static/vendor/{name}" in engine, name
    assert client.get("/static/vendor/does-not-exist.js").status_code == 404
    # Licenses and notes in the same directory still come from the static mount.
    assert client.get("/static/vendor/README.md").status_code == 200
    assert client.get("/static/vendor/wllama-3.6.1.LICENSE").status_code == 200


def test_completed_turn_is_visible_to_its_owner(client):
    prep = client.post("/api/chat/prepare", json={"session_id": "s_test", "message": "I prefer Python."}).json()
    sid = prep["session_id"]
    committed = client.post("/api/chat/commit", json={"session_id": sid, "message": "I prefer Python.", "answer": "Noted."})
    assert committed.status_code == 200
    assert committed.json()["memories_saved"]
    messages = client.get(f"/api/sessions/{sid}").json()["messages"]
    assert [m["role"] for m in messages] == ["user", "assistant"]
    assert client.get("/api/memories").json()
    assert client.patch(f"/api/sessions/{sid}", json={"title": "Renamed"}).status_code == 200
    assert client.get(f"/api/sessions/{sid}").json()["title"] == "Renamed"


def test_cross_browser_history_and_memory_isolation(client):
    client.post("/api/chat/prepare", json={"session_id": "s_private", "message": "I prefer Python."})
    client.post("/api/chat/commit", json={"session_id": "s_private", "message": "I prefer Python.", "answer": "Noted."})
    owner_cookie = client.cookies.get(main.COOKIE_NAME)
    client.cookies.clear()
    client.get("/api/health")
    assert client.get("/api/memories").json() == []
    assert client.get("/api/sessions/s_private").status_code == 404
    prep = client.post("/api/chat/prepare", json={"message": "What do I prefer about Python?"}).json()
    assert prep["memories"] == []
    assert client.post("/api/chat/commit", json={"session_id": "s_private", "message": "test", "answer": "no"}).status_code == 404
    client.delete("/api/sessions/s_private")
    client.cookies.clear()
    client.cookies.set(main.COOKIE_NAME, owner_cookie)
    assert client.get("/api/sessions/s_private").status_code == 200


def test_auto_extract_setting_respected(client):
    client.put("/api/settings", json={"auto_extract": "0"})
    prep = client.post("/api/chat/prepare", json={"message": "I prefer Python."}).json()
    result = client.post("/api/chat/commit", json={"session_id": prep["session_id"], "message": "I prefer Python.", "answer": "Noted."}).json()
    assert result["memories_saved"] == []
    assert client.get("/api/memories").json() == []


def test_default_migration_preserves_custom_persona(client):
    uid = client.cookies.get(main.COOKIE_NAME)
    store = main.app.state.store
    store.set_setting("model", "Archiver 2.5 (in-browser)", uid)
    store.set_setting("persona", "My custom persona", uid)
    main.apply_defaults(store, uid)
    assert store.get_setting("model", user_id=uid) == "Archiver 5.2 (in-browser)"
    assert store.get_setting("persona", user_id=uid) == "My custom persona"
    # 4.0 retired persona upgrades to 5.
    store.set_setting("persona", main.RETIRED_PERSONAS[0], uid)
    main.apply_defaults(store, uid)
    assert store.get_setting("persona", user_id=uid) == main.PERSONA
    assert "Archiver 5" in store.get_setting("persona", user_id=uid)


def test_restore_defaults_replaces_custom_settings(client):
    client.put("/api/settings", json={"persona": "Custom", "auto_extract": "0", "api_key": "legacy-secret"})
    restored = client.post("/api/settings/restore")
    assert restored.status_code == 200
    body = restored.json()
    assert body["persona"] == main.PERSONA
    assert body["auto_extract"] == "1"
    assert body["has_api_key"] is False
    assert "api_key" not in main.app.state.store.settings(secret=True, user_id=client.cookies.get(main.COOKIE_NAME))
    # Default model in settings is now 5.
    assert body["model"] == "Archiver 5.2 (in-browser)"


def test_retry_removes_trailing_turn_for_replacement(client):
    prep = client.post("/api/chat/prepare", json={"session_id": "retry_session", "message": "Explain caching."}).json()
    sid = prep["session_id"]
    client.post("/api/chat/commit", json={"session_id": sid, "message": "Explain caching.", "answer": "Old answer."})
    result = client.post(f"/api/sessions/{sid}/retry")
    assert result.status_code == 200
    assert result.json()["removed"] is True
    messages = client.get(f"/api/sessions/{sid}").json()["messages"]
    assert messages == []
    assert client.post(f"/api/sessions/{sid}/retry").json()["removed"] is False


def test_bundled_runtime_cache_and_integrity(client):
    from hashlib import sha256
    expected = "ef77cc550c47c441f0243d7d173864548164814a9565c1a9a0b8b57f82167199"
    for encoding, compressed in (("gzip", True), ("identity", False), ("gzip;q=0", False)):
        response = client.get("/static/vendor/web-llm-0.2.80.js", headers={"Accept-Encoding": encoding})
        assert response.status_code == 200
        assert sha256(response.content).hexdigest() == expected
        assert (response.headers.get("content-encoding") == "gzip") == compressed
        assert "immutable" in response.headers["cache-control"]
        assert response.headers["vary"] == "Accept-Encoding"
        assert "set-cookie" not in response.headers
    client.cookies.clear()
    response = client.get("/static/vendor/web-llm-0.2.80.js")
    assert "set-cookie" not in response.headers


def test_vendor_asset_conditional_request_returns_304(client):
    """A warm browser revalidates with the ETag and gets 304, not the payload.

    The vendored runtimes are the largest bytes the service ships and every
    avoided transfer is metered bandwidth not spent."""
    etags = {}
    for encoding in ("identity", "gzip"):
        first = client.get("/static/vendor/wllama-3.6.1.js", headers={"Accept-Encoding": encoding})
        assert first.status_code == 200
        etag = first.headers.get("etag")
        assert etag and etag.startswith('"'), encoding
        etags[encoding] = etag
        conditional = client.get(
            "/static/vendor/wllama-3.6.1.js",
            headers={"Accept-Encoding": encoding, "If-None-Match": etag},
        )
        assert conditional.status_code == 304, encoding
        assert conditional.content == b"", encoding
        assert conditional.headers["etag"] == etag, encoding
        assert "immutable" in conditional.headers["cache-control"], encoding
        assert conditional.headers["vary"] == "Accept-Encoding", encoding
        assert "set-cookie" not in conditional.headers, encoding
    # Plain and gziped variants are different bytes and get different validators.
    assert etags["identity"] != etags["gzip"]
    # A stale validator (a redeployed runtime) gets the payload back.
    stale = client.get(
        "/static/vendor/wllama-3.6.1.js",
        headers={"Accept-Encoding": "identity", "If-None-Match": '"0123456789abcdef"'},
    )
    assert stale.status_code == 200
    assert len(stale.content) > 1000


def test_health_performs_no_outbound_fetch(client, monkeypatch):
    """/api/health is the wake probe and the deploy health check: it answers the
    moment uvicorn binds, so nothing in it may reach the network."""
    from app import search, take

    calls = []

    async def forbidden(*args, **kwargs):
        calls.append((args, kwargs))
        raise AssertionError("an outbound fetch was attempted from /api/health")

    monkeypatch.setattr(take, "fetch", forbidden)
    monkeypatch.setattr(take, "fetch_text", forbidden)
    monkeypatch.setattr(search, "search", forbidden)
    monkeypatch.setattr(search, "suggest", forbidden)
    monkeypatch.setattr(search, "diag", forbidden)
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert response.json()["version"] == "5.2"
    assert calls == []


def test_search_returns_unverified_flag_on_empty(client, monkeypatch):
    """4.1: the search endpoint exposes an `unverified` flag so the UI knows
    when to label a best-effort answer instead of refusing outright."""
    from app import search as search_mod

    async def fake_search(*args, **kwargs):
        return {
            "results": [], "errors": [], "providers": {},
            "query": "xyzzy", "technical": False, "confidence": "none",
            "interpretation": {}, "report": {"unverified": True, "voice": "nothing"},
            "corrected": "", "unverified": True,
        }

    monkeypatch.setattr(search_mod, "search", fake_search)
    resp = client.get("/api/search?q=xyzzy")
    assert resp.status_code == 200
    body = resp.json()
    assert body["unverified"] is True


def test_search_diag_includes_bing(client, monkeypatch):
    """4.1: the diagnostic endpoint reports on the new Bing provider too."""
    from app import take as take_mod

    async def fake_fetch(c, url, **kwargs):
        class R:
            status_code = 200
            headers = {"content-type": "text/html"}
            def raise_for_status(self): pass
            text = ('<li class="b_algo"><h2><a href="https://example.com/x">Example</a></h2>'
                    '<p>An example snippet about the topic.</p></li>')
            def json(self): return {"ip": "127.0.0.1"}
        return R()

    monkeypatch.setattr(take_mod, "fetch", fake_fetch)
    # Directly via endpoint (monkeypatching take.fetch covers the diag call too).
    resp = client.get("/api/search/diag?q=example")
    assert resp.status_code == 200
    body = resp.json()
    assert "bing" in body["providers"]


def test_free_render_deployment_has_no_model_server():
    from pathlib import Path
    root = Path(__file__).resolve().parents[1]
    assert "plan: free" in (root / "render.yaml").read_text()
    requirements = (root / "requirements.txt").read_text()
    assert all(name not in requirements for name in ("torch", "transformers", "llama"))
    engine = (root / "web/archiver-engine.js").read_text()
    worker = (root / "web/archiver-worker.js").read_text()
    assert "esm.run" not in engine + worker
    assert "vendor/web-llm-0.2.80.js" in engine and "vendor/web-llm-0.2.80.js" in worker
    # 4.1: client-side search timeout is 75 s, not 12 s.
    assert "SEARCH_TIMEOUT_MS = 75000" in engine


def test_bing_parser_extracts_results_from_serp_html():
    """4.1: the Bing HTML parser must pull title / URL / snippet from a b_algo block."""
    from app.search import _parse_bing_html
    html = (
        '<li class="b_algo"><h2><a href="https://example.com/platypus">Platypus</a></h2>'
        '<p>The platypus is a semiaquatic egg-laying mammal endemic to Australia.</p>'
        '</li>'
        '<li class="b_algo"><h2><a href="https://example.com/two">Two</a></h2>'
        '<p>Second result snippet.</p></li>'
    )
    results = _parse_bing_html(html, 3)
    assert len(results) == 2
    assert results[0]["source"] == "Bing"
    assert results[0]["title"] == "Platypus"
    assert results[0]["url"] == "https://example.com/platypus"
    assert "egg-laying mammal" in results[0]["extract"]


def test_relaxed_thresholds_let_ordinary_web_results_through():
    """4.1 thresholds are lower than 4.0 so web hits with shorter titles surface."""
    from app import search
    assert search.SURE_AT == 0.30
    assert search.MAYBE_AT == 0.14
    assert search.QUOTE_AT == 0.10
    # Bing must be in the diag chain.
    assert any(name == "bing" for name, _ in search.BING_CHAIN)


def test_server_timeout_is_raised_for_waking_instance():
    """4.1: the server-side httpx timeout is raised so a waking instance is heard."""
    import httpx
    from app import search
    # connect must be at least 15s; read/write/pool at least 70s.
    assert isinstance(search.TIMEOUT, httpx.Timeout)
    assert search.TIMEOUT.connect >= 15.0
    assert search.TIMEOUT.read >= 70.0
    assert search.TIMEOUT.pool >= 70.0


def test_persona_mentions_concurrent_search_and_unverified_fallback():
    """Archiver 5 persona mentions the new behaviour and our own model."""
    assert "Archiver 5" in main.PERSONA
    assert "concurrently" in main.PERSONA
    assert "unverified" in main.PERSONA


def test_settings_default_mentions_local_provider_41(client):
    """Settings endpoint returns the Archiver 5 default model label and excludes anthropic."""
    body = client.get("/api/settings").json()
    assert body["model"] == "Archiver 5.2 (in-browser)"
    assert body["providers"]["local"]["default_model"] == "Archiver 5.2 (in-browser)"
    assert "anthropic" not in body["providers"]


def test_docs_match_the_release():
    """Docs drift is the failure mode that keeps coming back: the README said
    4.3 and 1,515 cards while the app shipped 5.x with 1,526."""
    here = Path(__file__).resolve().parent.parent
    kb = (here / "web" / "archiver-knowledge.js").read_text(encoding="utf-8")
    changelog = (here / "CHANGELOG.md").read_text(encoding="utf-8")
    readme = (here / "README.md").read_text(encoding="utf-8")
    upgrade = (here / "docs" / "MODEL-UPGRADE.md").read_text(encoding="utf-8")

    assert "version: '5.2'" in kb
    # The 5.1 cards, checked by id so a dropped card fails here rather than
    # silently shrinking the corpus. The total itself is asserted in
    # tests/smoke.js, which loads the corpus rather than grepping it.
    for card_id in ("sop-overview", "sop-gandolfini", "sop-finale", "sop-cast", "sop-melfi",
                    "sop-theme", "sop-locations", "sop-many-saints", "sop-pine-barrens", "sop-legacy"):
        assert f"id: '{card_id}'" in kb, card_id
    assert "...SOPRANOS]" in kb, 'the new cards are in the shipped corpus'

    assert changelog.startswith("## 5.2 — 2026-09-29"), changelog[:40]
    assert "1,526" in changelog
    assert readme.startswith("# Archiver 5.2")
    assert "Archiver 5.2 — our own model" in readme
    assert "1,526 cards" in readme
    assert "Archiver 5.2" in upgrade
