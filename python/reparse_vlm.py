#!/usr/bin/env python3
"""Re-check results that were already produced, without re-reading the images.

Every stored ``Scan/vlm/<rel>.json`` keeps the BIP39-normalised ``words`` and
the order they were read in, so a column/checksum fix can be re-applied to the
whole corpus for free.  This pass:

  * retries every column permutation of a 12/15/18/21/24-word read that did
    not validate, and promotes the ones that do to ``seed``;
  * never downgrades a label (an empty read stays whatever the model called it,
    e.g. ``selfie`` - the raw text is not stored);
  * counts ``error`` stubs, whose images must be scanned again;
  * writes ``Scan/vlm-retry.txt`` for reads that are still short or invalid and
    deserve a real second look at high resolution.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from worker.ocr_vlm import SIZES, checksum_ok, column_major  # noqa: E402

ROOT = Path("/opt/icloud3/export")


def log(message: str) -> None:
    line = time.strftime("%Y-%m-%d %H:%M:%S ") + message
    print(line, flush=True)


def recover(words: list[str]) -> list[str] | None:
    """A valid phrase hidden in a mis-ordered multi-column read."""
    if not words or len(words) not in SIZES:
        return None
    if checksum_ok(words):
        return words
    for columns in range(2, 8):
        candidate = column_major(list(words), columns)
        if len(candidate) in SIZES and checksum_ok(candidate):
            return candidate
    return None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--email")
    parser.add_argument("--write", action="store_true", help="apply the changes")
    args = parser.parse_args()

    accounts = sorted([p for p in ROOT.iterdir() if p.is_dir() and (p / "Scan").is_dir()])
    if args.email:
        wanted = {item.strip().lower() for item in args.email.split(",") if item.strip()}
        accounts = [p for p in accounts if p.name.lower() in wanted]

    results = gained = errors = 0
    retry_total = 0
    log(f"start {len(accounts)} accounts write={args.write}")

    for account in accounts:
        scan = account / "Scan"
        vlm = scan / "vlm"
        if not vlm.is_dir():
            continue
        index_path = scan / "vlm-index.json"
        try:
            index = json.loads(index_path.read_text()) if index_path.exists() else {}
        except Exception:
            index = {}
        account_gained = 0
        retry: list[str] = []
        for path in vlm.rglob("*.json"):
            rel = path.relative_to(vlm).as_posix()[:-5]
            try:
                data = json.loads(path.read_text())
            except Exception:
                data = {"error": "unreadable"}
            results += 1
            if set(data.keys()) == {"error"}:
                errors += 1
                retry.append(f"{account.name}/{rel}")
                continue
            words = [str(word) for word in (data.get("words") or [])]
            phrase = data.get("phrase") or ""
            checksum = bool(data.get("checksum"))
            if checksum and phrase:
                continue
            fixed = recover(words)
            if fixed:
                phrase = " ".join(fixed)
                checksum = True
                gained += 1
                account_gained += 1
                data.update(
                    {
                        "words": fixed,
                        "count": len(fixed),
                        "phrase": phrase,
                        "checksum": True,
                        "kind": "seed",
                        "confidence": 1.0,
                        "reason": "checksum ok (re-checked column layout)",
                    }
                )
                index[rel] = {
                    "kind": "seed",
                    "modelKind": data.get("modelKind") or "",
                    "checksum": True,
                    "count": len(fixed),
                    "phrase": phrase,
                    "hasText": bool(data.get("hasText")),
                }
                if args.write:
                    path.write_text(json.dumps(data, ensure_ascii=False))
                    findings_path = scan / "findings.json"
                    try:
                        existing = json.loads(findings_path.read_text())
                        if not isinstance(existing, list):
                            existing = existing.get("findings") or []
                    except Exception:
                        existing = []
                    if rel not in {item.get("file") for item in existing}:
                        existing.append(
                            {
                                "file": rel,
                                "area": "",
                                "name": path.name,
                                "phrase": phrase,
                                "words": len(fixed),
                                "tier": "valid",
                                "checksum": True,
                                "spam": False,
                                "source": "ocr-vlm-recheck",
                                "offset": 0,
                            }
                        )
                        findings_path.write_text(json.dumps(existing))
                continue
            if len(words) >= 6 or int(data.get("count") or 0) >= 6:
                retry.append(f"{account.name}/{rel}")
        retry_total += len(retry)
        if args.write:
            index_path.write_text(json.dumps(index))
            if retry:
                (scan / "vlm-retry.txt").write_text("\n".join(retry) + "\n")
            if account_gained or retry:
                log(f"{account.name} new_seeds {account_gained} retry {len(retry)}")

    log(f"finish results {results} new_seeds {gained} error_stubs {errors} need_high_res {retry_total}")


if __name__ == "__main__":
    main()
