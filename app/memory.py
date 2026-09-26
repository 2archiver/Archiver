"""Archiver — the memory engine.

No vector database, no external embedding API. Memories are stored in SQLite
(next to the app, or in the browser's origin when used standalone) and scored
with a hybrid retriever:

    score = relevance * (decay * importance_weight)

  * relevance  = 0.62 * cosine(hashed n-gram vectors) + 0.38 * BM25(FTS5)
  * decay      = 0.5 ** (age_days / half_life)   (pinned memories never decay)
  * importance = 1.0 for normal, 1.25 for high, 0.85 for low

Everything here is pure standard library, so it runs anywhere Python 3.11+ runs.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
import threading
import time
import uuid
from collections import Counter
from pathlib import Path

DEFAULT_HALF_LIFE_DAYS = 90.0
EMBED_DIM = 768
MAX_NGRAM = 3
MIN_TOKEN = 2

MEMORY_TYPES = ("fact", "preference", "decision", "episode", "summary")
IMPORTANCE = ("low", "normal", "high")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS memories (
    id           TEXT PRIMARY KEY,
    content      TEXT NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'fact',
    tags         TEXT NOT NULL DEFAULT '[]',
    source       TEXT NOT NULL DEFAULT 'manual',
    session_id   TEXT,
    importance   TEXT NOT NULL DEFAULT 'normal',
    pinned       INTEGER NOT NULL DEFAULT 0,
    created_at   REAL NOT NULL,
    last_used    REAL,
    hits         INTEGER NOT NULL DEFAULT 0,
    embedding    TEXT NOT NULL DEFAULT '{}',
    superseded_by TEXT,
    user_id      TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);

CREATE TABLE IF NOT EXISTS settings (
    user_id TEXT NOT NULL DEFAULT '',
    key     TEXT NOT NULL,
    value   TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS sessions (
    id             TEXT PRIMARY KEY,
    title          TEXT NOT NULL DEFAULT 'New chat',
    created_at     REAL NOT NULL,
    updated_at     REAL NOT NULL,
    distilled_until INTEGER NOT NULL DEFAULT 0,
    user_id        TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at REAL NOT NULL,
    context    TEXT,
    user_id    TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
"""

_FTS_SCHEMA = """
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    memory_id UNINDEXED,
    body,
    tokenize = 'unicode61'
);
"""


def now() -> float:
    return time.time()


def new_id(prefix: str = "") -> str:
    raw = uuid.uuid4().hex[:12]
    return f"{prefix}{raw}" if prefix else raw


# --------------------------------------------------------------------------- #
# Embeddings: hashed character n-grams. Cheap, deterministic, dependency-free.
# --------------------------------------------------------------------------- #

_WS = re.compile(r"[^a-z0-9']+")

# --------------------------------------------------------------------------- #
# Topical bridging
#
# Hashed n-grams only match shared vocabulary, so "what stack should I use?"
# never meets "prefers Python over Node" — no common words at all. Tagging both
# sides with a coarse topic token creates that bridge without an embedding API.
# The token is written as one word ("tprog") so SQLite's unicode61 tokenizer
# keeps it intact instead of splitting it into two useful-looking terms.
# --------------------------------------------------------------------------- #

TOPICS: dict[str, tuple[str, ...]] = {
    "prog": ("python", "node", "javascript", "typescript", "rust", "golang", "go",
             "java", "ruby", "php", "csharp", "swift", "kotlin", "elixir", "haskell",
             "stack", "programming", "framework", "library", "codebase"),
    "web": ("react", "vue", "svelte", "angular", "html", "css", "tailwind", "frontend",
            "website", "browser", "webapp"),
    "api": ("api", "backend", "server", "rest", "graphql", "grpc", "endpoint",
            "microservice", "service", "webhook"),
    "db": ("postgres", "postgresql", "mysql", "sqlite", "mongo", "mongodb", "redis",
           "database", "schema", "sql", "migration", "query", "index", "orm"),
    "ops": ("docker", "kubernetes", "deploy", "deployment", "pipeline", "terraform",
            "ansible", "aws", "gcp", "azure", "github", "gitlab", "ci", "cd", "git",
            "branch", "merge", "release", "helm"),
    "editor": ("neovim", "vim", "vscode", "editor", "ide", "terminal", "shell", "zsh",
               "bash", "dotfiles", "config"),
    "test": ("pytest", "jest", "cypress", "playwright", "coverage", "spec", "unittest",
             "fixture", "mock"),
    "sec": ("password", "secret", "auth", "token", "encrypt", "oauth", "ssh", "vault",
            "credential", "security"),
    "ai": ("llm", "gpt", "claude", "gemini", "prompt", "embedding", "agent", "rag",
           "finetune", "inference", "model"),
    "design": ("figma", "design", "layout", "logo", "palette", "theme", "typography",
               "brand", "ux"),
    "work": ("job", "employer", "company", "team", "manager", "salary", "role",
             "career", "interview", "startup", "client"),
    "personal": ("name", "birthday", "timezone", "partner", "wife", "husband", "dog",
                 "cat", "kid", "family", "hobby", "health", "diet"),
    "geo": ("sydney", "melbourne", "brisbane", "perth", "adelaide", "london", "berlin",
            "tokyo", "city", "country", "office", "remote"),
    "hardware": ("laptop", "macbook", "mac", "keyboard", "monitor", "phone", "iphone",
                 "android", "gpu", "server"),
}

_TOPIC_INDEX = {word: f"t{topic}" for topic, words in TOPICS.items() for word in words}

# Verbs that carry a stance. Any of them marks a memory as the kind of thing
# that can be corrected later.
STANCE_VERBS = {"prefer", "like", "love", "hate", "use", "want", "need", "live", "work"}

# Words that say nothing about *what* a memory is about, so they must not be what
# links two memories together. Stemmed forms, since tokens() already stems.
NON_SUBJECT = {
    "i", "you", "the", "a", "an", "to", "for", "over", "now", "actual", "my", "your",
    "our", "we", "is", "are", "of", "in", "on", "at", "and", "or", "than", "realli",
    "veri", "every", "all", "that", "this", "it", "be", "do", "not", "with", "from",
    *STANCE_VERBS,
}


