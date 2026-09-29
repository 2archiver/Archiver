"""4.2 free-tier hardening: headers, rate limits, body caps, boot stamps,
memory dedup/contradiction/cap, SQLite shutdown, search provider cooldown.
No network: search providers are replaced with in-process fakes."""
import asyncio

import httpx
import pytest
from fastapi.testclient import TestClient

from app import hardening, main, search
from app.memory import MemoryStore


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DB_PATH", str(tmp_path / "test.db"))
    with TestClient(main.app) as c:
        c.get("/api/health")
        yield c




def test_security_and_isolation_headers_on_html_api_and_static(client):
    for path in ("/", "/api/health", "/static/archiver-engine.js", "/static/vendor/wllama-3.6.1.js"):
        r = client.get(path)
        assert r.status_code == 200, path
        assert r.headers["cross-origin-opener-policy"] == "same-origin"
        assert r.headers["cross-origin-embedder-policy"] == "require-corp"
        assert r.headers["cross-origin-resource-policy"] == "same-origin"
        assert r.headers["x-content-type-options"] == "nosniff"
        assert r.headers["referrer-policy"] == "strict-origin-when-cross-origin"
        assert "camera=()" in r.headers["permissions-policy"]
        csp = r.headers["content-security-policy-report-only"]
        assert "https://huggingface.co" in csp and "'wasm-unsafe-eval'" in csp
    # Vendor asset keeps its own immutable caching and a single CORP header.
    r = client.get("/static/vendor/wllama-3.6.1.js")
    assert "immutable" in r.headers["cache-control"]
    assert r.headers.get_list("cross-origin-resource-policy") == ["same-origin"]


def test_coep_and_csp_switches(monkeypatch):
    monkeypatch.setenv("ARCHIVER_COEP", "off")
    monkeypatch.setenv("ARCHIVER_CSP", "enforce")
    h = hardening.security_headers("/")
    assert "Cross-Origin-Embedder-Policy" not in h
    assert "Content-Security-Policy" in h
    monkeypatch.setenv("ARCHIVER_COEP", "credentialless")
    monkeypatch.setenv("ARCHIVER_CSP", "off")
    h = hardening.security_headers("/")
    assert h["Cross-Origin-Embedder-Policy"] == "credentialless"
    assert not any(k.startswith("Content-Security-Policy") for k in h)


def test_rate_limiter_bucket_math():
    rl = hardening.RateLimiter({"search": (2, 10.0)})
    assert rl.check("search", "1.2.3.4", now=0) == 0
    assert rl.check("search", "1.2.3.4", now=0) == 0
    wait = rl.check("search", "1.2.3.4", now=0)
    assert wait == pytest.approx(5.0)
    assert rl.check("search", "5.6.7.8", now=0) == 0  # per IP
    assert rl.check("search", "1.2.3.4", now=5.1) == 0  # refilled
    assert rl.check("unknown-bucket", "x") == 0


def test_rate_limiter_is_bounded():
    rl = hardening.RateLimiter({"search": (5, 60.0)}, max_keys=10)
    for i in range(100):
        rl.check("search", f"ip{i}", now=0)
    assert len(rl._buckets) == 10


def test_bucket_routing():
    assert hardening.bucket_for("GET", "/api/search") == "search"
    assert hardening.bucket_for("GET", "/api/search/diag") == "search"
    assert hardening.bucket_for("POST", "/api/sessions/sync") == "sync"
    assert hardening.bucket_for("GET", "/api/sessions") is None
    assert hardening.bucket_for("POST", "/api/archive/import") == "import"
    assert hardening.bucket_for("GET", "/api/health") is None


def test_client_key_prefers_forwarded_for():
    scope = {"headers": [(b"x-forwarded-for", b"9.9.9.9, 10.0.0.1")], "client": ("10.0.0.1", 1)}
    assert hardening.client_key(scope) == "9.9.9.9"
    assert hardening.client_key({"headers": [], "client": ("1.1.1.1", 1)}) == "1.1.1.1"


def test_search_is_rate_limited_per_ip(client, monkeypatch):
    async def fake_search(q, limit):
        return {"results": [], "confidence": "none"}

    monkeypatch.setattr(search, "search", fake_search)
    limiter = hardening.RateLimiter({"search": (3, 60.0)})
    stack = client.app.middleware_stack
    # Walk to our middleware instance and swap its limiter for a tiny one.
    node = stack
    while node is not None and not isinstance(node, hardening.HardeningMiddleware):
        node = getattr(node, "app", None)
    assert node is not None
    node.limiter = limiter
    codes = [client.get("/api/search", params={"q": "x"}).status_code for _ in range(5)]
    assert codes[:3] == [200, 200, 200]
    assert codes[3] == 429
    r = client.get("/api/search", params={"q": "x"})
    assert int(r.headers["retry-after"]) >= 1
    assert r.headers["cross-origin-opener-policy"] == "same-origin"


def test_request_body_cap(client):
    node = client.app.middleware_stack
    while not isinstance(node, hardening.HardeningMiddleware):
        node = node.app
    node.max_body = 1000
    node.limiter = hardening.RateLimiter({})
    r = client.post("/api/memories", json={"content": "x" * 5000})
    assert r.status_code == 413
    ok = client.post("/api/memories", json={"content": "I like tea"})
    assert ok.status_code == 201


