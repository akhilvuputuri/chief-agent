"""Fetches the Kronos source and checkpoints named in kronos.lock.json and verifies every
file's SHA-256 before it is used. Runs at image build time only; the runtime has no network.

Usage: python fetch_artifacts.py kronos.lock.json <source-dir> <weights-dir>
"""

import hashlib
import json
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path


def download(url: str, dest: Path, sha256: str) -> None:
    digest = hashlib.sha256()
    with urllib.request.urlopen(url, timeout=600) as response, dest.open("wb") as out:
        while chunk := response.read(1 << 20):
            digest.update(chunk)
            out.write(chunk)
    if digest.hexdigest() != sha256:
        dest.unlink()
        raise SystemExit(f"SHA-256 mismatch for {url}: got {digest.hexdigest()}")


def main(lock_path: str, source_dir: str, weights_dir: str) -> None:
    lock = json.loads(Path(lock_path).read_text())

    # Only the model package is needed; the archive's other folders are never extracted.
    source = lock["source"]
    root = f"Kronos-{source['commit']}/"
    with tempfile.TemporaryDirectory() as tmp:
        archive = Path(tmp) / "kronos.tar.gz"
        download(source["url"], archive, source["sha256"])
        with tarfile.open(archive) as tar:
            members = [m for m in tar.getmembers() if m.name.startswith(f"{root}model/") and m.isfile()]
            if not members:
                raise SystemExit("The pinned archive has no model/ package")
            for member in members:
                member.name = member.name[len(root) :]
            tar.extractall(source_dir, members=members, filter="data")

    for name, model in lock["models"].items():
        target = Path(weights_dir) / name
        target.mkdir(parents=True, exist_ok=True)
        for filename, sha256 in model["files"].items():
            url = f"https://huggingface.co/{model['repo']}/resolve/{model['revision']}/{filename}"
            download(url, target / filename, sha256)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    main(*sys.argv[1:])