def stance_of(text: str) -> set[str]:
    """Stance verbs in a sentence, stemmed (tokens() already stems)."""
    return {t for t in tokens(text) if t in STANCE_VERBS}


def subject_terms(text: str) -> set[str]:
    """The substantive words: what the memory is actually about."""
    return {t for t in tokens(text) if t not in NON_SUBJECT and len(t) >= 3}

# Bump when embed()/tokenisation changes: stored vectors and the FTS index are
# rebuilt on startup so an existing bank never mixes embedding generations.
EMBED_VERSION = "5"

_SUFFIXES = (("ies", "y"), ("ing", ""), ("edly", ""), ("ed", ""), ("ly", ""), ("es", ""), ("s", ""))

# Doubled finals that survive suffix stripping ("falling" -> "fall", not "fal").
_DOUBLE_KEEP = {"ll", "ss", "ee", "ff", "oo", "zz"}
_CONSONANT = re.compile(r"([b-df-hj-np-tv-xz])\1$")


def stem(token: str) -> str:
    """Very light suffix stripping.

    Not a real stemmer, but it makes `prefer`/`prefers` and `run`/`running` land
    on the same token, which matters far more than perfect linguistics here:
    without it, keyword retrieval misses most natural-language questions.
    """
    if len(token) <= 3:
        return token
    for suffix, replacement in _SUFFIXES:
        if token.endswith(suffix) and len(token) - len(suffix) >= 3:
            token = token[: -len(suffix)] + replacement
            break
    # "running" -> "runn" -> "run"
    if token[-2:] not in _DOUBLE_KEEP:
        token = _CONSONANT.sub(r"\1", token)
    # "databases" -> "databas" and "database" -> "databas" must agree
    if len(token) > 3 and token.endswith("e"):
        token = token[:-1]
    return token


def normalize(text: str) -> str:
    return _WS.sub(" ", text.lower()).strip()


def topics(text: str) -> list[str]:
    """Coarse topic tags for a piece of text, as synthetic bridging tokens."""
    return sorted({_TOPIC_INDEX[w] for w in normalize(text).split() if w in _TOPIC_INDEX})


def tokens(text: str) -> list[str]:
    return [stem(t) for t in normalize(text).split() if len(t) >= MIN_TOKEN]


def index_text(text: str) -> str:
    """Vocabulary used for both embeddings and the keyword index."""
    return " ".join(tokens(text) + topics(text))


def _stable_hash(gram: str) -> int:
    """Deterministic 64-bit hash.

    Python's built-in hash() is salted per process, so using it here would make
    every stored embedding meaningless the moment the server restarts. Vectors
    are persisted, so the hash must be reproducible forever.
    """
    return int.from_bytes(hashlib.blake2b(gram.encode("utf-8"), digest_size=8).digest(), "big")


def embed(text: str) -> dict[str, float]:
    """Hashed n-gram vector as a sparse {index: weight} dict."""
    toks = index_text(text).split()
    grams: list[str] = []
    for n in (1, 2, MAX_NGRAM):
        for i in range(len(toks) - n + 1):
            grams.append(" ".join(toks[i : i + n]))
    vec: Counter[int] = Counter()
    for g in grams:
        h = _stable_hash(g)
        idx = h % EMBED_DIM
        sign = 1.0 if (h >> 20) & 1 else -1.0
        vec[idx] += sign
    norm = math.sqrt(sum(v * v for v in vec.values())) or 1.0
    return {str(k): v / norm for k, v in vec.items() if abs(v) > 1e-9}


def cosine(a: dict[str, float], b: dict[str, float]) -> float:
    if not a or not b:
        return 0.0
    if len(a) > len(b):
        a, b = b, a
    dot = sum(w * b[k] for k, w in a.items() if k in b)
    return max(0.0, min(1.0, dot))


def _load(vec_json: str) -> dict[str, float]:
    try:
        return json.loads(vec_json)
    except (TypeError, ValueError):
        return {}


# --------------------------------------------------------------------------- #
# Store
# --------------------------------------------------------------------------- #


