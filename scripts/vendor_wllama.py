"""Reproduce the pinned, self-hosted WASM inference runtime. Never downloads weights.

wllama is llama.cpp compiled to WebAssembly. It is vendored because Safari on
iOS/iPadOS ships WebGPU disabled on most OS versions, so the WebGPU runtime
alone leaves those visitors without generation. WASM needs no GPU, no flag and
no manual install step; it is the automatic fallback backend.

Two archives are fetched from the npm registry, each checked against a pinned
SHA-256 before a single byte is extracted:

* `@wllama/wllama` 3.6.1 — the main runtime (ESM loader + the JSPI/Memory64
  WebAssembly build). Used by Chromium-class browsers.
* `@wllama/wllama-compat` 3.6.1 — the Asyncify build for browsers without JSPI
  or Memory64 (Safari, and Firefox unless it enables JSPI). The loader decides
  which one to run (`needCompat()`); this script only makes both available
  locally so the app never asks jsDelivr for them at run time.

Important: BOTH builds import a *shared* WebAssembly.Memory. Browsers only
allow that in a cross-origin-isolated page, so the WASM path needs COOP/COEP
(provided by the app server, or by the GitHub Pages service worker) even for a
single thread. See web/vendor/README.md.

Run: python scripts/vendor_wllama.py
Uses only Python's standard library; deployment does not need npm or this script.
"""
from hashlib import sha256
from io import BytesIO
from pathlib import Path
import tarfile
import gzip
from urllib.request import urlopen

VERSION = "3.6.1"
ROOT = Path(__file__).resolve().parents[1] / "web" / "vendor"

# (npm archive URL, pinned archive SHA-256, members to extract)
# member -> (filename we ship, expected sha256 of the extracted bytes)
ARCHIVES = (
    (
        f"https://registry.npmjs.org/@wllama/wllama/-/wllama-{VERSION}.tgz",
        "866e9403a8d686e33d5df0512f507ab79fccfbf08902d4b7add4c3a7a706b539",
        (
            # The unminified esm/index.js is vendored on purpose: a visitor's
            # console stack trace should be readable, and the gzip difference
            # is small.
            ("package/esm/index.js", f"wllama-{VERSION}.js",
             "ee4b31125271a8d525db06d59724ebdb79c3bda5396eb9e3245f64fd531faf6b"),
            ("package/esm/wasm/wllama.wasm", f"wllama-{VERSION}.wasm",
             "6ca9fdd1b6c03206cd3a04e359b52c8f539896d6c5fb5d36243dded4a689f0ad"),
            # The package spells it LICENCE; it is the MIT license for wllama/llama.cpp.
            ("package/LICENCE", f"wllama-{VERSION}.LICENSE",
             "5866e3bd7e3cbd3f7c8bea6efd8a1e7fa7cc8de68c30f428aff7c6584a0fb720"),
        ),
    ),
    (
        f"https://registry.npmjs.org/@wllama/wllama-compat/-/wllama-compat-{VERSION}.tgz",
        "c8215faa70ac9c0ebe724aaef82235a8ea45643d9ee9535c6ba308c0d57f0ee8",
        (
            # Asyncify worker glue. The loader fetches it as text and runs it
            # inside a blob worker, so it is served as plain JavaScript.
            ("package/wasm/wllama.js", f"wllama-compat-{VERSION}.js",
             "97f88f7bf26b17ead6be6e7c0c39d20e21661e71827eb5e3c9a468667fc249f5"),
            ("package/wasm/wllama.wasm", f"wllama-compat-{VERSION}.wasm",
             "3c447fe82f5376b1202f909a414348421fe196ae069e1504010f55c0454f85f4"),
        ),
    ),
)

# The compat tarball ships no licence file (its package.json declares MIT).
# We keep the upstream MIT notice from the same repository and release.
COMPAT_LICENSE_FROM = ("wllama", f"wllama-{VERSION}.LICENSE")
COMPAT_LICENSE_TO = f"wllama-compat-{VERSION}.LICENSE"


def fetch_verified(url: str, expected_sha256: str) -> bytes:
    with urlopen(url, timeout=180) as response:
        data = response.read()
    if sha256(data).hexdigest() != expected_sha256:
        raise RuntimeError(f"{url.rsplit('/', 1)[-1]} archive checksum mismatch; refusing to vendor it")
    return data


def main() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    licence_bytes = None
    for url, archive_sha, members in ARCHIVES:
        data = fetch_verified(url, archive_sha)
        with tarfile.open(fileobj=BytesIO(data), mode="r:gz") as archive:
            for member, filename, expected in members:
                content = archive.extractfile(member).read()
                digest = sha256(content).hexdigest()
                if digest != expected:
                    raise RuntimeError(f"{filename} checksum mismatch; refusing to vendor it")
                (ROOT / filename).write_bytes(content)
                if filename == COMPAT_LICENSE_FROM[1]:
                    licence_bytes = content
                # Same reproducible-gzip convention as the WebGPU runtime: mtime=0 so
                # two runs produce byte-identical artifacts and the diff stays empty.
                if not filename.endswith(".LICENSE"):
                    (ROOT / (filename + ".gz")).write_bytes(gzip.compress(content, compresslevel=9, mtime=0))
                print(f"{filename}: {digest} ({len(content)} bytes)")
    if licence_bytes is None:
        raise RuntimeError("upstream MIT licence was not extracted; refusing to vendor the compat build")
    (ROOT / COMPAT_LICENSE_TO).write_bytes(licence_bytes)
    print(f"{COMPAT_LICENSE_TO}: copied from {COMPAT_LICENSE_FROM[1]} (same upstream MIT notice)")


if __name__ == "__main__":
    main()
