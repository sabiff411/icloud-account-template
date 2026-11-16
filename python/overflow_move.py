#!/usr/bin/env python3
"""Move finished accounts off the export disk when it runs low.

The app reads export/<email> through a symlink without trouble, so a finished,
fully unzipped account can live on the second disk and still appear in the
dashboard.  Only accounts with no pending zips are moved; the active bulk
account is never touched.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path

ROOT = Path("/opt/icloud3")
EXPORT = ROOT / "export"
OVERFLOW = ROOT / "export-overflow"
BULK_LOG = ROOT / "bulk_images.log"
LOG = ROOT / "overflow.log"
LOW_FREE = 250 * 1024**3
TARGET_FREE = 400 * 1024**3


def log(message: str) -> None:
    line = time.strftime("%Y-%m-%d %H:%M:%S ") + message
    print(line, flush=True)
    try:
        with LOG.open("a") as handle:
            handle.write(line + "\n")
    except OSError:
        pass


def active_email() -> str:
    try:
        for line in reversed(BULK_LOG.read_text().splitlines()[-60:]):
            parts = line.split()
            if "account" in parts:
                index = parts.index("account")
                if index + 1 < len(parts):
                    return parts[index + 1]
    except OSError:
        pass
    return ""


def finished(account: Path) -> bool:
    index = account / "zips" / "index.json"
    if not index.exists():
        return True
    try:
        data = json.loads(index.read_text())
    except Exception:
        return False
    if not data.get("unzipped"):
        return False
    folder = account / "zips"
    return not any((folder / batch["file"]).exists() for batch in data.get("batches") or [])


def main() -> None:
    usage = shutil.disk_usage(EXPORT)
    if usage.free >= LOW_FREE:
        return
    OVERFLOW.mkdir(parents=True, exist_ok=True)
    skip = active_email()
    log(f"export disk low: {usage.free / 1024**3:.0f} GB free")
    candidates = []
    for account in EXPORT.iterdir():
        if account.is_symlink() or not account.is_dir():
            continue
        if account.name == skip or not finished(account):
            continue
        size = 0
        for path in account.rglob("*"):
            if path.is_file():
                try:
                    size += path.stat().st_size
                except OSError:
                    pass
        candidates.append((size, account))
    candidates.sort(reverse=True)
    for size, account in candidates:
        if shutil.disk_usage(EXPORT).free >= TARGET_FREE:
            break
        dest = OVERFLOW / account.name
        if dest.exists():
            continue
        started = time.time()
        result = subprocess.run(
            ["rsync", "-aHAX", "--remove-source-files", f"{account}/", f"{dest}/"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if result.returncode != 0:
            log(f"move failed {account.name}")
            continue
        # Remove the emptied tree and point the export path at the new home.
        shutil.rmtree(account, ignore_errors=True)
        os.symlink(dest, account)
        log(
            f"moved {account.name} {size / 1e9:.1f} GB in {time.time() - started:.0f}s, "
            f"free={shutil.disk_usage(EXPORT).free / 1024**3:.0f} GB"
        )


if __name__ == "__main__":
    main()
