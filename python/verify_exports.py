#!/usr/bin/env python3
"""Post-run check: every reported image is on disk and in the manifest.

Compares bulk_report.json with the Photos tree and the per-account manifest:

  * image files under Photos (Library + Hidden + Recently Deleted), videos out
  * manifest rows with a photo:<asset id> key
  * leftover zips

Exit code 0 when every finished account matches.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bulk_images import EXPORT, REPORT, VIDEO_EXT, load_accounts, open_api  # noqa: E402


def image_files(email: str) -> tuple[int, int]:
    root = EXPORT / email / "Photos"
    files = 0
    total = 0
    if not root.is_dir():
        return 0, 0
    for path in root.rglob("*"):
        if path.is_file() and path.suffix.lower() not in VIDEO_EXT:
            files += 1
            try:
                total += path.stat().st_size
            except OSError:
                pass
    return files, total


def manifest_rows(email: str) -> int:
    path = EXPORT / email / "manifest.sqlite3"
    if not path.exists():
        return -1
    try:
        db = sqlite3.connect(str(path))
        count = db.execute("SELECT COUNT(*) FROM files WHERE key LIKE 'photo:%'").fetchone()[0]
        db.close()
        return int(count)
    except sqlite3.Error:
        return -1


def leftover_zips(email: str) -> int:
    folder = EXPORT / email / "zips"
    return len(list(folder.glob("*.zip"))) if folder.is_dir() else 0


def live_images(account: dict) -> int:
    """Count the images iCloud reports right now (no downloads)."""
    api = open_api(account)
    albums = api.photos.albums
    seen: set[str] = set()
    images = 0
    for name in ("Hidden", "Recently Deleted", "Library"):
        try:
            album = albums[name]
        except Exception:
            continue
        for asset in album:
            asset_id = str(getattr(asset, "id", "") or "")
            if not asset_id or asset_id in seen:
                continue
            seen.add(asset_id)
            versions = getattr(asset, "versions", {}) or {}
            original = versions.get("original") or {}
            filename = str(original.get("filename") or getattr(asset, "filename", "") or "")
            if Path(filename).suffix.lower() not in VIDEO_EXT:
                images += 1
    return images


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", action="store_true", help="re-count images on iCloud")
    args = parser.parse_args()
    rows = json.loads(REPORT.read_text()) if REPORT.exists() else []
    accounts = {account["email"]: account for account in load_accounts()}
    bad = 0
    for row in rows:
        email = row.get("email")
        if not email:
            continue
        if row.get("error"):
            print(f"FAILED ACCOUNT  {email}: {row['error']}")
            bad += 1
            continue
        expected = int(row.get("images") or 0)
        files, total = image_files(email)
        manifest = manifest_rows(email)
        zips = leftover_zips(email)
        problems = []
        if files < expected:
            problems.append(f"files {files} < images {expected}")
        if manifest >= 0 and manifest < expected:
            problems.append(f"manifest {manifest} < images {expected}")
        if zips:
            problems.append(f"{zips} zips left")
        if row.get("failures"):
            problems.append(f"{len(row['failures'])} download failures")
        if args.live and email in accounts:
            try:
                live = live_images(accounts[email])
                row["liveImages"] = live
                if live > expected:
                    problems.append(f"live {live} > exported {expected}")
            except Exception as error:  # noqa: BLE001
                problems.append(f"live check {type(error).__name__}")
        status = "OK  " if not problems else "WARN"
        if problems:
            bad += 1
        print(
            f"{status} {email}: images={expected} files={files} "
            f"manifest={manifest} zips={zips} bytes={total / 1e9:.2f} GB "
            + ("; ".join(problems))
        )
    print(f"\naccounts={len(rows)} problems={bad}")
    sys.exit(0 if bad == 0 else 1)


if __name__ == "__main__":
    main()
