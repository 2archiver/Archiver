"""Archiver's own read of a set of search results.

3.2 closed every web answer with a section headed "Additional Thoughts &
Lateral Angles". Its text was chosen by keyword bucket: one paragraph for any
query mentioning an influencer, one for anything mentioning Render, and a
fallback — "ask who pays, what must stay on, and what the default is" — for
everything else, Benito Mussolini included. The same sentences came back for
every topic in a bucket, and the fallback was nonsense for most of them.

This module replaces that. Nothing here is a language model and the server
still generates no prose about the world from its own knowledge. What it does
is read the retrieved extracts closely enough to say something specific about
*this* subject:

- what kind of thing it is, taken from the lead sentence ("X was an Italian
  politician, journalist, and dictator"), not from the query;
- the span of years the record covers and the sentence that carries the
  turning point;
- what the sources agree on, where they disagree, and how independent they are;
- what the question asked for that the extracts do not contain — a "why" asked
  of sources that only narrate, a "when" asked of sources with no dates.

It then commits to that reading in plain, unhedged sentences. Two different
subjects cannot produce the same paragraph, because every clause is built from
their own text; and a subject the sources do not explain is said to be
unexplained rather than papered over with a generic angle.

It also returns a one-line plan — what was read, what was found, how the answer
will be built — so the search path shows its thinking like every other route.
"""

from __future__ import annotations

import re
import zlib
from typing import Any

_YEAR = re.compile(r"\b(1[0-9]{3}|20[0-9]{2})\b")

# The lead sentence of an encyclopaedia entry has a fixed shape: a name, an
# optional parenthesis, an optional "also known as" aside, and a copula.
_LEAD = re.compile(
    r"^(?P<name>[^.(]{2,90}?)"
    r"\s*(?:\((?P<paren>[^)]{0,200})\))?"
    r"\s*(?:,\s*(?:also |commonly |better |often |sometimes )?(?:known|referred to|called|styled)"
    r"(?: as| simply as| professionally as)?\s+[^,]{1,80},)?"
    r"\s+(?P<cop>is|was|are|were)\s+(?P<desc>.+)$",
    re.S,
)

# Where the head noun phrase ends: a relative clause or a locating phrase.
_HEAD_END = re.compile(
    r"\s+(?:who|whom|that|which|whose|where|while|located|based|headquartered|"
    r"situated|owned|operated|run by|developed by|created by|founded|born|"
    r"best known|known|noted|famous|serving|during|between|against|fought|from|"
    r"until|under|of the|for the|in the|on the|at the|in|on|at)\b",
)

