"""3.3: the closing read of a web answer is built from the retrieved text.

No network. Extracts are real Wikipedia leads captured on 2026-09-26 so the
checks run against the shape of text the providers actually return.
"""
import re

import pytest

from app import search, take

MUSSOLINI = (
    "Benito Amilcare Andrea Mussolini was an Italian politician, journalist, and dictator who led "
    "the Kingdom of Italy as a fascist dictatorship from 1922 until his overthrow in 1943. Known under "
    "his rule as Il Duce, he founded fascism in 1919 with the creation of the Fasci Italiani di "
    "Combattimento, which became the National Fascist Party (PNF) in 1921. Mussolini was appointed "
    "Prime Minister of Italy after the March on Rome in 1922, establishing a totalitarian fascist "
    "dictatorship. He oversaw Italy's participation in World War II as a prominent member of the Axis "
    "Powers, and was executed by the Italian resistance near the end of the war in 1945."
)
FASCISM = (
    "Italian fascism, also called classical fascism and Fascism, is the original fascist ideology, "
    "which Benito Mussolini developed in Italy. The ideology of Italian fascism is associated with a "
    "series of political parties led by Mussolini: the National Fascist Party (PNF), which governed the "
    "Kingdom of Italy from 1922 until 1943, and the Republican Fascist Party (PFR), which governed the "
    "Italian Social Republic from 1943 to 1945."
)
KURSK = (
    "The Battle of Kursk, also called the Battle of the Kursk Salient, was a major World War II Eastern "
    "Front battle between the forces of Nazi Germany and the Soviet Union near Kursk in southwestern "
    "Russia during the summer of 1943, resulting in a Soviet victory. The Battle of Kursk is the single "
    "largest battle in the history of warfare. It ranks only behind the Battle of Stalingrad several "
    "months earlier as the most often-cited turning point in the European theatre of the war."
)
FUENTES = (
    "Nicholas Joseph Fuentes is an American far-right political commentator, live streamer, and "
    "influencer. He hosts the livestreamed show America First, where he has advanced white nationalism "
    "and white supremacy, Christian nationalism, the incel subculture, misogyny, anti-LGBTQ views, and "
    "antisemitism including Holocaust denial. His supporters are known as \"Groypers\"."
)
PYTHON = (
    "Python is a high-level, general-purpose programming language. Its design philosophy emphasizes "
    "code readability with the use of significant indentation. Guido van Rossum began working on Python "
    "in the late 1980s as a successor to the ABC programming language and first released it in 1991 as "
    "Python 0.9.0."
)
ROME = (
    "The fall of the Western Roman Empire, also called the fall of the Roman Empire or the fall of Rome, "
    "was the loss of central political control in the Western Roman Empire, a process in which the Empire "
    "failed to enforce its rule, and its vast territory was divided among several successor polities. "
    "Modern historians posit factors including the effectiveness and numbers of the army, the health and "
    "numbers of the Roman population, and the competence of the emperors. By 476 the Western Roman Empire "
    "had lost its military, political and financial power."
)
RENDER = (
    "Render is an American cloud application hosting company headquartered in San Francisco, California. "
    "It was founded in 2018 by Anurag Goel. Render offers a platform for developers to deploy web "
    "applications, static sites, databases and background workers; free-tier web services spin down "
    "after fifteen minutes of inactivity and restart on the next request."
)
THREAD = (
    "You need to buffer the response yourself. Use response.iter_content(chunk_size=8192) and write each "
    "chunk to a file-like object; do not call response.content, which reads the whole body into memory."
)

# Sentences 3.2 shipped, verbatim, for whole buckets of unrelated topics.
STOCK_32 = (
    "who pays, what must stay on, and what the default is",
    "clips outrun context every time",
    "wars are won in the warehouse",
    "free is a funnel, not charity",
    "state boundaries and deterministic fallbacks",
    "short-form clip economies",
    "Additional Thoughts",
    "Lateral Angles",
)


def hit(title, extract, source="Wikipedia"):
    return {"title": title, "extract": extract, "source": source,
            "url": "https://example.test/" + title.replace(" ", "_"), "confidence": 0.8}


