#!/usr/bin/env python3
"""Pre-build the JPEG preview for every photo whose format a browser cannot draw.

HEIC/HEIF, TIFF, BMP and camera raw need a JPEG before Chrome or Firefox will
show them.  The panel generates one on demand, which makes the first open slow
and, for a pruned account, costs a bucket round-trip.  This builds them ahead
of time into Scan/previews/<rel>.jpg — the exact path ensurePreview returns.

    warm_previews.py [--workers 12] [--limit N] [--account x@y.com]
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import classify_all as ca  # noqa: E402

RAW = {".heic", ".heif", ".tif", ".tiff", ".bmp", ".dng", ".nef", ".cr2", ".cr3",
       ".arw", ".orf", ".rw2", ".raf", ".srw", ".psd"}
THUMB = Path("/opt/icloud3/server/admin/thumb.py")


def log(message: str) -> None:
    print(time.strftime("%H:%M:%S ") + message, flush=True)


def preview_of(path: Path, root: Path) -> Path:
    return root / "Scan" / "previews" / f"{path.relative_to(root).as_posix()}.jpg"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workers", type=int, default=12)
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()
    python = sys.executable

    todo: list[tuple[Path, Path]] = []
    for email, root in sorted(ca.account_roots().items()):
        for path in ca.local_photos(root):
            if path.suffix.lower() not in RAW:
                continue
            target = preview_of(path, root)
            try:
                if target.is_file() and target.stat().st_size > 0:
                    continue
            except OSError:
                pass
            todo.append((path, target))
    if args.limit:
        todo = todo[: args.limit]
    log(f"{len(todo)} previews to build")

    done = {"ok": 0, "fail": 0}

    def one(item: tuple[Path, Path]) -> None:
        path, target = item
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            result = subprocess.run(
                [python, str(THUMB), str(path), str(target), "2400", "92"],
                capture_output=True, timeout=180,
            )
            if result.returncode == 0 and target.is_file() and target.stat().st_size > 0:
                done["ok"] += 1
            else:
                done["fail"] += 1
        except Exception:  # noqa: BLE001
            done["fail"] += 1
        total = done["ok"] + done["fail"]
        if total % 200 == 0:
            log(f"{total}/{len(todo)} · ok {done['ok']} · failed {done['fail']}")

    started = time.time()
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        list(pool.map(one, todo))
    log(f"done · ok {done['ok']} · failed {done['fail']} · {time.time() - started:.0f}s")


if __name__ == "__main__":
    main()