_KINDS: list[tuple[str, re.Pattern[str]]] = [
    ("person", re.compile(
        r"\b(?:politician|dictator|statesman|stateswoman|leader|president|prime minister|"
        r"chancellor|king|queen|emperor|empress|monarch|general|marshal|admiral|officer|"
        r"soldier|writer|author|poet|novelist|playwright|journalist|actor|actress|singer|"
        r"rapper|musician|composer|artist|painter|sculptor|scientist|physicist|chemist|"
        r"biologist|mathematician|philosopher|economist|historian|engineer|inventor|"
        r"entrepreneur|businessman|businesswoman|executive|founder|activist|streamer|"
        r"youtuber|influencer|personality|podcaster|commentator|host|comedian|footballer|"
        r"player|athlete|boxer|wrestler|fighter|coach|priest|pope|bishop|saint|monk|"
        r"revolutionary|dissident|criminal|murderer|model|designer|director|producer|"
        r"filmmaker|chef|pilot|astronaut|explorer|nobleman|noblewoman|duke|duchess|prince|"
        r"princess|lord|baron|tsar|sultan|caliph|pharaoh|senator|governor|mayor|minister|"
        r"diplomat|lawyer|judge|physician|doctor|surgeon|nurse|professor|teacher|"
        r"architect|programmer|developer|hacker|celebrity|rabbi|imam|theologian|"
        r"psychologist|sociologist|anthropologist|archaeologist|linguist|critic|"
        r"educator|nun|cardinal|conqueror|warlord|pirate|outlaw|spy|cricketer|golfer|"
        r"cyclist|swimmer|gymnast|skier|racing driver|man|woman|person|individual)\b")),
    ("event", re.compile(
        r"\b(?:battle|war|siege|campaign|invasion|treaty|election|revolution|uprising|"
        r"rebellion|revolt|coup|conference|summit|crisis|massacre|genocide|pandemic|"
        r"epidemic|earthquake|hurricane|typhoon|tsunami|flood|famine|disaster|attack|"
        r"bombing|assassination|riot|protest|strike|scandal|trial|referendum|festival|"
        r"tournament|championship|olympics|expedition|mission|operation|incident|"
        r"accident|explosion|fire|eruption|ceremony|match|final|season|engagement|"
        r"offensive|conflict|insurgency|occupation|plague|recession|depression|crash|"
        r"boom|period|era|fall|collapse|decline|rise|loss|dissolution|partition|"
        r"unification|independence|transition|process|founding|death|birth)\b")),
    ("place", re.compile(
        r"\b(?:city|town|village|country|nation|province|region|county|district|"
        r"capital|island|archipelago|river|lake|sea|ocean|mountain|volcano|range|valley|"
        r"desert|forest|continent|territory|municipality|borough|neighbou?rhood|suburb|"
        r"port|peninsula|bay|gulf|strait|canal|castle|palace|cathedral|temple|mosque|"
        r"park|street|square|building|skyscraper|tower|bridge|airport|stadium|monument|"
        r"site|landmark|commune|prefecture|canton|settlement|metropolis|planet|moon|"
        r"star|galaxy|constellation)\b")),
    ("organization", re.compile(
        r"\b(?:company|corporation|conglomerate|organi[sz]ation|party|agency|university|"
        r"college|school|institute|foundation|charity|band|group|team|club|league|"
        r"federation|union|church|army|navy|air force|regiment|division|government|"
        r"ministry|department|committee|council|court|bank|firm|studio|label|network|"
        r"channel|publisher|newspaper|magazine|startup|manufacturer|brand|retailer|"
        r"airline|franchise|order|society|association|alliance|coalition|dynasty|"
        r"empire|kingdom|republic|regime|state|militia|cartel|gang|cult|sect|"
        r"denomination|guild|consortium|cooperative|nonprofit|think tank|"
        r"provider|vendor|movement)\b")),
    ("work", re.compile(
        r"\b(?:film|movie|novel|book|album|song|single|series|television series|"
        r"tv series|show|sitcom|anime|manga|comic|video game|game|play|opera|symphony|"
        r"poem|painting|sculpture|documentary|musical|trilogy|soundtrack|podcast|"
        r"webcomic|short story|essay|treatise|memoir|biography|mixtape|record|"
        r"track|episode|miniseries|drama|thriller|comedy|anthology|textbook|"
        r"manuscript|scripture|gospel|epic|saga)\b")),
    ("software", re.compile(
        r"\b(?:programming language|scripting language|markup language|language|software|"
        r"library|framework|protocol|operating system|database|file format|format|api|"
        r"algorithm|application|app|platform|service|tool|toolkit|compiler|interpreter|"
        r"runtime|engine|browser|kernel|package|module|standard|specification|codec|"
        r"website|search engine|social media|hosting|cloud|language model|processor|"
        r"chip|device|technology|technique|method|system|function|command|utility|"
        r"data structure|design pattern|paradigm)\b")),
]

_KIND_WORD = {
    "person": "a person",
    "event": "an event",
    "place": "a place",
    "organization": "an organisation",
    "work": "a work",
    "software": "a technology",
    "concept": "a concept",
}

_ARC = re.compile(
    r"\b(?:founded|co-founded|led|ruled|reigned|governed|became|was appointed|were appointed|"
    r"was elected|were elected|was named|took power|seized|overthrew|overthrown|was overthrown|"
    r"executed|was executed|assassinated|was assassinated|killed|was killed|died|"
    r"defeated|was defeated|won|lost|signed|invaded|annexed|conquered|captured|surrendered|"
    r"resigned|was dismissed|was arrested|arrested|convicted|was convicted|charged|"
    r"acquitted|banned|was banned|launched|released|published|established|dissolved|"
    r"abolished|collapsed|ended|began|started|discovered|invented|introduced|designed|"
    r"created|developed|wrote|directed|recorded|premiered|opened|closed|merged|acquired|"
    r"declared|proclaimed|abdicated|exiled|fled|returned|escaped|imprisoned|"
    r"resulted in|resulting in|marked|hosted|hosts|advanced|promoted|sparked|"
    r"triggered|prompted|forced|adopted|ratified|rejected|approved|ordered|"
    r"suspended|removed|deposed|crowned|inaugurated|sworn in|succeeded|replaced|"
    r"emphasi[sz]es|supports|allows|provides|runs on|compiles|is used|written in)\b",
    re.I,
)

_WEIGHTY = re.compile(
    r"\b(?:turning point|decisive|largest|biggest|first|last|only|most|deadliest|"
    r"costliest|single|record|unprecedented|major)\b", re.I)

_OUTCOME = re.compile(
    r"\b(?:resulting in|resulted in|ended in|ending in|ended with|culminating in|culminated in)\s+"
    r"(?P<what>(?:an?|the)\s+[^.,;]{3,80})", re.I)

_CAUSAL = re.compile(
    r"\b(?:because|due to|as a result of|led to|caused by|caused|causes|causing|in order to|"
    r"so that|owing to|resulted from|resulting from|in response to|motivated by|reason|"
    r"reasons|consequence of|stemmed from|driven by|prompted by|triggered by|thanks to|"
    r"attributed to|blamed on|explained by|contributed to|contributing to|factors?|"
    r"posit|blame|root of|why)\b",
    re.I,
)