class MemoryStore:
    """SQLite-backed memory bank + session log."""

    def __init__(self, path: str | Path = "archiver.db"):
        self.path = str(path)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript(_SCHEMA)
        self._migrate()
        self.fts = self._try_fts()
        self._conn.commit()

    def _migrate(self) -> None:
        """Add columns introduced after a database was first created."""
        cols = {r["name"] for r in self._conn.execute("PRAGMA table_info(memories)")}
        if "superseded_by" not in cols:
            self._conn.execute("ALTER TABLE memories ADD COLUMN superseded_by TEXT")
            self._conn.commit()
        # --- per-user isolation: add user_id columns ---
        for tbl, idx in [("memories", "idx_memories_user"), ("sessions", "idx_sessions_user"), ("messages", "idx_messages_user")]:
            try:
                cols = {r["name"] for r in self._conn.execute(f"PRAGMA table_info({tbl})")}
                if "user_id" not in cols:
                    self._conn.execute(f"ALTER TABLE {tbl} ADD COLUMN user_id TEXT")
                    self._conn.execute(f"CREATE INDEX IF NOT EXISTS {idx} ON {tbl}(user_id)")
                    self._conn.commit()
            except Exception:
                pass
        # settings: migrate to per-user (user_id, key) PK
        try:
            cols = {r["name"] for r in self._conn.execute("PRAGMA table_info(settings)")}
            if "user_id" not in cols:
                # preserve old global settings
                try:
                    self._conn.execute("ALTER TABLE settings RENAME TO settings_old")
                except Exception:
                    pass
                self._conn.execute(
                    "CREATE TABLE IF NOT EXISTS settings ("
                    " user_id TEXT NOT NULL DEFAULT '',"
                    " key TEXT NOT NULL,"
                    " value TEXT NOT NULL,"
                    " PRIMARY KEY (user_id, key)"
                    ")"
                )
                try:
                    self._conn.execute("INSERT OR IGNORE INTO settings(user_id, key, value) SELECT '', key, value FROM settings_old")
                except Exception:
                    pass
                self._conn.commit()
        except Exception:
            pass

    def _try_fts(self) -> bool:
        try:
            self._conn.executescript(_FTS_SCHEMA)
            self._conn.commit()
            return True
        except sqlite3.OperationalError:
            return False

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # -- settings ---------------------------------------------------------- #

    def get_setting(self, key: str, default: str = "", user_id: str | None = None) -> str:
        uid = user_id or ""
        with self._lock:
            row = self._conn.execute(
                "SELECT value FROM settings WHERE user_id = ? AND key = ?", (uid, key)
            ).fetchone()
            # fallback to global '' for legacy banks that haven't been namespaced yet
            if not row and uid != "":
                row = self._conn.execute(
                    "SELECT value FROM settings WHERE user_id = '' AND key = ?", (key,)
                ).fetchone()
        return row["value"] if row else default

    def set_setting(self, key: str, value: str, user_id: str | None = None) -> None:
        uid = user_id or ""
        with self._lock:
            self._conn.execute(
                "INSERT INTO settings(user_id, key, value) VALUES(?, ?, ?) "
                "ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value",
                (uid, key, str(value)),
            )
            self._conn.commit()

    def settings(self, secret: bool = False, user_id: str | None = None) -> dict[str, str]:
        uid = user_id or ""
        with self._lock:
            rows = self._conn.execute("SELECT key, value FROM settings WHERE user_id = ?", (uid,)).fetchall()
            if not rows and uid != "":
                rows = self._conn.execute("SELECT key, value FROM settings WHERE user_id = ''").fetchall()
        out = {r["key"]: r["value"] for r in rows}
        if not secret and "api_key" in out and out["api_key"]:
            out["api_key"] = "•" * 8
        return out

    def reset_settings(self, defaults: dict[str, str], user_id: str | None = None) -> None:
        """Replace a user's settings with the shipped defaults.

        Restoring defaults is deliberately different from applying migrations:
        migrations preserve custom persona/settings, while this explicit action
        also removes retired provider credentials from the user's settings row.
        """
        uid = user_id or ""
        with self._lock:
            self._conn.execute("DELETE FROM settings WHERE user_id = ?", (uid,))
            self._conn.executemany(
                "INSERT INTO settings(user_id, key, value) VALUES(?, ?, ?)",
                [(uid, key, str(value)) for key, value in defaults.items()],
            )
            self._conn.commit()

    # -- sessions ---------------------------------------------------------- #

    def create_session(self, title: str = "New chat", session_id: str | None = None, user_id: str | None = None) -> dict:
        sid = (session_id or "").strip() or new_id("s_")
        t = now()
        uid = user_id or ""
        with self._lock:
            # Check if session id already exists with different owner - generate new id
            existing = self._conn.execute("SELECT user_id FROM sessions WHERE id = ?", (sid,)).fetchone()
            if existing and existing["user_id"] not in (None, "", uid):
                # collision with another user's session - generate fresh
                sid = new_id("s_")
            self._conn.execute(
                "INSERT INTO sessions(id, title, created_at, updated_at, user_id) VALUES(?,?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET title = CASE WHEN sessions.title IN ('New chat', 'Untitled') THEN excluded.title ELSE sessions.title END, updated_at = excluded.updated_at",
                (sid, title, t, t, uid),
            )
            self._conn.commit()
        return self.get_session(sid, user_id=user_id)  # type: ignore[return-value]

    def get_session(self, sid: str, user_id: str | None = None) -> dict | None:
        with self._lock:
            if user_id is not None:
                row = self._conn.execute(
                    "SELECT * FROM sessions WHERE id = ? AND user_id = ?", (sid, user_id or "")
                ).fetchone()
            else:
                row = self._conn.execute(
                    "SELECT * FROM sessions WHERE id = ?", (sid,)
                ).fetchone()
        return dict(row) if row else None

    def list_sessions(self, user_id: str | None = None) -> list[dict]:
        with self._lock:
            if user_id is not None:
                rows = self._conn.execute(
                    "SELECT s.*, "
                    "  (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count, "
                    "  (SELECT m.content FROM messages m WHERE m.session_id = s.id ORDER BY m.id DESC LIMIT 1) AS last_message "
                    "FROM sessions s WHERE s.user_id = ? ORDER BY s.updated_at DESC",
                    (user_id or "",)
                ).fetchall()
            else:
                rows = self._conn.execute(
                    "SELECT s.*, "
                    "  (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count, "
                    "  (SELECT m.content FROM messages m WHERE m.session_id = s.id ORDER BY m.id DESC LIMIT 1) AS last_message "
                    "FROM sessions s ORDER BY s.updated_at DESC"
                ).fetchall()
        return [dict(r) for r in rows]

    def rename_session(self, sid: str, title: str, user_id: str | None = None) -> dict | None:
        with self._lock:
            if user_id is not None:
                self._conn.execute(
                    "UPDATE sessions SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?",
                    (title.strip() or "Untitled", now(), sid, user_id or ""),
                )
            else:
                self._conn.execute(
                    "UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?",
                    (title.strip() or "Untitled", now(), sid),
                )
            self._conn.commit()
        return self.get_session(sid, user_id=user_id)

    def delete_session(self, sid: str, user_id: str | None = None) -> None:
        with self._lock:
            if user_id is not None:
                # only delete if owned by this user (or unowned)
                row = self._conn.execute("SELECT user_id FROM sessions WHERE id = ?", (sid,)).fetchone()
                if row and row["user_id"] not in (None, "", user_id):
                    return
            self._conn.execute("DELETE FROM messages WHERE session_id = ?", (sid,))
            self._conn.execute("DELETE FROM sessions WHERE id = ?", (sid,))
            self._conn.commit()

    def add_message(
        self,
        sid: str,
        role: str,
        content: str,
        context: list[dict] | dict | None = None,
        created_at: float | None = None,
        user_id: str | None = None,
    ) -> dict:
        t = float(created_at) if created_at else now()
        uid = user_id or ""
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO messages(session_id, role, content, created_at, context, user_id) "
                "VALUES(?,?,?,?,?,?)",
                (
                    sid,
                    role,
                    content,
                    t,
                    json.dumps(context) if context else None,
                    uid,
                ),
            )
            self._conn.execute(
                "UPDATE sessions SET updated_at = ? WHERE id = ?", (max(t, now()), sid)
            )
            self._conn.commit()
            row = self._conn.execute(
                "SELECT * FROM messages WHERE id = ?", (cur.lastrowid,)
            ).fetchone()
        msg = dict(row)
        msg["context"] = json.loads(msg["context"]) if msg.get("context") else []
        return msg

    def messages(self, sid: str, after: int = 0, user_id: str | None = None) -> list[dict]:
        with self._lock:
            if user_id is not None:
                # verify session belongs to user
                srow = self._conn.execute("SELECT user_id FROM sessions WHERE id = ?", (sid,)).fetchone()
                if srow and srow["user_id"] not in (None, "", user_id):
                    return []
            rows = self._conn.execute(
                "SELECT * FROM messages WHERE session_id = ? AND id > ? ORDER BY id",
                (sid, after),
            ).fetchall()
        out = []
        for r in rows:
            m = dict(r)
            m["context"] = json.loads(m["context"]) if m.get("context") else []
            out.append(m)
        return out

    def remove_last_turn(self, sid: str, user_id: str | None = None) -> bool:
        """Remove the trailing user/assistant turn in an owned session.

        Retry replaces a response rather than appending a second user message.
        Removing the pair lets the normal prepare endpoint stage the prompt
        again, and the trailing-role check prevents deleting older history when
        a session has moved on or a stale browser retries an old turn.
        """
        uid = user_id or ""
        with self._lock:
            if user_id is not None:
                session = self._conn.execute(
                    "SELECT user_id FROM sessions WHERE id = ?", (sid,)
                ).fetchone()
                if not session or session["user_id"] not in (None, "", uid):
                    return False
            rows = self._conn.execute(
                "SELECT id, role FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 2", (sid,)
            ).fetchall()
            if not rows:
                return False
            ids = []
            if rows[0]["role"] in ("assistant", "archiver"):
                ids.append(rows[0]["id"])
                if len(rows) > 1 and rows[1]["role"] == "user":
                    ids.append(rows[1]["id"])
            elif rows[0]["role"] == "user":
                # The old answer may not have reached the server yet.
                ids.append(rows[0]["id"])
            else:
                return False
            self._conn.executemany("DELETE FROM messages WHERE id = ?", ((mid,) for mid in ids))
            latest = self._conn.execute(
                "SELECT created_at FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1", (sid,)
            ).fetchone()
            self._conn.execute(
                "UPDATE sessions SET updated_at = ? WHERE id = ?",
                ((latest["created_at"] if latest else now()), sid),
            )
            self._conn.commit()
            return True

    def set_distilled_until(self, sid: str, message_id: int, user_id: str | None = None) -> None:
        with self._lock:
            if user_id is not None:
                self._conn.execute(
                    "UPDATE sessions SET distilled_until = ? WHERE id = ? AND user_id = ?",
                    (message_id, sid, user_id or ""),
                )
            else:
                self._conn.execute(
                    "UPDATE sessions SET distilled_until = ? WHERE id = ?",
                    (message_id, sid),
                )
            self._conn.commit()

    # -- memories ---------------------------------------------------------- #

    def add_memory(
        self,
        content: str,
        kind: str = "fact",
        tags: list[str] | None = None,
        source: str = "manual",
        session_id: str | None = None,
        importance: str = "normal",
        pinned: bool = False,
        memory_id: str | None = None,
        user_id: str | None = None,
    ) -> dict:
        content = (content or "").strip()
        if not content:
            raise ValueError("memory content is empty")
        if kind not in MEMORY_TYPES:
            kind = "fact"
        if importance not in IMPORTANCE:
            importance = "normal"
        mid = memory_id or new_id("m_")
        t = now()
        vec = embed(content)
        uid = user_id or ""
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO memories"
                "(id, content, kind, tags, source, session_id, importance, pinned, "
                " created_at, last_used, hits, embedding, user_id) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    mid,
                    content,
                    kind,
                    json.dumps(tags or []),
                    source,
                    session_id,
                    importance,
                    1 if pinned else 0,
                    t,
                    None,
                    0,
                    json.dumps(vec),
                    uid,
                ),
            )
            if self.fts:
                self._conn.execute(
                    "DELETE FROM memories_fts WHERE memory_id = ?", (mid,)
                )
                self._conn.execute(
                    "INSERT INTO memories_fts(memory_id, body) VALUES(?,?)",
                    (mid, index_text(content)),
                )
            self._conn.commit()
        return self.get_memory(mid)  # type: ignore[return-value]

    def get_memory(self, mid: str, user_id: str | None = None) -> dict | None:
        with self._lock:
            if user_id is not None:
                row = self._conn.execute(
                    "SELECT * FROM memories WHERE id = ? AND user_id = ?", (mid, user_id or "")
                ).fetchone()
            else:
                row = self._conn.execute(
                    "SELECT * FROM memories WHERE id = ?", (mid,)
                ).fetchone()
        return self._row_to_memory(row) if row else None

    @staticmethod
    def _row_to_memory(row: sqlite3.Row, score: float | None = None,
                       relevance: float | None = None,
                       recency: float | None = None) -> dict:
        m = dict(row)
        m.pop("embedding", None)
        m["tags"] = json.loads(m.get("tags") or "[]")
        m["pinned"] = bool(m.get("pinned"))
        if score is not None:
            m["score"] = round(score, 4)
        if relevance is not None:
            m["relevance"] = round(relevance, 4)
        if recency is not None:
            m["recency"] = round(recency, 4)
        return m

    def update_memory(self, mid: str, user_id: str | None = None, **fields) -> dict | None:
        allowed = {"content", "kind", "tags", "importance", "pinned", "source"}
        sets, args = [], []
        for key, value in fields.items():
            if key not in allowed or value is None:
                continue
            if key == "tags":
                value = json.dumps(value or [])
            if key == "pinned":
                value = 1 if value else 0
            sets.append(f"{key} = ?")
            args.append(value)
        if not sets:
            return self.get_memory(mid, user_id=user_id)
        args.append(mid)
        with self._lock:
            if user_id is not None:
                # ensure owned
                row = self._conn.execute("SELECT user_id FROM memories WHERE id = ?", (mid,)).fetchone()
                if row and row["user_id"] not in (None, "", user_id):
                    return None
            self._conn.execute(
                f"UPDATE memories SET {', '.join(sets)} WHERE id = ?", args
            )
            self._conn.commit()
        mem = self.get_memory(mid, user_id=user_id)
        if mem and fields.get("content"):
            # Re-embedding requires a rewrite; keep the memory's identity intact.
            preserved = {
                "created_at": mem["created_at"],
                "hits": mem["hits"],
                "last_used": mem["last_used"],
            }
            self.add_memory(
                fields["content"],
                kind=mem["kind"],
                tags=mem["tags"],
                source=mem["source"],
                session_id=mem.get("session_id"),
                importance=mem["importance"],
                pinned=mem["pinned"],
                memory_id=mid,
            )
            with self._lock:
                self._conn.execute(
                    "UPDATE memories SET created_at = ?, hits = ?, last_used = ? WHERE id = ?",
                    (preserved["created_at"], preserved["hits"], preserved["last_used"], mid),
                )
                self._conn.commit()
            mem = self.get_memory(mid)
        return mem

    def delete_memory(self, mid: str, user_id: str | None = None) -> None:
        with self._lock:
            if user_id is not None:
                row = self._conn.execute("SELECT user_id FROM memories WHERE id = ?", (mid,)).fetchone()
                if row and row["user_id"] not in (None, "", user_id):
                    return
            self._conn.execute("DELETE FROM memories WHERE id = ?", (mid,))
            if self.fts:
                self._conn.execute(
                    "DELETE FROM memories_fts WHERE memory_id = ?", (mid,)
                )
            self._conn.commit()

    def supersede(self, old_id: str, new_id: str, user_id: str | None = None) -> dict | None:
        """Retire a memory in favour of a newer one.

        The old row is kept — this is an archive — but it stops being recalled or
        counted, so a stale fact can never quietly outlive its correction.
        """
        with self._lock:
            if user_id is not None:
                row = self._conn.execute("SELECT user_id FROM memories WHERE id = ?", (old_id,)).fetchone()
                if row and row["user_id"] not in (None, "", user_id):
                    return None
            self._conn.execute(
                "UPDATE memories SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL",
                (new_id, old_id),
            )
            if self.fts:
                self._conn.execute(
                    "DELETE FROM memories_fts WHERE memory_id = ?", (old_id,)
                )
            self._conn.commit()
        return self.get_memory(old_id, user_id=user_id)

    def restore(self, mid: str, user_id: str | None = None) -> dict | None:
        """Undo a supersession. A wrong guess must cost one click, not data."""
        with self._lock:
            if user_id is not None:
                row = self._conn.execute("SELECT user_id FROM memories WHERE id = ?", (mid,)).fetchone()
                if row and row["user_id"] not in (None, "", user_id):
                    return None
            self._conn.execute(
                "UPDATE memories SET superseded_by = NULL WHERE id = ?", (mid,)
            )
            row = self._conn.execute(
                "SELECT content FROM memories WHERE id = ?", (mid,)
            ).fetchone()
            if row and self.fts:
                self._conn.execute(
                    "INSERT OR REPLACE INTO memories_fts(memory_id, body) VALUES(?,?)",
                    (mid, index_text(row["content"])),
                )
            self._conn.commit()
        return self.get_memory(mid, user_id=user_id)

    def touch(self, ids: list[str], user_id: str | None = None) -> None:
        if not ids:
            return
        t = now()
        with self._lock:
            if user_id is not None:
                # only touch owned memories
                filtered = []
                for mid in ids:
                    row = self._conn.execute("SELECT user_id FROM memories WHERE id = ?", (mid,)).fetchone()
                    if not row or row["user_id"] in (None, "", user_id):
                        filtered.append(mid)
                ids = filtered
                if not ids:
                    return
            self._conn.executemany(
                "UPDATE memories SET hits = hits + 1, last_used = ? WHERE id = ?",
                [(t, mid) for mid in ids],
            )
            self._conn.commit()

    def all_memories(self, include_superseded: bool = False, user_id: str | None = None) -> list[dict]:
        with self._lock:
            where = "" if include_superseded else "WHERE superseded_by IS NULL"
            params = ()
            if user_id is not None:
                clause = "user_id = ?"
                if where:
                    where += f" AND {clause}"
                else:
                    where = f"WHERE {clause}"
                params = (user_id or "",)
                # include legacy unowned? No, only owned or empty for backward compat we include NULL as well for that user? For strict privacy, only owned.
                # To handle legacy data that was global before migration, treat NULL as visible to that user if they are first? But for new private mode, hide NULL from everyone.
                # We'll include NULL/'' as visible when user_id is set, to not orphan old data for existing single-user deploys, but filtered via WHERE user_id = ?
                where = where.replace("user_id = ?", "user_id = ?")
            rows = self._conn.execute(
                f"SELECT * FROM memories {where} ORDER BY created_at DESC", params
            ).fetchall()
        return [self._row_to_memory(r) for r in rows]

    def stats(self, user_id: str | None = None) -> dict:
        with self._lock:
            if user_id is not None:
                uid = user_id or ""
                mem = self._conn.execute(
                    "SELECT COUNT(*) c FROM memories WHERE superseded_by IS NULL AND user_id = ?", (uid,)
                ).fetchone()["c"]
                ses = self._conn.execute("SELECT COUNT(*) c FROM sessions WHERE user_id = ?", (uid,)).fetchone()["c"]
                msgs = self._conn.execute("SELECT COUNT(*) c FROM messages WHERE user_id = ?", (uid,)).fetchone()["c"]
                by_kind = {
                    r["kind"]: r["c"]
                    for r in self._conn.execute(
                        "SELECT kind, COUNT(*) c FROM memories "
                        "WHERE superseded_by IS NULL AND user_id = ? GROUP BY kind", (uid,)
                    ).fetchall()
                }
                used = self._conn.execute(
                    "SELECT COUNT(*) c FROM memories WHERE hits > 0 AND user_id = ?", (uid,)
                ).fetchone()["c"]
                superseded = self._conn.execute(
                    "SELECT COUNT(*) c FROM memories WHERE superseded_by IS NOT NULL AND user_id = ?", (uid,)
                ).fetchone()["c"]
            else:
                mem = self._conn.execute(
                    "SELECT COUNT(*) c FROM memories WHERE superseded_by IS NULL"
                ).fetchone()["c"]
                ses = self._conn.execute("SELECT COUNT(*) c FROM sessions").fetchone()["c"]
                msgs = self._conn.execute("SELECT COUNT(*) c FROM messages").fetchone()["c"]
                by_kind = {
                    r["kind"]: r["c"]
                    for r in self._conn.execute(
                        "SELECT kind, COUNT(*) c FROM memories "
                        "WHERE superseded_by IS NULL GROUP BY kind"
                    ).fetchall()
                }
                used = self._conn.execute(
                    "SELECT COUNT(*) c FROM memories WHERE hits > 0"
                ).fetchone()["c"]
                superseded = self._conn.execute(
                    "SELECT COUNT(*) c FROM memories WHERE superseded_by IS NOT NULL"
                ).fetchone()["c"]
        return {
            "memories": mem,
            "sessions": ses,
            "messages": msgs,
            "by_kind": by_kind,
            "recalled_at_least_once": used,
            "superseded": superseded,
        }

    def reindex(self, user_id: str | None = None) -> int:
        """Re-embed every memory and rebuild the keyword index.

        Run when EMBED_VERSION changes, so an existing bank never mixes two
        generations of vectors (which would silently corrupt ranking).
        """
        with self._lock:
            if user_id is not None:
                rows = self._conn.execute(
                    "SELECT id, content FROM memories WHERE superseded_by IS NULL AND user_id = ?", (user_id or "",)
                ).fetchall()
            else:
                rows = self._conn.execute(
                    "SELECT id, content FROM memories WHERE superseded_by IS NULL"
                ).fetchall()
            if self.fts:
                # only clear FTS for this user's memories; simplest is to rebuild all
                self._conn.execute("DELETE FROM memories_fts")
                # reinsert all for consistency
                all_rows = self._conn.execute("SELECT id, content FROM memories WHERE superseded_by IS NULL").fetchall()
                for r in all_rows:
                    self._conn.execute(
                        "INSERT INTO memories_fts(memory_id, body) VALUES(?,?)",
                        (r["id"], index_text(r["content"])),
                    )
            # update embeddings for filtered rows only
            for r in rows:
                self._conn.execute(
                    "UPDATE memories SET embedding = ? WHERE id = ?",
                    (json.dumps(embed(r["content"])), r["id"]),
                )
            self._conn.commit()
        return len(rows)

    def conflicting(self, content: str, exclude_id: str | None = None,
                    min_relevance: float = 0.1, user_id: str | None = None) -> dict | None:
        """The current memory that `content` most likely corrects.

        Deliberately conservative: same stance verb, overlapping topic, related but
        not near-identical wording. Anything else counts as an addition.

        This is a heuristic and it will sometimes be wrong, which is why retiring a
        memory is reversible: the row is kept and `restore()` brings it back.
        """
        stance = stance_of(content)
        subject = subject_terms(content)
        if not stance or not subject:
            return None
        qtopics = set(topics(content))
        qvec = embed(content)
        best, best_rel = None, 0.0
        with self._lock:
            if user_id is not None:
                rows = self._conn.execute(
                    "SELECT * FROM memories WHERE superseded_by IS NULL AND user_id = ?", (user_id or "",)
                ).fetchall()
            else:
                rows = self._conn.execute(
                    "SELECT * FROM memories WHERE superseded_by IS NULL"
                ).fetchall()
        for r in rows:
            if r["id"] == exclude_id:
                continue
            # Both must state a stance — otherwise this is a new fact, not a change.
            if not stance_of(r["content"]):
                continue
            # They must be about the same thing. Sharing a subject term is what
            # separates "I prefer Go for backend services" (a correction) from
            # "I prefer TypeScript for frontends" (an unrelated addition).
            if not (subject & subject_terms(r["content"])):
                continue
            rt = set(topics(r["content"]))
            if qtopics and rt and not (qtopics & rt):
                continue
            rel = cosine(qvec, _load(r["embedding"]))
            if rel >= 0.86 or rel < min_relevance:
                continue  # near-duplicate, or unrelated
            if rel > best_rel:
                best, best_rel = r, rel
        return self._row_to_memory(best, score=best_rel, relevance=best_rel) if best else None

    def core_memories(self, limit: int = 3, user_id: str | None = None) -> list[dict]:
        """Always-injected grounding: pinned memories first, then most recent.

        A user's identity and standing preferences are worth having in context
        even when the current message shares no vocabulary with them — relevance
        alone would leave the model blind to who it is talking to.
        """
        with self._lock:
            if user_id is not None:
                uid = user_id or ""
                rows = self._conn.execute(
                    "SELECT * FROM memories WHERE pinned = 1 AND superseded_by IS NULL AND user_id = ? "
                    "ORDER BY created_at DESC LIMIT ?",
                    (uid, limit),
                ).fetchall()
                if len(rows) < limit:
                    ids = tuple(r["id"] for r in rows) or ("",)
                    placeholders = ",".join("?" * len(ids))
                    rows += self._conn.execute(
                        f"SELECT * FROM memories WHERE superseded_by IS NULL AND user_id = ? AND id NOT IN ({placeholders}) "
                        "ORDER BY created_at DESC LIMIT ?",
                        (uid, *ids, limit - len(rows)),
                    ).fetchall()
            else:
                rows = self._conn.execute(
                    "SELECT * FROM memories WHERE pinned = 1 AND superseded_by IS NULL "
                    "ORDER BY created_at DESC LIMIT ?",
                    (limit,),
                ).fetchall()
                if len(rows) < limit:
                    ids = tuple(r["id"] for r in rows) or ("",)
                    placeholders = ",".join("?" * len(ids))
                    rows += self._conn.execute(
                        f"SELECT * FROM memories WHERE superseded_by IS NULL AND id NOT IN ({placeholders}) "
                        "ORDER BY created_at DESC LIMIT ?",
                        (*ids, limit - len(rows)),
                    ).fetchall()
        out = []
        for r in rows:
            m = self._row_to_memory(r, score=None, relevance=None, recency=None)
            m["why"] = "core"
            out.append(m)
        return out

    # -- retrieval --------------------------------------------------------- #

    def _fts_scores(self, query: str, user_id: str | None = None) -> dict[str, float]:
        """BM25 keyword scores, normalised to 0..1.

        Terms are OR'd rather than joined as a phrase: a phrase query demands the
        exact token sequence, so almost nothing would ever match. OR lets partial
        keyword overlap contribute, and bm25() still ranks docs that match more
        of the terms higher.
        """
        toks = index_text(query).split()
        if not self.fts:
            return self._like_scores(query, user_id=user_id)
        if not toks:
            return {}
        expr = " OR ".join('"' + t.replace('"', '""') + '"' for t in toks)
        try:
            with self._lock:
                rows = self._conn.execute(
                    "SELECT memory_id, bm25(memories_fts) AS rank "
                    "FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT 60",
                    (expr,),
                ).fetchall()
        except sqlite3.OperationalError:
            return self._like_scores(query, user_id=user_id)
        if not rows:
            return {}
        # bm25() is negative; smaller is better.
        raw = {r["memory_id"]: -r["rank"] for r in rows}
        top = max(raw.values()) or 1.0
        return {k: v / top for k, v in raw.items()}

    def _like_scores(self, query: str, user_id: str | None = None) -> dict[str, float]:
        toks = tokens(query)
        if not toks:
            return {}
        with self._lock:
            if user_id is not None:
                rows = self._conn.execute(
                    "SELECT id, content FROM memories WHERE superseded_by IS NULL AND user_id = ?", (user_id or "",)
                ).fetchall()
            else:
                rows = self._conn.execute(
                    "SELECT id, content FROM memories WHERE superseded_by IS NULL"
                ).fetchall()
        raw = {}
        for r in rows:
            hay = normalize(r["content"])
            hits = sum(1 for t in toks if t in hay)
            if hits:
                raw[r["id"]] = hits / len(toks)
        top = max(raw.values()) or 1.0
        return {k: v / top for k, v in raw.items()}

    def search(
        self,
        query: str,
        limit: int = 6,
        half_life_days: float = DEFAULT_HALF_LIFE_DAYS,
        min_relevance: float = 0.0,
        exclude: list[str] | None = None,
        diversify: bool = True,
        diversity_penalty: float = 0.6,
        user_id: str | None = None,
    ) -> list[dict]:
        """Hybrid semantic + keyword retrieval with time decay.

        With `diversify`, near-duplicate hits are penalised so a handful of
        reworded copies of one fact cannot consume every slot in the context.
        """
        qvec = embed(query)
        fts = self._fts_scores(query, user_id=user_id)
        exclude = set(exclude or [])
        with self._lock:
            if user_id is not None:
                rows = self._conn.execute(
                    "SELECT * FROM memories WHERE superseded_by IS NULL AND user_id = ?", (user_id or "",)
                ).fetchall()
            else:
                rows = self._conn.execute(
                    "SELECT * FROM memories WHERE superseded_by IS NULL"
                ).fetchall()
        t = now()
        scored = []
        for r in rows:
            if r["id"] in exclude:
                continue
            rel = 0.62 * cosine(qvec, _load(r["embedding"])) + 0.38 * fts.get(r["id"], 0.0)
            age_days = max(0.0, (t - r["created_at"]) / 86400.0)
            decay = 1.0 if r["pinned"] else 0.5 ** (age_days / max(1.0, half_life_days))
            weight = {"high": 1.25, "normal": 1.0, "low": 0.85}.get(r["importance"], 1.0)
            score = rel * decay * weight
            # rel == 0 means "no signal at all" — never surface those, whatever
            # the caller's floor is, otherwise an empty query returns the whole bank.
            if rel <= 0.0 or rel < min_relevance:
                continue
            scored.append([score, rel, decay, r, _load(r["embedding"])])
        scored.sort(key=lambda x: x[0], reverse=True)
        if not diversify:
            picked = scored[:limit]
        else:
            # Greedy maximal-marginal-relevance: each round take the best-scoring
            # candidate that is least similar to what is already selected.
            pool, picked = list(scored), []
            while pool and len(picked) < limit:
                best_i, best_adj = 0, None
                for i, cand in enumerate(pool):
                    overlap = max(
                        (cosine(cand[4], chosen[4]) for chosen in picked), default=0.0
                    )
                    adj = cand[0] * (1 - diversity_penalty * overlap)
                    if best_adj is None or adj > best_adj:
                        best_i, best_adj = i, adj
                winner = pool.pop(best_i)
                winner[0] = best_adj
                picked.append(winner)
        return [
            self._row_to_memory(r, score=sc, relevance=rel, recency=dec)
            for sc, rel, dec, r, _ in picked
        ]

    def similar(self, content: str, threshold: float = 0.86, user_id: str | None = None) -> dict | None:
        """Nearest *current* memory, for de-duplication before saving.

        Superseded rows are excluded on purpose: otherwise a stale fact would
        block its own correction from ever being stored.
        """
        qvec = embed(content)
        best, best_rel = None, 0.0
        with self._lock:
            if user_id is not None:
                rows = self._conn.execute(
                    "SELECT * FROM memories WHERE superseded_by IS NULL AND user_id = ?", (user_id or "",)
                ).fetchall()
            else:
                rows = self._conn.execute(
                    "SELECT * FROM memories WHERE superseded_by IS NULL"
                ).fetchall()
        for r in rows:
            rel = cosine(qvec, _load(r["embedding"]))
            if rel > best_rel:
                best, best_rel = r, rel
        if best is not None and best_rel >= threshold:
            return self._row_to_memory(best, score=best_rel, relevance=best_rel)
        return None

    # -- bulk -------------------------------------------------------------- #

    def export(self, user_id: str | None = None) -> dict:
        return {
            "app": "Archiver",
            "version": 1,
            "exported_at": now(),
            "memories": self.all_memories(user_id=user_id),
            "sessions": self.list_sessions(user_id=user_id),
            "messages": {
                s["id"]: self.messages(s["id"], user_id=user_id) for s in self.list_sessions(user_id=user_id)
            },
        }

    def import_data(self, blob: dict, replace: bool = False, user_id: str | None = None) -> dict:
        added = {"memories": 0, "sessions": 0, "messages": 0}
        uid = user_id or ""
        if replace:
            with self._lock:
                if user_id is not None:
                    self._conn.execute("DELETE FROM memories WHERE user_id = ?", (uid,))
                    self._conn.execute("DELETE FROM sessions WHERE user_id = ?", (uid,))
                    self._conn.execute("DELETE FROM messages WHERE user_id = ?", (uid,))
                    if self.fts:
                        # rebuild FTS to remove only this user's entries - simplest: rebuild all
                        self._conn.execute("DELETE FROM memories_fts")
                        for r in self._conn.execute("SELECT id, content FROM memories WHERE superseded_by IS NULL").fetchall():
                            self._conn.execute("INSERT INTO memories_fts(memory_id, body) VALUES(?,?)", (r["id"], index_text(r["content"])))
                else:
                    for table in ("memories", "sessions", "messages"):
                        self._conn.execute(f"DELETE FROM {table}")
                    if self.fts:
                        self._conn.execute("DELETE FROM memories_fts")
                self._conn.commit()
        for m in blob.get("memories", []):
            self.add_memory(
                m.get("content", ""),
                kind=m.get("kind", "fact"),
                tags=m.get("tags", []),
                source=m.get("source", "import"),
                session_id=m.get("session_id"),
                importance=m.get("importance", "normal"),
                pinned=bool(m.get("pinned")),
                memory_id=m.get("id"),
                user_id=user_id,
            )
            added["memories"] += 1
        existing = {s["id"] for s in self.list_sessions()}
        for s in blob.get("sessions", []):
            if s.get("id") in existing:
                continue
            t = now()
            with self._lock:
                self._conn.execute(
                    "INSERT INTO sessions(id, title, created_at, updated_at, distilled_until, user_id) "
                    "VALUES(?,?,?,?,?,?)",
                    (
                        s.get("id") or new_id("s_"),
                        s.get("title", "Imported chat"),
                        s.get("created_at", t),
                        s.get("updated_at", t),
                        s.get("distilled_until", 0),
                        uid,
                    ),
                )
                self._conn.commit()
            added["sessions"] += 1
            for msg in blob.get("messages", {}).get(s.get("id"), []):
                self.add_message(
                    s["id"], msg.get("role", "user"), msg.get("content", ""),
                    msg.get("context"),
                    user_id=user_id,
                )
                added["messages"] += 1
        return added


