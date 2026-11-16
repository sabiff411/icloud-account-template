#!/usr/bin/env python3
"""Bulk iCloud Drive download for one account.

    bulk_drive.py --email user@icloud.com [--workers 6]

Walks the Drive tree, writes every file under export/<email>/Drive keeping the
folder structure, skips .app bundles and installer extensions, and records each
file in the manifest under the same key the worker uses.
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bulk_images import EXPORT, ROOT, load_accounts, log, open_api_safe  # noqa: E402
from worker.exporter import is_skipped_drive, safe_name  # noqa: E402

LOCK = threading.Lock()


def manifest(email: str):
    path = EXPORT / email / "manifest.sqlite3"
    path.parent.mkdir(parents=True, exist_ok=True)
    # The image exporter holds the same database; wait for it instead of
    # raising "database is locked" and losing a finished download.
    db = sqlite3.connect(str(path), check_same_thread=False, timeout=60, isolation_level=None)
    db.execute("PRAGMA busy_timeout=60000")
    db.execute(
        """CREATE TABLE IF NOT EXISTS files (
            key TEXT PRIMARY KEY, area TEXT NOT NULL, path TEXT NOT NULL,
            size INTEGER NOT NULL DEFAULT 0, sha256 TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'done', updated TEXT NOT NULL)"""
    )
    return db


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--email", required=True)
    parser.add_argument("--workers", type=int, default=6)
    args = parser.parse_args()

    account = next(a for a in load_accounts() if a["email"] == args.email)
    email = account["email"]
    base = EXPORT / email / "Drive"
    db = manifest(email)
    api = open_api_safe(account)

    files = []
    skipped = 0
    stack = [(api.drive.root, "", "")]
    seen = set()
    while stack:
        node, rel, prefix = stack.pop()
        try:
            children = node.get_children() or []
        except Exception:
            continue
        for child in children:
            raw = str(getattr(child, "name", "") or "")
            name = safe_name(raw or "file")
            if getattr(child, "type", "") == "folder":
                if raw.lower().endswith(".app"):
                    continue
                # No leading slash: base / "/Downloads" would resolve to
                # /Downloads on the root filesystem (Permission denied) and
                # every nested file failed.
                child_rel = f"{rel}/{name}" if rel else name
                stack.append((child, child_rel, f"{prefix}{raw}/"))
                continue
            size = int(getattr(child, "size", 0) or 0)
            full = f"{prefix}{raw}"
            key = f"drive:{full}:{size}"
            if key in seen:
                continue
            seen.add(key)
            if is_skipped_drive(full):
                skipped += 1
                continue
            dest = base / rel / name if rel else base / name
            files.append((key, child, dest, size, full))
    log("drive", email, "files", len(files), "skipped", skipped)

    def fetch(item):
        key, child, dest, size, full = item
        last = None
        for attempt in range(4):
            try:
                data = getattr(child, "data", None)
                if isinstance(data, dict) and "size" not in data:
                    data["size"] = size
                dest.parent.mkdir(parents=True, exist_ok=True)
                response = child.open(stream=True, timeout=(20, 180))
                temporary = dest.with_name(dest.name + ".part")
                written = 0
                with temporary.open("wb") as handle:
                    for chunk in response.iter_content(1 << 20):
                        if chunk:
                            handle.write(chunk)
                            written += len(chunk)
                if size and written != size:
                    temporary.unlink(missing_ok=True)
                    raise RuntimeError(f"short {written}/{size}")
                temporary.replace(dest)
                with LOCK:
                    db.execute(
                        """INSERT INTO files(key, area, path, size, sha256, status, updated)
                           VALUES(?,?,?,?,?,?,?)
                           ON CONFLICT(key) DO UPDATE SET path=excluded.path, size=excluded.size,
                             status=excluded.status, updated=excluded.updated""",
                        (key, "drive", str(dest), written, "", "done",
                         time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())),
                    )
                return True, written, ""
            except Exception as error:  # noqa: BLE001
                last = error
                time.sleep(1)
        return False, 0, f"{type(last).__name__}: {last}" if last else "error"

    ok = total = 0
    failures = 0
    errors: list[str] = []
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        for good, written, error in pool.map(fetch, files):
            if good:
                ok += 1
                total += written
            else:
                failures += 1
                if len(errors) < 5:
                    errors.append(error)
    db.commit()
    db.close()
    log("drive", email, "downloaded", ok, "of", len(files), f"{total / 1e9:.2f} GB", "failures", failures, errors)


if __name__ == "__main__":
    main()
