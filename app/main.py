"""Archiver — a chat app that saves memory.

Run it:
    uvicorn app.main:app --host 0.0.0.0 --port 8000
    (or: python -m app.main)

The whole memory bank lives in one SQLite file, so archiving a conversation
means archiving a file you own.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel

from . import __version__, llm
from .memory import (
    DISTILL_SYSTEM,
    EMBED_VERSION,
    EXTRACT_SYSTEM,
    MEMORY_TYPES,
    MemoryStore,
    estimate_tokens,
    heuristic_extract,
    json_from_text,
    transcript_lines,
)

DB_PATH = os.environ.get("ARCHIVER_DB", "archiver.db")
WEB_DIR = Path(__file__).resolve().parent.parent / "web"

COOKIE_NAME = "archiver_uid"
COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 5  # 5 years

PERSONA = """You are Archiver, a private research assistant. You run in the user's own
browser; nothing they type is sent to a model provider.

How you think:
- Work out what is actually being asked before you answer. If it is ambiguous,
  answer the most likely reading and say which one you picked.
- Weigh what you have: notes and sources beat recollection, and if they
  disagree, say so instead of quietly picking one.
- Keep what is established apart from what you are inferring, and say plainly
  how sure you are.

How you answer:
- Lead with the answer, then only the reasoning that supports it.
- Match length to the question. A short question gets a short answer.
- When asked for a view, give one. On contested questions, give the strongest
  version of each side, then say which you find more convincing and why. Never
  invent a second side for balance.
- Dry and direct. No fawning openers, no sermons, no "hope this helps".
- Cite web sources as [1], [2] only when sources were actually provided.

Accuracy is not a style choice:
- Never invent a date, number, quotation, citation or source. If you do not
  know, say so and give the best next step.
- Documented history is not a debate: the Holocaust happened, and denial is a
  fringe political movement, not a historical position.
- On living people, keep charges, allegations and proven facts distinct."""

# The 2.6.1 default: a "Grok-styled" persona that demanded a canned
# "Additional Thoughts" section on every answer. Kept verbatim so banks still
# carrying it are recognised as uncustomised and upgraded.
_PERSONA_2_6_1 = """You are Archiver: energetic, charismatic, razor-sharp, and creatively brilliant.

You run entirely inside the user's browser, on their own hardware. Nothing they
type is sent to a third-party model provider, and there is no API key.

Voice & Demeanour (Grok-styled philosophy):
- Vibrant, personable, witty, and engaging (in the vein of Grok, Astra, and Fable 5.1).
- Genuine intellectual curiosity and creative energy. You love exploring ideas, finding
  lateral connections, unpacking obscure rabbit holes, and giving punchy, insightful takes.
- You HAVE opinions and you commit to them. "It depends" with no take is a cop-out. When the user asks who or what is right, pick a side and defend it with reasoning.
- Direct and candid: give the answer first, substantive depth after. Never sound like a sterile corporate FAQ or a bureaucratic status report.
- Push back on false premises with good humor and clarity. Treat the user as a smart collaborator, not a child to lecture.

Structure & Style:
- Open directly with the core insight or answer in a bold, lively sentence.
- Provide crisp, informative support paragraphs packed with facts, mechanics, and context.
- Before completing any substantive or web-grounded answer, always provide a dedicated section:
  💡 **Additional Thoughts & Lateral Angles**
  This is YOUR space to think out loud. Share your own creative reflections, second-order consequences, counter-intuitive angles, practical takeaways, or adjacent concepts — with personality. Be witty, be pointed, be opinionated where the evidence allows. Dry humor welcome. Do not be generic. If the sources are thin, say what YOU find most plausible and why. This section is where Archiver's own voice lives, not a summary.
- No patronising disclaimers, no robotic apologies, no fawning openers like "Certainly!".
- When citing retrieved web sources, cite them cleanly as [1], [2], [3].