def read(query, results, level="single"):
    interp = search.interpret_question(query)
    shared = search._consensus(query, results)
    conflict = search._conflict(results, shared) if shared else ""
    technical = bool(search.TECH_HINTS.search(query))
    return take.compose(query, results, interp, shared, conflict, level, technical)


def test_profile_reads_the_lead_sentence_not_the_query():
    p = take.profile("Benito Mussolini", MUSSOLINI)
    assert p["kind"] == "person" and p["past"] is True
    assert p["short"] == "Mussolini"
    assert p["head"] == "an Italian politician, journalist, and dictator"
    assert p["pron"] == ("he", "him", "his")

    assert take.profile("Python (programming language)", PYTHON)["kind"] == "software"
    assert take.profile("Battle of Kursk", KURSK)["kind"] == "event"
    assert take.profile("Fall of the Western Roman Empire", ROME)["kind"] == "event"
    assert take.profile("Render (company)", RENDER)["head"] == "an American cloud application hosting company"
    assert take.profile("Nick Fuentes", FUENTES)["past"] is False


def test_mussolini_gets_a_read_about_mussolini():
    """The 3.2 fallback told the reader to ask 'who pays, what must stay on,
    and what the default is' about a dictator. The read now comes from his
    own record."""
    out = read("Benito Mussolini", [hit("Benito Mussolini", MUSSOLINI), hit("Italian fascism", FASCISM)], "high")
    text = out["text"]
    assert "Italian politician, journalist, and dictator" in text
    assert "1919–1945" in text
    assert "founded fascism in 1919" in text
    assert "National Fascist Party" in text and "PNF —" not in text
    assert "Both are Wikipedia pages" in text
    for stock in STOCK_32:
        assert stock not in text
    assert out["kind"] == "person"
    assert out["plan"].startswith("Read the question as Benito Mussolini; 2 sources (Wikipedia) describe Mussolini as a person")


def test_different_subjects_never_share_a_paragraph():
    cases = [
        ("Benito Mussolini", [hit("Benito Mussolini", MUSSOLINI)]),
        ("battle of kursk", [hit("Battle of Kursk", KURSK)]),
        ("who is nick fuentes", [hit("Nick Fuentes", FUENTES)]),
        ("python programming language", [hit("Python (programming language)", PYTHON)]),
        ("capital of peru", [hit("Lima", "Lima is the capital and largest city of Peru. The city was founded in 1535 by Francisco Pizarro.")]),
        ("render hosting", [hit("Render (company)", RENDER)]),
    ]
    texts = [read(q, r)["text"] for q, r in cases]
    assert len(set(texts)) == len(texts)
    # Not merely different strings: no sentence is shared between any two.
    sentences = [set(s.strip() for s in re.split(r"(?<=[.!?])\s+", t) if len(s.strip()) > 40) for t in texts]
    for i in range(len(sentences)):
        for j in range(i + 1, len(sentences)):
            shared = sentences[i] & sentences[j]
            # The single-source caveat is the one sentence allowed to recur.
            shared = {s for s in shared if "single Wikipedia page" not in s and "One source cleared the bar" not in s}
            assert not shared, (cases[i][0], cases[j][0], shared)


def test_the_read_commits():
    """No hedges in Archiver's own sentences, and contested claims a source
    states as the subject's own conduct are repeated that way."""
    for q, r in [
        ("who is nick fuentes", [hit("Nick Fuentes", FUENTES)]),
        ("Benito Mussolini", [hit("Benito Mussolini", MUSSOLINI)]),
        ("battle of kursk", [hit("Battle of Kursk", KURSK)]),
    ]:
        text = read(q, r)["text"]
        own = text
        for src in (FUENTES, MUSSOLINI, KURSK):
            for s in take._sentences(src):
                own = own.replace(s.rstrip("."), "").replace(take._lower_first(s.rstrip(".")), "")
        assert not take.HEDGES.search(own), (q, take.HEDGES.search(own))

    fuentes = read("who is nick fuentes", [hit("Nick Fuentes", FUENTES)])["text"]
    assert "does not hedge and neither will I" in fuentes
    assert "white nationalism, white supremacy and misogyny" in fuentes
    assert "positions he has advanced himself, not as things critics say about him" in fuentes
    assert "America First" in fuentes  # the long-form record is named, not gestured at
    assert "hisself" not in fuentes and "summary of he" not in fuentes


