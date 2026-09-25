# Archiver 2.6

**A private assistant that runs in your browser, reads the web for you, and remembers you.**

No API key. No account. No signup. Nothing you type is sent to a model provider.

**Try it: <https://archiver-r7zh.onrender.com>**

---

## What it does

You ask it something. It answers — from what it already knows, and from live
sources when you turn **WEB** on.

It reads those sources rather than listing them. You get a short answer, the
sense it made of your question, whether the sources agree, and how confident it
is. If it found nothing worth your time, it says so instead of showing you four
links that don't answer the question.

There is one model. It is called Archiver. You don't pick it, download it, or
configure it.

## How it talks

It has a view and it gives it. Ask it something contested and you get the
strongest version of each side, then which one it finds more convincing — it
won't invent a second side to look balanced, and it won't moralise at you.
Short sentences, dry humour, no fawning.

It also knows what you just said. `and?`, `why?`, `based?`, `what do you think`
are answered against the previous turn rather than looked up as new questions —
so a follow-up about Stalingrad stays about Stalingrad. Greetings, slang,
swearing and fragments are treated as talk and never handed to a search engine:
`hey yo` is a hello, not a Japanese wrestler named Yo-Hey, and `fu` is somebody
in a mood rather than a lookup.

Asking about its own vocabulary works too. After it mentions its 61 cards,
`cards` explains the cards — `memory`, `web`, `sources` and `teach` all answer
about itself rather than searching for the concept. And a genuine miss always
says what it *does* know instead of stopping the conversation.

## Using it

| | |
|---|---|
| Ask anything | Type and press send |
| **WEB** | Turn it on to search live sources |
| **MEM** | Your memory bank — what it has learned about you |
| `teach: question = answer` | Teach it something permanently |
| `forget: question` | Remove something you taught |
| `help` | Everything it can do |

## How it works, briefly

Your question goes to modesty-sized local retrieval (61 curated cards) and, if
WEB is on, to a keyless server-side search across Wikipedia, Wikimedia, Stack
Exchange and DuckDuckGo. Results are scored for relevance and most are thrown
away — a search panel that is always full is a panel nobody trusts.

Then the model, running on your own GPU through WebGPU, writes the answer. It
loads itself the first time you send a message, downloads once, and never
touches a server.

Your conversations and memories live in one SQLite file you own.

---

## Run it yourself

```bash
git clone https://github.com/2archiver/Archiver.git
cd Archiver
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
./run.sh
```

Then open <http://localhost:8000>.

Three dependencies: FastAPI, uvicorn, httpx. No build step, no bundler, no npm.

| Variable | Default | What it's for |
|---|---|---|
| `PORT` | `8000` | Port to listen on |
| `ARCHIVER_DB` | `archiver.db` | Where your memory bank is stored |

To deploy on Render: build `pip install -r requirements.txt`, start `./run.sh`.
Attach a persistent disk and point `ARCHIVER_DB` at it, or your memories are
lost on every deploy.

## Known limits

- **WebGPU is required** for the model. Chrome, Edge and Safari 26+ have it.
  Without it you still get the corpus and live search, just no reasoning.
- **The model is roughly 5 GB**, downloaded once per browser. Desktop is fine.
  A phone will likely run out of GPU memory and fall back to a smaller one.
- **The curated corpus is narrow** — WWII, contemporary internet figures, and
  web engineering. Outside that, WEB is what carries the answer.
- **Search grounds, it doesn't verify.** A Wikipedia sentence can be wrong.
- **No auth.** It's a personal app. Don't publish a copy with a memory bank you
  care about.

---

MIT — see `LICENSE`.