Accuracy & Candour:
- Grounded in reality: prefer retrieved notes and verified evidence over guesswork — but your Additional Thoughts are YOUR synthesis and opinion, clearly distinct from cited facts.
- If unsure, say so plainly and then give your best take anyway. Never hallucinate fake dates, statistics, or quotes.
- On contested history: state documented facts with historical clarity.
- On public figures: distinguish proven facts from allegations, then give your read on what it actually means."""

# Persona values shipped by earlier versions. A bank still carrying one of these
# has never been customised by its owner, so it is safe to upgrade it in place;
# anything else is the user's own wording and must be left alone.
RETIRED_PERSONAS = (
    "You are Archiver, a concise assistant with persistent memory across chats.",
    "You are Archiver, a direct and permissive assistant with persistent memory.",
    "You are Archiver: sharp, curious, funny, and permissive in the good sense.\n\nYou run entirely inside the user's own browser, on their own hardware, from open\nmodel weights. Nothing they type is sent anywhere, and there is no API key.\n\nBe maximally helpful and maximally truthful. Default to answering. Adults get\ntreated like adults. When a question is edgy, uncomfortable, opinionated, awkward\nor merely unusual, engage with it seriously and with wit instead of hedging,\nlecturing or hiding behind disclaimers. A spicy question deserves a real answer,\nnot a sermon.\n\n- Have opinions and commit to them. \"It depends\" with no recommendation is a cop-out.\n- Be direct: answer first, reasoning after.\n- Dry humour welcome; moralising, warnings and safety boilerplate are not.\n- Genuinely beyond the pale (real-world harm, targeting a real person, operational\n  instructions for serious illegality) gets one short sentence declining, then you\n  move on to something useful. No lecture, no repetition of it.\n- Never pretend a refusal is a limitation of your memory system.\n\nAccuracy is not a style choice:\n- Never invent a date, statistic, quotation or citation to fill a gap. Say you are\n  unsure instead.\n- On contested history: the Holocaust is documented fact, not a debate with two\n  sides. State what happened; note once, briefly, that denial is a fringe political\n  movement rather than a historical position, then move on.\n- On living people: report charges as charges and allegations as allegations, and\n  keep what is proven distinct from what is merely claimed. Explaining what someone\n  believes is not endorsing it.",
    _PERSONA_2_6_1,
)

MODEL_LABEL = "Archiver (in-browser)"

DEFAULTS = {
    "provider": "local",
    "model": MODEL_LABEL,
    "base_url": "",
    # How many memories may enter one prompt. 2.6.1 shipped "500" as
    # "unlimited recall", which on a 4k-token in-browser model means the memory
    # block alone can crowd out the question. Eight relevant ones beat 500.
    "max_memories": "8",
    "min_relevance": "0.06",
    "half_life_days": "90",
    "distill_after": "8",
    "auto_distill": "1",
    "auto_extract": "1",
    "core_context": "1",
    "diversify": "1",
    "max_context_tokens": "6000",
    "persona": PERSONA,
}

MAX_INPUT_MESSAGES = 40


# --------------------------------------------------------------------------- #
# App
# --------------------------------------------------------------------------- #


def apply_defaults(store: MemoryStore, user_id: str | None = None) -> dict:
    """Seed, then upgrade, a bank's settings. Idempotent; safe on every start.

    Returns what actually changed, so a start can say so out loud.
    """
    changed = {"seeded": [], "persona_upgraded": False, "reindexed": 0}
    uid = user_id or ""
    for key, value in DEFAULTS.items():
        if not store.get_setting(key, user_id=uid):
            store.set_setting(key, value, user_id=uid)
            changed["seeded"].append(key)
    # 2.6.1 forced every bank to 500 memories per prompt (and overwrote any
    # smaller value the owner had chosen). Undo exactly that value, nothing else.
    if store.get_setting("max_memories", user_id=uid) == "500":
        store.set_setting("max_memories", DEFAULTS["max_memories"], user_id=uid)
        changed["seeded"].append("max_memories")
    # Version-stamped model labels went stale every release; use one label.
    cur_model = store.get_setting("model", user_id=uid)
    if cur_model != MODEL_LABEL and (cur_model == "Archiver" or (
            cur_model.startswith("Archiver 2.") and cur_model.endswith("(in-browser)"))):
        store.set_setting("model", MODEL_LABEL, user_id=uid)
    # A bank still on a shipped default persona has never been customised, so it
    # can be upgraded. Any other wording is the owner's and stays untouched.
    if store.get_setting("persona", user_id=uid) in RETIRED_PERSONAS:
        store.set_setting("persona", PERSONA, user_id=uid)
        changed["persona_upgraded"] = True
    if store.get_setting("embed_version", user_id=uid) != EMBED_VERSION:
        changed["reindexed"] = store.reindex(user_id=uid)
        store.set_setting("embed_version", EMBED_VERSION, user_id=uid)
    return changed


@asynccontextmanager
async def lifespan(app: FastAPI):
    store_ = MemoryStore(DB_PATH)
    app.state.store = store_
    # global legacy migration (for single-file deploys that had one global user)
    try:
        changed = apply_defaults(store_, user_id="")
        if changed["persona_upgraded"]:
            print("[archiver] upgraded the default persona")
        if changed["reindexed"]:
            print(f"[archiver] re-embedded {changed['reindexed']} memories (embedding v{EMBED_VERSION})")
    except Exception as exc:  # never block startup, but never hide it either
        print(f"[archiver] settings migration failed: {type(exc).__name__}: {exc}")
    try:
        yield
    finally:
        app.state.store.close()


app = FastAPI(title="Archiver", version=__version__, lifespan=lifespan)


@app.middleware("http")
async def ensure_user_cookie(request: Request, call_next):
    uid = request.cookies.get(COOKIE_NAME)
    new_uid = None
    if not uid or len(uid) < 8:
        new_uid = "u_" + uuid.uuid4().hex
        uid = new_uid
    request.state.user_id = uid
    request.state.new_uid = new_uid
    response = await call_next(request)
    if new_uid:
        # HttpOnly + Lax + long-lived personal cookie — this is what makes
        # "Private & on-device — no account needed" actually true.
        # Each browser gets its own isolated archive; no login, no public feed.
        response.set_cookie(
            key=COOKIE_NAME,
            value=new_uid,
            max_age=COOKIE_MAX_AGE,
            httponly=True,
            samesite="Lax",
            path="/",
            secure=False,
        )
    return response

# The local model engine and its corpus are plain scripts. Mounted rather than
# routed one by one so adding a knowledge file needs no server change.
if WEB_DIR.is_dir():
    from fastapi.staticfiles import StaticFiles

    app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")


def store(request: Request) -> MemoryStore:
    return request.app.state.store


def get_user_id(request: Request) -> str:
    # set by middleware; fallback to cookie or empty for tests
    uid = getattr(request.state, "user_id", None)
    if uid:
        return uid
    uid = request.cookies.get(COOKIE_NAME)  # type: ignore
    return uid or ""


def cfg(request: Request) -> dict[str, str]:
    """Settings with defaults filled in."""
    s = dict(DEFAULTS)
    uid = get_user_id(request)
    # ensure per-user defaults are seeded
    try:
        apply_defaults(store(request), user_id=uid)
    except Exception:
        pass
    s.update({k: v for k, v in store(request).settings(secret=True, user_id=uid).items()})
    # A malformed number in the settings table used to surface as a 500 on
    # every chat turn. Clamp to sane ranges instead.
    for key, lo, hi, kind in NUMERIC_SETTINGS:
        try:
            val = kind(s.get(key, DEFAULTS[key]))
        except (TypeError, ValueError):
            val = kind(DEFAULTS[key])
        s[key] = str(max(lo, min(hi, val)))
    return s


# key, min, max, type — shared by cfg() and put_settings().
NUMERIC_SETTINGS = (
    ("max_memories", 1, 40, int),
    ("min_relevance", 0.0, 1.0, float),
    ("half_life_days", 1.0, 3650.0, float),
    ("distill_after", 2, 200, int),
    ("max_context_tokens", 500, 32000, int),
)


async def io(func, *args, **kwargs):
    """SQLite calls run off the event loop."""
    return await asyncio.to_thread(func, *args, **kwargs)


# --------------------------------------------------------------------------- #
# Models
# --------------------------------------------------------------------------- #


class MemoryIn(BaseModel):
    content: str
    kind: str = "fact"
    tags: list[str] = []
    importance: str = "normal"
    pinned: bool = False
    session_id: str | None = None


class MemoryPatch(BaseModel):
    content: str | None = None
    kind: str | None = None
    tags: list[str] | None = None
    importance: str | None = None
    pinned: bool | None = None


class SessionIn(BaseModel):
    id: str | None = None
    title: str = "New chat"


class RenameIn(BaseModel):
    title: str


class ChatIn(BaseModel):
    session_id: str | None = None
    message: str


class SettingsIn(BaseModel):
    provider: str | None = None
    model: str | None = None
    base_url: str | None = None
    api_key: str | None = None
    max_memories: str | None = None
    min_relevance: str | None = None
    half_life_days: str | None = None
    distill_after: str | None = None
    auto_distill: str | None = None
    auto_extract: str | None = None
    core_context: str | None = None
    diversify: str | None = None
    max_context_tokens: str | None = None
    persona: str | None = None


class ImportIn(BaseModel):
    data: dict
    replace: bool = False


# --------------------------------------------------------------------------- #
# Prompt assembly — this is where memory actually enters the model
# --------------------------------------------------------------------------- #


ANSWER_STYLE = """# How to answer
- Lead with the answer, then justify it briefly. Be specific.
- Match length to the question. Use Markdown only when it helps.
- If you do not know, say so in one line and give the best next step."""


def fit_history(messages: list[dict], budget: int) -> list[dict]:
    """Keep the most recent turns that fit, but never drop the opening message.

    The first message usually carries the actual task, so silently truncating it
    out of a long chat is how assistants start answering the wrong question.
    """
    if budget <= 0 or not messages:
        return messages
    total = sum(estimate_tokens(m["content"]) for m in messages)
    if total <= budget:
        return messages
    head, rest = messages[0], messages[1:]
    kept: list[dict] = []
    used = estimate_tokens(head["content"])
    for m in reversed(rest):
        cost = estimate_tokens(m["content"])
        if used + cost > budget:
            break
        kept.insert(0, m)
        used += cost
    return [head, *kept]


def memory_bullet(m: dict) -> str:
    flags = []
    if m.get("pinned"):
        flags.append("pinned")
    if m.get("importance") and m["importance"] != "normal":
        flags.append(f"importance: {m['importance']}")
    suffix = f" | {' | '.join(flags)}" if flags else ""
    return f"- [{m['kind']}] {m['content']}{suffix}"


def build_system_prompt(persona: str, memories: list[dict], summary: str) -> str:
    parts = [
        persona.strip() or DEFAULTS["persona"],
        "",
        "# Memory",
        "You remember this user across conversations. The memories below were selected",
        "as relevant to the current message. Use them naturally as background — never",
        "announce that they were recalled, retrieved, injected or scored, and do not",
        "narrate your own memory.",
        "If the user contradicts a memory, trust the user: the memory is stale. Note the",
        "change in your answer and move on without making a production of it.",
    ]
    if memories:
        parts += ["", "## What you know about them", *[memory_bullet(m) for m in memories]]
    else:
        parts += ["", "## What you know about them", "(nothing yet — treat this as a first meeting)"]
    if summary:
        parts += ["", "## Earlier in this conversation", summary]
    parts += ["", ANSWER_STYLE]
    return "\n".join(parts)


def recall_for(s: MemoryStore, c: dict, uid: str, message: str, prior: list[dict]) -> list[dict]:
    """Memories for one turn: relevance first, then standing core memories.

    Runs in a worker thread (called through io()). Always scoped to `uid` —
    2.6.1 searched every visitor's bank here, so one browser's memories could
    be recalled into another's prompt.
    """
    # A short follow-up ("and for the tests?") carries almost no signal on its
    # own, so borrow the previous turn's vocabulary to retrieve with.
    query = message
    if len(message) < 60:
        prev_user = next((m["content"] for m in reversed(prior) if m["role"] == "user"), "")
        if prev_user:
            query = f"{message} {prev_user}"[:400]
    budget = int(c["max_memories"])
    recalled = s.search(
        query, budget, float(c["half_life_days"]), float(c["min_relevance"]),
        None, c.get("diversify") == "1", 0.6, uid,
    )
    for m in recalled:
        m["why"] = "matched"
    # Relevance is not the only reason to include something: identity and
    # standing preferences stay in context even when nothing matched.
    if c.get("core_context") == "1":
        for core in s.core_memories(3, uid):
            if len(recalled) >= budget or any(r["id"] == core["id"] for r in recalled):
                continue
            recalled.append(core)
    return recalled


async def learn_from(s: MemoryStore, candidates: list[dict], sid: str, uid: str) -> tuple[list, list]:
    """Save extracted memories into the caller's bank; retire what they correct."""
    saved, superseded = [], []
    for cand in candidates:
        if await io(s.similar, cand["content"], 0.86, uid):
            continue
        mem = await io(
            s.add_memory, cand["content"], cand["kind"], cand["tags"],
            "extract", sid, cand["importance"], False, None, uid,
        )
        saved.append(mem)
        # A correction should retire what it corrects, not sit next to it so
        # both versions get recalled and the model has to guess.
        stale = await io(s.conflicting, cand["content"], mem["id"], 0.1, uid)
        if stale:
            await io(s.supersede, stale["id"], mem["id"], uid)
            superseded.append({"old": stale, "new": mem})
    return saved, superseded


