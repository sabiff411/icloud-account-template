#!/usr/bin/env python3
"""What do the accounts added in the last 24 h actually have?

    audit_recent.py [hours]

For every account created within the window it prints live counts (from the
account store), the exporter's own record (manifest.sqlite3) and what is
physically present now (local tree + the S4 listing), so a shortfall is visible
without trusting any single number.
"""
from __future__ import annotations

import json
import sqlite3
import sys
import time
from pathlib import Path

ROOT = Path("/opt/icloud3")
STORE = ROOT / "server/data/items.json"
EXPORT = ROOT / "export"
VIDEO = (".mov", ".mp4", ".m4v", ".3gp")


def local_files(base: Path, sub: str) -> int:
    root = base / sub
    if not root.is_dir():
        return 0
    return sum(1 for p in root.rglob("*") if p.is_file() and not p.name.endswith(".part"))


def sqlite_counts(base: Path) -> dict[str, int]:
    path = base / "manifest.sqlite3"
    out = {"photos": 0, "notes": 0, "drive": 0}
    if not path.exists():
        return out
    try:
        db = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
        for area, key in (("photos", "photos"), ("hidden", "photos"), ("deleted", "photos"),
                           ("notes", "notes"), ("drive", "drive")):
            out[key] += db.execute(
                "SELECT COUNT(*) FROM files WHERE area=? AND status='done'", (area,)
            ).fetchone()[0]
        db.close()
    except sqlite3.Error:
        pass
    return out


def bucket_counts(base: Path) -> dict[str, int]:
    out = {"photos": 0, "drive": 0, "notes": 0}
    path = base / "Scan" / "s4-manifest.json"
    if not path.exists():
        return out
    try:
        files = json.loads(path.read_text()).get("files") or []
    except Exception:
        return out
    for entry in files:
        rel = str(entry.get("p") or "")
        if rel.startswith("Photos/") and not rel.lower().endswith(VIDEO):
            out["photos"] += 1
        elif rel.startswith("Drive/"):
            out["drive"] += 1
        elif rel.startswith("Notes/"):
            out["notes"] += 1
    return out


def main() -> None:
    hours = float(sys.argv[1]) if len(sys.argv) > 1 else 24
    cutoff = time.time() - hours * 3600
    store = json.loads(STORE.read_text())
    accounts = store.get("accounts") or []
    rows = []
    for account in accounts:
        created = str(account.get("createdAt") or "")
        try:
            stamp = time.mktime(time.strptime(created[:19], "%Y-%m-%dT%H:%M:%S"))
        except Exception:
            continue
        if stamp < cutoff:
            continue
        email = str(account.get("email") or "")
        counts = account.get("counts") or {}
        base = EXPORT / email
        have_local = local_files(base, "Photos")
        have_bucket = bucket_counts(base)
        have_db = sqlite_counts(base)
        rows.append(
            {
                "email": email,
                "created": created[:16],
                "status": account.get("status"),
                "live_images": int(counts.get("images") or 0),
                "disk_images": have_local,
                "db_images": have_db["photos"],
                "bucket_images": have_bucket["photos"],
                "live_notes": int(counts.get("notes") or 0),
                "disk_notes": len(list((base / "Notes/txt").glob("*.txt"))) if (base / "Notes/txt").is_dir() else 0,
                "db_notes": have_db["notes"],
                "live_drive": int(counts.get("driveFiles") or 0),
                "disk_drive": local_files(base, "Drive"),
                "db_drive": have_db["drive"],
                "bucket_drive": have_bucket["drive"],
            }
        )
    rows.sort(key=lambda row: row["live_images"], reverse=True)
    head = (
        f"{'account':35} {'live':>7} {'disk':>7} {'db':>7} {'s4':>7} | "
        f"{'notes live/disk/db':>20} | {'drive live/disk/db/s4':>23}"
    )
    print(head)
    total = {"live": 0, "disk": 0, "db": 0, "s4": 0, "notes_live": 0, "notes_disk": 0,
             "drive_live": 0, "drive_disk": 0, "drive_db": 0, "drive_s4": 0}
    for row in rows:
        print(
            f"{row['email']:35} {row['live_images']:7} {row['disk_images']:7} "
            f"{row['db_images']:7} {row['bucket_images']:7} | "
            f"{row['live_notes']:6}/{row['disk_notes']:<5}/{row['db_notes']:<6} | "
            f"{row['live_drive']:5}/{row['disk_drive']:<4}/{row['db_drive']:<5}/{row['bucket_drive']:<6}"
        )
        total["live"] += row["live_images"]
        total["disk"] += row["disk_images"]
        total["db"] += row["db_images"]
        total["s4"] += row["bucket_images"]
        total["notes_live"] += row["live_notes"]
        total["notes_disk"] += row["disk_notes"]
        total["drive_live"] += row["live_drive"]
        total["drive_disk"] += row["disk_drive"]
        total["drive_db"] += row["db_drive"]
        total["drive_s4"] += row["bucket_drive"]
    print(
        f"\n{len(rows)} accounts · images live {total['live']} · disk {total['disk']} · "
        f"db {total['db']} · s4 {total['s4']}"
    )
    print(
        f"notes live {total['notes_live']} · disk {total['notes_disk']} · "
        f"drive live {total['drive_live']} · disk {total['drive_disk']} · db {total['drive_db']} · s4 {total['drive_s4']}"
    )


if __name__ == "__main__":
    main()
