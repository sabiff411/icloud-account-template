#!/usr/bin/env python3
"""Fetch every asset of one account's Hidden album right now.

Independent of the bulk run: it does not touch zips/urls.jsonl, it writes the
files straight into Photos/Hidden and records them in the manifest, so the
dashboard shows all hidden items immediately.

    fetch_hidden_one.py --email jonesjd74@mac.com
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bulk_images import EXPORT, ROOT, load_accounts, log, open_api  # noqa: E402

PROXY_FILE = Path("/var/lib/icloud3-bulk/download_proxies.txt")


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
    parser.add_argument("--workers", type=int, default=20)
    args = parser.parse_args()

    account = next(a for a in load_accounts() if a["email"] == args.email)
    api = open_api(account)
    album = api.photos.albums["Hidden"]
    folder = EXPORT / account["email"] / "Photos" / "Hidden"
    folder.mkdir(parents=True, exist_ok=True)
    existing = {p.name.split("_", 1)[0] for p in folder.iterdir() if p.is_file()}

    items = []
    for asset in album:
        asset_id = str(getattr(asset, "id", "") or "")
        if not asset_id:
            continue
        versions = getattr(asset, "versions", {}) or {}
        original = versions.get("original") or {}
        name = str(original.get("filename") or getattr(asset, "filename", "") or f"{asset_id}.bin")
        items.append(
            {
                "id": asset_id,
                "filename": name,
                "size": int(original.get("size") or getattr(asset, "size", 0) or 0),
                "url": original.get("url") or "",
            }
        )
    log("hidden", args.email, "live", len(items), "already on disk", len(existing))

    todo = [item for item in items if item["id"][:8] not in existing and item["url"]]
    pool = proxies()
    db = manifest(account["email"])

    def fetch(position_item):
        position, item = position_item
        last = None
        for attempt in range(4):
            proxy = pool[(position + attempt) % len(pool)]
            try:
                r = requests.get(
                    item["url"],
                    proxies={"http": proxy, "https": proxy},
                    headers={"Cookie": ""},
                    timeout=(20, 180),
                    stream=True,
                )
                r.raise_for_status()
                dest = folder / f"{item['id'][:8]}_{item['filename']}"
                with dest.open("wb") as handle:
                    for chunk in r.iter_content(1 << 20):
                        if chunk:
                            handle.write(chunk)
                r.close()
                size = dest.stat().st_size
                if item["size"] and size != item["size"]:
                    raise RuntimeError(f"short {size}/{item['size']}")
                db.execute(
                    """INSERT INTO files(key, area, path, size, sha256, status, updated)
                       VALUES(?,?,?,?,?,?,?)
                       ON CONFLICT(key) DO UPDATE SET area=excluded.area, path=excluded.path,
                         size=excluded.size, status=excluded.status, updated=excluded.updated""",
                    (f"photo:{item['id']}", "hidden", str(dest), size, "", "done",
                     time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())),
                )
                return True, size, ""
            except Exception as error:  # noqa: BLE001
                last = error
                time.sleep(0.5 * (attempt + 1))
        return False, 0, type(last).__name__ if last else "error"

    ok = 0
    total = 0
    failures = []
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
        for good, size, error in executor.map(fetch, list(enumerate(todo))):
            if good:
                ok += 1
                total += size
            else:
                failures.append(error)
    db.commit()
    db.close()
    log(
        "hidden",
        args.email,
        "downloaded",
        ok,
        "of",
        len(todo),
        f"{total / 1e6:.1f} MB",
        "failures",
        len(failures),
    )


if __name__ == "__main__":
    main()