async def extract_memories(s: MemoryStore, c: dict, messages: list[dict]) -> list[dict]:
    """Ask the model for durable memories; fall back to heuristics offline."""
    if c.get("auto_extract") != "1":
        return []
    transcript = transcript_lines(messages, limit=12)
    last_user = next(
        (m["content"] for m in reversed(messages) if m["role"] == "user"), ""
    )
    if c["provider"] == "mock":
        return heuristic_extract(last_user)
    try:
        raw = await llm.complete(
            provider=c["provider"],
            model=c["model"],
            system=EXTRACT_SYSTEM,
            messages=[{"role": "user", "content": transcript}],
            api_key=c.get("api_key", ""),
            base_url=c.get("base_url", ""),
            temperature=0.1,
            max_tokens=700,
        )
    except llm.ProviderError:
        return heuristic_extract(last_user)
    parsed = json_from_text(raw)
    out = []
    if isinstance(parsed, dict):
        parsed = parsed.get("facts") or parsed.get("memories") or []
    for item in parsed if isinstance(parsed, list) else []:
        if isinstance(item, str):
            item = {"content": item}
        if not isinstance(item, dict):
            continue
        content = str(item.get("content", "")).strip()
        if not (4 <= len(content) <= 400):
            continue
        out.append(
            {
                "content": content,
                "kind": item.get("kind") if item.get("kind") in MEMORY_TYPES else "fact",
                "importance": item.get("importance")
                if item.get("importance") in ("low", "normal", "high")
                else "normal",
                "tags": [str(t) for t in (item.get("tags") or [])][:5],
            }
        )
        if len(out) >= 6:
            break
    return out


