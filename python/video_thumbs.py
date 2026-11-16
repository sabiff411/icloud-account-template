#!/usr/bin/env python3
"""Give every video a thumbnail, and store it on S4.

A video tile needs a still frame.  The panel used to make one on demand from
the local video, which works only while the file is still on disk; after the
prune it must come from S4.  So: for each video without a thumbnail, take the
frame (from the local file, or from the S4 copy), write the JPEG under
Scan/thumbs, and push that JPEG to the bucket.

    video_thumbs.py [--email a@b,c@d] [--workers 6] [--loop]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from worker.scan import video_thumb  # noqa: E402

ROOT = Path("/opt/icloud3/export")
RCLONE = "/usr/local/bin/rclone"
BUCKET = "s4:icld"
VIDEO_EXT = {".mov", ".mp4", ".m4v", ".3gp", ".avi", ".mkv", ".webm"}
LOG = Path("/opt/icloud3/video_thumbs.log")


def log(message: str) -> None:
    line = time.strftime("%Y-%m-%d %H:%M:%S ") + message
    print(line, flush=True)
    try:
        with LOG.open("a") as handle:
            handle.write(line + "\n")
    except OSError:
        pass


def videos(account: Path) -> list[dict]:
    out: list[dict] = []
    manifest = account / "Scan" / "s4-manifest.json"
    if manifest.exists():
        try:
            for entry in json.loads(manifest.read_text()).get("files") or []:
                rel = entry.get("p") or ""
                if Path(rel).suffix.lower() in VIDEO_EXT and rel.startswith(("Photos/", "Drive/")):
                    out.append({"rel": rel, "size": entry.get("s", 0)})
            return out
        except Exception:
            pass
    for base in (account / "Photos", account / "Drive"):
        if base.is_dir():
            for path in base.rglob("*"):
                if path.is_file() and path.suffix.lower() in VIDEO_EXT:
                    out.append({"rel": path.relative_to(account).as_posix(), "size": 0})
    return out


def source_for(account: Path, rel: str, play: bool) -> Path | None:
    """Prefer the local file, then the H.264 proxy, then the original."""
    local = account / rel
    if local.is_file():
        return local
    stem = Path(rel)
    candidates = []
    if play:
        candidates.append(f"Scan/play/{rel}.mp4")
    candidates.append(rel)
    for key in candidates:
        target = Path(tempfile.gettempdir()) / "vthumb" / account.name / Path(key).name
        target.parent.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(
            [RCLONE, "copyto", f"{BUCKET}/{account.name}/{key}", str(target), "--stats", "0"],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0 and target.is_file() and target.stat().st_size > 0:
            return target
    return None


def one(account: Path, item: dict) -> tuple[str, bool]:
    rel = item["rel"]
    thumb = account / "Scan" / "thumbs" / f"{rel}.jpg"
    if thumb.exists() and thumb.stat().st_size > 0:
        return rel, True
    src = source_for(account, rel, play=True)
    if not src:
        return rel, False
    ok = video_thumb(src, thumb)
    if src.is_absolute() and str(src).startswith(tempfile.gettempdir()):
        src.unlink(missing_ok=True)
    return rel, ok


def run_account(account: Path, workers: int) -> tuple[int, int]:
    items = videos(account)
    todo = [item for item in items if not (account / "Scan" / "thumbs" / f"{item['rel']}.jpg").exists()]
    if not todo:
        return 0, 0
    log(f"{account.name} {len(todo)}/{len(items)} videos need a thumbnail")
    done = failed = 0
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        for rel, ok in pool.map(lambda item: one(account, item), todo):
            done += 1
            if not ok:
                failed += 1
            if done % 25 == 0:
                log(f"{account.name} {done}/{len(todo)}")
    # The panel runs as icloud3; keep the generated files readable by it.
    subprocess.run(["chown", "-R", "icloud3:icloud3", str(account / "Scan" / "thumbs")],
                   capture_output=True)
    # push the new JPEGs (rclone copies only what changed)
    result = subprocess.run(
        [RCLONE, "copy", str(account / "Scan" / "thumbs"), f"{BUCKET}/{account.name}/Scan/thumbs",
         "--transfers", "32", "--checkers", "16", "--stats", "0", "--log-level", "ERROR"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        log(f"{account.name} upload failed: {result.stderr.strip()[-160:]}")
    log(f"{account.name} done {done - failed} thumbnails, {failed} failed")
    return done - failed, failed


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--email")
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--loop", action="store_true")
    parser.add_argument("--sleep", type=int, default=900)
    args = parser.parse_args()

    wanted = {item.strip().lower() for item in (args.email or "").split(",") if item.strip()}
    while True:
        made = failed = 0
        for account in sorted(ROOT.iterdir()):
            if not account.is_dir() or account.name.startswith("."):
                continue
            if wanted and account.name.lower() not in wanted:
                continue
            try:
                ok, bad = run_account(account, args.workers)
                made += ok
                failed += bad
            except Exception as error:  # noqa: BLE001
                log(f"{account.name} failed: {type(error).__name__}: {error}")
        log(f"pass done: {made} thumbnails, {failed} failed")
        if not args.loop:
            return
        time.sleep(max(60, args.sleep))


if __name__ == "__main__":
    main()
