#!/usr/bin/env python3
"""OCR-verify the photos a VLM label flagged as seed / wallet / recover.

The classifier says "this looks like a seed phrase"; this says "these are the
words".  For every flagged photo it runs RapidOCR on the original (fetched from
S4 when the account was pruned), extracts candidate sequences with the same
BIP39 code the scanner uses, and records a verdict:

    phrase-valid    12/15/18/21/24 words, checksum passes
    phrase-invalid  enough words but the checksum fails (misread word)
    no-phrase       no run of 12+ BIP39 words at all -> the label was a guess

That turns "seed" into a measured precision per label, and the valid phrases
are merged into Scan/findings.json so the panel's Seeds tab shows them.

    verify_seeds.py --account x@y.com [--labels seed,seed-candidate,privatekey]
                    [--workers 12] [--limit 0] [--keep]
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import classify_all as ca  # noqa: E402
from scan_vlm import merge_findings  # noqa: E402
from worker import scan  # noqa: E402

WORD_COUNTS = (12, 15, 18, 21, 24)


def log(message: str) -> None:
    print(time.strftime("%H:%M:%S ") + message, flush=True)


def load_rows(account: str, labels: set[str]) -> list[dict]:
    found: dict[str, dict] = {}
    with ca.RESULTS.open(errors="ignore") as handle:
        for line in handle:
            try:
                row = json.loads(line)
            except Exception:  # noqa: BLE001
                continue
            rel = row.get("rel_path") or ""
            if not rel.startswith(account + "/"):
                continue
            if row.get("label") not in labels:
                continue
            if row.get("status") != "ok":
                continue
            found[rel.split("/", 1)[1]] = row
    return [{**row, "rel": rel} for rel, row in sorted(found.items())]


def fetch(account: str, root: Path, rels: list[str], stage: Path) -> list[str]:
    """Copy the originals that are not on disk from the bucket; return rels."""
    missing = [rel for rel in rels if not (root / rel).is_file()]
    if not missing:
        return rels
    stage.mkdir(parents=True, exist_ok=True)
    listing = stage / "list.txt"
    listing.write_text("\n".join(missing) + "\n")
    log(f"fetching {len(missing)} originals from S4")
    process = subprocess.run(
        ["rclone", "copy", f"{ca.REMOTE}/{account}", str(stage / account),
         "--files-from-raw", str(listing), "--transfers", "32", "--checkers", "64",
         "--no-traverse", "--retries", "3", "--stats", "0"],
        capture_output=True, text=True, timeout=7200,
    )
    if process.returncode != 0:
        log(f"rclone rc={process.returncode}: {process.stderr.strip()[-200:]}")
    return rels


def source_for(account: str, root: Path, stage: Path, rel: str) -> Path | None:
    local = root / rel
    if local.is_file():
        return local
    staged = stage / account / rel
    if staged.is_file():
        return staged
    thumb = root / "Scan" / "thumbs" / f"{rel}.jpg"
    if thumb.is_file():
        return thumb
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--account", required=True)
    parser.add_argument("--labels", default="seed,seed-candidate,privatekey,wallet,recover")
    parser.add_argument("--workers", type=int, default=12)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--keep", action="store_true", help="keep the staged originals")
    args = parser.parse_args()

    labels = {label.strip() for label in args.labels.split(",") if label.strip()}
    accounts = ca.account_roots()
    root = accounts.get(args.account)
    if not root:
        parser.error(f"no export directory for {args.account}")

    rows = load_rows(args.account, labels)
    if args.limit:
        rows = rows[: args.limit]
    if not rows:
        log("nothing flagged")
        return
    log(f"{len(rows)} flagged photos · labels {sorted(labels)}")

    stage = ca.STAGE / f"verify-{args.account}"
    shutil.rmtree(stage, ignore_errors=True)
    fetch(args.account, root, [row["rel"] for row in rows], stage)

    index = scan.word_index()
    out_path = root / "Scan" / "classify-verify.jsonl"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    started = time.time()
    results: list[dict] = []
    lock = __import__("threading").Lock()
    done = 0

    def work(row: dict) -> None:
        nonlocal done
        rel = row["rel"]
        path = source_for(args.account, root, stage, rel)
        text = ""
        error = ""
        if path is None:
            error = "missing"
        else:
            try:
                text = scan.ocr_image(path)
            except Exception as failure:  # noqa: BLE001
                error = type(failure).__name__
        phrases = []
        if text:
            for item in scan.find_sequences(text, index):
                if item["words"] in WORD_COUNTS:
                    phrases.append({
                        "phrase": item["phrase"],
                        "words": item["words"],
                        "checksum": bool(item["checksum"]),
                        "tier": item["tier"],
                    })
        valid = [p for p in phrases if p["checksum"]]
        if valid:
            verdict = "phrase-valid"
        elif phrases:
            verdict = "phrase-invalid"
        else:
            verdict = "no-phrase"
        record = {
            "rel": rel,
            "label": row["label"],
            "verdict": verdict,
            "phrases": phrases[:6],
            "chars": len(text),
            "error": error,
            "source": path.name if path else "",
        }
        with lock:
            results.append(record)
            done += 1
            if done % 50 == 0 or done == len(rows):
                elapsed = time.time() - started
                log(f"{done}/{len(rows)} · {done / elapsed:.1f}/s · "
                    f"valid {sum(1 for r in results if r['verdict'] == 'phrase-valid')}")

    cores = max(1, min(args.workers, len(rows)))
    with ThreadPoolExecutor(max_workers=cores) as pool:
        list(pool.map(work, rows))

    results.sort(key=lambda item: item["rel"])
    out_path.write_text("\n".join(json.dumps(item) for item in results) + "\n")

    findings = []
    for record in results:
        for phrase in record["phrases"]:
            if not phrase["checksum"]:
                continue
            findings.append({
                "file": record["rel"],
                "area": scan.area_for(record["rel"]),
                "name": Path(record["rel"]).name,
                "phrase": phrase["phrase"],
                "words": phrase["words"],
                "tier": phrase["tier"],
                "checksum": True,
                "spam": scan.is_spam_phrase(phrase["phrase"]),
                "source": "classify-verify",
                "offset": 0,
            })
    if findings:
        merge_findings(root / "Scan", findings)

    if not args.keep:
        shutil.rmtree(stage, ignore_errors=True)

    # Precision per label: how often the label contained a real phrase run.
    by_label: dict[str, dict[str, int]] = {}
    for record in results:
        counts = by_label.setdefault(record["label"], {"total": 0, "phrase-valid": 0,
                                                       "phrase-invalid": 0, "no-phrase": 0})
        counts["total"] += 1
        counts[record["verdict"]] += 1
    log("verdicts by label")
    for label, counts in sorted(by_label.items()):
        total = counts["total"]
        log(f"  {label:15s} {total:5d} photos · valid {counts['phrase-valid']:4d} "
            f"({100 * counts['phrase-valid'] / total:.1f}%) · "
            f"near {counts['phrase-invalid']:4d} · none {counts['no-phrase']:4d}")
    log(f"wrote {out_path} · {len(findings)} valid phrases")


if __name__ == "__main__":
    main()