def test_concurrency_cap_returns_503_but_health_still_answers():
    async def slow_app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    mw = hardening.HardeningMiddleware(slow_app, limiter=hardening.RateLimiter({}), max_body=10, max_inflight=0)
    sent = []

    async def send(m):
        sent.append(m)

    async def receive():
        return {"type": "http.request", "body": b""}

    asyncio.run(mw({"type": "http", "path": "/api/sessions", "method": "GET", "headers": []}, receive, send))
    assert sent[0]["status"] == 503
    sent.clear()
    asyncio.run(mw({"type": "http", "path": "/api/health", "method": "GET", "headers": []}, receive, send))
    assert sent[0]["status"] == 200


def test_health_reports_boot_and_db_stamps_and_ping(client):
    body = client.get("/api/health").json()
    assert body["version"] == "5.1"
    assert body["boot_id"] and body["db_created_at"] > 0 and body["ephemeral_disk"] is True
    # Stable across calls within one process.
    assert client.get("/api/health").json()["db_created_at"] == body["db_created_at"]
    r = client.get("/api/ping")
    assert r.status_code == 200 and r.text == "ok"


def test_memory_write_time_dedup(client):
    a = client.post("/api/memories", json={"content": "My cat is called Miso."}).json()
    b = client.post("/api/memories", json={"content": "my cat is called miso"}).json()
    assert b["deduplicated"] is True
    assert b["memory"]["id"] == a["memory"]["id"]
    assert len(client.get("/api/memories").json()) == 1


def test_memory_contradiction_supersedes(client):
    old = client.post("/api/memories", json={"content": "I prefer Python for backend services."}).json()
    new = client.post("/api/memories", json={"content": "I prefer Go for backend services now."}).json()
    assert new["superseded"] == old["memory"]["id"]
    current = [m["id"] for m in client.get("/api/memories").json()]
    assert old["memory"]["id"] not in current and new["memory"]["id"] in current


def test_memory_cap_evicts_unpinned_low_value(tmp_path):
    s = MemoryStore(tmp_path / "cap.db")
    pinned = s.add_memory("pinned fact alpha", pinned=True, user_id="u")
    low = s.add_memory("low value beta", importance="low", user_id="u")
    for i in range(3):
        s.add_memory(f"normal fact number {i} gamma{i}", user_id="u")
    removed = s.enforce_cap(3, user_id="u")
    assert removed == 2
    ids = {m["id"] for m in s.all_memories(include_superseded=True, user_id="u")}
    assert pinned["id"] in ids and low["id"] not in ids
    assert s.enforce_cap(0, user_id="u") == 0
    s.close()


def test_store_close_checkpoints_wal_and_is_idempotent(tmp_path):
    path = tmp_path / "wal.db"
    s = MemoryStore(path)
    s.add_memory("something to flush", user_id="u")
    stamp = s.created_at()
    assert stamp > 0 and s.created_at() == stamp
    s.close()
    s.close()
    wal = tmp_path / "wal.db-wal"
    assert not wal.exists() or wal.stat().st_size == 0
    reopened = MemoryStore(path)
    assert reopened.created_at() == stamp
    assert len(reopened.all_memories(user_id="u")) == 1
    reopened.close()


def test_provider_cooldown_skips_blocked_provider(monkeypatch):
    search._provider_down.clear()
    calls = {"blocked": 0, "good": 0}

    async def blocked(c, q, n):
        calls["blocked"] += 1
        req = httpx.Request("GET", "https://example.invalid")
        raise httpx.HTTPStatusError("403", request=req, response=httpx.Response(403, request=req))

    async def good(c, q, n):
        calls["good"] += 1
        return [{"title": "t", "url": "https://e/", "extract": "x"}]

    chain = [("blocked", blocked), ("good", good)]

    async def run():
        async with httpx.AsyncClient() as c:
            log1, log2 = {}, {}
            await search._try_chain(c, chain, "q", 2, log1)
            await search._try_chain(c, chain, "q", 2, log2)
            return log1, log2

    log1, log2 = asyncio.run(run())
    assert calls == {"blocked": 1, "good": 2}
    assert log1["blocked"].startswith("HTTPStatusError")
    assert log2["blocked"].startswith("skipped: cooling down after HTTP 403")
    assert "blocked" in search.provider_health()
    search._provider_down.clear()


def test_provider_timeout_is_per_provider(monkeypatch):
    search._provider_down.clear()
    monkeypatch.setattr(search, "PROVIDER_TIMEOUT", 0.05)

    async def slow(c, q, n):
        await asyncio.sleep(5)
        return []

    async def fast(c, q, n):
        return [{"title": "fast"}]

    async def run():
        async with httpx.AsyncClient() as c:
            log = {}
            got = await search._try_chain(c, [("slow", slow), ("fast", fast)], "q", 2, log)
            return got, log

    got, log = asyncio.run(run())
    assert got == [{"title": "fast"}]
    assert "TimeoutError" in log["slow"]
    assert search._cooling("slow")
    search._provider_down.clear()


def test_diagnostics_script_is_shipped_and_wired(client):
    r = client.get("/static/archiver-diag.js")
    assert r.status_code == 200
    assert "crossOriginIsolated" in r.text and "db_created_at" in r.text
    page = client.get("/").text
    assert "/static/archiver-diag.js" in page and 'id="openDiagnostics"' in page
