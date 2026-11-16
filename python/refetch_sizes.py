#!/usr/bin/env python3
"""Re-download files whose size does not match the iCloud metadata.

Some proxy responses were truncated at an exact MiB boundary (e.g. 5 MiB of an
8.5 MB video), which is why the browser says the video is corrupt.  This pass
scans the cached URL lists, finds every size mismatch, downloads those files
again with a strict size check and updates the manifest.

    refetch_sizes.py --email user@icloud.com [--all]
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bulk_images import EXPORT, load_accounts, log, open_api_safe  # noqa: E402

PROXY_FILE = Path("/var/lib/icloud3-bulk/download_proxies.txt")
FOLDERS = {"Hidden": "Hidden", "Recently Deleted": "Recently Deleted", "Library": "Library"}


def proxies() -> list[str]:
    out = []
    for line in PROXY_FILE.read_text().splitlines():
        parts = line.strip().split(":")
        if len(parts) == 4:
            out.append(f"http://{parts[2]}:{parts[3]}@{parts[0]}:{parts[1]}")
    return out


def manifest(email: str):
    path = EXPORT / email / "manifest.sqlite3"
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(path))
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
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()

    account = next(a for a in load_accounts() if a["email"] == args.email)
    base = EXPORT / account["email"]
    pool = proxies()
    db = manifest(account["email"])
    api = None

    mismatches = []
    for album, folder in FOLDERS.items():
        path = base / "zips" / f"urls-{album.replace(' ', '_').lower()}.jsonl"
        if not path.exists():
            continue
        for line in path.read_text().splitlines():
            if not line.strip():
                continue
            item = json.loads(line)
            dest = base / "Photos" / folder / f"{item['id'][:8]}_{item['filename']}"
            expected = int(item.get("size") or 0)
            if not dest.exists():
                continue
            if expected and dest.stat().st_size != expected:
                mismatches.append((item, dest, folder))
    log("refetch", args.email, "mismatches", len(mismatches))

    def fetch(position_item):
        position, (item, dest, folder) = position_item
        last = None
        for attempt in range(5):
            nonlocal api
            try:
                if api is None:
                    api = open_api_safe(account)
            except Exception:
                api = None
            try:
                r = requests.get(
                    item["url"],
                    proxies={"http": pool[(position + attempt) % len(pool)], "https": pool[(position + attempt) % len(pool)]},
                    headers={"Cookie": ""},
                    timeout=(20, 300),
                    stream=True,
                )
                if r.status_code in (403, 410) and api is not None:
                    album = api.photos.albums[item["area"]]
                    asset = album.get(item["id"])
                    fresh = ((getattr(asset, "versions", {}) or {}).get("original") or {}).get("url")
                    if fresh:
                        item["url"] = fresh
                        r.close()
                        continue
                r.raise_for_status()
                temporary = dest.with_suffix(dest.suffix + ".part")
                with temporary.open("wb") as handle:
                    for chunk in r.iter_content(1 << 20):
                        if chunk:
                            handle.write(chunk)
                r.close()
                size = temporary.stat().st_size
                if item.get("size") and size != int(item["size"]):
                    temporary.unlink(missing_ok=True)
                    raise RuntimeError(f"short {size}/{item['size']}")
                temporary.replace(dest)
                db.execute(
                    """INSERT INTO files(key, area, path, size, sha256, status, updated)
                       VALUES(?,?,?,?,?,?,?)
                       ON CONFLICT(key) DO UPDATE SET size=excluded.size, path=excluded.path,
                         status=excluded.status, updated=excluded.updated""",
                    (f"photo:{item['id']}", "hidden" if folder == "Hidden" else "deleted" if folder == "Recently Deleted" else "photos",
                     str(dest), size, "", "done", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())),
                )
                return True, dest.name, size, ""
            except Exception as error:  # noqa: BLE001
                last = error
                time.sleep(1)
        return False, item["filename"], 0, type(last).__name__ if last else "error"

    ok = 0
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
        for good, name, size, error in executor.map(fetch, list(enumerate(mismatches))):
            if good:
                ok += 1
                log("refetch", args.email, "fixed", name, size)
            else:
                log("refetch", args.email, "failed", name, error)
    db.commit()
    db.close()
    log("refetch", args.email, "done", ok, "of", len(mismatches))


if __name__ == "__main__":
    main()
