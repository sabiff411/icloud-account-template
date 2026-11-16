#!/usr/bin/env python3
"""Keep Scan/thumbs up to date for every account.

    warm_thumbs.py [email[,email]] [--workers 8] [--loop 120]

The panel asks for one thumbnail per visible tile.  When a thumbnail is
missing the web process generates it on demand, which for a 2 MB HEIC means
fetching and decoding the original — a page of 100 tiles took ~10 s.  This
warmer builds the missing thumbnails ahead of time (same code, same output),
so a tile is a static JPEG read from disk.

Thumbnails live in Scan/thumbs, which the S4 prune does not move, so warming
an account before it is pruned keeps its tiles instant for ever.
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image, ImageFile, ImageOps

try:  # iPhone photos
    from pillow_heif import register_heif_opener

    register_heif_opener()
except Exception:  # noqa: BLE001
    pass

ImageFile.LOAD_TRUNCATED_IMAGES = True
Image.MAX_IMAGE_PIXELS = 500_000_000

ROOT = Path("/opt/icloud3/export")
LOG = Path("/opt/icloud3/warm_thumbs.log")
SIZE = int(os.environ.get("WARM_THUMB_SIZE", "640"))
QUALITY = int(os.environ.get("WARM_THUMB_QUALITY", "82"))
VIDEO = {".mov", ".mp4", ".m4v", ".3gp"}
IMAGE = {
    ".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".bmp", ".tif", ".tiff",
    ".avif", ".gif", ".dng", ".nef", ".cr2", ".cr3", ".arw", ".orf", ".rw2", ".raf",
}


def log(message: str) -> None:
    line = time.strftime("%Y-%m-%d %H:%M:%S ") + message
    print(line, flush=True)
    try:
        with LOG.open("a") as handle:
            handle.write(line + "\n")
    except OSError:
        pass


def make(source: Path, target: Path) -> bool:
    if target.exists() and target.stat().st_size > 0:
        return False
    if source.suffix.lower() not in IMAGE:
        return False
    try:
        with Image.open(source) as image:
            upright = ImageOps.exif_transpose(image) or image
            upright = upright.convert("RGB")
            upright.thumbnail((SIZE, SIZE))
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_suffix(target.suffix + ".part")
            upright.save(temporary, "JPEG", quality=QUALITY, optimize=True)
            os.replace(temporary, target)
        return True
    except Exception:  # noqa: BLE001
        return False


def account_files(base: Path) -> list[tuple[Path, Path]]:
    pending = []
    photos = base / "Photos"
    if not photos.is_dir():
        return pending
    for path in photos.rglob("*"):
        if not path.is_file() or path.name.endswith(".part"):
            continue
        if path.suffix.lower() not in IMAGE:
            continue
        rel = path.relative_to(base)
        target = base / "Scan" / "thumbs" / f"{rel}.jpg"
        if not target.exists():
            pending.append((path, target))
    return pending


def warm(base: Path, workers: int) -> int:
    pending = account_files(base)
    if not pending:
        return 0
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        done = sum(1 for ok in pool.map(lambda pair: make(*pair), pending) if ok)
    return done


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--emails", default="")
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--loop", type=int, default=0, help="seconds between passes (0 = once)")
    args = parser.parse_args()

    wanted = {item.strip().lower() for item in args.emails.split(",") if item.strip()}
    while True:
        accounts = [
            path for path in sorted(ROOT.iterdir())
            if path.is_dir() and not path.name.startswith(".")
        ]
        total = 0
        for base in accounts:
            if wanted and base.name.lower() not in wanted:
                continue
            started = time.time()
            made = warm(base, args.workers)
            if made:
                log(f"{base.name}: {made} thumbnails in {time.time() - started:.0f}s")
            total += made
        log(f"pass done, {total} thumbnails")
        if not args.loop:
            break
        time.sleep(args.loop)


if __name__ == "__main__":
    main()
