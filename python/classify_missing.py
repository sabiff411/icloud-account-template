#!/usr/bin/env python3
"""Classify an explicit list of bucket objects, not just the manifests.

The classifier works from each account's local tree and its s4-manifest.json.
That misses objects uploaded by the prune *after* the manifest was written, and
anything that only ever existed in the bucket.  This reads a list of
"email/rel_path" lines, fetches the cached 640 px thumbnail (or the original
when there is none), labels it, and appends to the same results file.

    classify_missing.py --list /tmp/uncovered_s4.txt [--workers 96] [--batch 2000]
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import classify as core  # noqa: E402
import classify_all as ca  # noqa: E402
from classify_all import rclone_copy  # noqa: E402


def log(message: str) -> None:
    print(time.strftime("%H:%M:%S ") + message, flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", required=True)
    parser.add_argument("--workers", type=int, default=96)
    parser.add_argument("--batch", type=int, default=1500)
    parser.add_argument("--decode-workers", type=int, default=4)
    parser.add_argument("--base-url", default=os.environ.get("VISION_BASE_URL",
                        "https://e1fbo6zesvurm4-8000.proxy.runpod.net/v1"))
    parser.add_argument("--model", default=os.environ.get("VISION_MODEL", "Qwen/Qwen3.5-4B"))
    args = parser.parse_args()

    done = core.load_results(ca.RESULTS)
    todo: dict[str, list[str]] = {}
    for line in Path(args.list).read_text(errors="ignore").splitlines():
        rel = line.strip()
        if not rel or "/" not in rel:
            continue
        if (done.get(rel) or {}).get("status") == "ok":
            continue
        email, _, path = rel.partition("/")
        todo.setdefault(email, []).append(path)
    total = sum(len(v) for v in todo.values())
    log(f"{total} bucket images to label in {len(todo)} accounts")
    if not total:
        return

    core._DECODE = threading.BoundedSemaphore(max(1, args.decode_workers))
    classifier = core.Classifier(args.base_url, args.model)
    writer = ca.Writer(ca.RESULTS)
    counter = {"done": 0, "ok": 0, "failed": 0, "invalid": 0, "total": total}
    started = time.time()
    try:
        for email, paths in sorted(todo.items(), key=lambda item: -len(item[1])):
            for start in range(0, len(paths), args.batch):
                chunk = paths[start:start + args.batch]
                stage = ca.STAGE / f"missing-{email}-{start}"
                thumbs = [f"Scan/thumbs/{path}.jpg" for path in chunk]
                rclone_copy(email, thumbs, stage)
                items: list[tuple[str, Path]] = []
                missing: list[str] = []
                for path in chunk:
                    staged = stage / email / "Scan" / "thumbs" / f"{path}.jpg"
                    if staged.is_file() and staged.stat().st_size > 0:
                        items.append((f"{email}/{path}", staged))
                    else:
                        missing.append(path)
                if missing:
                    rclone_copy(email, missing, stage)
                    for path in missing:
                        staged = stage / email / path
                        if staged.is_file() and staged.stat().st_size > 0:
                            items.append((f"{email}/{path}", staged))
                        else:
                            writer.write({"rel_path": f"{email}/{path}", "label": "",
                                          "status": "error", "error": "not-in-bucket",
                                          "ms": 0, "model": args.model})
                            counter["done"] += 1
                            counter["failed"] += 1

                def record(row: dict) -> None:
                    writer.write(row)
                    counter["done"] += 1
                    if row["status"] == "ok":
                        counter["ok"] += 1
                    elif row["status"] == "invalid_label":
                        counter["invalid"] += 1
                    else:
                        counter["failed"] += 1
                    if counter["done"] % 200 == 0 or counter["done"] == counter["total"]:
                        elapsed = max(0.001, time.time() - started)
                        rate = counter["done"] / elapsed
                        left = counter["total"] - counter["done"]
                        ca.write_progress(counter, started, "s4-list")
                        log(f"{counter['done']}/{counter['total']} · {rate:.1f}/s · "
                            f"ETA {int(left / rate // 60) if rate else 0}m · {email}")

                core.run_pool(classifier, items, args.workers, on_result=record)
                shutil.rmtree(stage, ignore_errors=True)
                log(f"{email} batch {start + len(chunk)}/{len(paths)} · ok {counter['ok']}")
    finally:
        writer.close()
        ca.write_progress(counter, started, "finished")
    log(f"done · {counter['ok']} ok · {counter['failed']} failed · "
        f"{time.time() - started:.0f}s")


if __name__ == "__main__":
    main()
