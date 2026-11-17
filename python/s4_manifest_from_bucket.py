#!/usr/bin/env python3
"""Rebuild Scan/s4-manifest.json from the S4 bucket.

The panel lists an account from `Scan/s4-manifest.json`.  The prune rewrites
that file from the local tree, and when it runs after the local original was
deleted the manifest comes out empty — the photos are on S4 but disappear from
the panel.  This rebuilds the manifest from the bucket itself (path, size and
mtime), which is the only authoritative list once the bytes were pruned.

One full bucket listing builds every account at once (~4 min for the whole
fleet); pass a comma-separated email list to restrict it.

    s4_manifest_from_bucket.py                  every account
    s4_manifest_from_bucket.py a@x.com,b@y.com   just these
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
    """One account's files (used when a list of emails is given)."""
    command = [RCLONE, "lsf", f"{REMOTE}/{account}", "--recursive", "--files-only", "--format", "pst"]
    if RCLONE_CONFIG:
        command += ["--config", RCLONE_CONFIG]
    result = subprocess.run(command, capture_output=True, text=True)
    files = []
    for line in result.stdout.splitlines():
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


def write_manifest(account_dir: Path, files: list[dict]) -> bool:
    if not files:
        return False
    manifest = account_dir / "Scan" / "s4-manifest.json"
    existing = 0
    try:
        existing = len(json.loads(manifest.read_text()).get("files") or [])
    except Exception:
        existing = 0
    if len(files) <= existing:
        return False
    try:
        manifest.parent.mkdir(parents=True, exist_ok=True)
        manifest.write_text(
            json.dumps({"generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "files": files})
        )
    except OSError as error:
        print(f"{account_dir.name}: {type(error).__name__}: {error}", flush=True)
        return False
    print(f"{account_dir.name}: rebuilt {len(files)} entries", flush=True)
    return True


def full_listing() -> dict[str, list[dict]]:
    """One bucket pass, grouped per account."""
    command = [RCLONE, "lsf", REMOTE, "--recursive", "--files-only", "--format", "pst"]
    if RCLONE_CONFIG:
        command += ["--config", RCLONE_CONFIG]
    result = subprocess.run(command, capture_output=True, text=True)
    buckets: dict[str, list[dict]] = {}
    for line in result.stdout.splitlines():
        # path;size;2026-11-14 07:55:00.123456789
        parts = line.split(";")
        if len(parts) < 2:
            continue
        path = parts[0]
        account, _, rel = path.partition("/")
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
        buckets.setdefault(account, []).append({"p": rel, "s": size, "m": mtime})
    return buckets


def main() -> None:
    wanted = (
        {item.strip().lower() for item in (sys.argv[1] or "").split(",") if item.strip()}
        if len(sys.argv) > 1
        else set()
    )
    started = time.time()
    rebuilt = 0

    if wanted:
        # Target mode: one prefix listing per account, which is much faster
        # than the whole bucket when only a handful of manifests are broken.
        for account_dir in sorted(ROOT.iterdir()):
            if not account_dir.is_dir() or account_dir.name.lower() not in wanted:
                continue
            if write_manifest(account_dir, listing(account_dir.name)):
                rebuilt += 1
    else:
        buckets = full_listing()
        print(
            f"bucket: {sum(len(v) for v in buckets.values())} files in {len(buckets)} accounts "
            f"({time.time() - started:.0f}s)",
            flush=True,
        )
        for account_dir in sorted(ROOT.iterdir()):
            if not account_dir.is_dir() or account_dir.name.startswith("."):
                continue
            if write_manifest(account_dir, buckets.get(account_dir.name) or []):
                rebuilt += 1
    print(f"done · {rebuilt} manifests rebuilt · {time.time() - started:.0f}s", flush=True)


if __name__ == "__main__":
    main()
