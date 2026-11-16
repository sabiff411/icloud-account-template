#!/usr/bin/env python3
"""Metadata-only size survey: sum the bytes of every still image per account.

No image bytes are downloaded.  It opens each account session exactly like
bulk_images.py, enumerates Hidden / Recently Deleted / Library, and records
the image count and total size so the disk plan is based on real numbers
instead of an average.  Accounts already measured by the bulk run are skipped.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bulk_images import (  # noqa: E402
    EXPORT,
    LOG,
    REPORT,
    VIDEO_EXT,
    load_accounts,
    log,
    open_api,
)

OUT = Path(os.environ.get("SIZE_SURVEY_OUT") or Path(__file__).resolve().parents[1] / "size_survey.json")


def measured() -> set[str]:
    found = set()
    if REPORT.exists():
        try:
            for row in json.loads(REPORT.read_text()):
                if isinstance(row, dict) and row.get("email") and "error" not in row:
                    found.add(row["email"])
        except Exception:
            pass
    if OUT.exists():
        try:
            for row in json.loads(OUT.read_text()):
                if row.get("email") and "error" not in row:
                    found.add(row["email"])
        except Exception:
            pass
    return found


def active_email() -> str:
    try:
        lines = LOG.read_text().splitlines()
    except Exception:
        return ""
    for line in reversed(lines[-40:]):
        if " account " in line:
            parts = line.split()
            if len(parts) > 2 and parts[2].startswith("account"):
                return parts[3]
            if "account" in parts:
                return parts[parts.index("account") + 1]
    return ""


def main() -> None:
    rows = []
    if OUT.exists():
        try:
            rows = json.loads(OUT.read_text())
        except Exception:
            rows = []
    known = {row.get("email") for row in rows if isinstance(row, dict)}
    skip = measured()
    accounts = [a for a in load_accounts() if a["email"] not in skip]
    log("survey start", len(accounts), "accounts")
    for account in accounts:
        email = account["email"]
        if email == active_email():
            log("survey skip active", email)
            continue
        started = time.time()
        try:
            api = open_api(account)
            albums = api.photos.albums
            images = 0
            videos = 0
            image_bytes = 0
            video_bytes = 0
            seen = set()
            for album_name in ("Hidden", "Recently Deleted", "Library"):
                try:
                    album = albums[album_name]
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
                    size = int(original.get("size") or getattr(asset, "size", 0) or 0)
                    if Path(filename).suffix.lower() in VIDEO_EXT:
                        videos += 1
                        video_bytes += size
                    else:
                        images += 1
                        image_bytes += size
            row = {
                "email": email,
                "images": images,
                "imageBytes": image_bytes,
                "videos": videos,
                "videoBytes": video_bytes,
                "seconds": round(time.time() - started, 1),
            }
            log("survey", email, images, f"{image_bytes / 1e9:.2f} GB", f"{row['seconds']}s")
        except Exception as error:  # noqa: BLE001
            row = {"email": email, "error": f"{type(error).__name__}: {error}"}
            log("survey failed", email, row["error"][:160])
        if email not in known:
            rows.append(row)
            known.add(email)
        else:
            for position, old in enumerate(rows):
                if old.get("email") == email:
                    rows[position] = row
                    break
        OUT.write_text(json.dumps(rows, indent=2))
    good = [row for row in rows if "error" not in row]
    log(
        "survey finish",
        len(good),
        "accounts",
        sum(row["images"] for row in good),
        "images",
        f"{sum(row['imageBytes'] for row in good) / 1e9:.1f} GB",
    )


if __name__ == "__main__":
    main()