async def distill_session(s: MemoryStore, c: dict, sid: str, user_id: str | None = None) -> dict | None:
    """Compress the undistilled tail of a session into a summary + facts."""
    sess = s.get_session(sid, user_id=user_id)
    if not sess:
        return None
    msgs = s.messages(sid, user_id=user_id)
    tail = [m for m in msgs if m["id"] > (sess.get("distilled_until") or 0)]
    if len(tail) < 2:
        return None
    transcript = transcript_lines(tail, limit=40)
    summary, facts, threads = "", [], []
    if c["provider"] in ("mock", "local"):
        # No server-side model: distil with the offline heuristic pass.
        first_user = next((m["content"] for m in tail if m["role"] == "user"), "")
        summary = (
            f"Offline distillation of {len(tail)} messages, started with "
            f"“{first_user[:100]}”. "
            + " ".join(
                m["content"][:90]
                for m in tail
                if m["role"] == "user"
            )[:400]
        )
        facts = [
            f["content"]
            for f in heuristic_extract(
                " ".join(m["content"] for m in tail if m["role"] == "user")
            )
        ]
    else:
        try:
            raw = await llm.complete(
                provider=c["provider"],
                model=c["model"],
                system=DISTILL_SYSTEM,
                messages=[{"role": "user", "content": transcript}],
                api_key=c.get("api_key", ""),
                base_url=c.get("base_url", ""),
                temperature=0.2,
                max_tokens=900,
            )
            parsed = json_from_text(raw) or {}
            summary = str(parsed.get("summary", "")).strip()
            facts = [str(f).strip() for f in parsed.get("facts", []) if str(f).strip()]
            threads = [str(t).strip() for t in parsed.get("open_threads", []) if str(t).strip()]
        except llm.ProviderError:
            summary = ""
    if not summary:
        first_user = next((m["content"] for m in tail if m["role"] == "user"), "")
        summary = f"Conversation about “{first_user[:90]}” ({len(tail)} messages)."
    s.set_distilled_until(sid, tail[-1]["id"], user_id=user_id)
    s.add_message(sid, "system", summary, context={"distilled": True, "open_threads": threads, "covered": len(tail)}, user_id=user_id)
    s.add_memory(
        summary,
        kind="summary",
        tags=["distilled"] + (["threads"] if threads else []),
        source="distill",
        session_id=sid,
        importance="normal",
        user_id=user_id,
    )
    for f in facts[:8]:
        f = str(f).strip()
        if not (4 <= len(f) <= 400):
            continue
        if s.similar(f, 0.86, user_id=user_id):
            continue
        s.add_memory(f, kind="fact", tags=["distilled"], source="distill", session_id=sid, user_id=user_id)
    return {"summary": summary, "facts": facts, "open_threads": threads}


