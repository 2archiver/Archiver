"""3.1 browser-chat sync regression tests; no external requests or model calls."""
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
    assert client.get("/api/health").json()["version"] == "3.1"
    for asset in ("archiver-comprehension.js", "archiver-engine.js", "archiver-worker.js"):
        assert client.get("/static/" + asset).status_code == 200
    page = client.get("/").text
    assert 'maximum-scale=1' not in page
    assert 'id="autoAI"' not in page
    assert 'id="retryModel"' in page
    assert 'Browser generation is always enabled' in page


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
    assert store.get_setting("model", user_id=uid) == "Archiver 3.1 (in-browser)"
    assert store.get_setting("persona", user_id=uid) == "My custom persona"
    store.set_setting("persona", main.RETIRED_PERSONAS[0], uid)
    main.apply_defaults(store, uid)
    assert store.get_setting("persona", user_id=uid) == main.PERSONA


def test_restore_defaults_replaces_custom_settings(client):
    client.put("/api/settings", json={"persona": "Custom", "auto_extract": "0", "api_key": "legacy-secret"})
    restored = client.post("/api/settings/restore")
    assert restored.status_code == 200
    body = restored.json()
    assert body["persona"] == main.PERSONA
    assert body["auto_extract"] == "1"
    assert body["has_api_key"] is False
    assert "api_key" not in main.app.state.store.settings(secret=True, user_id=client.cookies.get(main.COOKIE_NAME))


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
