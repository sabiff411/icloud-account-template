#!/usr/bin/env python3
"""Re-label stored VLM results from their raw answer (no pod calls).

Used after a classification rule changes: the raw text is in the result file,
so kind / checksum / phrase can be recomputed exactly as a fresh read would.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, "/opt/icloud3/python")
from worker.ocr_vlm import classify, parse_output  # noqa: E402

ROOT = Path("/opt/icloud3/export")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("emails", nargs="+")
    args = parser.parse_args()

    for email in args.emails:
        account = ROOT / email
        vlm = account / "Scan" / "vlm"
        if not vlm.is_dir():
            print(f"{email}: no results")
            continue
        index = {}
        changed = 0
        kinds = Counter()
        seeds = 0
        total = 0
        for path in vlm.rglob("*.json"):
            try:
                data = json.loads(path.read_text())
            except Exception:
                continue
            raw = data.get("raw")
            if not raw:
                continue
            total += 1
            before = data.get("kind")
            result = parse_output(raw)
            labels = classify(raw, result)
            data.update(result)
            data.update(labels)
            if before != labels["kind"]:
                changed += 1
            kinds[labels["kind"]] += 1
            if labels["kind"] == "seed":
                seeds += 1
            path.write_text(json.dumps(data, ensure_ascii=False))
            rel = path.relative_to(vlm).as_posix()[:-5]
            index[rel] = {
                "kind": labels["kind"],
                "modelKind": result.get("modelKind") or "",
                "checksum": bool(result.get("checksum")),
                "count": int(result.get("count") or 0),
                "phrase": " ".join(result.get("words") or []),
                "hasText": labels["hasText"],
            }
        (account / "Scan" / "vlm-index.json").write_text(json.dumps(index))
        print(f"{email}: re-labelled {total} results, {changed} changed, seeds {seeds}")
        print("   kinds:", dict(kinds.most_common(10)))


if __name__ == "__main__":
    main()
