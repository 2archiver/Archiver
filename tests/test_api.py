"""API regression tests. Run: python -m pytest tests/ -q

Each test gets a fresh SQLite bank. Two TestClients with separate cookie jars
stand in for two different browsers, which is what the per-user isolation is
supposed to separate.
"""

from __future__ import annotations

import importlib

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def main(tmp_path, monkeypatch):
    monkeypatch.setenv("ARCHIVER_DB", str(tmp_path / "test.db"))
    import app.main as m
    m = importlib.reload(m)
    return m


@pytest.fixture()
def pair(main):
    with TestClient(main.app) as a, TestClient(main.app) as b:
        a.get("/api/health")
        b.get("/api/health")
        assert a.cookies.get("archiver_uid") != b.cookies.get("archiver_uid")
        yield a, b


def turn(client, text, sid=None, answer="Noted."):
    prep = client.post("/api/chat/prepare", json={"session_id": sid, "message": text}).json()
    commit = client.post("/api/chat/commit", json={
        "session_id": prep["session_id"], "message": text, "answer": answer,
        "memory_ids": [m["id"] for m in prep["memories"]],
    })
    assert commit.status_code == 200, commit.text
    return prep, commit.json()


def test_learned_memories_stay_in_their_own_bank(pair):
    a, b = pair
    _, commit = turn(a, "I prefer Rust for backend services")
    assert commit["memories_saved"], "the heuristic extractor should have kept that"
    assert any("Rust" in m["content"] for m in a.get("/api/memories").json())
    # 2.6.1 saved extracted memories with no owner and recalled across banks.
    assert b.get("/api/memories").json() == []
    prep_b = b.post("/api/chat/prepare", json={"message": "what backend language should I use"}).json()
    assert all("Rust" not in m["content"] for m in prep_b["memories"])
    prep_a = a.post("/api/chat/prepare", json={"message": "what backend language should I use"}).json()
    assert any("Rust" in m["content"] for m in prep_a["memories"])


def test_assistant_turns_are_owned_and_visible(pair):
    a, b = pair
    prep, _ = turn(a, "hello there", answer="Hi.")
    sess = a.get(f"/api/sessions/{prep['session_id']}").json()
    assert [m["role"] for m in sess["messages"]] == ["user", "assistant"]
    assert b.get(f"/api/sessions/{prep['session_id']}").status_code == 404
    assert b.get("/api/stats").json()["messages"] == 0


def test_rename_session_works_and_is_scoped(pair):
    a, b = pair
    prep, _ = turn(a, "first message")
    sid = prep["session_id"]
    r = a.patch(f"/api/sessions/{sid}", json={"title": "Renamed"})
    assert r.status_code == 200 and r.json()["title"] == "Renamed"  # was a NameError
    assert b.patch(f"/api/sessions/{sid}", json={"title": "Hijack"}).status_code == 404


def test_delete_session_is_scoped(pair):
    a, b = pair
    prep, _ = turn(a, "keep this")
    sid = prep["session_id"]
    assert b.delete(f"/api/sessions/{sid}").status_code == 404
    assert a.get(f"/api/sessions/{sid}").status_code == 200
    assert a.delete(f"/api/sessions/{sid}").status_code == 200
    assert a.get(f"/api/sessions/{sid}").status_code == 404


def test_editing_a_memory_keeps_it_in_the_bank(pair):
    a, b = pair
    mem = a.post("/api/memories", json={"content": "My dog is called Rex"}).json()["memory"]
    r = a.patch(f"/api/memories/{mem['id']}", json={"content": "My dog is called Max"})
    assert r.status_code == 200 and r.json()["content"] == "My dog is called Max"
    listed = a.get("/api/memories").json()
    assert [m["content"] for m in listed] == ["My dog is called Max"]
    assert b.patch(f"/api/memories/{mem['id']}", json={"content": "x"}).status_code == 404
    assert b.delete(f"/api/memories/{mem['id']}").status_code == 404


def test_session_ids_cannot_be_borrowed(pair):
    a, b = pair
    prep, _ = turn(a, "private thing", sid="s_shared")
    prep_b = b.post("/api/chat/prepare", json={"session_id": "s_shared", "message": "hi"}).json()
    assert prep_b["session_id"] != "s_shared"
    assert all(m["content"] != "private thing" for m in prep_b["history"])


