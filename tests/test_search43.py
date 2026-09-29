"""4.3 search resilience, gzip middleware and UI fixes. No network: providers
run against stub functions and fixture HTML, async code under plain asyncio."""
import asyncio

import httpx
import pytest
from fastapi.testclient import TestClient

from app import main
from app import search as search_mod
from app import take as take_mod


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DB_PATH", str(tmp_path / "test.db"))
    with TestClient(main.app) as c:
        c.get("/api/health")
        yield c


def test_bing_parser_handles_markup_variants():
    """Single quotes, extra classes and attributed snippet paragraphs parse."""
    html = ("<li class='b_algo b_crq'><h2><a href='https://example.com/x'>X Y</a></h2>"
            "<div class='b_caption'><p class='b_lineclamp2'>Snippet <b>here</b> now.</p></div></li>")
    results = search_mod._parse_bing_html(html, 3)
    assert len(results) == 1
    assert results[0]["title"] == "X Y"
    assert "Snippet here now" in results[0]["extract"]


def test_bing_parser_falls_back_to_bare_headings():
    """If Bing ever drops b_algo blocks, h2 > a headings still yield results."""
    html = ("<div id='b_content'><h2><a href=\"https://a.test/1\">First Result Title</a></h2>"
            "<p>First snippet text here.</p>"
            "<h2><a href=\"https://b.test/2\">Second Result Title</a></h2>"
            "<p>Second snippet text here.</p></div>")
    results = search_mod._parse_bing_html(html, 3)
    assert len(results) == 2
    assert results[0]["url"] == "https://a.test/1"
    assert "First snippet" in results[0]["extract"]


def test_ddg_html_parser_unwraps_redirector():
    html = ('<a rel="nofollow" class="result__a" '
            'href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FGaddafi&amp;rut=abc">'
            'Muammar <b>Gaddafi</b> - Wikipedia</a>'
            '<a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">'
            'Gaddafi was a Libyan revolutionary who ruled Libya from 1969 to 2011.</a>')
    results = search_mod._parse_ddg_html(html, 3)
    assert len(results) == 1
    assert results[0]["url"] == "https://en.wikipedia.org/wiki/Gaddafi"
    assert "1969 to 2011" in results[0]["extract"]


def test_single_word_query_scores_zero_without_overlap():
    """Proximity for a lone query word requires the word to actually occur.
    The old unconditional 1.0 let any stub clear MAYBE_AT for one-word
    queries, so junk gated as 'single' and fallbacks never fired."""
    junk = {"title": "Unrelated page about cooking",
            "extract": "recipes for pasta and soup"}
    assert search_mod.confidence("gaddafi", junk) == 0.0
    good = {"title": "Muammar Gaddafi",
            "extract": "Muammar Gaddafi ruled Libya from 1969 until 2011."}
    assert search_mod.confidence("gaddafi", good) >= search_mod.SURE_AT


def test_new_providers_are_in_the_chains_and_diag():
    names = [n for n, _ in search_mod.OTHER_CHAIN]
    assert "ddg-html" in names and "wiki-opensearch" in names
    diag_names = [n for n, _ in (search_mod.WIKI_CHAIN + search_mod.BING_CHAIN
                                 + search_mod.SE_CHAIN + search_mod.OTHER_CHAIN
                                 + search_mod.PROXY_CHAIN)]
    assert "ddg-html" in diag_names and "wiki-opensearch" in diag_names


def test_bing_retries_with_browser_ua_after_block(monkeypatch):
    """A 403 on the plain UA gets one retry behind a browser UA."""
    calls = []

    async def fake_fetch(client, url, params=None, headers=None, **kwargs):
        calls.append(dict(headers or {}))
        if len(calls) == 1:
            raise httpx.HTTPStatusError(
                "403", request=httpx.Request("GET", url),
                response=httpx.Response(403))
        class R:
            status_code = 200
            text = ('<li class="b_algo"><h2><a href="https://example.com/x">Example</a></h2>'
                    '<p>An example snippet about the topic.</p></li>')
            def raise_for_status(self): pass
        return R()

    monkeypatch.setattr(take_mod, "fetch", fake_fetch)
    results = asyncio.run(search_mod.p_bing(httpx.AsyncClient(), "example", 3))
    assert len(results) == 1 and results[0]["title"] == "Example"
    assert len(calls) == 2
    assert calls[1].get("User-Agent") == search_mod.BROWSER_UA