_HOWTO = re.compile(
    r"\b(?:step|steps|install|configure|run|use|call|pass|set|add|write|create|"
    r"import|compile|build|deploy|enable|disable|open|click|type|enter|select|"
    r"should|need to|have to|you can|make sure|instead|try|example)\b",
    re.I,
)

# Words that signal a claim is contested — and, separately, the words that
# mark it as *someone else's* claim rather than the source's own statement.
_CONTESTED = re.compile(
    r"\b(?:white nationalis\w*|white supremac\w*|supremac\w*|antisemit\w*|misogyn\w*|"
    r"racis\w*|holocaust denial|conspiracy theor\w*|extremis\w*|far-right|far-left|"
    r"fraud|scandal|controvers\w*|criticis\w*|criticiz\w*|condemned|denounced|"
    r"deplatformed|indicted|charged|sued|lawsuit|investigat\w*|banned|suspended)\b",
    re.I,
)
_ALLEGED = re.compile(
    r"\b(?:alleged|allegedly|allegation|allegations|accused|accusation|accusations|"
    r"claimed|reportedly|purported|purportedly|critics say|described by critics|"
    r"has been described as|has been called|labell?ed)\b",
    re.I,
)

# Words Archiver's own sentences never use. Quoted source text is left alone;
# the test suite checks the templates against this list.
HEDGES = re.compile(
    r"\b(?:arguably|perhaps|maybe|possibly|it depends|might be|could be|somewhat|"
    r"in some ways|to some extent|it seems|seemingly|apparently)\b",
    re.I,
)

_DISAMBIG = re.compile(
    r"\b(?:most often refers to|may refer to|can refer to|usually refers to|"
    r"may also refer to|commonly refers to)\b",
    re.I,
)

# "He hosts the livestreamed show America First" — the long-form record of a
# living figure is usually named in the extract. Naming it beats advising the
# reader to go and find "a long-form source".
_VENUE = re.compile(
    r"\b(?:hosts?|hosted|co-hosts?|runs|streams? on|show|podcast|channel|series|"
    r"newsletter|column)\s+(?:the\s+)?(?:livestreamed\s+|weekly\s+|daily\s+|popular\s+)?"
    r"(?:show\s+|podcast\s+|channel\s+|programme\s+|program\s+)?"
    r"(?P<name>[A-Z][\w'’&.-]*(?:\s+(?:[A-Z][\w'’&.-]*|of|the|and|&)){0,4})")


# --------------------------------------------------------------------------- #
# reading the extracts
# --------------------------------------------------------------------------- #


def _sentences(text: str) -> list[str]:
    t = re.sub(r"\b(U\.S|U\.K|e\.g|i\.e|vs|etc|St|Dr|Prof|Mr|Mrs|Ms|Jr|Sr|c|ca|fl|No)\.",
               r"\1__DOT__", text or "")
    t = re.sub(r"(\d)\.(\d)", r"\1__DOT__\2", t)
    return [p.strip().replace("__DOT__", ".")
            for p in re.split(r"(?<=[.!?])\s+", t) if p.strip()]


def _seed(text: str) -> int:
    return zlib.crc32((text or "").encode("utf-8"))


def _pick(options: list[str], key: str) -> str:
    """Deterministic variety: the same question always reads the same way,
    different questions do not all read identically."""
    return options[_seed(key) % len(options)]


def _clip(text: str, limit: int = 220) -> str:
    text = (text or "").strip().rstrip(".;,")
    if len(text) <= limit:
        return text
    cut = text[:limit]
    for mark in (", ", "; ", " — ", " – ", " and ", " which ", " that ", " where "):
        at = cut.rfind(mark)
        if at > limit * 0.55:
            return cut[:at].rstrip(".;,")
    space = cut.rfind(" ")
    return (cut[:space] if space > limit * 0.6 else cut).rstrip(".;,") + "…"


_LOWERABLE = {
    "He", "She", "They", "It", "The", "A", "An", "His", "Her", "Its", "Their", "This",
    "That", "These", "Those", "In", "On", "At", "By", "After", "Before", "During", "From",
    "Under", "Since", "Following", "Known", "Although", "Though", "While", "When", "Despite",
    "As", "Over", "Within", "With", "Through", "Between", "Later", "Initially", "Eventually",
}


def _lower_first(text: str) -> str:
    """Lower the first word of a clause unless it is a proper noun."""
    m = re.match(r"[A-Za-z]+", text or "")
    if not m or m.group(0) not in _LOWERABLE:
        return text
    return m.group(0).lower() + text[m.end():]


def _strip_article(text: str) -> str:
    return re.sub(r"^(?:an?|the)\s+", "", (text or "").strip(), flags=re.I)


def _with_article(text: str) -> str:
    """Keep the article the source used; add one if the head has none."""
    t = (text or "").strip()
    if not t or re.match(r"^(?:an?|the)\s", t, re.I):
        return t
    if re.match(r"^[A-Z][a-z]*[A-Z]", t) or t[0].isdigit():
        return t
    return ("an " if t[0].lower() in "aeiou" else "a ") + t


