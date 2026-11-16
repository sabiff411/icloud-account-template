#!/usr/bin/env python3
"""Build one ZIP with N images from the export for offline OCR testing.

Entries are named  <account>__<original name>  so the source account stays
visible, and a manifest.json inside the ZIP records the full source path,
area and size of every entry.
"""
from __future__ import annotations

import argparse
import json
import os
import time
import zipfile
from pathlib import Path

ROOT = Path("/opt/icloud3/export")
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".bmp", ".tif", ".tiff", ".avif", ".gif"}
AREAS = ("Library", "Hidden", "Recently Deleted")
LOG = Path("/opt/icloud3/test_zip.log")


def log(message: str) -> None:
    line = time.strftime("%Y-%m-%d %H:%M:%S ") + message
    print(line, flush=True)
    with LOG.open("a") as handle:
        handle.write(line + "\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=50_000)
    parser.add_argument("--out", default="/data/test-export/50k-images.zip")
    parser.add_argument("--max-bytes", type=int, default=0, help="stop at this archive size")
    args = parser.parse_args()

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    accounts = sorted([p for p in ROOT.iterdir() if p.is_dir()], key=lambda p: p.name.lower())
    manifest = []
    used = set()
    written = 0
    written_bytes = 0
    max_bytes = int(args.max_bytes or 0)
    log(f"start {args.count} images -> {out} cap={max_bytes or 'none'}")

    with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED, allowZip64=True) as archive:
        for account in accounts:
            if written >= args.count:
                break
            short = account.name.split("@")[0][:14]
            for area in AREAS:
                base = account / "Photos" / area
                if not base.is_dir():
                    continue
                for path in sorted(base.rglob("*")):
                    if written >= args.count:
                        break
                    if not path.is_file() or path.suffix.lower() not in IMAGE_EXT:
                        continue
                    size = path.stat().st_size
                    if max_bytes and written_bytes + size > max_bytes:
                        break
                    name = f"{short}__{path.name}"
                    if name in used:
                        stem, suffix = os.path.splitext(name)
                        name = f"{stem}__{written}{suffix}"
                    used.add(name)
                    try:
                        archive.write(path, arcname=name)
                    except OSError:
                        continue
                    manifest.append(
                        {
                            "entry": name,
                            "source": str(path.relative_to(ROOT)),
                            "account": account.name,
                            "area": area,
                            "size": path.stat().st_size,
                        }
                    )
                    written += 1
                    written_bytes += size
                    if written % 2000 == 0:
                        log(f"progress {written}/{args.count} {out.stat().st_size / 1e9:.1f} GB")
        archive.writestr("manifest.json", json.dumps(manifest, indent=1))

    log(f"done {written} images, {out.stat().st_size / 1e9:.2f} GB, manifest {len(manifest)}")


if __name__ == "__main__":
    main()
