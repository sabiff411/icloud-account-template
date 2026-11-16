#!/usr/bin/env python3
"""Rebuild Scan/s4-manifest.json from the S4 bucket.

Used for accounts whose local copy was already pruned and whose manifest was
regenerated while empty.  The bucket listing carries path, size and mtime, so
it is a faithful replacement for the walk.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(os.environ.get("EXPORT_DIR") or (Path(__file__).resolve().parents[1] / "export"))
# The prune runs as root; a manual run as the service user has no rclone
# config of its own, so point at root's when it exists.
RCLONE_CONFIG = os.environ.get("RCLONE_CONFIG") or (
    "/root/.config/rclone/rclone.conf"
    if os.path.exists("/root/.config/rclone/rclone.conf")
    else ""
)
KEEP = ("Photos/", "Drive/", "Notes/", "Calendar/", "Contacts/")
RCLONE = os.environ.get("RCLONE") or "/usr/local/bin/rclone"
REMOTE = os.environ.get("S4_REMOTE", "s4:icld").rstrip("/")


def listing(account: str) -> list[dict]:
    command = [RCLONE, "lsf", f"{REMOTE}/{account}", "--recursive", "--files-only", "--format", "pst"]
    if RCLONE_CONFIG:
        command += ["--config", RCLONE_CONFIG]
    result = subprocess.run(command, capture_output=True, text=True)
    files = []
    for line in result.stdout.splitlines():
        # path;size;2026-11-14 07:55:00.123456789
        parts = line.split(";")
        if len(parts) < 2:
            continue
        rel = parts[0]
        if not rel.startswith(KEEP):
            continue
        try:
            size = int(parts[1])
        except ValueError:
            size = 0
        mtime = 0
        if len(parts) > 2:
            try:
                stamp = parts[2].split(".")[0]
                mtime = int(time.mktime(time.strptime(stamp, "%Y-%m-%d %H:%M:%S")) * 1000)
            except Exception:
                mtime = 0
        files.append({"p": rel, "s": size, "m": mtime})
    return files


def main() -> None:
    wanted = {item.strip().lower() for item in (sys.argv[1] or "").split(",") if item.strip()} if len(sys.argv) > 1 else set()
    for account_dir in sorted(ROOT.iterdir()):
        if not account_dir.is_dir() or account_dir.name.startswith("."):
            continue
        if wanted and account_dir.name.lower() not in wanted:
            continue
        manifest = account_dir / "Scan" / "s4-manifest.json"
        existing = 0
        try:
            existing = len(json.loads(manifest.read_text()).get("files") or [])
        except Exception:
            existing = 0
        files = listing(account_dir.name)
        if not files:
            print(f"{account_dir.name}: nothing in the bucket")
            continue
        # Rebuild whenever the bucket knows more than the manifest does.  The
        # old "skip if any entry exists" check kept a photo-less manifest:
        # the prune regenerated it from the disk it had just emptied, so every
        # pruned photo disappeared from the panel even though it was on S4.
        if len(files) <= existing:
            continue
        manifest.parent.mkdir(parents=True, exist_ok=True)
        manifest.write_text(
            json.dumps({"generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "files": files})
        )
        print(f"{account_dir.name}: rebuilt {len(files)} entries")


if __name__ == "__main__":
    main()