def _head(desc: str) -> str:
    """'an Italian politician, journalist, and dictator' out of the description.

    Cut at the relative clause first, then only if what is left is still long
    cut at punctuation — so a comma list of roles survives and a long locating
    clause does not.
    """
    d = (desc or "").strip().rstrip(".")
    m = _HEAD_END.search(d)
    if m and m.start() > 3:
        d = d[:m.start()]
    if len(d.split()) > 12:
        p = re.search(r"[,;:]", d)
        if p and p.start() > 3:
            d = d[:p.start()]
    d = d.strip().rstrip(",;:")
    if len(d.split()) > 14:
        d = _clip(d, 90)
    return d


_TITLE_EVENT = re.compile(
    r"^(?:the\s+)?(?:fall|collapse|decline|rise|death|birth|founding|dissolution|partition|"
    r"unification|independence|history|assassination|siege|battle|sack|conquest)\s+of\b", re.I)


def _kind_of(head: str, paren: str, desc: str, title: str = "") -> str:
    """The head noun decides. Both 'general' and 'language' occur in 'general-
    purpose programming language'; the noun that ends the head phrase is the
    one that says what the thing is. When the head names nothing, the title
    ("Fall of the Western Roman Empire") is read before the rest of the
    description, and there the *first* noun wins — the later ones are the
    things the subject did something to."""
    if re.search(r"\b(?:born|né|née)\b", paren or "", re.I):
        return "person"
    if re.search(r"\d{3,4}\s*[–—-]\s*(?:\d{1,2}\s+\w+\s+)?\d{3,4}", paren or ""):
        return "person"
    best_kind, best_end = "", -1
    for kind, pat in _KINDS:
        for m in pat.finditer(head.lower()):
            if m.end() > best_end:
                best_kind, best_end = kind, m.end()
    if best_kind:
        return best_kind
    if _TITLE_EVENT.match(title or ""):
        return "event"
    first_kind, first_start = "", 10 ** 9
    for kind, pat in _KINDS:
        m = pat.search(desc.lower())
        if m and m.start() < first_start:
            first_kind, first_start = kind, m.start()
    return first_kind or "concept"


_REFLEXIVE = {"he": "himself", "she": "herself", "they": "themselves"}
_LABEL_ONLY = re.compile(r"^(?:far-right|far-left|extremis\w*|controvers\w*|criticis\w*|criticiz\w*)$", re.I)


def _pronoun(text: str) -> tuple[str, str, str]:
    """(subject, object, possessive), from what the extract itself uses."""
    t = " " + (text or "").lower() + " "
    he = len(re.findall(r"\b(?:he|him|his|himself)\b", t))
    she = len(re.findall(r"\b(?:she|her|hers|herself)\b", t))
    if he > she:
        return ("he", "him", "his")
    if she > he:
        return ("she", "her", "her")
    return ("they", "them", "their")


def _short_name(name: str, kind: str, title: str) -> str:
    """'Mussolini' for a person; the lead's own name for anything else."""
    if kind != "person":
        n = (name or "").strip()
        return n if n and len(n.split()) <= 7 else (title or n)
    words = [w for w in re.findall(r"[A-Za-z][A-Za-z'\-]+", name or title or "") if w[0].isupper()]
    if not words:
        return title or name
    if len(words) == 1:
        return words[0]
    tail = words[-1]
    if re.fullmatch(r"(?:[IVX]+|Jr|Sr)", tail) and len(words) >= 2:
        return words[-2] + " " + tail
    return tail


def _life(paren: str, extract: str) -> tuple[str, str]:
    """Birth and death years, when the lead parenthesis gives them."""
    m = re.search(r"(\d{3,4})\s*[–—-]\s*(?:\d{1,2}\s+\w+\s+)?(\d{3,4})", paren or "")
    if m:
        return m.group(1), m.group(2)
    m = re.search(r"born[^)]*?(\d{4})", paren or "", re.I)
    if m:
        return m.group(1), ""
    return "", ""


def profile(title: str, extract: str) -> dict[str, Any]:
    """Read what kind of thing the top result describes, from its own words."""
    sents = _sentences(extract)
    lead = next((s for s in sents if len(s) > 25 and not _DISAMBIG.search(s)), sents[0] if sents else "")
    m = _LEAD.match(lead) if lead else None
    name, paren, cop, desc, head = title, "", "", "", ""
    if m:
        name = m.group("name").strip()
        paren = m.group("paren") or ""
        cop = m.group("cop")
        desc = m.group("desc").strip().rstrip(".")
        head = _head(desc)
    kind = _kind_of(head or title, paren, desc or lead, title)
    past = cop in {"was", "were"}
    born, died = _life(paren, extract)
    contested = _CONTESTED.findall(extract or "")
    alleged = len(_ALLEGED.findall(extract or ""))
    return {
        "lead": lead,
        "name": name,
        "short": _short_name(name, kind, title),
        "head": _with_article(head) if head else "",
        "desc": desc,
        "kind": kind,
        "past": past,
        "born": born,
        "died": died,
        "pron": _pronoun(extract) if kind == "person" else ("it", "it", "its"),
        "contested": [c for i, c in enumerate(contested) if c.lower() not in {x.lower() for x in contested[:i]}],
        "alleged": alleged,
        "kind_word": _KIND_WORD.get(kind, "a topic"),
    }