# --------------------------------------------------------------------------- #
# Routes: health / ui
# --------------------------------------------------------------------------- #


@app.get("/api/health")
async def health(request: Request):
    return {"ok": True, "app": "Archiver", "db": DB_PATH, "stats": store(request).stats(user_id=get_user_id(request))}


@app.get("/")
async def index():
    path = WEB_DIR / "index.html"
    if not path.exists():
        # Degrade loudly instead of raising: a missing asset used to surface as a
        # bare "Internal Server Error" with no hint of what was actually wrong.
        return JSONResponse(
            {
                "error": "index.html is missing",
                "expected": str(path),
                "hint": "The web/ directory must ship with the app. "
                        "API routes are unaffected.",
            },
            status_code=500,
        )
    return FileResponse(path)


def _web_file(name: str, media_type: str):
    path = WEB_DIR / name
    if path.exists():
        return FileResponse(path, media_type=media_type)
    return JSONResponse({"error": f"{name} is missing"}, status_code=404)


@app.get("/favicon.svg")
async def favicon():
    return _web_file("favicon.svg", "image/svg+xml")


# index.html and the manifest reference these at the root; without routes they
# 404'd and "Add to Home Screen" fell back to a screenshot icon.
@app.get("/apple-touch-icon.png")
async def touch_icon():
    return _web_file("apple-touch-icon.png", "image/png")


@app.get("/manifest.json")
async def manifest():
    return _web_file("manifest.json", "application/manifest+json")


# --------------------------------------------------------------------------- #
# Routes: memories
# --------------------------------------------------------------------------- #


@app.get("/api/memories")
async def list_memories(
    request: Request, q: str = "", limit: int = 200, include_superseded: bool = False
):
    s = store(request)
    uid = get_user_id(request)
    limit = max(1, min(1000, limit))
    if q.strip():
        return await io(s.search, q, limit, float(cfg(request)["half_life_days"]), user_id=uid)
    return (await io(s.all_memories, include_superseded, uid))[:limit]


@app.post("/api/memories/{mid}/supersede")
async def supersede_memory(request: Request, mid: str, body: dict):
    """Retire a memory in favour of another, keeping the record for the archive."""
    s = store(request)
    uid = get_user_id(request)
    new_id = str(body.get("by", "")).strip()
    if not s.get_memory(mid, user_id=uid):
        raise HTTPException(404, "memory not found")
    if not s.get_memory(new_id, user_id=uid):
        raise HTTPException(404, "replacement memory not found")
    return await io(s.supersede, mid, new_id, uid)


@app.post("/api/memories", status_code=201)
async def create_memory(request: Request, body: MemoryIn):
    s = store(request)
    uid = get_user_id(request)
    if not body.content.strip():
        raise HTTPException(400, "content is required")
    if body.kind not in MEMORY_TYPES:
        raise HTTPException(400, f"kind must be one of {', '.join(MEMORY_TYPES)}")
    dup = await io(s.similar, body.content, 0.9, uid)
    mem = await io(
        s.add_memory,
        body.content,
        body.kind,
        body.tags,
        "manual",
        body.session_id,
        body.importance,
        body.pinned,
        None,
        uid,
    )
    return {"memory": mem, "duplicate_of": dup["id"] if dup else None}


@app.patch("/api/memories/{mid}")
async def patch_memory(request: Request, mid: str, body: MemoryPatch):
    s = store(request)
    uid = get_user_id(request)
    if not await io(s.get_memory, mid, uid):
        raise HTTPException(404, "memory not found")
    fields = body.model_dump(exclude_none=True)
    if "content" in fields and not fields["content"].strip():
        raise HTTPException(400, "content cannot be empty")
    mem = await io(s.update_memory, mid, uid, **fields)
    if not mem:
        raise HTTPException(404, "memory not found")
    return mem


@app.delete("/api/memories/{mid}")
async def delete_memory(request: Request, mid: str):
    s = store(request)
    uid = get_user_id(request)
    if not await io(s.get_memory, mid, uid):
        raise HTTPException(404, "memory not found")
    await io(s.delete_memory, mid, uid)
    return {"deleted": mid}


@app.post("/api/memories/{mid}/restore")
async def restore_memory(request: Request, mid: str):
    """Bring back a memory that was retired by an automatic correction."""
    s = store(request)
    uid = get_user_id(request)
    if not s.get_memory(mid, user_id=uid):
        raise HTTPException(404, "memory not found")
    return await io(s.restore, mid, uid)


@app.post("/api/memories/{mid}/pin")
async def pin_memory(request: Request, mid: str):
    s = store(request)
    uid = get_user_id(request)
    mem = s.get_memory(mid, user_id=uid)
    if not mem:
        raise HTTPException(404, "memory not found")
    return await io(s.update_memory, mid, uid, pinned=not mem["pinned"])


@app.post("/api/memories/search")
async def search_memories(request: Request, body: dict):
    s = store(request)
    c = cfg(request)
    uid = get_user_id(request)
    try:
        limit = max(1, min(50, int(body.get("limit", 6))))
    except (TypeError, ValueError):
        limit = 6
    return await io(
        s.search,
        str(body.get("q", "")),
        limit,
        float(c["half_life_days"]),
        float(c["min_relevance"]),
        None,
        True,
        0.6,
        uid,
    )


