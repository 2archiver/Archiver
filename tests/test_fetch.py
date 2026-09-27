"""4.0: the guards around the only place the service spends metered bandwidth.

Render's free tier throttles past a shared monthly egress allowance, and every
search query spends it on server-originated fetches. These tests pin the five
defences in `app/take.py`: a byte ceiling that aborts oversized bodies, a
content-type gate that refuses non-text before the body is read, an in-process
TTL cache, gzip on every outbound request (stored decompressed), and a
concurrency cap. No network and no new framework: every fetch runs against an
in-process recording transport, and async code runs under plain asyncio.
"""
import asyncio
import gzip

import httpx
import pytest

from app import take


class CountingStream(httpx.AsyncByteStream):
    """A body that reports how much of it was actually pulled."""

    def __init__(self, chunks):
        self.chunks = list(chunks)
        self.served = 0

    async def __aiter__(self):
        for chunk in self.chunks:
            self.served += len(chunk)
            yield chunk

    async def aclose(self):
        pass


class ExplodingStream(httpx.AsyncByteStream):
    """A body that fails the test the moment anything reads it."""

    async def __aiter__(self):
        raise AssertionError("the body was read; the content-type gate must refuse first")
        yield b""  # pragma: no cover

    async def aclose(self):
        pass


class RecordingTransport(httpx.AsyncBaseTransport):
    def __init__(self, responder):
        self.responder = responder
        self.requests = []

    async def handle_async_request(self, request):
        self.requests.append(request)
        return await self.responder(request)


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def clean_cache():
    take.cache_clear()
    yield
    take.cache_clear()


def test_byte_ceiling_aborts_an_oversized_body():
    """One unbounded PDF or media file must not eat a slice of the allowance."""
    chunk = b"x" * (256 * 1024)
    total = 8 * 1024 * 1024
    stream = CountingStream([chunk] * (total // len(chunk)))

    async def responder(request):
        return httpx.Response(200, headers={"content-type": "text/plain"}, stream=stream)

    transport = RecordingTransport(responder)

    async def scenario():
        async with httpx.AsyncClient(transport=transport) as client:
            with pytest.raises(take.BodyTooLarge):
                await take.fetch(client, "https://example.test/huge.pdf")
        # Aborted means aborted: the remaining megabytes never crossed the wire.
        assert stream.served < total
        assert stream.served <= take.MAX_BODY_BYTES + len(chunk)

    run(scenario())


def test_non_text_content_type_is_rejected_before_the_body_is_read():
    async def responder(request):
        return httpx.Response(200, headers={"content-type": "application/pdf"},
                              stream=ExplodingStream())

    transport = RecordingTransport(responder)

    async def scenario():
        async with httpx.AsyncClient(transport=transport) as client:
            with pytest.raises(take.NonTextContent):
                await take.fetch(client, "https://example.test/paper.pdf", head_first=False)

    run(scenario())
    assert transport.requests and transport.requests[0].method == "GET"


def test_head_probe_refuses_non_text_without_a_get():
    """take.py only ever needs text: a HEAD gate can refuse before any GET body."""
    async def responder(request):
        return httpx.Response(200, headers={"content-type": "application/pdf"},
                              stream=ExplodingStream())

    transport = RecordingTransport(responder)

    async def scenario():
        async with httpx.AsyncClient(transport=transport) as client:
            with pytest.raises(take.NonTextContent):
                await take.fetch_text(client, "https://example.test/paper.pdf")

    run(scenario())
    assert [r.method for r in transport.requests] == ["HEAD"]


def test_cache_hit_within_ttl_and_miss_after_expiry(monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(take, "_now", lambda: clock[0])
    calls = []

    async def responder(request):
        calls.append(str(request.url))
        return httpx.Response(200, headers={"content-type": "application/json"},
                              content=b'{"ok": true}')

    transport = RecordingTransport(responder)

    async def scenario():
        async with httpx.AsyncClient(transport=transport) as client:
            first = await take.fetch(client, "https://example.test/api?b=2&a=1")
            clock[0] += take.CACHE_TTL - 1
            # Same target, different spelling: the normalised key collapses them.
            second = await take.fetch(client, "https://example.test/api?a=1&b=2")
            assert first.json() == second.json() == {"ok": True}
            assert len(calls) == 1, "the repeat fetch must be served from the TTL cache"
            clock[0] = 1000.0 + take.CACHE_TTL + 1
            third = await take.fetch(client, "https://example.test/api?a=1&b=2")
            assert third.json() == {"ok": True}
            assert len(calls) == 2, "past the TTL the cache must not answer"

    run(scenario())


def test_cache_is_bounded_by_entry_count(monkeypatch):
    monkeypatch.setattr(take, "_now", lambda: 1000.0)

    async def responder(request):
        return httpx.Response(200, headers={"content-type": "text/plain"}, content=b"ok")

    transport = RecordingTransport(responder)

    async def scenario():
        async with httpx.AsyncClient(transport=transport) as client:
            for i in range(take.CACHE_MAX_ENTRIES * 2):
                await take.fetch(client, f"https://example.test/q?i={i}")
        assert take.cache_stats()["entries"] <= take.CACHE_MAX_ENTRIES

    run(scenario())


def test_gzip_is_requested_and_only_decompressed_bytes_are_kept():
    payload = gzip.compress(b"plain text body")
    stream = CountingStream([payload])

    async def responder(request):
        assert request.headers.get("accept-encoding") == "gzip", \
            "every outbound request must offer gzip"
        return httpx.Response(200, headers={"content-type": "text/plain",
                                            "content-encoding": "gzip"},
                              stream=stream)

    transport = RecordingTransport(responder)

    async def scenario():
        async with httpx.AsyncClient(transport=transport) as client:
            text = await take.fetch_text(client, "https://example.test/page", head_first=False)
            assert text == "plain text body"
            # The cache counts decoded bytes: compressed transport form is dropped.
            assert take.cache_stats()["bytes"] == len(b"plain text body")

    run(scenario())


def test_outbound_fetches_are_capped_at_the_semaphore_limit():
    in_flight = 0
    peak = 0

    async def responder(request):
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        await asyncio.sleep(0.01)
        in_flight -= 1
        return httpx.Response(200, headers={"content-type": "text/plain"}, content=b"ok")

    transport = RecordingTransport(responder)

    async def scenario():
        async with httpx.AsyncClient(transport=transport) as client:
            await asyncio.gather(*(
                take.fetch(client, f"https://example.test/q?i={i}", head_first=False)
                for i in range(8)
            ))
        # One query fanning out must not saturate the shared CPU.
        assert peak == take.MAX_CONCURRENT_FETCHES

    run(scenario())