def _years(results: list[dict[str, Any]]) -> list[int]:
    seen: set[int] = set()
    for r in results:
        for y in _YEAR.findall(r.get("title", "") + " " + r.get("extract", "")):
            seen.add(int(y))
    return sorted(seen)


def hinge(results: list[dict[str, Any]], lead: str, short: str) -> dict[str, Any]:
    """The sentence that carries the turning point: the most action and dates,
    weighted toward the top result, never the definition or a stub."""
    best: tuple[float, str, list[int]] = (0.0, "", [])
    for rank, r in enumerate(results):
        for i, s in enumerate(_sentences(r.get("extract", ""))):
            if s == lead or len(s) < 30 or _DISAMBIG.search(s):
                continue
            verbs = len(_ARC.findall(s))
            years = [int(y) for y in _YEAR.findall(s)]
            weighty = 1.0 if _WEIGHTY.search(s) else 0.0
            if not verbs and not years and not weighty:
                continue
            score = min(verbs, 3) * 2.0 + min(len(years), 3) * 1.5 + weighty
            if short and short.lower() in s.lower():
                score += 1.0
            score -= 0.15 * i + 6.0 * rank
            if score > best[0]:
                best = (score, s, years)
    return {"text": best[1], "years": best[2], "score": best[0]}


# --------------------------------------------------------------------------- #
# composing the read
# --------------------------------------------------------------------------- #


def _mid(name: str) -> str:
    """'the Battle of Kursk' when the name falls mid-sentence."""
    return re.sub(r"^(The|A|An)\s", lambda m: m.group(1).lower() + " ", name or "")


def _join(items: list[str]) -> str:
    items = [i for i in items if i]
    if not items:
        return ""
    if len(items) == 1:
        return items[0]
    return ", ".join(items[:-1]) + " and " + items[-1]


def _span(years: list[int]) -> str:
    if not years:
        return ""
    if years[0] == years[-1]:
        return str(years[0])
    return f"{years[0]}–{years[-1]}"


_STOP = {"the", "a", "an", "and", "or", "of", "in", "on", "at", "to", "for", "with", "from", "by",
         "is", "was", "are", "were", "did", "does", "do", "why", "how", "what", "who", "when", "where",
         "it", "its", "that", "this", "there", "their", "his", "her", "they", "them", "fall", "happen",
         "happened", "so", "much", "many", "get", "got"}


def _closest(subject: str, text: str, lead: str) -> str:
    """The sentence that shares the most of the question's own words — the
    nearest thing to an answer when no sentence gives a cause."""
    words = {w[:5] for w in re.findall(r"[a-z0-9]+", (subject or "").lower()) if len(w) > 2 and w not in _STOP}
    if not words:
        return ""
    best, best_n = "", 1
    for sent in _sentences(text):
        if sent == lead:
            continue
        pieces = [c.strip() for c in re.split(r";\s+", sent) if c.strip()] if len(sent) > 200 else [sent]
        for piece in pieces:
            here = {w[:5] for w in re.findall(r"[a-z0-9]+", piece.lower())}
            n = len(words & here)
            if n > best_n:
                best, best_n = piece, n
    return best


def _around(sentence: str, pat: re.Pattern[str], limit: int = 200) -> str:
    """The clause of a long sentence that contains the match, so a hit near
    the end is not clipped away."""
    if len(sentence) <= limit:
        return _clip(sentence, limit)
    m = pat.search(sentence)
    if not m:
        return _clip(sentence, limit)
    clauses = re.split(r"(?<=[,;:])\s+", sentence)
    pos = 0
    for c in clauses:
        if pos <= m.start() < pos + len(c) + 1:
            return _clip(c.strip().lstrip(",;: "), limit)
        pos += len(c) + 1
    return _clip(sentence[max(0, m.start() - 90):], limit)


def _facts_worth_naming(shared: list[str], query: str, title: str = "") -> list[str]:
    """Consensus facts that are not just the question echoed back, and not a
    bare adjective. Phrases beat single words; if any phrase survives, the
    single words are noise next to it."""
    q = {w.lower() for w in re.findall(r"[a-z0-9']+", (query + " " + (title or "")).lower())}
    kept = []
    for f in shared:
        if f.isdigit():
            continue
        words = {w.lower() for w in re.findall(r"[A-Za-z0-9']+", f)}
        if words and words <= q:
            continue
        # "National Fascist Party PNF" is the phrase plus the acronym that
        # followed it in brackets; the acronym is not part of the name.
        f = re.sub(r"\s+[A-Z]{2,6}$", "", f) if len(f.split()) > 2 else f
        kept.append(f)
    phrases = [f for f in kept if " " in f]
    return (phrases or kept)[:3]


