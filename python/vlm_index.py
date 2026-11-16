#!/usr/bin/env python3
"""Publish classifier labels into the panel's per-account Scan/vlm-index.json.

The dashboard's "Image type" filter reads <account>/Scan/vlm-index.json.  The
old VLM scanner wrote it, but its endpoint died and every entry ended up with
an empty `kind`.  This tool converts the labels written by classify_all.py into
that same file, so the filter works with no frontend change, and refreshes a
small marker file so the server can rebuild its catalog as soon as new labels
land.

Safe to run every minute: unchanged accounts are skipped by content hash.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import classify_all as ca  # noqa: E402

STATE = ca.OUT_DIR / ".index-state.json"
MARKER = ca.OUT_DIR / "index.json"


def log(message: str) -> None:
    print(time.strftime("%Y-%m-%d %H:%M:%S ") + message, flush=True)


def main() -> None:
    results = ca.RESULTS
    if not results.is_file():
        log("no results.jsonl yet")
        return

    rows: dict[str, dict] = {}
    with results.open(errors="ignore") as handle:
        for line in handle:
            try:
                row = json.loads(line)
            except Exception:  # noqa: BLE001
                continue
            rel = row.get("rel_path") or ""
            if not rel:
                continue
            user, _, path = rel.partition("/")
            if not path:
                continue
            rows.setdefault(user, {})[path] = row

    accounts = ca.account_roots()
    state: dict[str, str] = {}
    if STATE.is_file():
        try:
            state = json.loads(STATE.read_text())
        except Exception:  # noqa: BLE001
            state = {}

    written = 0
    totals: dict[str, int] = {}
    per_account: dict[str, dict[str, int]] = {}
    classified = 0
    for email, items in rows.items():
        labels: dict[str, int] = {}
        for row in items.values():
            if row.get("status") == "ok":
                labels[row["label"]] = labels.get(row["label"], 0) + 1
                totals[row["label"]] = totals.get(row["label"], 0) + 1
        per_account[email] = labels
        classified += sum(1 for row in items.values() if row.get("status") == "ok")

        root = accounts.get(email)
        if not root:
            continue
        payload = {
            path: {
                "kind": row.get("label") or "",
                "modelKind": row.get("model") or "",
                "checksum": bool(row.get("checksum")),
                "count": 0,
                "phrase": "",
                "hasText": False,
                "source": "classify",
                "status": row.get("status") or "",
            }
            for path, row in items.items()
        }
        digest = hashlib.sha1(json.dumps(payload, sort_keys=True).encode()).hexdigest()
        if state.get(email) == digest:
            continue

        index_path = root / "Scan" / "vlm-index.json"
        merged: dict[str, dict] = {}
        try:
            existing = json.loads(index_path.read_text())
            if isinstance(existing, dict):
                merged = existing
        except Exception:  # noqa: BLE001
            merged = {}
        # Keep an OCR phrase that was found earlier; the label is authoritative.
        for path, meta in payload.items():
            previous = merged.get(path) or {}
            if previous.get("phrase"):
                meta["phrase"] = previous["phrase"]
                meta["checksum"] = bool(previous.get("checksum"))
                meta["count"] = int(previous.get("count") or 0)
                meta["hasText"] = bool(previous.get("hasText"))
            merged[path] = meta
        index_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = index_path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(merged, separators=(",", ":")))
        os.replace(temporary, index_path)
        state[email] = digest
        written += 1

    STATE.write_text(json.dumps(state))
    if not written and MARKER.is_file():
        # Nothing moved: keep the marker's mtime so the panel does not rebuild
        # its 20 s catalog once a minute for no reason.
        log(f"accounts written 0 · classified {classified} · marker kept")
        return
    MARKER.write_text(json.dumps({
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "classified": classified,
        "labels": dict(sorted(totals.items(), key=lambda item: -item[1])),
        "accounts": {email: counts for email, counts in per_account.items() if counts},
    }))
    log(f"accounts written {written} · classified {classified} · "
        + " · ".join(f"{label} {count}" for label, count in
                     sorted(totals.items(), key=lambda item: -item[1])[:8]))


if __name__ == "__main__":
    main()