def test_allegations_stay_allegations():
    alleged = ("Jane Doe is an American businesswoman. She has been accused of fraud and was allegedly "
               "involved in a scandal; critics say her company misled investors, an allegation she denies.")
    text = read("who is jane doe", [hit("Jane Doe", alleged)])["text"]
    assert "framed as allegations" in text
    assert "repeat them as allegations, not as findings" in text


def test_a_why_asked_of_narrating_sources_is_called_out():
    out = read("why did mussolini fall", [hit("Benito Mussolini", MUSSOLINI)])
    assert "You asked why" in out["text"]
    assert "I will not invent one" in out["text"]
    assert "no cause in sources" in out["gaps"]

    rome = read("why did the roman empire fall", [hit("Fall of the Western Roman Empire", ROME)])
    assert "posit factors" in rome["text"], "when a source does reach for a cause, that sentence is the one quoted"
    assert rome["text"].count("posit factors") == 1, "and it is not quoted twice"

    render = read("why does render free tier sleep", [hit("Render (company)", RENDER)])
    assert "spin down after fifteen minutes" in render["text"], "the closest clause is quoted as a what, not a why"
    assert "not a why" in render["text"]


def test_when_and_yes_or_no_questions():
    when = read("when was python released", [hit("Python (programming language)", PYTHON)])["text"]
    assert "The firm part is the dating: 1991" in when

    verdict = read("was mussolini a socialist", [hit("Benito Mussolini", MUSSOLINI), hit("Italian fascism", FASCISM)], "high")
    assert "“socialist” does not appear in any of these extracts" in verdict["text"]
    assert search.interpret_question("was mussolini a socialist")["shape"] == "verdict"
    assert search.interpret_question("was mussolini a socialist")["restatement"] == "a yes-or-no on “was mussolini a socialist”"


def test_events_fix_the_outcome():
    text = read("battle of kursk", [hit("Battle of Kursk", KURSK)])["text"]
    assert text.startswith("The Battle of Kursk was a major World War II Eastern Front battle.")
    assert "a Soviet victory" in text and "1943" in text
    assert "scale of the Battle of Kursk" in text  # mid-sentence article is lowercased


def test_stack_exchange_threads_are_read_as_practitioner_answers():
    out = read("how do i stream a large http response in python",
               [hit("How to download large file in python with requests", THREAD, "Stack Exchange")])
    assert out["text"].startswith("The thread that answers this is “How to download large file in python with requests”")
    assert "buffer the response yourself" in out["text"]
    assert "version" in out["text"]
    assert "practitioner question" in out["plan"]
    # A technical-looking query with only encyclopaedia results does not get the thread advice.
    wiki = read("python programming language", [hit("Python (programming language)", PYTHON)])["text"]
    assert "accepted answer" not in wiki


def test_brief_closes_with_the_read_and_no_heading():
    results = [hit("Benito Mussolini", MUSSOLINI), hit("Italian fascism", FASCISM)]
    interp = search.interpret_question("Benito Mussolini")
    report = search.brief("Benito Mussolini", results, "high", False, interp)
    assert report["take"] and report["voice"].endswith(report["take"])
    assert report["plan"].startswith("Read the question as")
    assert "additional_thoughts" not in report
    assert "💡" not in report["voice"] and "Lateral" not in report["voice"]
    assert report["voice"].count(report["take"]) == 1

    empty = search.brief("nothing", [], "none", False, search.interpret_question("nothing"))
    assert empty["take"] == "" and "no live source cleared the confidence bar" in empty["plan"]


def test_the_keyword_buckets_are_gone():
    src = open(search.__file__, encoding="utf-8").read()
    assert "_synthesize_thoughts" not in src
    for stock in STOCK_32:
        assert stock not in src, stock
    assert not hasattr(search, "_synthesize_thoughts")