def _frame(p: dict[str, Any], years: list[int], h: dict[str, Any], key: str,
           results: list[dict[str, Any]]) -> str:
    short, head, kind, past = p["short"], p["head"], p["kind"], p["past"]
    subj, obj, poss = p["pron"]
    span = _span(years)
    hinge_txt = _lower_first(_clip(h["text"])) if h["text"] else ""
    was = "was" if past else "is"
    top = results[0] if results else {}

    if top.get("source") == "Stack Exchange":
        line = _clip(p["lead"] or top.get("extract", ""), 200)
        return (f"The thread that answers this is “{_clip(top.get('title', ''), 90)}”, and its answer in one line:"
                f" {_lower_first(line)}.")

    if not head:
        head = p["kind_word"]

    if kind == "person" and past:
        if hinge_txt and span:
            return _pick([
                f"Read {short} as {head}. The record here runs {span}, and it turns on one moment: {hinge_txt}.",
                f"{short} {was} {head}; the arc the sources cover is {span}, and its hinge is that {hinge_txt}.",
                f"Strip {short} down to what the sources will stand behind and you get {head}, a {span} arc, and one turning point: {hinge_txt}.",
            ], key)
        if span:
            return f"{short} {was} {head}; the sources cover {span} and very little outside it."
        return f"{short} {was} {head} — that is the whole of what these extracts establish."

    if kind == "person":
        base = f"{short} is {head}."
        if hinge_txt:
            base += " " + _pick([
                f"The concrete thing on record: {hinge_txt}.",
                f"Past the label, the fact the sources actually carry is that {hinge_txt}.",
            ], key)
        positions = [c.lower() for c in p["contested"] if not _LABEL_ONLY.match(c)]
        if len(positions) >= 2:
            named = _join(positions[:3])
            if p["alleged"]:
                base += (f" The extract keeps {named} at arm's length — {p['alleged']} of its claims are framed as"
                         f" allegations — so repeat them as allegations, not as findings.")
            else:
                base += (f" The source does not hedge and neither will I: it attributes {named} to {obj} as"
                         f" positions {subj} has advanced {_REFLEXIVE[subj]}, not as things critics say about"
                         f" {obj}. Repeat them that way.")
        return base

    if kind == "event":
        lead_in = f"{short} {was} {head}."
        outcome = _OUTCOME.search(" ".join(r.get("extract", "") for r in results))
        out_txt = _clip(outcome.group("what"), 80) if outcome else ""
        if out_txt and hinge_txt:
            return lead_in + " " + _pick([
                f"The outcome the sources fix: {out_txt}{', in ' + span if span else ''}. The line that carries the weight: {hinge_txt}.",
                f"Two things are not in doubt here — it ended in {out_txt}{' (' + span + ')' if span else ''}, and {hinge_txt}.",
            ], key)
        if out_txt:
            return f"{lead_in} It ended in {out_txt}{', ' + span if span else ''}; that is the firm part."
        if hinge_txt and span:
            return f"{lead_in} Pin it to {span}; the sentence that carries the weight is that {hinge_txt}."
        if hinge_txt:
            return f"{lead_in} What decides it, in the sources' own telling: {hinge_txt}."
        return lead_in + (f" The sources date it to {span}." if span else "")

    lead_in = f"{short} {was} {head}."
    if hinge_txt and span and "–" in span:
        return lead_in + " " + _pick([
            f"The sources run {span}; the line that does the work is that {hinge_txt}.",
            f"Across {span}, the sentence to keep is that {hinge_txt}.",
        ], key)
    if hinge_txt and span:
        return f"{lead_in} The one date the sources give is {span}, and the line that does the work is that {hinge_txt}."
    if hinge_txt:
        return f"{lead_in} The line that does the work: {hinge_txt}."
    return lead_in


def _agreement(results: list[dict[str, Any]], shared: list[str], conflict: str,
               level: str, query: str, key: str) -> str:
    n = len(results)
    hosts = sorted({r.get("source", "") for r in results if r.get("source")})
    facts = _facts_worth_naming(shared, query, results[0].get("title", "") if results else "")
    both = "Both" if n == 2 else f"All {n}"
    if n >= 2 and facts:
        those = "that" if len(facts) == 1 else "those"
        base = _pick([
            f"{n} sources converge on {_join(facts)} — treat {those} as settled.",
            f"What all {n} sources put on the table is {_join(facts)}; that is the floor, not the ceiling.",
        ], key)
        if conflict:
            base += f" They split on one date: {conflict[0].lower() + conflict[1:]}"
        elif hosts == ["Wikipedia"]:
            base += f" {both} are Wikipedia pages, so this is one editorial view from {n} angles, not {n} independent witnesses."
        return base
    if n >= 2 and conflict:
        return f"The sources disagree on a date: {conflict[0].lower() + conflict[1:]}"
    if n == 1 or level == "single":
        src = results[0].get("source", "one source") if results else "one source"
        return _pick([
            f"This rests on a single {src} page, so it is that page's reading, not a consensus.",
            f"One source cleared the bar ({src}); everything above is its account, uncorroborated here.",
        ], key)
    if hosts == ["Wikipedia"]:
        return f"{both} sources are Wikipedia, which is one editorial view from {n} angles rather than {n} witnesses."
    return ""


