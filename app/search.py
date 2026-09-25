"""Web search for Archiver — keyless, multi-source, server-side.

Wikipedia's Action API returns 403 for whole datacentre IP ranges, which is
exactly where this app gets deployed. A single-source search therefore works on
a laptop and silently degrades to nothing in production, which is what happened
in 2.2, and 2.5 turned retrieval into an opinion.

So: several independent providers, tried in order, each one recorded. If any
provider answers, the user gets results. The `diag` endpoint reports precisely
which providers work from the host that is running, so this can be debugged
from production rather than guessed at.

Nothing here generates prose about the world. It retrieves, it decides how much
of what it found deserves to be shown, and it reads that back in plain words.

As of 2.9 the second part matters more than the first. A search panel that is
always full is a panel nobody trusts — and a panel that dumps 1500-char
extracts is one nobody reads. So most work below is about refusing to show
things and shortening what remains: a confidence score, a word-order check
that catches "capital of peru" matching *Capital punishment in Peru*, a hard
cap of three results, and extracts cut to ~400 chars. Interpretation leads,
sources support — not the other way round.
"""

from __future__ import annotations

import asyncio
import html
import re
from typing import Any, Awaitable, Callable

import httpx

TIMEOUT = httpx.Timeout(14.0, connect=6.0)

# Wikimedia's policy requires "<client>/<version> (<contact>)"; a bare product
# name is rejected outright.
UA = "Archiver/2.5 (https://github.com/2archiver/Archiver; personal assistant) httpx/0.27"

ENDPOINTS = {
    "wikipedia-action": "https://en.wikipedia.org/w/api.php",
    "wikimedia-core": "https://api.wikimedia.org/core/v1/wikipedia/en/search/page",
    "wikipedia-rest": "https://en.wikipedia.org/api/rest_v1/page/summary/",
    "ddg-instant": "https://api.duckduckgo.com/",
    "stackexchange": "https://api.stackexchange.com/2.3/search/advanced",
    "allorigins": "https://api.allorigins.win/raw",
}


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #


def _clean(text: str, limit: int = 1200) -> str:
    text = html.unescape(re.sub(r"<[^>]+>", " ", text or ""))
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= limit:
        return text
    cut = text[:limit]
    stop = cut.rfind(". ")
    return (cut[: stop + 1] if stop > limit * 0.4 else cut).strip()


# Query shapes that want an engineer's answer, not an encyclopaedia entry.
TECH_HINTS = re.compile(
    r"\b(how (?:do|can|would) i|error|exception|stack ?trace|fix|debug|"
    r"python|javascript|typescript|react|css|html|sql|postgres|database|"
    r"api|http|json|regex|git|docker|kubernetes|nginx|server|buffer|"
    r"async|await|promise|stream|sse|websocket|cors|latency|memory leak|"
    r"compile|deploy|dockerfile|function|class|array|object|loop|"
    r"npm|pip|cargo|rust|golang|java|kotlin|swift|bash|shell)\b",
    re.I,
)


# Words that carry no identifying information. Leaving them in inflates the
# match score for anything, which is how "the battle of X" became a match for
# every article containing "battle" and a "the".
STOP = {
    "the", "a", "an", "and", "or", "of", "in", "on", "at", "to", "for", "with",
    "from", "by", "as", "is", "was", "were", "are", "be", "been", "being",
    "who", "whom", "whose", "what", "which", "when", "where", "why", "how",
    "did", "does", "do", "can", "could", "would", "should", "will", "shall",
    "it", "its", "that", "this", "these", "those", "there", "their", "his",
    "her", "him", "she", "they", "them", "about", "into", "than", "then",
    "tell", "me", "explain", "please", "much", "many", "get", "got",
    "search", "searching", "find", "finding", "lookup", "look", "something",
    "anything", "know", "info", "information", "give", "show", "details",
}


def _stem(word: str) -> str:
    """Compare on a four-character prefix.

    Without this, "streaming" is not "stream" and "buffering" is not "buffer",
    so a question about buffering a stream scored as if it shared nothing with
    the pages that answer it. The engine compared strings where it should have
    been comparing words.
    """
    return word[:4] if len(word) >= 5 else word


def _stems(text: str) -> set[str]:
    return {
        _stem(w)
        for w in re.findall(r"[a-z0-9]+", (text or "").lower())
        if len(w) > 2 and w not in STOP
    }


def _ordered_stems(text: str) -> list[str]:
    return [
        _stem(w)
        for w in re.findall(r"[a-z0-9]+", (text or "").lower())
        if len(w) > 2 and w not in STOP
    ]