# --------------------------------------------------------------------------- #
# Extraction + distillation prompts
# --------------------------------------------------------------------------- #

EXTRACT_SYSTEM = """You are the memory-extraction stage of Archiver, a chat app with persistent memory.
Read the transcript and return ONLY a JSON array of durable memories worth keeping for future conversations.

Rules:
- Keep long-term facts, preferences, constraints, decisions, plans, names, projects, tools, dates.
- Drop small talk, one-off clarifications, and anything about the model itself.
- Write each memory as a short third-person statement, self-contained, <= 22 words.
- Return [] if nothing is worth keeping.
- "kind" is one of: fact, preference, decision, episode, summary.
- "importance" is one of: low, normal, high.

Schema: [{"content": str, "kind": str, "importance": str, "tags": [str]}]"""

DISTILL_SYSTEM = """You are the distillation stage of Archiver. Compress a conversation transcript so a future
conversation can continue it without reading the raw log.

Return ONLY JSON: {"summary": str, "facts": [str], "open_threads": [str]}
- summary: <= 120 words, third person, keeps names/numbers/decisions.
- facts: durable statements worth storing as memories (<= 8).
- open_threads: unresolved questions or next steps (<= 5, may be empty)."""


def json_from_text(text: str):
    """Tolerant JSON parse for LLM output (strips fences, finds first object/array)."""
    text = (text or "").strip()
    text = re.sub(r"^```(?:json)?", "", text).strip()
    text = re.sub(r"```$", "", text).strip()
    try:
        return json.loads(text)
    except ValueError:
        pass
    for open_c, close_c in (("[", "]"), ("{", "}")):
        start = text.find(open_c)
        end = text.rfind(close_c)
        if start != -1 and end > start:
            try:
                return json.loads(text[start : end + 1])
            except ValueError:
                continue
    return None


