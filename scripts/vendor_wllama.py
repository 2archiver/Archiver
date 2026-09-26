"""Reproduce the pinned, self-hosted WASM inference runtime. Never downloads weights.

wllama is llama.cpp compiled to WebAssembly. It is vendored because Safari on
iOS/iPadOS ships WebGPU disabled on most OS versions, so the WebGPU runtime
alone leaves those visitors without generation. WASM needs no GPU, no flag and
no manual install step; it is the automatic fallback backend.

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
URL = f"https://registry.npmjs.org/@wllama/wllama/-/wllama-{VERSION}.tgz"
ARCHIVE_SHA256 = "866e9403a8d686e33d5df0512f507ab79fccfbf08902d4b7add4c3a7a706b539"
ROOT = Path(__file__).resolve().parents[1] / "web" / "vendor"

# member inside the tarball -> (filename we ship, expected sha256)
# The unminified esm/index.js is vendored on purpose: a visitor's console stack
# trace should be readable, and the gzip difference is small.
MEMBERS = (
    ("package/esm/index.js", f"wllama-{VERSION}.js",
     "ee4b31125271a8d525db06d59724ebdb79c3bda5396eb9e3245f64fd531faf6b"),
    ("package/esm/wasm/wllama.wasm", f"wllama-{VERSION}.wasm",
     "6ca9fdd1b6c03206cd3a04e359b52c8f539896d6c5fb5d36243dded4a689f0ad"),
    # The package spells it LICENCE; it is the MIT license for wllama/llama.cpp.
    ("package/LICENCE", f"wllama-{VERSION}.LICENSE",
     "5866e3bd7e3cbd3f7c8bea6efd8a1e7fa7cc8de68c30f428aff7c6584a0fb720"),
)


def main() -> None:
    with urlopen(URL, timeout=180) as response:
        data = response.read()
    if sha256(data).hexdigest() != ARCHIVE_SHA256:
        raise RuntimeError("wllama archive checksum mismatch; refusing to vendor it")
    ROOT.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=BytesIO(data), mode="r:gz") as archive:
        for member, filename, expected in MEMBERS:
            content = archive.extractfile(member).read()
            digest = sha256(content).hexdigest()
            if digest != expected:
                raise RuntimeError(f"{filename} checksum mismatch; refusing to vendor it")
            (ROOT / filename).write_bytes(content)
            # Same reproducible-gzip convention as the WebGPU runtime: mtime=0 so
            # two runs produce byte-identical artifacts and the diff stays empty.
            if not filename.endswith(".LICENSE"):
                (ROOT / (filename + ".gz")).write_bytes(gzip.compress(content, compresslevel=9, mtime=0))
            print(f"{filename}: {digest} ({len(content)} bytes)")


if __name__ == "__main__":
    main()
