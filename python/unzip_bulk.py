#!/usr/bin/env python3
"""Turn bulk_images.py ZIPs back into the per-account Photos tree.

Each zip entry is named ``<asset_id[:8]>_<filename>``.  The batch index has
the full asset ids, so we can restore the original names, place hidden and
recently-deleted assets in their own folders, and record every file in the
manifest (so verify/counts see it as done).

By default the zip is removed after a successful extraction; keeping both
would double the used space.  Use --keep-zips to keep them.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bulk_images import EXPORT, ROOT, load_accounts, open_api  # noqa: E402


def manifest_path(email: str) -> Path:
    return EXPORT / email / "manifest.sqlite3"


REPAIR = Path("/var/lib/icloud3-bulk/repair_accounts.txt")


def queue_repair(email: str) -> None:
    """Remember the account needs its corrupt batches downloaded again."""
    known = set()
    if REPAIR.exists():
        try:
            known = {line.strip() for line in REPAIR.read_text().splitlines() if line.strip()}
        except OSError:
            known = set()
    if email in known:
        return
    try:
        with REPAIR.open("a") as handle:
            handle.write(email + "\n")
    except OSError:
        pass


def connect_manifest(email: str) -> sqlite3.Connection:
    db_path = manifest_path(email)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(db_path))
    db.execute(
        """CREATE TABLE IF NOT EXISTS files (
            key TEXT PRIMARY KEY, area TEXT NOT NULL, path TEXT NOT NULL,
            size INTEGER NOT NULL DEFAULT 0, sha256 TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'done', updated TEXT NOT NULL)"""
    )
    db.execute("PRAGMA synchronous=NORMAL")
    db.commit()
    return db


def mark_done(db: sqlite3.Connection, key: str, area: str, path: Path, size: int) -> None:
    db.execute(
        """INSERT INTO files(key, area, path, size, sha256, status, updated)
           VALUES(?,?,?,?,?,?,?)
           ON CONFLICT(key) DO UPDATE SET
             area=excluded.area, path=excluded.path, size=excluded.size,
             sha256=excluded.sha256, status=excluded.status, updated=excluded.updated""",
        (
            key,
            area,
            str(path),
            int(size),
            "",
            "done",
            time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        ),
    )


def hidden_map(account: dict) -> dict[str, str]:
    try:
        api = open_api(account)
        result = {}
        for area, album in (("hidden", "Hidden"), ("deleted", "Recently Deleted")):
            try:
                for asset in api.photos.albums[album]:
                    value = str(getattr(asset, "id", "") or "")
                    if value:
                        result[value] = area
            except Exception:
                continue
        return result
    except Exception:
        return {}


def process(account: dict, delete_zips: bool) -> dict:
    email = account["email"]
    folder = EXPORT / email / "zips"
    index_path = folder / "index.json"
    if not index_path.exists():
        return {"email": email, "skipped": "no index"}
    index = json.loads(index_path.read_text())
    batches = index.get("batches") or []
    if not batches:
        return {"email": email, "skipped": "no batches"}
    special = hidden_map(account)
    restored = 0
    removed = 0
    corrupt: list[dict] = []
    dropped: set[str] = set()
    db = connect_manifest(email)
    made: set[Path] = set()
    try:
        for batch in batches:
            zip_path = folder / batch["file"]
            if not zip_path.exists():
                continue
            if batch.get("extracted"):
                # The exporter wrote these files straight into Photos/.
                if delete_zips:
                    zip_path.unlink(missing_ok=True)
                    removed += 1
                continue
            ids = batch.get("ids") or []
            by_prefix = {str(asset_id)[:8]: str(asset_id) for asset_id in ids}
            with zipfile.ZipFile(zip_path) as zf:
                # Extraction reads every byte, so a CRC error surfaces here;
                # a separate full-file testzip only doubles the disk I/O.
                bad = ""
                entries = zf.infolist()
                count_bad = bool(batch.get("count")) and len(entries) != int(batch["count"])
                if bad or count_bad:
                    corrupt.append(
                        {
                            "file": batch["file"],
                            "entry": bad or "",
                            "expected": int(batch.get("count") or 0),
                            "found": len(entries),
                        }
                    )
                    dropped.add(batch["file"])
                    zip_path.unlink(missing_ok=True)
                    continue
                areas = batch.get("areas") or {}
                try:
                    for info in entries:
                        name = info.filename
                        prefix = name.split("_", 1)[0]
                        asset_id = by_prefix.get(prefix, prefix)
                        labelled = areas.get(asset_id)
                        if labelled == "Hidden":
                            area = "hidden"
                        elif labelled == "Recently Deleted":
                            area = "deleted"
                        elif labelled == "Library":
                            area = "photos"
                        else:
                            area = special.get(asset_id, "photos")
                        album = {"photos": "Library", "hidden": "Hidden", "deleted": "Recently Deleted"}[area]
                        parent = EXPORT / email / "Photos" / album
                        if parent not in made:
                            parent.mkdir(parents=True, exist_ok=True)
                            made.add(parent)
                        dest = parent / name
                        if not (dest.exists() and dest.stat().st_size == info.file_size):
                            with zf.open(info) as source, dest.open("wb") as target:
                                while True:
                                    chunk = source.read(1 << 20)
                                    if not chunk:
                                        break
                                    target.write(chunk)
                        mark_done(db, f"photo:{asset_id}", area, dest, dest.stat().st_size)
                        restored += 1
                except Exception as error:  # noqa: BLE001
                    corrupt.append({"file": batch["file"], "error": type(error).__name__})
                    dropped.add(batch["file"])
                    zip_path.unlink(missing_ok=True)
                    continue
            db.commit()
            if delete_zips:
                zip_path.unlink(missing_ok=True)
                removed += 1
    finally:
        db.commit()
        db.close()
    index["unzippedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    if dropped:
        # The bad zip is gone; drop its ids from the index so the exporter
        # downloads them again, and queue the account for a repair pass.
        index["batches"] = [b for b in index["batches"] if b.get("file") not in dropped]
        index["corrupt"] = corrupt
        index["unzipped"] = False
        queue_repair(email)
    else:
        index["unzipped"] = True
        index.pop("corrupt", None)
    index_path.write_text(json.dumps(index, indent=2))
    return {
        "email": email,
        "restored": restored,
        "zipsRemoved": removed,
        "batches": len(batches),
        "corrupt": corrupt,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--email")
    parser.add_argument("--keep-zips", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()
    accounts = load_accounts()
    if args.email:
        wanted = {item.strip().lower() for item in args.email.split(",") if item.strip()}
        accounts = [item for item in accounts if item["email"].lower() in wanted]
    if args.limit:
        accounts = accounts[: args.limit]
    reports = []
    for account in accounts:
        try:
            result = process(account, delete_zips=not args.keep_zips)
            print(json.dumps(result), flush=True)
            reports.append(result)
        except Exception as error:  # noqa: BLE001
            print(json.dumps({"email": account.get("email"), "error": f"{type(error).__name__}: {error}"}), flush=True)
    print(json.dumps(reports, indent=2), flush=True)


if __name__ == "__main__":
    main()