def _window(h: dict[str, Any], years: list[int]) -> tuple[int, int] | None:
    """The stretch of years the hinge sentence covers — or from the hinge to
    the next dated thing, when the hinge names a single year."""
    if not h["years"]:
        return None
    start = min(h["years"])
    end = max(h["years"])
    if end == start:
        later = [y for y in years if y > start]
        if not later:
            return None
        end = later[0]
    return (start, end)


def _gap(query: str, p: dict[str, Any], interp: dict[str, Any], results: list[dict[str, Any]],
         years: list[int], h: dict[str, Any], shared: list[str], key: str) -> str:
    shape = interp.get("shape", "topic")
    text = " ".join(r.get("extract", "") for r in results)
    short, kind = p["short"], p["kind"]
    subj, obj, poss = p["pron"]

    if any(r.get("source") == "Stack Exchange" for r in results):
        return _pick([
            "Practitioner answers are the right kind of source for a how-to, and they date: check which version the accepted answer assumes against yours before copying it.",
            "Take the mechanism from the accepted answer, not the top-voted comment, and check the version it assumes — that is where these threads go stale.",
        ], key)

    if shape == "why":
        m = _CAUSAL.search(text)
        if m:
            s = next((s for s in _sentences(text) if m.group(0) in s), "")
            if s and s == h["text"]:
                return ("You asked why, and the sentence above is the only place these sources reach for a cause."
                        " Check it before repeating it: one source's list of causes is its editors' choice, not a finding.")
            if s:
                return (f"You asked why. The one place the sources reach for a cause: {_lower_first(_clip(s, 200))}."
                        " That is the sentence to check before repeating it.")
        near = _closest(interp.get("subject", ""), text, p["lead"])
        if near:
            return (f"You asked why. The closest the sources come is a what, not a why: {_lower_first(_clip(near, 200))}."
                    " The reason behind it is not in them and I will not invent one; ask for the reason directly and the search will target it.")
        return (f"You asked why, and these extracts narrate — they say what {_mid(short)} did and when, never why."
                " The cause is not in them and I will not invent one; ask for it directly and the search will target it.")

    if shape == "how" and not _HOWTO.search(text):
        return (f"You asked how; the sources describe rather than instruct. What they give is the mechanism"
                f"{' in ' + _span(h['years']) if h['years'] else ''}, not the steps — ask for the steps separately.")

    if shape == "when":
        if years:
            return (f"The firm part is the dating: {_join([str(y) for y in years[:4]])}."
                    " Anything narrower than the year is not in these extracts.")
        return ("For a “when” question the answer has to be a date, and no date survives in these extracts"
                " — the sources found the subject, not the moment.")

    if shape == "who" and kind != "person":
        return (f"Note that {short} is {p['kind_word']}, not a person. If you meant someone by that name,"
                " the sources did not surface them — add a first name or a role.")

    if shape == "verdict":
        asked = (query or "").strip().rstrip("?.! ")
        name_words = {w.lower() for w in re.findall(r"[A-Za-z0-9']+", p["name"] + " " + p["short"])}
        terms = [w for w in re.findall(r"[a-z0-9\-']{4,}", asked.lower())
                 if w not in _STOP and w not in name_words and w not in {"true", "really", "actually", "real"}]
        term = terms[-1] if terms else ""
        if term:
            pat = re.compile(r"\b" + re.escape(term) + r"\w*", re.I)
            hit = next((sent for sent in _sentences(text) if pat.search(sent)), "")
            if hit:
                return (f"On the yes-or-no — “{asked}?” — the sources' own words are: {_lower_first(_around(hit, pat))}."
                        " That is as far as they go; read the verdict off that sentence, not off the label.")
            return (f"On the yes-or-no — “{asked}?” — the word “{term}” does not appear in any of these extracts,"
                    " so they cannot settle it either way. That absence is the answer here, not a shrug.")
        if h["text"]:
            return (f"On the yes-or-no — “{asked}?” — the sources give facts, not a verdict, and the fact that decides it"
                    f" is that {_lower_first(_clip(h['text'], 180))}.")
        return f"On the yes-or-no — “{asked}?” — nothing in these extracts settles it either way, which is itself the answer."

    if kind == "person" and p["past"]:
        win = _window(h, years)
        if win and (win[0], win[1]) != (years[0], years[-1]):
            start, end = win
            digits = [int(y) for y in shared if y.isdigit()]
            inside = [y for y in digits if start <= y <= end]
            tail = " — every date the sources agree on falls inside it" if digits and len(inside) == len(digits) else ""
            return _pick([
                f"If you want the mechanism rather than the biography, the window to read closely is {start}–{end}{tail}.",
                f"The stretch that explains the rest is {start}–{end}{tail}; the years before it are prologue in these sources.",
            ], key)
        if p["born"] and p["died"]:
            return (f"The sources bracket {obj} at {p['born']}–{p['died']} and spend nearly all their words on what"
                    f" {subj} did, not on how {subj} got there.")
        return f"The sources give {short}'s offices and dates, not {poss} motives; the motives are the part to ask about next."

    if kind == "person":
        venue = _VENUE.search(text)
        if venue:
            return (f"The long-form record is {poss} own: {venue.group('name').strip()}. That is the thing to read or"
                    f" watch before repeating a one-paragraph summary of {obj}; the summary tells you the label,"
                    " the record tells you the pattern.")
        return _pick([
            f"What the sources do not give you is reception — how {short} actually lands beyond the label. They give the résumé; one long-form primary source is worth more than any summary of {obj}.",
            f"The extract gives {short}'s résumé and nothing on how it lands; what {subj} has said in long form is the check, not the summary.",
        ], key)

    if kind == "event":
        if h["years"]:
            return (f"The sources tell the outcome; the how sits in the {_span(h['years'])} passage,"
                    " which is the part worth reading in full.")
        return (f"The sources fix the outcome and the scale of {_mid(short)}; what they leave out is the how"
                f"{' — the mechanics of the ' + _span(years) + ' fighting' if years and 'battle' in (p['head'] or '').lower() else ''}"
                ", and that is the part to read in full.")

    if kind == "software":
        first = next((y for y in years if y), None)
        return (f"The sources define {short}{' and date it to ' + str(first) if first else ''}; they do not tell you"
                " when to choose it. That trade-off lives in what you would replace it with, and it is not in them.")

    if kind == "place":
        return (f"The sources locate and date {short}; they do not say why it matters to your question."
                " Name the angle — history, geography, economy — and the search will narrow.")

    if kind == "organization":
        return (f"The sources give {short}'s founding and role; who runs it now and who pays for it is not in"
                " an encyclopaedia lead. Ask for that directly.")

    if kind == "work":
        return (f"The sources describe {short} as an object — who made it, when — and say nothing about whether"
                " it is any good; that judgement is not in them.")

    return (f"The sources define {short}; they do not argue about it. If the question was really about a"
            f" dispute over {short}, name the dispute.")