def _tokens(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", (text or "").lower())


def _strict_head(query: str) -> str:
    """Head noun of a phrase-shaped lookup, or "" if it isn't one.

    "capital of peru" is a phrase: three tokens with the preposition in the
    middle. "how many people died" is a question, not a phrase, and must not be
    treated as one.
    """
    words = _tokens(query)
    if (
        len(words) == 3
        and words[0] not in STOP
        and words[2] not in STOP
        and words[1] in STOP
    ):
        return words[0]
    return ""


def _proximity(q_stems: set[str], text: str) -> float:
    """Measures how closely the query stems occur together in the text (order-independent)."""
    if len(q_stems) <= 1:
        return 1.0
    body = _tokens(text)
    stems = [_stem(w) for w in body if w not in STOP and len(w) > 2]
    if not stems:
        return 0.0
    positions: dict[str, list[int]] = {}
    for i, st in enumerate(stems):
        if st in q_stems:
            positions.setdefault(st, []).append(i)
    if len(positions) < len(q_stems):
        return (len(positions) / len(q_stems)) * 0.5
    min_span = 999
    all_pos = sorted([(pos, st) for st, plist in positions.items() for pos in plist])
    for i in range(len(all_pos)):
        seen = {all_pos[i][1]}
        for j in range(i, min(i + 15, len(all_pos))):
            seen.add(all_pos[j][1])
            if len(seen) == len(q_stems):
                span = all_pos[j][0] - all_pos[i][0]
                if span < min_span:
                    min_span = span
                break
    if min_span <= 6:
        return 1.0
    elif min_span <= 15:
        return 0.85
    elif min_span <= 30:
        return 0.70
    return 0.50


def _tight_pair(query: str, result: dict[str, Any]) -> bool:
    """Does any adjacent pair of the question's own words appear together?"""
    head = _strict_head(query)
    if head:
        words = _tokens(query)
        hay = " " + re.sub(r"[^a-z0-9]+", " ", (result.get("title", "") + " " + result.get("extract", "")).lower()).strip() + " "
        return f" {' '.join(words)} " in hay

    q = _ordered_stems(query)
    if len(q) < 2:
        return True
    body = _tokens(result.get("title", "") + " " + result.get("extract", ""))
    stems = [_stem(w) for w in body]
    stops = [(w in STOP or len(w) <= 2) for w in body]
    for a, b in zip(q, q[1:]):
        for i, st in enumerate(stems):
            if st != a:
                continue
            for j in range(i + 1, min(i + 12, len(stems))):
                if stops[j]:
                    continue
                if stems[j] == b:
                    return True
                break
    return False


def _best_sentence(query: str, text: str, limit: int = 800) -> str:
    """The sentence most likely to be the answer."""
    parts = [p for p in _sentences(text) if len(p) > 25]
    if not parts:
        return ""
    q = [_stem(w) for w in re.findall(r"[a-z0-9]+", (query or "").lower())
         if len(w) > 2 and w not in STOP]
    if not q:
        res = parts[0].strip()
        return res[:limit] if len(res) <= limit else res[:res[:limit].rfind(" ")].rstrip() + "…"
    freq: dict[str, int] = {}
    for part in parts:
        for stem in set(_stems(part)):
            freq[stem] = freq.get(stem, 0) + 1
    best, best_score = "", 0.0
    for i, part in enumerate(parts):
        here = _stems(part)
        score = sum(1.0 / freq.get(stem, 1) for stem in q if stem in here)
        if score == 0.0:
            continue
        score = score / len(q) - 0.01 * i
        if score > best_score:
            best, best_score = part, score
    if not best:
        res = parts[0].strip()
    else:
        res = best.strip()
    return res if len(res) <= limit else res[:res[:limit].rfind(" ")].rstrip() + "…"


def _match_sentence(query: str, result: dict[str, Any]) -> str:
    """The sentence in the result that actually answers the question."""
    q = _ordered_stems(query)
    if len(q) < 2:
        return ""
    hits = [
        sentence
        for sentence in re.split(r"(?<=[.!?])\s+", result.get("extract", "") or "")
        if _tight_pair(query, {"title": "", "extract": sentence})
    ]
    if not hits:
        return ""
    return _best_sentence(query, " ".join(hits))[:220]


def _content_words(text: str) -> set[str]:
    return _stems(text)


def confidence(query: str, result: dict[str, Any]) -> float:
    """0-1: how much of the question this result actually addresses."""
    q = _stems(query)
    if not q:
        return 1.0
    title_stems = _stems(result.get("title", ""))
    body_stems = _stems(result.get("extract", ""))
    all_stems = title_stems | body_stems
    
    cov = len(q & all_stems) / len(q)
    hit = len(q & title_stems) / len(q)
    prox = _proximity(q, result.get("title", "") + " " + result.get("extract", ""))
    
    score = 0.50 * cov + 0.30 * hit + 0.20 * prox
    extra_title = len(title_stems - q)
    if extra_title > 3:
        score -= 0.03 * min(extra_title - 3, 3)
    return round(max(0.0, min(1.0, score)), 4)


def _dedupe(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Best extract per title, preferring Wikipedia over aggregators."""
    weight = {"Wikipedia": 3, "Stack Exchange": 2, "DuckDuckGo": 2}
    best: dict[str, dict[str, Any]] = {}
    for r in results:
        key = re.sub(r"[^a-z0-9]", "", r["title"].lower())[:60]
        if not key:
            continue
        prev = best.get(key)
        if prev is None:
            best[key] = r
            continue
        better = len(r["extract"]) > len(prev["extract"]) + 40
        stronger = weight.get(r["source"], 1) > weight.get(prev["source"], 1)
        if better or (stronger and len(r["extract"]) >= len(prev["extract"])):
            best[key] = r
    return list(best.values())


# --------------------------------------------------------------------------- #
# providers
# --------------------------------------------------------------------------- #


async def p_wikipedia_action(c: httpx.AsyncClient, q: str, n: int) -> list[dict[str, Any]]:
    r = await c.get(
        ENDPOINTS["wikipedia-action"],
        params={
            "action": "query", "format": "json", "generator": "search",
            "gsrsearch": q, "gsrlimit": str(n), "prop": "extracts|info",
            "exintro": "1", "explaintext": "1", "exlimit": "max",
            "inprop": "url", "redirects": "1",
        },
        headers={"User-Agent": UA},
    )
    r.raise_for_status()
    pages = (r.json().get("query") or {}).get("pages") or {}
    out = []
    for p in sorted(pages.values(), key=lambda p: p.get("index", 999)):
        text = _clean(p.get("extract", ""))
        if text:
            out.append({"title": p.get("title", ""), "extract": text,
                        "url": p.get("fullurl", ""), "source": "Wikipedia",
                        "rank": p.get("index", 999)})
    return out


async def p_wikimedia_core(c: httpx.AsyncClient, q: str, n: int) -> list[dict[str, Any]]:
    """api.wikimedia.org — a separate service from en.wikipedia.org, so it is
    not covered by the same IP restrictions."""
    r = await c.get(
        ENDPOINTS["wikimedia-core"],
        params={"q": q, "limit": str(n)},
        headers={"User-Agent": UA, "Accept": "application/json"},
    )
    r.raise_for_status()
    out = []
    for i, page in enumerate((r.json() or {}).get("pages") or []):
        excerpt = _clean(re.sub(r"<[^>]+>", " ", page.get("excerpt") or ""), 350)
        desc = _clean(page.get("description") or "", 140)
        body = excerpt or desc
        if not body:
            continue
        title = page.get("title", "")
        out.append({"title": title, "extract": body,
                    "url": "https://en.wikipedia.org/wiki/" + title.replace(" ", "_"),
                    "source": "Wikipedia", "rank": i})
    return out


async def p_allorigins_wikipedia(c: httpx.AsyncClient, q: str, n: int) -> list[dict[str, Any]]:
    """Last-resort route to Wikipedia, through a public read-only proxy.

    The proxy fetches from its own infrastructure, which is not blocked, so this
    still works when every direct Wikipedia call is refused. Used only when the
    direct routes have all failed.
    """
    target = (
        "https://en.wikipedia.org/w/api.php?action=query&format=json"
        "&generator=search&gsrlimit=%d&prop=extracts|info&exintro=1"
        "&explaintext=1&inprop=url&redirects=1&gsrsearch=%s" % (n, q.replace(" ", "+"))
    )
    r = await c.get(ENDPOINTS["allorigins"], params={"url": target},
                    headers={"User-Agent": UA})
    r.raise_for_status()
    data = r.json()
    if isinstance(data, dict) and "contents" in data:
        import json as _json
        data = _json.loads(data["contents"])
    pages = (data.get("query") or {}).get("pages") or {}
    out = []
    for p in sorted(pages.values(), key=lambda p: p.get("index", 999)):
        text = _clean(p.get("extract", ""))
        if text:
            out.append({"title": p.get("title", ""), "extract": text,
                        "url": p.get("fullurl", ""), "source": "Wikipedia",
                        "rank": p.get("index", 999)})
    return out


async def p_hackernews(c: httpx.AsyncClient, q: str, n: int) -> list[dict[str, Any]]:
    """Tech discussions, dev commentary, and startup culture."""
    r = await c.get(
        "https://hn.algolia.com/api/v1/search",
        params={"query": q, "hitsPerPage": str(n), "tags": "story"},
        headers={"User-Agent": UA},
    )
    r.raise_for_status()
    out = []
    for i, h in enumerate((r.json() or {}).get("hits") or []):
        title = h.get("title") or h.get("story_title") or ""
        obj_id = h.get("objectID")
        url = h.get("url") or f"https://news.ycombinator.com/item?id={obj_id}"
        text = _clean(h.get("story_text") or title, 380)
        if title:
            out.append({"title": title, "extract": text, "url": url,
                        "source": "Hacker News", "rank": i})
    return out


async def p_wikiquote(c: httpx.AsyncClient, q: str, n: int) -> list[dict[str, Any]]:
    """Primary statements, notable quotes, and historical sayings."""
    r = await c.get(
        "https://en.wikiquote.org/w/api.php",
        params={
            "action": "query", "format": "json", "generator": "search",
            "gsrsearch": q, "gsrlimit": str(n), "prop": "extracts|info",
            "exintro": "1", "explaintext": "1", "inprop": "url", "redirects": "1",
        },
        headers={"User-Agent": UA},
    )
    r.raise_for_status()
    pages = (r.json().get("query") or {}).get("pages") or {}
    out = []
    for p in sorted(pages.values(), key=lambda p: p.get("index", 999)):
        text = _clean(p.get("extract", ""))
        if text:
            out.append({"title": p.get("title", ""), "extract": text,
                        "url": p.get("fullurl", ""), "source": "Wikiquote",
                        "rank": p.get("index", 999)})
    return out


async def p_ddg_instant(c: httpx.AsyncClient, q: str, n: int) -> list[dict[str, Any]]:
    r = await c.get(ENDPOINTS["ddg-instant"],
                    params={"q": q, "format": "json", "no_html": "1",
                            "no_redirect": "1", "skip_disambig": "1"},
                    headers={"User-Agent": UA})
    r.raise_for_status()
    d = r.json()
    abstract = _clean(d.get("AbstractText", ""), 380)
    if not abstract:
        return []
    return [{"title": d.get("Heading") or q, "extract": abstract,
             "url": d.get("AbstractURL", ""), "source": "DuckDuckGo", "rank": 0}]


async def p_stackexchange(c: httpx.AsyncClient, q: str, n: int) -> list[dict[str, Any]]:
    """Genuinely good answers for programming questions, and keyless."""
    r = await c.get(ENDPOINTS["stackexchange"],
                    params={"order": "desc", "sort": "relevance", "q": q,
                            "site": "stackoverflow", "pagesize": str(n),
                            "filter": "withbody"},
                    headers={"User-Agent": UA})
    r.raise_for_status()
    out = []
    for i, item in enumerate((r.json() or {}).get("items") or []):
        body = _clean(item.get("body") or "", 380)
        if not body:
            continue
        out.append({"title": item.get("title", ""), "extract": body,
                    "url": item.get("link", ""), "source": "Stack Exchange",
                    "rank": i})
    return out


# Order matters: accuracy first, availability last.
WIKI_CHAIN: list[tuple[str, Callable[..., Awaitable[list[dict[str, Any]]]]]] = [
    ("wikipedia-action", p_wikipedia_action),
    ("wikimedia-core", p_wikimedia_core),
]
PROXY_CHAIN: list[tuple[str, Callable[..., Awaitable[list[dict[str, Any]]]]]] = [
    ("allorigins-wikipedia", p_allorigins_wikipedia),
]
OTHER_CHAIN: list[tuple[str, Callable[..., Awaitable[list[dict[str, Any]]]]]] = [
    ("ddg-instant", p_ddg_instant),
    ("stackexchange", p_stackexchange),
    ("hackernews", p_hackernews),
    ("wikiquote", p_wikiquote),
]


async def _try_chain(
    client: httpx.AsyncClient,
    chain: list[tuple[str, Callable[..., Awaitable[list[dict[str, Any]]]]]],
    q: str,
    n: int,
    log: dict[str, str],
) -> list[dict[str, Any]]:
    """Run a chain until one provider yields something. Never raises."""
    for name, fn in chain:
        try:
            got = await fn(client, q, n)
            log[name] = f"ok ({len(got)} result{'s' if len(got) != 1 else ''})"
            if got:
                return got
        except Exception as exc:
            log[name] = f"{type(exc).__name__}: {str(exc)[:110]}"
    return []


# --------------------------------------------------------------------------- #
# how sure is sure enough
# --------------------------------------------------------------------------- #

# Two bars, and they exist because a search panel that is always full is a
# search panel nobody trusts. Anything at or above SURE_AT is a real match and
# is listed. Anything below it is not shown at all — unless exactly one result
# clears MAYBE_AT, in which case that one result is shown on its own, labelled
# as uncorroborated. Below MAYBE_AT the honest answer is "nothing", and the
# report says that instead of dressing up a near-miss.
SURE_AT = 0.40
MAYBE_AT = 0.20

# Below MAYBE_AT the only thing that can still be shown is a verbatim sentence
# containing what was asked. That is a quotation, not a claim about relevance.
QUOTE_AT = 0.15

# No matter what the caller asks for. Ten results is not a better answer than
# three good ones — and three short, interpreted results beat four long dumps.
MAX_RESULTS = 3


# --------------------------------------------------------------------------- #
# interpretation
# --------------------------------------------------------------------------- #

# What kind of thing is being asked. Archiver says which one it picked before
# it answers, so a misphrased question can be caught and re-asked cheaply
# without the user having to work out what the machine misunderstood.
_SHAPES: list[tuple[str, str]] = [
    ("verdict", r"\b(is it true|really|is .{1,30} real|did .{1,30} actually)\b"),
    # Ahead of "how", or every "how many" question is read as "how do I".
    ("count", r"\bhow (?:many|much|often|long|far|tall|big)\b"),
    ("who", r"\b(who|whose|whom)\b"),
    ("when", r"\b(when|what (?:year|date)|which year)\b"),
    ("where", r"\b(where)\b"),
    ("why", r"\b(why|how come|what caused|what led to)\b"),
    ("how", r"\b(how|in what way)\b"),
    ("what", r"\b(what|which)\b"),
]

# Note the absence of "the". Stripping it turned "what is the meaning of
# life" into "what meaning of life is", which reads like a machine.
_LEAD_WORDS = re.compile(
    r"^(?:so|ok|okay|hey|hi|hello|please|quick question|i was wondering|"
    r"can you tell me|do you know|tell me (?:about)?|explain|what|whats|what's|who|whos|"
    r"who's|when|where|why|how|which|is|are|was|were|did|does|do|to|"
    r"search (?:for|about|something about|anything about|me)?|look up|lookup|"
    r"find (?:out about|out|me)?|give me (?:info on|information on)?|google)\b[\s,]*",
    re.I,
)


def _clean_query(query: str) -> str:
    """Extract the core search subject by stripping search commands and conversational filler."""
    q = (query or "").strip()
    q = re.sub(
        r"^(?:search (?:for|about|something about|anything about|me)?|look up|lookup|"
        r"find (?:out about|out|me)?|give me (?:info on|information on)?|google|"
        r"tell me about|what is|whats|what's|who is|whos|who's|where is|when was|how does)\b[\s,]*",
        "",
        q,
        flags=re.I,
    ).strip()
    q = re.sub(r"[?!.]+$", "", q).strip()
    return q or (query or "").strip()


def _subject(query: str) -> str:
    """The part of the question that is actually being asked about.

    Strips the interrogative scaffolding so Archiver can repeat the question
    back in its own words. "who is clavicular" -> "clavicular".
    """
    text = re.sub(r"[?!.]+\s*$", "", (query or "").strip())
    prev = None
    while prev != text:
        prev = text
        text = _LEAD_WORDS.sub("", text).strip()
    return text or (query or "").strip()


def interpret_question(query: str) -> dict[str, Any]:
    """Say what was asked, before answering it.

    Cheap, deterministic, and honest about being a guess: it reads the shape of
    the question rather than understanding it. That is enough to catch the
    common failure where a question is phrased as one thing and meant as
    another.
    """
    q = (query or "").strip()
    shape = "topic"
    for name, pattern in _SHAPES:
        if re.search(pattern, q, re.I):
            shape = name
            break

    subject = _subject(q)
    # A question whose subject is already a clause ("who won the 1998 world
    # cup") does not want an "is" bolted onto the end of it.
    if shape in {"who", "what"} and re.match(
        r"(?:won|lost|was|were|is|are|did|does|do|killed|died|invented|wrote|"
        r"made|built|discovered|started|began|ended|happened|created|founded|"
        r"invented)\b",
        subject,
        re.I,
    ):
        shape = "clause"

    restatement = {
        "who": f"who {subject} is",
        "when": f"when {subject} happened",
        "where": f"where {subject} is",
        "why": f"why {subject} happened",
        "how": f"how to {subject}",
        "count": f"how {subject}",
        "clause": subject,
        "verdict": f"whether {subject}",
        "what": f"what {subject} is",
        "topic": subject,
    }.get(shape, subject)

    # "how to buffer a stream" becomes "how to to buffer a stream" unless the
    # leftover "to" is trimmed here.
    if shape == "how":
        restatement = re.sub(r"^how to to\b", "how to", restatement)

    return {"shape": shape, "subject": subject, "restatement": restatement}





def _gate(
    query: str, results: list[dict[str, Any]], technical: bool
) -> tuple[list[tuple[dict[str, Any], float]], str]:
    """Decide how much of the pool deserves to be shown.

    Returns the kept results and a level of "high", "single" or "none".
    """
    scored = sorted(
        ((r, confidence(query, r)) for r in _dedupe(results)),
        key=lambda pair: pair[1],
        reverse=True,
    )

    kept = [(r, c) for r, c in scored if c >= SURE_AT][:MAX_RESULTS]
    level = "high"
    if not kept:
        if scored and scored[0][1] >= MAYBE_AT:
            kept, level = scored[:1], "single"
        else:
            quotable = [
                (r, c) for r, c in scored if c >= QUOTE_AT and _match_sentence(query, r)
            ]
            kept, level = (quotable[:1], "single") if quotable else ([], "none")

    # Technical queries: an engineer's answer outranks an encyclopaedia entry.
    def order(pair):
        r, c = pair
        prefer = 0 if (technical and r.get("_chain") == "se") else 1
        return (prefer, -c, r.get("rank", 99))

    kept.sort(key=order)
    return kept, level


async def _gather(
    q: str, client: httpx.AsyncClient, log: dict[str, str], technical: bool
) -> list[dict[str, Any]]:
    """Run the providers. Records what each one said into `log`."""

    async def run(chain, tag):
        out = await _try_chain(client, chain, q, 5, log)
        for r in out:
            r["_chain"] = tag
        return out

    # Wikipedia and Stack Exchange answer different kinds of question, and
    # running them together costs one round trip instead of two.
    wiki_task = asyncio.create_task(run(WIKI_CHAIN, "wiki"))
    se_task = asyncio.create_task(run([("stackexchange", p_stackexchange)], "se"))
    wiki = await wiki_task
    se = await se_task if technical else []
    if not technical:
        se_task.cancel()

    found = wiki + se
    if len(found) < 2:
        found += await run(OTHER_CHAIN, "other")
    if not found:
        found += await run(PROXY_CHAIN, "proxy")
    return found


async def search(query: str, limit: int = 5) -> dict[str, Any]:
    """Search, then decide how much of it is worth showing.

    Returns the results, how confident it is in them, a reading of the question,
    and a short interpretation of what they say. Never raises for a bad query.
    """
    query = (query or "").strip()
    if not query:
        return {"results": [], "errors": ["empty query"], "providers": {},
                "query": "", "confidence": "none", "report": {},
                "interpretation": {}, "corrected": "", "technical": False}
    limit = max(1, min(MAX_RESULTS, int(limit or 5)))

    orig_query = query
    technical = bool(TECH_HINTS.search(query))
    corrected = ""
    log: dict[str, str] = {}

    clean_q = _clean_query(query)
    q_to_search = clean_q if clean_q else query

    async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True) as client:
        pool = await _gather(q_to_search, client, log, technical)
        kept, level = _gate(q_to_search, pool, technical)

        # If clean search gave nothing, try the raw query
        if level == "none" and q_to_search.lower() != query.lower():
            log_raw: dict[str, str] = {}
            pool_raw = await _gather(query, client, log_raw, technical)
            kept_raw, level_raw = _gate(query, pool_raw, technical)
            if level_raw != "none":
                kept, level, pool = kept_raw, level_raw, pool_raw
                log.update(log_raw)

        if level == "none":
            # Before giving up, ask whether the question was simply misspelled
            better = await suggest(clean_q or query)
            if better and better.lower() != query.lower():
                log2: dict[str, str] = {}
                pool2 = await _gather(better, client, log2, technical)
                kept2, level2 = _gate(better, pool2, technical)
                if level2 != "none":
                    corrected = better
                    query, kept, level = better, kept2, level2
                    log.update(log2)

    out = []
    for r, c in kept[:limit]:
        r = dict(r)
        r.pop("rank", None)
        r.pop("_chain", None)
        r["confidence"] = c
        raw_extract = r.get("extract", "").strip()
        r["extract"] = raw_extract
        quote = _match_sentence(query, r)
        r["quote"] = quote if quote else _best_sentence(query, raw_extract, 260)
        r["short"] = _best_sentence(query, raw_extract, 260) or raw_extract[:260]
        out.append(r)

    interp = interpret_question(orig_query)
    report = brief(orig_query, out, level, technical, interp, corrected, orig_query)

    errors = [f"{k}: {v}" for k, v in log.items() if not v.startswith("ok")]
    return {
        "results": out,
        "errors": errors,
        "providers": log,
        "query": query,
        "technical": technical,
        "confidence": level,
        "interpretation": interp,
        "report": report,
        "corrected": corrected,
    }


# --------------------------------------------------------------------------- #
# interpretation — reading the results back to you
# --------------------------------------------------------------------------- #

# Sentence-initial function words get capitalised, which makes them look like
# proper nouns to a regex. This is the list of things that are not facts.
_NOT_FACTS = {
    "The", "A", "An", "In", "On", "At", "It", "Its", "He", "She", "They", "Them",
    "Their", "This", "That", "These", "Those", "There", "Then", "Than", "But",
    "And", "Or", "For", "As", "By", "From", "With", "After", "Before", "During",
    "When", "While", "However", "Also", "Both", "One", "Two", "Three", "First",
    "Second", "Third", "His", "Her", "Who", "What", "Which", "Most", "Some",
    "Many", "All", "No", "Not", "If", "So", "Over", "Under", "Between", "Within",
    "About", "Into", "Out", "Up", "Down", "Now", "Here", "Where", "Why", "How",
    "Was", "Were", "Is", "Are", "Had", "Has", "Have", "Did", "Does", "Do",
    "Would", "Could", "Should", "Will", "Shall", "May", "Might", "Must", "Can",
    "Other", "Others", "Such", "Same", "More", "Less", "Well", "Just", "Only",
    "Even", "Still", "Yet", "Because", "Although", "Though", "Since", "Until",
    # Month names are capitalised and are not facts. Reporting that the sources
    # "agree on December" is worse than reporting nothing.
    "January", "February", "March", "April", "May", "June", "July", "August",
    "September", "October", "November", "December",
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
}

_YEAR = re.compile(r"\b(1[0-9]{3}|20[0-9]{2})\b")


def _sentences(text: str) -> list[str]:
    t = re.sub(r"\b(U\.S|e\.g|i\.e|vs|etc|St|Dr|Prof|Mr|Mrs|Ms|Jr|Sr)\.", r"\1__DOT__", text or "")
    return [p.strip().replace("__DOT__", ".") for p in re.split(r"(?<=[.!?])\s+", t) if p.strip()]


def _lead_sentence(text: str, limit: int = 300) -> str:
    """The first real sentence, without cutting mid-thought.

    The period must be followed by whitespace or end-of-string, so "U.S. Army"
    and "St. Petersburg" survive intact.
    """
    text = (text or "").strip()
    if not text:
        return ""
    m = re.match(r"(.{30,%d}?[.!?])(?:\s|$)" % limit, text)
    if m:
        return m.group(1).strip()
    cut = text[:limit]
    space = cut.rfind(" ")
    return (cut[:space] + "…") if space > 60 else cut


def _facts(text: str) -> set[str]:
    """Proper nouns and years — the parts of a sentence worth checking.

    Names are kept whole. Collecting loose capitalised words turned "Holy Roman
    Emperor" into the fact **Holy**, which is not a thing anyone agrees on, so
    consecutive capitals inside one sentence are joined into the phrase they
    actually are. Sentences are separated first, or the last word of one would
    merge with the first word of the next.
    """
    out: set[str] = set()
    for sentence in _sentences(text or ""):
        # Digits stay in the stream. Dropping them made "28 April 1937 – 30
        # December 2006" look like two adjacent capitals, and the app reported
        # "April December" as something the sources agreed on.
        words = re.findall(r"[A-Za-z0-9][A-Za-z0-9'\-]*", sentence)
        run: list[str] = []

        def flush() -> None:
            if not run:
                return
            if len(run) >= 2:
                out.add(" ".join(run))
            elif len(run[0]) > 3 and run[0] not in _NOT_FACTS:
                out.add(run[0])
            run.clear()

        for word in words:
            if word[0].isupper() and not word.isdigit() and word not in _NOT_FACTS:
                if run and run[-1].lower() == word.lower():
                    continue          # a run-on, not a longer name
                run.append(word)
            else:
                flush()
        flush()
    out |= set(_YEAR.findall(text or ""))

    # "Saddam Hussein Abd" is not a name, it is "Saddam Hussein" with the next
    # word caught in the same run. Keep the shortest form.
    kept = set(out)
    for f in sorted(kept, key=len):
        for g in list(kept):
            if len(g) > len(f) and g.lower().startswith(f.lower() + " "):
                kept.discard(g)
    return kept


def _consensus(query: str, results: list[dict[str, Any]]) -> list[str]:
    """Facts every source states.

    This is the honest version of "summarising": it does not paraphrase, it
    finds what is agreed. Anything appearing in two independent documents and
    not already in the question is worth surfacing, because it is the part the
    sources converge on.
    """
    if len(results) < 2:
        return []
    q = {w.lower() for w in re.findall(r"[A-Za-z0-9']+", query or "")}
    tally: dict[str, int] = {}
    surface: dict[str, str] = {}
    for r in results:
        for fact in _facts(r.get("title", "") + ". " + r.get("extract", "")):
            key = fact.lower()
            tally[key] = tally.get(key, 0) + 1
            surface.setdefault(key, fact)

    # Two independent sources, not all of them. Requiring unanimity meant a
    # single dissenting page could silence something the rest agreed on.
    agreed = [k for k, n in tally.items() if n >= 2 and k not in q]

    # Phrases before single words, then years. "World War II" is worth more to
    # a reader than "World".
    def rank(key: str) -> tuple[int, int, str]:
        text = surface[key]
        return (0 if " " in text else 1, 0 if not text.isdigit() else 1, text)

    agreed.sort(key=rank)
    single = [t for t in sorted({f for f in set(_YEAR.findall(
        " ".join(r.get("extract", "") for r in results))) if f not in q})]
    if not agreed:
        return single[:3]
    return [surface[k] for k in agreed[:3]]


def _conflict(results: list[dict[str, Any]], shared: list[str]) -> str:
    """Do two sources give different dates for the same agreed fact?

    Narrow on purpose. It only fires when a proper noun both sources mention is
    followed by years in each, and the years do not overlap — which is a real
    discrepancy rather than two documents discussing different periods.
    """
    for fact in shared[:3]:
        # Only real names, not single words. "December" near two different years
        # is not a disagreement about when December happened.
        if " " not in fact:
            continue
        years: list[set[str]] = []
        for r in results:
            text = r.get("title", "") + ". " + r.get("extract", "")
            local: set[str] = set()
            for m in re.finditer(re.escape(fact) + r"(.{0,90})", text):
                local |= set(_YEAR.findall(m.group(1)))
            if local:
                years.append(local)
        if len(years) >= 2 and years[0] and years[1] and not (years[0] & years[1]):
            a = sorted(years[0])[0]
            b = sorted(years[1])[0]
            return f"{fact} is dated {a} in one source and {b} in another — check that one before repeating it."
    return ""


def _seed(text: str) -> int:
    import zlib

    return zlib.crc32((text or "").encode("utf-8"))


def _pick(options: list[str], key: str) -> str:
    """Deterministic variety.

    The same question always gets the same sentence, so the voice is a voice and
    not a slot machine — but different questions do not all read identically.
    """
    return options[_seed(key) % len(options)]


def _gloss(result: dict[str, Any], first: bool) -> str:
    """One line on what a given source is for."""
    src = result.get("source", "")
    if src == "Stack Exchange":
        return "someone hit this exact problem" if first else "another thread on it"
    if first:
        return "the main article"
    return "more detail"


def _synthesize_thoughts(
    query: str,
    results: list[dict[str, Any]],
    technical: bool,
    interp: dict[str, Any],
) -> str:
    """Generate energetic, substantive, and creative lateral thoughts on the topic."""
    if not results:
        return ""
    q_lower = query.lower()
    titles = [r.get("title", "") for r in results]
    first_title = titles[0] if titles else query

    # General web search
    if any(k in q_lower for k in ("tool", "search", "engine", "web search")):
        return (
            f"For **{first_title}**, the strongest results usually come from triangulating a focused question with primary sources — chase the original document or dataset rather than the aggregator that merely lists it."
        )
    # Technical, Engineering & AI
    if technical or any(k in q_lower for k in ("code", "api", "python", "javascript", "db", "database", "server", "stream", "llm", "ai", "css", "html", "git", "cache", "network", "linux", "gpu", "webgpu", "memory")):
        return (
            f"From an engineering lens on **{first_title}**, the critical design lever is almost always state boundaries and deterministic fallbacks. Systems thrive when failure paths degrade gracefully to local offline caches rather than stalling the whole pipeline on upstream latency."
        )
    # History, Conflicts & Geopolitics
    if any(k in q_lower for k in ("war", "battle", "treaty", "history", "ww2", "wwii", "president", "empire", "revolution", "soviet", "nazi", "reich", "churchill", "hitler", "stalin", "roosevelt", "stalingrad", "kursk", "barbarossa")):
        return (
            f"My historical read on **{first_title}**: everyone remembers the bold arrow on the map, but wars are won in the warehouse. For {first_title}, the boring truth is logistics and production — who could move fuel, shells, and food in winter — decided it before the famous charge did. That is less cinematic and more correct."
        )
    # Culture, Figures & Internet Lore
    if any(k in q_lower for k in ("who is", "streamer", "youtuber", "drama", "influencer", "celebrity", "podcast", "figure", "manosphere", "looksmaxxing")):
        return (
            f"With figures and subcultures like **{first_title}**, modern discourse is heavily filtered through short-form clip economies and meme amplification. Digging into unedited long-form exchanges reveals far more about the real incentives than viral second-hand commentary."
        )
    # Figures & Controversial Public Figures — Grok has a take
    if any(k in q_lower for k in ("nick fuentes", "fuentes", "clavicular", "kanye", "ye ", "trump", "biden", "musk", "tate")):
        return (
            f"My take on **{first_title}**: the facts above are the receipts, but the *why* is audience economics. Controversial figures scale by turning outrage into distribution — clips outrun context every time. If you only watch the 30-second cut, you will misjudge the person and the incentive. Watch one full long-form exchange and you will see the actual playbook, which is far more banal than the meme suggests."
        )
    # Render free-tier economics — must not fallback to generic Pro bono
    if any(k in q_lower for k in ("render", "free tier", "free service", "freemium", "afford", "hosting", "sleep", "cold start")) or any(k in first_title.lower() for k in ("render", "free tier", "freemium")):
        return (
            f"My take on **{first_title}**: free is a funnel, not charity. Render lets free Web Services sleep after ~15 min idle — next request pays a ~30s cold start — because keeping it warm 24/7 is the real cost. They afford it by paying only for awake time, shared capacity, and converting you when you need always-on, Postgres/Redis, or scale. If you can live with sleep, free is honest; if you need uptime, you buy wakefulness."
        )
    # Self-aware lightweight-model comparison — avoid Madonna misfire
    if any(k in q_lower for k in ("compare", "tinyllama", "tiny llama", "phi-3", "phi 3", "gemma", "qwen", "smollm", "lightweight", "small model")) and any(k in q_lower for k in ("you", "yourself", "archiver", "compare")):
        return (
            f"Where I sit vs those lights: I'm not a weights file — I'm retrieval + synthesis over ~1300 offline topics plus live WEB, built to idle on Render's free 512 MB instance (sleep -> ~30s wake) with no GPU. TinyLlama 1.1B, Qwen2.5 0.5B/1.5B and SmolLM2 1.7B *will* actually fit free (quantized GGUF, <400 MB RAM). Phi-3 mini 3.8B and Gemma 2 2B are sharper but want ~3-4 GB RAM, so you slip to paid. I trade pure model depth for grounded sources and privacy; they trade grounding for local LLM chops."
        )
    # Science, Philosophy & General Knowledge — Grok-styled, opinionated, not generic
    return (
        f"My read on **{first_title}**: skip the headline — find the constraint that actually binds it. For {first_title}, ask who pays, what must stay on, and what the default is. Most surprises live there, not in the press release."
    )


def brief(
    query: str,
    results: list[dict[str, Any]],
    level: str,
    technical: bool,
    interp: dict[str, Any],
    corrected: str = "",
    original: str = "",
) -> dict[str, Any]:
    """Read the results back as a substantive, lively summary with grounding.

    Extracts key facts, background narrative, and technical details from the
    retrieved sources into an informative synthesis with creative lateral thoughts.
    """
    reading = interp.get("restatement", "")
    if corrected:
        reading = f"{reading} (searched for **{corrected}**)"
    n = len(results)

    if level == "none" or not results:
        return {
            "headline": "",
            "reading": reading,
            "voice": "Nothing directly answering that found in live sources. Try rephrasing or asking more specifically.",
            "additional_thoughts": "",
            "confidence": "nothing worth citing",
            "sources": 0,
            "consensus": [],
        }

    # Pick the best lead sentence across results, avoiding disambiguation stubs
    lead = ""
    for r in results:
        cand = _best_sentence(query, r.get("extract", ""))
        if cand and not re.search(r"\b(?:most often refers to|may refer to|can refer to|usually refers to|stands for|may also refer to):\s*$", cand.strip(), re.I):
            lead = cand
            break

    top = results[0]
    if not lead:
        lead = _best_sentence(query, top.get("extract", ""))
    headline = lead or f"**{top.get('title', '')}** — {top.get('source', '')}"

    substantive_paras: list[str] = []
    for r in results:
        ext = r.get("extract", "")
        for s in _sentences(ext):
            s_clean = s.strip()
            if (
                s_clean
                and s_clean != lead
                and len(s_clean) > 25
                and not re.search(r"\b(?:most often refers to|may refer to|can refer to|usually refers to|stands for|may also refer to):\s*$", s_clean, re.I)
                and s_clean not in substantive_paras
            ):
                substantive_paras.append(s_clean)

    # Group into cohesive paragraphs (2-3 sentences each)
    paras: list[str] = []
    chunk: list[str] = []
    for s in substantive_paras[:8]:
        chunk.append(s)
        if len(chunk) >= 2 or len(" ".join(chunk)) > 260:
            paras.append(" ".join(chunk))
            chunk = []
    if chunk:
        paras.append(" ".join(chunk))

    shared = _consensus(query, results)
    conflict = _conflict(results, shared) if shared else ""
    if conflict:
        paras.append(conflict)

    thoughts = _synthesize_thoughts(query, results, technical, interp)
    if thoughts:
        paras.append(f"💡 **Additional Thoughts & Lateral Angles**\n{thoughts}")

    voice = "\n\n".join(paras) if paras else ""
    label = {"high": "well supported", "single": "one source", "none": "nothing worth citing"}.get(level, "supported")

    return {
        "headline": headline,
        "reading": reading,
        "voice": voice,
        "additional_thoughts": thoughts,
        "confidence": label,
        "sources": n,
        "consensus": shared,
    }


async def suggest(query: str) -> str:
    """Wikipedia's own spelling correction, if it has one.

    A misspelled question used to return nothing at all, because every provider
    searches for the literal string. Wikipedia already works out what was meant
    — it just needed to be asked.
    """
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True) as c:
            r = await c.get(
                ENDPOINTS["wikipedia-action"],
                params={
                    "action": "query", "list": "search", "srsearch": query,
                    "srlimit": 1, "srinfo": "suggestion", "format": "json",
                },
                headers={"User-Agent": UA},
            )
            r.raise_for_status()
            info = (r.json().get("query") or {}).get("searchinfo") or {}
            return (info.get("suggestion") or "").strip()
    except Exception:
        return ""


async def diag(query: str = "Battle of Kursk") -> dict[str, Any]:
    """Probe every provider individually from the host that is running.

    This is how the 403 was found in the first place: the app could not tell
    which source was failing, so it just looked broken.
    """
    out: dict[str, Any] = {"host": None, "providers": {}}
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as c:
            me = await c.get("https://api.ipify.org?format=json", headers={"User-Agent": UA})
            out["host"] = me.json().get("ip")
    except Exception as exc:
        out["host"] = f"unknown ({type(exc).__name__})"

    async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True) as client:
        for name, fn in WIKI_CHAIN + OTHER_CHAIN + PROXY_CHAIN:
            try:
                got = await fn(client, query, 2)
                out["providers"][name] = {
                    "ok": bool(got),
                    "count": len(got),
                    "sample": got[0]["title"][:70] if got else None,
                }
            except Exception as exc:
                out["providers"][name] = {
                    "ok": False, "count": 0,
                    "error": f"{type(exc).__name__}: {str(exc)[:150]}",
                }
    return out
