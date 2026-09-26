# Vendored browser AI runtime

`web-llm-0.2.80.js` is the **unmodified** `package/lib/index.js` from
`@mlc-ai/web-llm@0.2.80` on npm. Its Apache-2.0 license is included as
`web-llm-0.2.80.LICENSE`. Upstream: <https://github.com/mlc-ai/web-llm>.

- Package: <https://registry.npmjs.org/@mlc-ai/web-llm/-/web-llm-0.2.80.tgz>
- Archive SHA-256: `e344a81e022edddde47f76ba89786105491113a33aed5d50a127fc836953aed1`
- JavaScript SHA-256: `ef77cc550c47c441f0243d7d173864548164814a9565c1a9a0b8b57f82167199`

Reproduce these files with `python scripts/vendor_webllm.py`. The script verifies
the pinned archive checksum, copies only the runtime and license, and creates a
reproducible gzip representation (`mtime=0`). Deployments do not run this script
and do not need npm. `app/main.py` serves the gzip variant when accepted, with
versioned immutable caching. Both the page and inference worker import this
same-origin asset. No inference-library CDN request is needed.

**These are runtime code, not model weights.** WebLLM fetches the selected Qwen2.5
0.5B quantized model, tokenizer, and compiled GPU library from the upstream URLs
in its pinned catalog. Those assets are cached by WebLLM's browser Cache API,
subject to storage availability and eviction. They are never downloaded to the
Render service or committed to Git. Browser model caches are separate from the
SQLite archive and are not a durable user-data backup.

Do not edit a versioned asset in place: change its version/URL, engine import,
worker import, server route, checksum, and tests together when upgrading. The
upstream source-map reference is retained; source maps are not vendored.
