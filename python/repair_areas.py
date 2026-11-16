#!/usr/bin/env python3
"""Move images that belong to Hidden / Recently Deleted out of Library.

Older ZIPs did not record the album, so the unzip step had to ask iCloud and,
when the session was unavailable, everything landed in Photos/Library.  This
pass reads the two albums from a working session and moves the matching files,
updating the manifest entry as well.  It never touches images that are already
in the right folder.
"""
from __future__ import annotations

import argparse
import shutil
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bulk_images import EXPORT, load_accounts, log, open_api  # noqa: E402

AREAS = {"hidden": "Hidden", "deleted": "Recently Deleted"}


def album_ids(api, album_name: str) -> set[str]:
    try:
        return {str(getattr(asset, "id", "") or "") for asset in api.photos.albums[album_name]}
    except Exception:
        return set()


def update_manifest(email: str, moves: dict[str, Path]) -> None:
    path = EXPORT / email / "manifest.sqlite3"
    if not path.exists() or not moves:
        return
    db = sqlite3.connect(str(path))
    for asset_id, dest in moves.items():
        area = "hidden" if dest.parent.name == "Hidden" else "deleted"
        db.execute(
            "UPDATE files SET area=?, path=?, updated=? WHERE key=?",
            (area, str(dest), time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), f"photo:{asset_id}"),
        )
    db.commit()
    db.close()


def process(account: dict) -> dict:
    email = account["email"]
    root = EXPORT / email / "Photos"
    library = root / "Library"
    if not library.is_dir():
        return {"email": email, "skipped": "no library"}
    api = open_api(account)
    wanted = {
        "Hidden": album_ids(api, "Hidden"),
        "Recently Deleted": album_ids(api, "Recently Deleted"),
    }
    prefixes = {album: {asset_id[:8]: asset_id for asset_id in ids} for album, ids in wanted.items()}
    moved: dict[str, Path] = {}
    files = [p for p in library.iterdir() if p.is_file()]
    for path in files:
        prefix = path.name.split("_", 1)[0]
        for album, mapping in prefixes.items():
            asset_id = mapping.get(prefix)
            if not asset_id:
                continue
            dest_dir = root / album
            dest_dir.mkdir(parents=True, exist_ok=True)
            dest = dest_dir / path.name
            if dest.exists():
                try:
                    if dest.stat().st_size == path.stat().st_size:
                        path.unlink()
                        moved[asset_id] = dest
                        break
                except OSError:
                    pass
                continue
            shutil.move(str(path), str(dest))
            moved[asset_id] = dest
            break
    update_manifest(email, moved)
    return {"email": email, "moved": len(moved), "hidden": len(wanted["Hidden"]), "deleted": len(wanted["Recently Deleted"])}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--email")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()
    accounts = load_accounts()
    if args.email:
        wanted = {item.strip().lower() for item in args.email.split(",") if item.strip()}
        accounts = [account for account in accounts if account["email"].lower() in wanted]
    if args.limit:
        accounts = accounts[: args.limit]
    for account in accounts:
        try:
            result = process(account)
            log("areas", result)
        except Exception as error:  # noqa: BLE001
            log("areas", account.get("email"), "failed", type(error).__name__, str(error)[:120])


if __name__ == "__main__":
    main()
