#!/usr/bin/env python3
"""Build browser-playable H.264 proxies for every video in the export.

iPhone videos are HEVC (hvc1) in a QuickTime container: Safari plays them,
Chrome/Edge on most desktops cannot and show "file is corrupt".  The panel
already prefers Scan/play/<rel>.mp4 when it exists, so this pass fills that
cache for Photos and Drive videos without touching the originals.
"""
from __future__ import annotations

import argparse
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from worker.scan import video_proxy  # noqa: E402

ROOT = Path("/opt/icloud3/export")
AREAS = ("Library", "Hidden", "Recently Deleted")
VIDEO_EXT = {".mov", ".mp4", ".m4v", ".3gp", ".avi", ".mkv", ".webm"}
LOG = Path("/opt/icloud3/video_proxies.log")


def log(message: str) -> None:
    line = time.strftime("%Y-%m-%d %H:%M:%S ") + message
    print(line, flush=True)
    try:
        with LOG.open("a") as handle:
            handle.write(line + "\n")
    except OSError:
        pass


def videos(account: Path) -> list[Path]:
    found: list[Path] = []
    for area in AREAS:
        base = account / "Photos" / area
        if base.is_dir():
            found.extend(p for p in base.rglob("*") if p.is_file() and p.suffix.lower() in VIDEO_EXT)
    drive = account / "Drive"
    if drive.is_dir():
        found.extend(p for p in drive.rglob("*") if p.is_file() and p.suffix.lower() in VIDEO_EXT)
    return found


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--email")
    args = parser.parse_args()

    accounts = sorted([p for p in ROOT.iterdir() if p.is_dir()])
    if args.email:
        wanted = {item.strip().lower() for item in args.email.split(",") if item.strip()}
        accounts = [p for p in accounts if p.name.lower() in wanted]

    log(f"start {len(accounts)} accounts workers {args.workers}")
    totals = {"done": 0, "skip": 0, "fail": 0}

    for account in accounts:
        scan_dir = account / "Scan" / "play"
        items = videos(account)
        todo = []
        for path in items:
            rel = path.relative_to(account).as_posix()
            target = scan_dir / f"{rel}.mp4"
            if target.exists() and target.stat().st_size > 10_000:
                totals["skip"] += 1
                continue
            todo.append((path, target))
        if not todo:
            continue
        log(f"{account.name} {len(todo)} videos to convert")
        started = time.time()

        def one(pair):
            path, target = pair
            return path, video_proxy(path, target)

        done = 0
        with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
            for path, ok in pool.map(one, todo):
                done += 1
                totals["done" if ok else "fail"] += 1
                if not ok:
                    log(f"FAIL {path.relative_to(account).as_posix()}")
                if done % 50 == 0:
                    log(f"{account.name} {done}/{len(todo)}")
        log(f"done {account.name} {len(todo)} in {time.time() - started:.0f}s")

    log(f"finish converted {totals['done']} skipped {totals['skip']} failed {totals['fail']}")


if __name__ == "__main__":
    main()