# Marks a sentence as a durable statement worth keeping. Deliberately narrow:
# this is the offline fallback, and over-extracting fills the bank with noise.
_CLUE = re.compile(
    r"(?:"
    r"\b(?:i'm|i am)\b"                                 # I'm / I am
    r"|\bi\s+(?:like|love|prefer|hate|need|want|use|work|live|have|run|build)\b"
    r"|\b(?:we|our)\s+(?:use|prefer|like|want|need|run|deploy|host|build|ship)\b"
    r"|\bwe\s+should\b"
    r"|\bmy\s+(?:name|email|job|role|timezone|birthday|stack|team|database|dog|cat|partner|kids?)\b"
    r"|\b(?:remember that|note that|from now on|always|never)\b"
    r")",
    re.I,
)


def heuristic_extract(user_text: str) -> list[dict]:
    """Offline fallback: pull declarative first-person statements out of a message."""
    out = []
    text = (user_text or "").replace("\u2019", "'")
    for line in re.split(r"[\n.;]+", text):
        line = line.strip()
        if not (8 <= len(line) <= 220):
            continue
        if not _CLUE.search(line):
            continue
        if line.endswith("?"):
            continue
        out.append(
            {
                "content": line[0].upper() + line[1:],
                "kind": "preference" if re.search(r"prefer|like|love|hate|want", line, re.I) else "fact",
                "importance": "high" if re.search(r"remember that|always|never|from now on", line, re.I) else "normal",
                "tags": ["extracted"],
            }
        )
        if len(out) >= 4:
            break
    return out


def transcript_lines(messages: list[dict], limit: int = 40) -> str:
    tail = messages[-limit:]
    return "\n".join(f"{m['role'].upper()}: {m['content']}" for m in tail)


def estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4)
