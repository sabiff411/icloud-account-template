#!/usr/bin/env python3
"""Keep the bulk export from filling the disk.

Deletes the least valuable data first and logs every step, so the export keeps
running:

  150 GB free -> delete the nightly /root/backups archives (oldest first)
  110 GB free -> delete video files under every Photos tree (images only task)
   65 GB free -> delete regenerable Scan previews/play cache

It never touches image files, Notes, Drive or the manifests.
"""
from __future__ import annotations

import os
import shutil
import time
from pathlib import Path

ROOT = Path("/opt/icloud3")
EXPORT = ROOT / "export"
BACKUPS = Path("/root/backups")
LOG = ROOT / "disk_guard.log"
VIDEO_EXT = {".mov", ".mp4", ".m4v", ".3gp", ".avi", ".mkv", ".webm", ".part"}
SCAN_CACHE = ("play", "previews")


def log(message: str) -> None:
    line = time.strftime("%Y-%m-%d %H:%M:%S ") + message
    print(line, flush=True)
    try:
        with LOG.open("a") as handle:
            handle.write(line + "\n")
    except OSError:
        pass


def free_gb() -> float:
    return shutil.disk_usage(ROOT).free / 1024**3


def photos_dirs():
    for account in EXPORT.iterdir():
        photos = account / "Photos"
        if photos.is_dir():
            yield photos


def delete_videos() -> tuple[int, int]:
    files = 0
    total = 0
    for photos in photos_dirs():
        for path in photos.rglob("*"):
            if path.is_file() and path.suffix.lower() in VIDEO_EXT:
                try:
                    size = path.stat().st_size
                    path.unlink()
                    files += 1
                    total += size
                except OSError:
                    continue
    return files, total


def delete_scan_cache() -> tuple[int, int]:
    files = 0
    total = 0
    for account in EXPORT.iterdir():
        for name in SCAN_CACHE:
            folder = account / "Scan" / name
            if not folder.is_dir():
                continue
            for path in folder.rglob("*"):
                if path.is_file():
                    try:
                        size = path.stat().st_size
                        path.unlink()
                        files += 1
                        total += size
                    except OSError:
                        continue
    return files, total


def delete_oldest_backup() -> tuple[str, int]:
    if not BACKUPS.is_dir():
        return "", 0
    archives = sorted(BACKUPS.glob("*.tgz"), key=lambda p: p.stat().st_mtime)
    for archive in archives:
        try:
            size = archive.stat().st_size
            archive.unlink()
            return archive.name, size
        except OSError:
            continue
    return "", 0


def bulk_alive() -> bool:
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            args = (entry / "cmdline").read_bytes().decode().split("\0")
        except OSError:
            continue
        if any(arg.endswith("bulk_images.py") for arg in args):
            return True
    return False


def main() -> None:
    log(f"guard start free={free_gb():.1f} GB")
    videos_done = False
    scan_done = False
    while True:
        free = free_gb()
        while free < 150:
            name, size = delete_oldest_backup()
            if not name:
                break
            log(f"freed backup {name} {size / 1e9:.1f} GB, free={free_gb():.1f} GB")
            free = free_gb()
        if free < 110 and not videos_done:
            files, total = delete_videos()
            videos_done = True
            log(f"freed videos: {files} files {total / 1e9:.1f} GB, free={free_gb():.1f} GB")
        if free < 65 and not scan_done:
            files, total = delete_scan_cache()
            scan_done = True
            log(f"freed scan cache: {files} files {total / 1e9:.1f} GB, free={free_gb():.1f} GB")
        if not bulk_alive() and free_gb() > 150:
            log(f"guard finish free={free_gb():.1f} GB")
            return
        time.sleep(300)


if __name__ == "__main__":
    main()