def test_secondary_round_rescues_query_when_primary_fails_gate(monkeypatch):
    """Two junk primary hits used to end the query at 'none' without ever
    asking the secondary legs. The second-chance round asks them."""
    search_mod._provider_down.clear()

    async def junk(client, q, n):
        return [{"title": "Unrelated page about cooking",
                 "extract": "recipes for pasta and soup",
                 "url": "https://example.com/cook", "source": "Wikipedia", "rank": 0}]

    async def good(client, q, n):
        return [{"title": "Muammar Gaddafi",
                 "extract": ("Muammar Gaddafi ruled Libya from 1969 until 2011 "
                             "when rebels killed him in Sirte, Libya."),
                 "url": "https://example.com/gaddafi", "source": "DuckDuckGo", "rank": 0}]

    async def no_suggest(q):
        return None

    monkeypatch.setattr(search_mod, "WIKI_CHAIN", [("wikipedia-action", junk)])
    monkeypatch.setattr(search_mod, "BING_CHAIN", [("bing", junk)])
    monkeypatch.setattr(search_mod, "OTHER_CHAIN", [("ddg-html", good)])
    monkeypatch.setattr(search_mod, "PROXY_CHAIN", [])
    monkeypatch.setattr(search_mod, "suggest", no_suggest)
    out = asyncio.run(search_mod.search("gaddafi"))
    assert out["confidence"] != "none", out["providers"]
    assert out["results"] and out["results"][0]["url"] == "https://example.com/gaddafi"
    assert out["providers"].get("ddg-html", "").startswith("ok")


def test_secondary_round_dedupes_urls(monkeypatch):
    search_mod._provider_down.clear()

    async def dupes(client, q, n):
        return [
            {"title": "Seen", "extract": "already seen", "url": "https://example.com/seen",
             "source": "DuckDuckGo", "rank": 0},
            {"title": "New", "extract": "brand new", "url": "https://example.com/new",
             "source": "DuckDuckGo", "rank": 1},
        ]

    monkeypatch.setattr(search_mod, "OTHER_CHAIN", [("ddg-html", dupes)])
    monkeypatch.setattr(search_mod, "PROXY_CHAIN", [])
    log: dict = {}
    extra = asyncio.run(search_mod._gather_secondary(
        "q", httpx.AsyncClient(), log, {"https://example.com/seen"}))
    assert [r["url"] for r in extra] == ["https://example.com/new"]
    assert extra[0]["_chain"] == "other"


def test_app_shell_is_gzipped_but_vendor_and_streams_are_untouched(client):
    gz = client.get("/", headers={"Accept-Encoding": "gzip"})
    assert gz.status_code == 200
    assert gz.headers.get("content-encoding") == "gzip"
    assert "Archiver 5" in gz.text
    # Explicit refusal is respected.
    plain = client.get("/", headers={"Accept-Encoding": "gzip;q=0"})
    assert plain.headers.get("content-encoding") != "gzip"
    assert "Archiver 5.3" in plain.text
    # The vendor routes keep their own single Vary header.
    vendor = client.get("/static/vendor/wllama-3.6.1.js", headers={"Accept-Encoding": "gzip"})
    assert vendor.headers["vary"] == "Accept-Encoding"


def test_shell_carries_oled_theme_and_fixed_styles(client):
    page = client.get("/").text
    assert 'data-theme="oled"' in page
    assert '<option value="oled">OLED — true black</option>' in page
    for cls in (".cursor-blink", ".mem-card", ".cl-entry",
                ".toast.err", ".dot.on", ".recall-item", ".think-live"):
        assert cls in page, cls
    # 5.1: one loading indicator. The bubble's bouncing dots are gone; the
    # status line that names the step actually running is the only one.
    assert ".typing-dots" not in page
    assert 'defer></script>' in page or 'defer>' in page
