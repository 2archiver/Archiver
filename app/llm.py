"""LLM providers for Archiver.

Supported:
  * openai  — any OpenAI-compatible /v1/chat/completions endpoint
              (OpenAI, OpenRouter, Groq, Together, Ollama, LM Studio…)
  * anthropic — /v1/messages
  * mock    — offline echo provider used for tests and for demoing the
              memory pipeline without an API key.

Streaming is exposed as an async generator of text deltas.
"""

from __future__ import annotations

import asyncio
import json
import re
from typing import AsyncIterator

import httpx

DEFAULT_MODELS = {
    "openai": "gpt-4o-mini",
    "anthropic": "claude-3-5-haiku-latest",
    "mock": "archiver-mock-1",
}

DEFAULT_BASE_URLS = {
    "openai": "https://api.openai.com/v1",
    "anthropic": "https://api.anthropic.com/v1",
    "mock": "local",
}

ANTHROPIC_VERSION = "2023-06-01"
TIMEOUT = httpx.Timeout(180.0, connect=15.0)


class ProviderError(RuntimeError):
    pass


async def stream_completion(
    *,
    provider: str,
    model: str,
    system: str,
    messages: list[dict],
    api_key: str = "",
    base_url: str = "",
    temperature: float = 0.7,
    max_tokens: int = 1024,
) -> AsyncIterator[str]:
    provider = (provider or "mock").lower()
    if provider == "anthropic":
        async for chunk in _anthropic(
            model, system, messages, api_key, base_url, temperature, max_tokens
        ):
            yield chunk
    elif provider == "openai":
        async for chunk in _openai(
            model, system, messages, api_key, base_url, temperature, max_tokens
        ):
            yield chunk
    else:
        async for chunk in _mock(system, messages, max_tokens):
            yield chunk


async def complete(
    *, provider: str, model: str, system: str, messages: list[dict],
    api_key: str = "", base_url: str = "", temperature: float = 0.2,
    max_tokens: int = 900,
) -> str:
    parts: list[str] = []
    async for delta in stream_completion(
        provider=provider, model=model, system=system, messages=messages,
        api_key=api_key, base_url=base_url, temperature=temperature,
        max_tokens=max_tokens,
    ):
        parts.append(delta)
    return "".join(parts)


# --------------------------------------------------------------------------- #


def _base(provider: str, base_url: str) -> str:
    return (base_url or DEFAULT_BASE_URLS.get(provider, "")).rstrip("/")


async def _openai(
    model: str, system: str, messages: list[dict], api_key: str,
    base_url: str, temperature: float, max_tokens: int,
) -> AsyncIterator[str]:
    payload = {
        "model": model or DEFAULT_MODELS["openai"],
        "messages": [{"role": "system", "content": system}]
        + [{"role": m["role"], "content": m["content"]} for m in messages],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": True,
    }
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    url = f"{_base('openai', base_url)}/chat/completions"
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        try:
            async with client.stream("POST", url, json=payload, headers=headers) as r:
                if r.status_code >= 400:
                    raise ProviderError(
                        f"OpenAI-compatible endpoint returned {r.status_code}: "
                        f"{(await r.aread()).decode('utf-8', 'replace')[:400]}"
                    )
                async for line in r.aiter_lines():
                    line = line.strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        obj = json.loads(data)
                    except ValueError:
                        continue
                    choices = obj.get("choices") or []
                    if choices:
                        delta = choices[0].get("delta", {}).get("content")
                        if delta:
                            yield delta
        except httpx.HTTPError as exc:  # pragma: no cover - network path
            raise ProviderError(f"request failed: {exc}") from exc


async def _anthropic(
    model: str, system: str, messages: list[dict], api_key: str,
    base_url: str, temperature: float, max_tokens: int,
) -> AsyncIterator[str]:
    payload = {
        "model": model or DEFAULT_MODELS["anthropic"],
        "system": system,
        "messages": [
            {"role": m["role"], "content": m["content"]}
            for m in messages
            if m["role"] in ("user", "assistant")
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": True,
    }
    headers = {
        "Content-Type": "application/json",
        "x-api-key": api_key,
        "anthropic-version": ANTHROPIC_VERSION,
    }
    url = f"{_base('anthropic', base_url)}/messages"
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        try:
            async with client.stream("POST", url, json=payload, headers=headers) as r:
                if r.status_code >= 400:
                    raise ProviderError(
                        f"Anthropic returned {r.status_code}: "
                        f"{(await r.aread()).decode('utf-8', 'replace')[:400]}"
                    )
                async for line in r.aiter_lines():
                    line = line.strip()
                    if not line.startswith("data:"):
                        continue
                    try:
                        obj = json.loads(line[5:].strip())
                    except ValueError:
                        continue
                    if obj.get("type") == "content_block_delta":
                        text = obj.get("delta", {}).get("text")
                        if text:
                            yield text
        except httpx.HTTPError as exc:  # pragma: no cover - network path
            raise ProviderError(f"request failed: {exc}") from exc


async def _mock(
    system: str, messages: list[dict], max_tokens: int
) -> AsyncIterator[str]:
    """Offline provider — and a live demonstration of the memory pipeline.

    It has no model behind it, so instead of pretending it reads the memories that
    were actually injected into the prompt and answers from them: direct answer
    first, receipts after, no hedging. Enough to prove retrieval, injection and
    recall work before you spend a single API key.
    """
    import asyncio

    last_user = next(
        (m["content"] for m in reversed(messages) if m["role"] == "user"), ""
    )
    recalled = re.findall(
        r"^- \[([a-z]+)\] (.+?)(?: \| .*)?$",
        system.split("## What you know about them")[-1].split("##")[0],
        re.M,
    )
    preferences = [t for k, t in recalled if k == "preference"]
    facts = [t for k, t in recalled if k != "preference"]

    lines = [
        "**Short answer:** ",
    ]
    if preferences:
        lines[0] += (
            f"go with what you already told me you prefer — {preferences[0].lower()}. "
            "You picked it for a reason, and nothing in this question changes that reason."
        )
    elif recalled:
        lines[0] += (
            "I do not have a preference on record for this, so here is the blunt "
            "default: pick the boring option that ships this week, not the interesting "
            "one that ships next quarter."
        )
    else:
        lines[0] += (
            "I have nothing on you yet, so I would be guessing — and guessing dressed "
            "up as confidence is the worst thing an assistant can do. Tell me one real "
            "constraint and I will commit to an answer."
        )

    lines += ["", "What I am working from:"]
    if recalled:
        for kind, text in recalled[:6]:
            lines.append(f"- `{kind}` {text}")
    else:
        lines.append("- nothing — this is a first meeting")

    lines += [
        "",
        f"_You asked:_ “{last_user}”",
        "",
        "---",
        "_archiver-mock-1, offline. Retrieval, injection, extraction and distillation "
        "are all real; only the reasoning is canned. Add a key under **Settings** and "
        "the same pipeline drives a real model._",
    ]
    text = "\n".join(lines)

    words = text.split(" ")
    step = max(2, min(7, len(words) // max(1, min(40, max_tokens // 4)) or 7))
    for i in range(0, len(words), step):
        yield " ".join(words[i : i + step]) + " "
        await asyncio.sleep(0.004)
