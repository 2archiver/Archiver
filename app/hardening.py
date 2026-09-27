"""Free-tier hardening: security headers, rate limits, body caps, concurrency.

Everything here is in-memory and standard library only. It is written for a
single Render free instance (~512 MB RAM, 0.1 vCPU, one process): state lives
in small bounded dicts and disappears on restart, which is exactly what a
spin-down does anyway.

Environment switches (all optional):

    ARCHIVER_COEP        require-corp (default) | credentialless | off
    ARCHIVER_CSP         report-only (default)  | enforce       | off
    ARCHIVER_MAX_BODY    request body cap in bytes (default 2 MiB)
    ARCHIVER_MAX_INFLIGHT concurrent requests before 503 (default 24)
    ARCHIVER_RATE        "search=30/60,sync=60/60,import=5/60" style overrides
"""

from __future__ import annotations

import os
import time
from collections import OrderedDict

# Where model bytes may legitimately come from. WebLLM fetches MLC weights from
# Hugging Face and its compiled model libraries from GitHub raw; wllama fetches
# GGUF files from Hugging Face, which redirects to its LFS/Xet CDNs.
MODEL_HOSTS = (
    "https://huggingface.co",
    "https://*.huggingface.co",
    "https://*.hf.co",
    "https://raw.githubusercontent.com",
)


def content_security_policy() -> str:
    # 'unsafe-inline' is required because index.html ships its app script and
    # styles inline (no build step). 'wasm-unsafe-eval' lets WebAssembly
    # compile without allowing JavaScript eval.
    return "; ".join(
        (
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:",
            "worker-src 'self' blob:",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "font-src 'self' data:",
            "connect-src 'self' blob: data: " + " ".join(MODEL_HOSTS),
            "object-src 'none'",
            "base-uri 'self'",
            "frame-ancestors 'self'",
            "form-action 'self'",
        )
    )


PERMISSIONS_POLICY = (
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), "
    "interest-cohort=(), browsing-topics=()"
)


def security_headers(path: str) -> dict[str, str]:
    """Headers added to every response the app serves."""
    headers = {
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "Permissions-Policy": PERMISSIONS_POLICY,
        # Everything this origin serves is for this origin. Required so our
        # own assets load under COEP: require-corp.
        "Cross-Origin-Resource-Policy": "same-origin",
    }
    coep = os.environ.get("ARCHIVER_COEP", "require-corp").strip().lower()
    if coep in ("require-corp", "credentialless"):
        # COOP + COEP make the page crossOriginIsolated, which is what unlocks
        # SharedArrayBuffer (multithreaded wllama) in Chrome, Edge, Firefox and
        # Safari. Safari does not implement `credentialless`, so require-corp is
        # the default; cross-origin model fetches are CORS requests and pass.
        headers["Cross-Origin-Opener-Policy"] = "same-origin"
        headers["Cross-Origin-Embedder-Policy"] = coep
    csp = os.environ.get("ARCHIVER_CSP", "report-only").strip().lower()
    if csp == "enforce":
        headers["Content-Security-Policy"] = content_security_policy()
    elif csp != "off":
        headers["Content-Security-Policy-Report-Only"] = content_security_policy()
    return headers


# --------------------------------------------------------------------------- #
# rate limiting
# --------------------------------------------------------------------------- #

DEFAULT_RATES = {"search": (30, 60.0), "sync": (60, 60.0), "import": (5, 60.0)}


def _parse_rates(spec: str) -> dict[str, tuple[int, float]]:
    rates = dict(DEFAULT_RATES)
    for part in (spec or "").split(","):
        name, _, value = part.strip().partition("=")
        count, _, window = value.partition("/")
        try:
            rates[name.strip()] = (int(count), float(window or 60))
        except ValueError:
            continue
    return rates


