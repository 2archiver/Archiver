# Archiver 2.6.2

**A private research assistant that runs in your browser, reads the web for you, remembers you, and — when you let it — thinks.**

No API key. No account. Your messages are never sent to a model provider.

**Try it: <https://archiver-r7zh.onrender.com>**

---

## What it does

You ask it something. It answers from three places:

1. **The library.** About 1,300 curated cards: history (WW2 in depth, Napoleon
   and 19th-century Europe), science, health, tech, philosophy, nature, culture
   and practical life. It is instant and works offline, and nothing needs
   downloading.
2. **The web**, when you turn **WEB** on. A keyless server-side search across
   Wikipedia, Wikimedia, Stack Exchange and DuckDuckGo. Results are scored for
   relevance and most are thrown away. You get a short reading of what the
   sources say, whether they agree, and at most three sources you can check.
3. **A reasoning model**, when you load one. Qwen3 runs on your own GPU through
   [WebLLM](https://github.com/mlc-ai/web-llm). It thinks before it answers. You
   watch the reasoning stream in, and you can open **"Thought for Ns"** under
   any reply to read it. The library notes and web sources go to the model as
   notes, so it does the thinking while the notes keep it honest about dates
   and names.

Nothing downloads until you ask. Loading the model is opt-in, from the banner
on the start page or from **Settings → Engine**.

| Model | Download | For |
|---|---|---|
| Qwen3 8B | ≈5.7 GB | Desktop GPU with 8 GB or more |
| **Qwen3 4B** (default) | ≈3.4 GB | Most laptops |
| Qwen3 1.7B | ≈2.0 GB | Older laptops, tablets |
| Qwen3 0.6B | ≈1.4 GB | Phones (noticeably weaker) |

The weights download once and your browser caches them. If your GPU runs out
of memory, Archiver steps down a size and tells you. **THINK** under the chat
box turns reasoning on or off for each message: off is quicker, on is better
for hard questions.

## How it talks

It has a view and it gives it. Ask it something contested and you get the
strongest version of each side, then the one it finds more convincing. It won't
invent a second side to look balanced, and it won't moralise.

It knows what you just said. With the model loaded, `why?`, `what do you
think?`, `source?` and `based?` go to the model with the conversation in view.
Without the model it tells you plainly that a real opinion needs the model. It
doesn't hand you a stock verdict. Greetings, slang and swearing are treated
as talk, never as searches. `hey yo` is a hello, not a Japanese wrestler.

## Using it

| | |
|---|---|
| Ask anything | Type and press Enter |
| **WEB** | Search live sources and cite them |
| **THINK** | Reason before answering (model loaded) |
| **MEMORY** | Your memory bank: view, edit, pin or forget anything it learned |
| **STOP** / **retry** | Stop an answer mid-stream / ask the same question again |
| `teach: question = answer` | Teach it something (kept in this browser) |
| `forget: question` | Remove exactly that taught answer |
| `help` | Everything it can do |

## Where your data lives

- **Chats and memories** are stored by the Archiver server you are using, in
  one SQLite file. Your browser gets an anonymous cookie, and everything is
  scoped to it: other visitors can't see your memories or sessions. If you run
  Archiver yourself, that file is on your machine.
- **Chats are also kept in your browser** (localStorage), so they survive a
  server restart. They re-sync when the server is back.
- **`teach:` answers** stay in your browser only.
- **The model runs in your browser.** Prompts and answers never go to a model
  provider. WEB search goes through the Archiver server.

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

It has three runtime dependencies: FastAPI, uvicorn and httpx. There is no build
step and no bundler. WebLLM is loaded from a CDN only when someone loads a model.

| Variable | Default | What it's for |
|---|---|---|
| `PORT` | `8000` | Port to listen on |
| `ARCHIVER_DB` | `archiver.db` | Where chats and memories are stored |

To deploy on Render, use `pip install -r requirements.txt` as the build command
and `./run.sh` as the start command. Attach a persistent disk and point
`ARCHIVER_DB` at it, or memories are lost on every deploy.

### Tests

```bash
make test                      # API tests (pytest)
node tests/smoke.js            # engine behaviour, including a fake-model path
npm i --no-save jsdom          # optional, for the page test
node tests/page_check.js       # the real page against a running server
```

## Known limits

- **The model needs WebGPU.** Chrome, Edge and Safari 26+ have it. Without it
  you still get the library and live search, just no reasoning.
- **Its context window is 4,096 tokens.** Long chats are trimmed to the most
  recent turns before they reach the model. Memories and summaries still carry
  what matters.
- **Small models are small.** 0.6B and 1.7B reason visibly worse than 4B and
  8B. For facts, WEB matters more than model size.
- **Search grounds, it doesn't verify.** A Wikipedia sentence can be wrong.
- **There is no login.** Browsers are separated by cookie, not by account.
  Don't host a copy for others with a memory bank you care about.

---

MIT — see `LICENSE`.