def compose(
    query: str,
    results: list[dict[str, Any]],
    interp: dict[str, Any],
    shared: list[str],
    conflict: str,
    level: str,
    technical: bool,
) -> dict[str, Any]:
    """Archiver's read, plus the one-line plan that produced it.

    Returns {"text": paragraph, "plan": one sentence, "kind": ..., "gaps": [...]}.
    Empty text when there is nothing retrieved to read.
    """
    if not results:
        return {"text": "", "plan": "", "kind": "", "gaps": []}
    top = results[0]
    p = profile(top.get("title", ""), top.get("extract", ""))
    years = _years(results)
    h = hinge(results, p["lead"], p["short"])
    key = (query or "").strip().lower()

    parts = [
        _frame(p, years, h, key, results),
        _agreement(results, shared, conflict, level, query, key),
        _gap(query, p, interp, results, years, h, shared, key),
    ]
    text = " ".join(s.strip() for s in parts if s and s.strip())
    text = re.sub(r"\s{2,}", " ", text).replace(" ,", ",").replace(" .", ".").strip()

    hosts = sorted({r.get("source", "") for r in results if r.get("source")})
    n = len(results)
    reading = interp.get("restatement") or query
    if top.get("source") == "Stack Exchange":
        plan = (f"Read the question as {reading}; it is a practitioner question, and {n} Stack Exchange"
                f" thread{'s' if n != 1 else ''} matched — quote the answer in one line, then say what to check"
                " before copying it.")
    else:
        plan = (
            f"Read the question as {reading}; {n} source{'s' if n != 1 else ''}"
            f" ({', '.join(hosts) or 'unknown'}) describe{'' if n != 1 else 's'} {_mid(p['short'])} as {p['kind_word']}"
            f"{' (' + _strip_article(p['head']) + ')' if p['head'] else ''}; lead with the strongest line, then what"
            f" the sources agree on{', then the date they split on' if conflict else ''}, then my own read of"
            f" {'the ' + _span(years) + ' record' if years else 'what they leave out'}."
        )
    gaps = []
    if interp.get("shape") == "why" and not _CAUSAL.search(" ".join(r.get("extract", "") for r in results)):
        gaps.append("no cause in sources")
    if n == 1 or level == "single":
        gaps.append("single source")
    if hosts == ["Wikipedia"] and n > 1:
        gaps.append("one publisher")
    return {"text": text, "plan": plan, "kind": p["kind"], "gaps": gaps}