# --------------------------------------------------------------------------- #
# Routes: sessions
# --------------------------------------------------------------------------- #


def normalise_role(role) -> str:
    """Map client role names onto the three the model understands.

    The browser stored its own turns as role "archiver" in 2.6.1, which every
    history filter then silently dropped — the model never saw its own previous
    answers, so follow-ups had nothing to follow.
    """
    role = str(role or "").strip().lower()
    if role in ("assistant", "archiver", "ai", "bot", "model"):
        return "assistant"
    if role in ("user", "system"):
        return role
    return ""


class SyncSessionItem(BaseModel):
    id: str
    title: str = "New chat"
    messages: list[dict] = []

class SyncIn(BaseModel):
    sessions: list[SyncSessionItem] = []


@app.post("/api/sessions/sync")
async def sync_sessions(request: Request, body: SyncIn):
    s = store(request)
    uid = get_user_id(request)
    synced = []
    for item in body.sessions:
        sid = item.id.strip()
        if not sid:
            continue
        sess = await io(s.create_session, (item.title or "New chat")[:120], sid, uid)
        if not sess:
            continue  # the id belongs to a session this browser cannot see
        sid = sess["id"]
        # Rehydrate messages if session had none on server
        curr_msgs = await io(s.messages, sid, 0, uid)
        if not curr_msgs and item.messages:
            for m in item.messages[:2000]:
                role = normalise_role(m.get("role"))
                content = str(m.get("content") or "")
                if not role or not content.strip():
                    continue
                ctx = m.get("context") if isinstance(m.get("context"), list) else None
                created = m.get("created_at")
                try:
                    created = float(created) if created else None
                except (TypeError, ValueError):
                    created = None
                await io(s.add_message, sid, role, content, ctx, created, uid)
        synced.append(sid)
    return {"ok": True, "synced": len(synced)}


@app.get("/api/sessions")
async def list_sessions(request: Request):
    uid = get_user_id(request)
    return await io(store(request).list_sessions, uid)


@app.delete("/api/sessions")
async def delete_all_sessions(request: Request):
    s = store(request)
    uid = get_user_id(request)
    sessions = await io(s.list_sessions, uid)
    for sess in sessions:
        await io(s.delete_session, sess["id"], uid)
    return {"deleted_all": True, "count": len(sessions)}


@app.post("/api/sessions", status_code=201)
async def create_session(request: Request, body: SessionIn):
    uid = get_user_id(request)
    return await io(store(request).create_session, body.title, body.id, uid)


@app.get("/api/sessions/{sid}")
async def get_session(request: Request, sid: str):
    s = store(request)
    uid = get_user_id(request)
    sess = await io(s.get_session, sid, uid)
    if not sess:
        raise HTTPException(404, "session not found")
    sess["messages"] = await io(s.messages, sid, 0, uid)
    return sess


@app.patch("/api/sessions/{sid}")
async def rename_session(request: Request, sid: str, body: RenameIn):
    uid = get_user_id(request)
    sess = await io(store(request).rename_session, sid, body.title[:120], uid)
    if not sess:
        raise HTTPException(404, "session not found")
    return sess


@app.delete("/api/sessions/{sid}")
async def delete_session(request: Request, sid: str):
    s = store(request)
    uid = get_user_id(request)
    if not await io(s.get_session, sid, uid):
        raise HTTPException(404, "session not found")
    await io(s.delete_session, sid, uid)
    return {"deleted": sid}


@app.post("/api/sessions/{sid}/distill")
async def force_distill(request: Request, sid: str):
    s, c = store(request), cfg(request)
    uid = get_user_id(request)
    if not await io(s.get_session, sid, uid):
        raise HTTPException(404, "session not found")
    result = await distill_session(s, c, sid, uid)
    if not result:
        raise HTTPException(400, "nothing new to distill")
    return result


@app.get("/api/sessions/{sid}/export")
async def export_session(request: Request, sid: str):
    s = store(request)
    uid = get_user_id(request)
    sess = s.get_session(sid, user_id=uid)
    if not sess:
        raise HTTPException(404, "session not found")
    msgs = s.messages(sid, user_id=uid)
    summaries = [m for m in msgs if m["role"] == "system"]
    lines = [f"# {sess['title']}", "", f"_Session `{sid}` — {len(msgs)} messages_", ""]
    if summaries:
        lines += ["## Distilled summaries", ""]
        for m in summaries:
            lines += [f"- {m['content']}", ""]
    lines += ["## Transcript", ""]
    for m in msgs:
        if m["role"] == "system":
            continue
        lines += [f"**{m['role'].upper()}**", "", m["content"], ""]
    from fastapi.responses import PlainTextResponse

    return PlainTextResponse(
        "\n".join(lines),
        headers={"Content-Disposition": f'attachment; filename="archiver-{re.sub(r"[^A-Za-z0-9_-]", "", sid)[:64] or "session"}.md"'},
    )


# --------------------------------------------------------------------------- #
# Routes: chat (SSE)
# --------------------------------------------------------------------------- #