class RateLimiter:
    """Sliding-window-ish token bucket per (bucket, client key).

    Bounded to `max_keys` entries with LRU eviction, so a flood of distinct
    IPs cannot grow memory without limit.
    """

    def __init__(self, rates: dict[str, tuple[int, float]] | None = None, max_keys: int = 4096):
        self.rates = rates if rates is not None else _parse_rates(os.environ.get("ARCHIVER_RATE", ""))
        self.max_keys = max_keys
        self._buckets: OrderedDict[tuple[str, str], tuple[float, float]] = OrderedDict()

    def check(self, bucket: str, key: str, now: float | None = None) -> float:
        """Consume one token. Returns 0 when allowed, else seconds to wait."""
        if bucket not in self.rates:
            return 0.0
        capacity, window = self.rates[bucket]
        if capacity <= 0:
            return 0.0
        t = time.monotonic() if now is None else now
        refill = capacity / window
        tokens, last = self._buckets.get((bucket, key), (float(capacity), t))
        tokens = min(float(capacity), tokens + (t - last) * refill)
        if tokens < 1.0:
            self._buckets[(bucket, key)] = (tokens, t)
            self._buckets.move_to_end((bucket, key))
            return (1.0 - tokens) / refill
        self._buckets[(bucket, key)] = (tokens - 1.0, t)
        self._buckets.move_to_end((bucket, key))
        while len(self._buckets) > self.max_keys:
            self._buckets.popitem(last=False)
        return 0.0

    def reset(self) -> None:
        self._buckets.clear()


def bucket_for(method: str, path: str) -> str | None:
    if path.startswith("/api/search"):
        return "search"
    if path == "/api/archive/import":
        return "import"
    if method != "GET" and (path.startswith("/api/sessions") or path.startswith("/api/memories")
                            or path.startswith("/api/chat")):
        return "sync"
    return None


def client_key(scope: dict) -> str:
    """Client IP. Render terminates TLS at a proxy and sets X-Forwarded-For;
    the first hop is the visitor. Falls back to the socket peer."""
    for name, value in scope.get("headers") or []:
        if name == b"x-forwarded-for":
            first = value.decode("latin-1").split(",")[0].strip()
            if first:
                return first
    client = scope.get("client")
    return client[0] if client else "unknown"


# --------------------------------------------------------------------------- #
# ASGI middleware
# --------------------------------------------------------------------------- #


async def _send_json(send, status: int, body: bytes, extra: list[tuple[bytes, bytes]] | None = None) -> None:
    headers = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]
    headers += extra or []
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body})


class HardeningMiddleware:
    """Pure ASGI (not BaseHTTPMiddleware) so streaming SSE responses are not
    buffered and the per-request overhead stays tiny."""

    def __init__(self, app, limiter: RateLimiter | None = None,
                 max_body: int | None = None, max_inflight: int | None = None):
        self.app = app
        self.limiter = limiter or RateLimiter()
        self.max_body = max_body if max_body is not None else int(os.environ.get("ARCHIVER_MAX_BODY", 2 * 1024 * 1024))
        self.max_inflight = max_inflight if max_inflight is not None else int(os.environ.get("ARCHIVER_MAX_INFLIGHT", 24))
        self.inflight = 0

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path = scope.get("path", "")
        method = scope.get("method", "GET")
        extra = [(k.lower().encode(), v.encode()) for k, v in security_headers(path).items()]

        # Health must always answer, even under load: it is the deploy check.
        exempt = path in ("/api/health", "/api/ping")
        if not exempt and self.inflight >= self.max_inflight:
            return await _send_json(send, 503, b'{"detail":"server busy, retry shortly"}',
                                    extra + [(b"retry-after", b"2")])

        bucket = bucket_for(method, path)
        if bucket:
            wait = self.limiter.check(bucket, client_key(scope))
            if wait > 0:
                return await _send_json(send, 429, b'{"detail":"rate limited"}',
                                        extra + [(b"retry-after", str(max(1, int(wait + 0.999))).encode())])

        declared = None
        for name, value in scope.get("headers") or []:
            if name == b"content-length":
                try:
                    declared = int(value)
                except ValueError:
                    declared = None
        if declared is not None and declared > self.max_body:
            return await _send_json(send, 413, b'{"detail":"request body too large"}', extra)

        received = 0

        async def limited_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_body:
                    raise _BodyTooLarge()
            return message

        started = False

        async def send_with_headers(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
                present = {k.lower() for k, _ in message.get("headers", [])}
                message = dict(message)
                message["headers"] = list(message.get("headers", [])) + [
                    (k, v) for k, v in extra if k not in present
                ]
            await send(message)

        self.inflight += 1
        try:
            await self.app(scope, limited_receive, send_with_headers)
        except _BodyTooLarge:
            if not started:
                await _send_json(send, 413, b'{"detail":"request body too large"}', extra)
        finally:
            self.inflight -= 1


class _BodyTooLarge(Exception):
    pass