def test_sync_normalises_client_roles(pair):
    a, _ = pair
    a.post("/api/sessions/sync", json={"sessions": [{
        "id": "s_local1", "title": "From the browser",
        "messages": [{"role": "user", "content": "q"}, {"role": "archiver", "content": "a"},
                     {"role": "weird", "content": "dropped"}],
    }]})
    msgs = a.get("/api/sessions/s_local1").json()["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant"]
    # ...and the model's own answer is now part of the history it is sent.
    prep = a.post("/api/chat/prepare", json={"session_id": "s_local1", "message": "and?"}).json()
    assert [m["role"] for m in prep["history"]] == ["user", "assistant"]


def test_settings_are_validated_and_defaults_sane(pair, main):
    a, _ = pair
    s = a.get("/api/settings").json()
    assert s["max_memories"] == "8"
    assert "Grok" not in s["persona"] and "Additional Thoughts" not in s["persona"]
    r = a.put("/api/settings", json={"max_memories": "500", "min_relevance": "7", "persona": "  "})
    assert r.status_code == 200
    s = r.json()
    assert s["max_memories"] == "40" and s["min_relevance"] == "1.0"
    assert s["persona"] == main.PERSONA
    assert a.put("/api/settings", json={"half_life_days": "soon"}).status_code == 400


def test_grok_persona_and_500_memories_are_migrated(main, tmp_path):
    store = main.MemoryStore(str(tmp_path / "old.db"))
    store.set_setting("persona", main._PERSONA_2_6_1, user_id="u_old")
    store.set_setting("max_memories", "500", user_id="u_old")
    store.set_setting("model", "Archiver 2.5 (in-browser)", user_id="u_old")
    changed = main.apply_defaults(store, user_id="u_old")
    assert changed["persona_upgraded"]
    assert store.get_setting("persona", user_id="u_old") == main.PERSONA
    assert store.get_setting("max_memories", user_id="u_old") == "8"
    assert store.get_setting("model", user_id="u_old") == main.MODEL_LABEL
    # A persona the owner wrote is theirs and is never touched.
    store.set_setting("persona", "Be terse.", user_id="u_old")
    main.apply_defaults(store, user_id="u_old")
    assert store.get_setting("persona", user_id="u_old") == "Be terse."
    store.close()


def test_keyword_fallback_without_matches_does_not_crash(main, tmp_path):
    store = main.MemoryStore(str(tmp_path / "nofts.db"))
    store.fts = False  # force the LIKE path, which crashed on zero hits
    store.add_memory("I like tea", user_id="u1")
    assert store.search("zzzz qqqq", user_id="u1") == []
    store.close()


def test_static_assets_are_served(main):
    with TestClient(main.app) as c:
        assert c.get("/manifest.json").status_code == 200
        assert c.get("/apple-touch-icon.png").status_code == 200
        assert c.get("/static/archiver-engine.js").status_code == 200


def test_search_brief_has_no_canned_thoughts():
    from app import search
    results = [
        {"title": "Battle of Kursk", "extract": "The Battle of Kursk was fought in 1943. It was a major tank battle.",
         "url": "u", "source": "Wikipedia"},
        {"title": "Operation Citadel", "extract": "Operation Citadel began in July 1943 near Kursk.",
         "url": "u2", "source": "Wikipedia"},
    ]
    interp = search.interpret_question("battle of kursk")
    report = search.brief("battle of kursk", results, "high", False, interp)
    assert "Additional Thoughts" not in report["voice"]
    assert "warehouse" not in report["voice"]
    assert "additional_thoughts" not in report


def test_auto_distill_setting_actually_distils(pair):
    a, _ = pair
    assert a.put("/api/settings", json={"distill_after": "4", "auto_distill": "1"}).status_code == 200
    prep, _ = turn(a, "I am planning a trip to Kyoto in April")
    sid = prep["session_id"]
    _, commit = turn(a, "I want to see the temples and the gardens", sid)
    # 2.6.1 had the toggle but never acted on it.
    assert commit["distilled"] and commit["distilled"]["summary"]
    msgs = a.get(f"/api/sessions/{sid}").json()["messages"]
    assert any(m["role"] == "system" for m in msgs)

    a.put("/api/settings", json={"auto_distill": "0"})
    prep2, _ = turn(a, "hello again")
    _, c2 = turn(a, "and again", prep2["session_id"])
    _, c3 = turn(a, "one more", prep2["session_id"])
    assert not c3["distilled"]


def test_export_filename_is_safe(pair):
    a, _ = pair
    prep, _ = turn(a, "export me")
    r = a.get(f"/api/sessions/{prep['session_id']}/export")
    assert r.status_code == 200
    cd = r.headers["content-disposition"]
    assert cd.startswith('attachment; filename="archiver-') and cd.count('"') == 2
