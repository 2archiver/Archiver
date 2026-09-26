"""Reproduce the pinned, self-hosted WebLLM runtime. Never downloads model weights.

Run: python scripts/vendor_webllm.py
Uses only Python's standard library; deployment does not need npm or this script.
"""
from hashlib import sha256
from io import BytesIO
from pathlib import Path
import tarfile
import gzip
from urllib.request import urlopen

VERSION = "0.2.80"
URL = f"https://registry.npmjs.org/@mlc-ai/web-llm/-/web-llm-{VERSION}.tgz"
ARCHIVE_SHA256 = "e344a81e022edddde47f76ba89786105491113a33aed5d50a127fc836953aed1"
ROOT = Path(__file__).resolve().parents[1] / "web" / "vendor"


def main():
    with urlopen(URL, timeout=60) as response:
        data = response.read()
    if sha256(data).hexdigest() != ARCHIVE_SHA256:
        raise RuntimeError("WebLLM archive checksum mismatch; refusing to vendor it")
    ROOT.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=BytesIO(data), mode="r:gz") as archive:
        for member, filename in (
            ("package/lib/index.js", f"web-llm-{VERSION}.js"),
            ("package/LICENSE", f"web-llm-{VERSION}.LICENSE"),
        ):
            content = archive.extractfile(member).read()
            (ROOT / filename).write_bytes(content)
            if filename.endswith(".js"):
                (ROOT / (filename + ".gz")).write_bytes(gzip.compress(content, compresslevel=9, mtime=0))
            print(f"{filename}: {sha256(content).hexdigest()}")


if __name__ == "__main__":
    main()