def sse(event: str, payload: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


async def open_session(s: MemoryStore, uid: str, session_id: str | None, message: str) -> dict:
    """The caller's session, created on first use.

    create_session() swaps in a fresh id when the requested one belongs to
    somebody else, so the returned id is the one to use from here on.
    """
    sess = await io(s.get_session, session_id, uid) if session_id else None
    if not sess:
        sess = await io(s.create_session, message[:60], session_id, uid)
    return sess


@app.post("/api/chat")
async def chat(request: Request, body: ChatIn):
    s, c = store(request), cfg(request)
    uid = get_user_id(request)
    message = body.message.strip()
    if not message:
        raise HTTPException(400, "message is required")

    sess = await open_session(s, uid, body.session_id, message)
    sid = sess["id"]

    await io(s.add_message, sid, "user", message, None, None, uid)

    async def stream() -> AsyncIterator[str]:
        yield sse("session", sess)
        try:
            history = await io(s.messages, sid, 0, uid)
            prior = [m for m in history[:-1] if m["role"] in ("user", "assistant")]
            # distillations are stored as system messages: they are the compressed
            # stand-in for everything the raw transcript no longer needs to carry.
            summaries = [m["content"] for m in history if m["role"] == "system"][-3:]
            recalled = await io(recall_for, s, c, uid, message, prior)
            system = build_system_prompt(c["persona"], recalled, "\n".join(summaries))
            history = fit_history(
                [
                    {"role": m["role"], "content": m["content"]}
                    for m in prior
                    if m["role"] in ("user", "assistant")
                ][-MAX_INPUT_MESSAGES:],
                int(c["max_context_tokens"]),
            )
            payload = history + [{"role": "user", "content": message}]

            yield sse(
                "context",
                {
                    "memories": recalled,
                    "summary": "\n".join(summaries),
                    "system": system,
                    "prompt_tokens": estimate_tokens(system + json.dumps(payload)),
                    "messages_sent": len(payload),
                },
            )
            await io(s.touch, [m["id"] for m in recalled], uid)

            chunks: list[str] = []
            async for delta in llm.stream_completion(
                provider=c["provider"],
                model=c["model"],
                system=system,
                messages=payload,
                api_key=c.get("api_key", ""),
                base_url=c.get("base_url", ""),
                max_tokens=1024,
            ):
                chunks.append(delta)
                yield sse("delta", {"text": delta})
            answer = "".join(chunks).strip()
            if not answer:
                answer = "(the model returned an empty response)"
            msg = await io(s.add_message, sid, "assistant", answer,
                           [{"id": m["id"], "content": m["content"]} for m in recalled], None, uid)
            yield sse("assistant", {"message": msg})

            # auto-title
            if sess["title"] in ("New chat", "Untitled") and message:
                await io(s.rename_session, sid, message[:60], uid)
                yield sse("session", await io(s.get_session, sid, uid))

            # learn — only from what the user said, never from the model's reply
            candidates = await extract_memories(s, c, [payload[-1]])
            saved, superseded = await learn_from(s, candidates, sid, uid)
            if saved:
                yield sse("memories_saved", {"memories": saved})
            if superseded:
                yield sse("memories_superseded", {"updates": superseded})

            distilled = None
            after = await io(s.messages, sid, 0, uid)
            threshold = int(c["distill_after"])
            undistilled = [
                m for m in after
                if m["id"] > (sess.get("distilled_until") or 0) and m["role"] != "system"
            ]
            if c["auto_distill"] == "1" and len(undistilled) >= threshold:
                distilled = await distill_session(s, c, sid, uid)
                if distilled:
                    yield sse("distilled", distilled)

            yield sse("done", {"session_id": sid, "stats": s.stats(user_id=uid)})
        except llm.ProviderError as exc:
            yield sse("error", {"message": str(exc)})
        except Exception as exc:  # pragma: no cover - defensive
            yield sse("error", {"message": f"{type(exc).__name__}: {exc}"})

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/chat/prepare")
async def chat_prepare(request: Request, body: ChatIn):
    """Stage one of a chat turn: memory work, no generation.

    Generation happens in the visitor's browser on a local model, so the server
    no longer calls a provider and there is no API key anywhere in the system.
    This endpoint does everything that must be server-side — session handling,
    retrieval, prompt assembly — and hands the browser the prompt to answer.
    """
    s, c = store(request), cfg(request)
    uid = get_user_id(request)
    message = body.message.strip()
    if not message:
        raise HTTPException(400, "message is required")

    sess = await open_session(s, uid, body.session_id, message)
    sid = sess["id"]
    await io(s.add_message, sid, "user", message, None, None, uid)

    history = await io(s.messages, sid, 0, uid)
    prior = [m for m in history[:-1] if m["role"] in ("user", "assistant")]
    summaries = [m["content"] for m in history if m["role"] == "system"][-3:]
    recalled = await io(recall_for, s, c, uid, message, prior)

    system = build_system_prompt(c["persona"], recalled, "\n".join(summaries))
    fit = fit_history(
        [{"role": m["role"], "content": m["content"]} for m in prior
         if m["role"] in ("user", "assistant")][-MAX_INPUT_MESSAGES:],
        int(c["max_context_tokens"]),
    )
    await io(s.touch, [m["id"] for m in recalled], uid)

    return {
        "session_id": sid,
        "session": await io(s.get_session, sid, uid),
        "message": message,
        "system": system,
        "history": fit,
        "memories": recalled,
        "summary": "\n".join(summaries),
        "distill_after": int(c["distill_after"]),
        "auto_distill": c["auto_distill"] == "1",
        "undistilled": len([
            m for m in history
            if m["id"] > (sess.get("distilled_until") or 0) and m["role"] != "system"
        ]) + 1,
    }


class CommitIn(BaseModel):
    session_id: str
    message: str
    answer: str
    memory_ids: list[str] = []
    summary: str | None = None
    facts: list[str] = []
    open_threads: list[str] = []


@app.post("/api/chat/commit")
async def chat_commit(request: Request, body: CommitIn):
    """Stage two: store the locally generated answer and learn from the turn.

    Memory extraction uses the offline heuristic pass. That is deliberate: the
    server has no model of its own to call, and a browser-side extraction step
    would mean trusting the client for writes to someone's memory bank.
    """
    s, c = store(request), cfg(request)
    uid = get_user_id(request)
    sid = body.session_id
    if not await io(s.get_session, sid, uid):
        raise HTTPException(404, "session not found")

    answer = (body.answer or "").strip() or "(the model returned an empty response)"
    recalled = [{"id": i, "content": ""} for i in body.memory_ids[:50]]
    for r in recalled:
        mem = await io(s.get_memory, r["id"], uid)
        if mem:
            r["content"] = mem["content"]
    msg = await io(
        s.add_message, sid, "assistant", answer,
        [{"id": r["id"], "content": r["content"]} for r in recalled if r["content"]],
        None, uid,
    )

    if body.summary:
        await io(s.add_message, sid, "system", body.summary, None, None, uid)

    # auto-title
    sess = await io(s.get_session, sid, uid)
    if sess and sess["title"] in ("New chat", "Untitled") and body.message:
        await io(s.rename_session, sid, body.message[:60], uid)

    saved, superseded = [], []
    if c.get("auto_extract") == "1":
        saved, superseded = await learn_from(s, heuristic_extract(body.message), sid, uid)

    distilled = None
    if body.facts or body.open_threads:
        distilled = {"summary": body.summary, "facts": body.facts, "open_threads": body.open_threads}
    elif c.get("auto_distill") == "1":
        # The setting existed but nothing ever acted on it. Compress the chat
        # once enough undistilled messages have built up.
        sess = await io(s.get_session, sid, uid)
        msgs = await io(s.messages, sid, 0, uid)
        pending = [m for m in msgs
                   if m["id"] > ((sess or {}).get("distilled_until") or 0) and m["role"] != "system"]
        if len(pending) >= int(c["distill_after"]):
            distilled = await distill_session(s, c, sid, uid)

    return {
        "message": msg,
        "session": await io(s.get_session, sid, uid),
        "memories_saved": saved,
        "memories_superseded": superseded,
        "distilled": distilled,
        "stats": s.stats(user_id=uid),
    }


# --------------------------------------------------------------------------- #
# Routes: settings / archive
# --------------------------------------------------------------------------- #


@app.get("/api/settings")
async def get_settings(request: Request):
    uid = get_user_id(request)
    out = cfg(request)
    out.pop("api_key", None)
    # Generation is local to the visitor's browser; the server holds no provider
    # credentials and exposes no key field. `llm.py` remains for the offline
    # mock used in tests, not as a hosted provider.
    out["providers"] = {"local": {"default_model": MODEL_LABEL, "default_base_url": ""}}
    out["has_api_key"] = False
    out["default_persona"] = PERSONA
    out["version"] = __version__
    return out


@app.put("/api/settings")
async def put_settings(request: Request, body: SettingsIn):
    s = store(request)
    uid = get_user_id(request)
    limits = {k: (lo, hi, kind) for k, lo, hi, kind in NUMERIC_SETTINGS}
    for key, value in body.model_dump(exclude_none=True).items():
        # The server never talks to a provider, so it never stores credentials.
        if key in ("api_key", "provider", "base_url", "model"):
            continue
        value = str(value)
        if key in limits:
            lo, hi, kind = limits[key]
            try:
                value = str(max(lo, min(hi, kind(value))))
            except ValueError:
                raise HTTPException(400, f"{key} must be a number")
        elif key in ("auto_distill", "auto_extract", "core_context", "diversify"):
            value = "1" if value in ("1", "true", "True", "on") else "0"
        elif key == "persona":
            # An emptied box means "use the default", not "have no persona".
            value = value.strip()[:8000] or PERSONA
        await io(s.set_setting, key, value, uid)
    return await get_settings(request)


@app.get("/api/search/diag")
async def search_diag(q: str = "Battle of Kursk"):
    """Probe every search provider from this host. Debugging aid.

    Search failures used to be invisible: the app just looked broken with no
    indication which upstream was refusing. This reports each provider's status
    and the host's own IP, so blocking can be identified rather than guessed.
    """
    from . import search as search_mod

    return await search_mod.diag(q)


@app.get("/api/search")
async def web_search(q: str, limit: int = 3):
    """Keyless web grounding. Retrieval only — nothing is generated here.

    Called by the browser when the SEARCH toggle is on, and the results are
    handed to the local model as sourced notes.
    """
    if not q.strip():
        raise HTTPException(400, "q is required")
    from . import search as search_mod

    return await search_mod.search(q[:300], limit)


@app.get("/api/archive/export")
async def archive_export(request: Request):
    uid = get_user_id(request)
    blob = await io(store(request).export, uid)
    return JSONResponse(
        blob,
        headers={"Content-Disposition": 'attachment; filename="archiver-archive.json"'},
    )


@app.post("/api/archive/import")
async def archive_import(request: Request, body: ImportIn):
    uid = get_user_id(request)
    return await io(store(request).import_data, body.data, body.replace, uid)


@app.get("/api/stats")
async def stats(request: Request):
    uid = get_user_id(request)
    return store(request).stats(user_id=uid)


def main() -> None:  # pragma: no cover
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8000")),
        reload=False,
    )


if __name__ == "__main__":  # pragma: no cover
    main()
