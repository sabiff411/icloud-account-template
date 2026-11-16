#!/usr/bin/env python3
"""Rebuild every Scan/s4-manifest.json from the bucket + local files.

The prune used to regenerate the manifest from whatever was still on disk, so
an account pruned in two passes lost the entries of the first pass.  The bucket
holds the truth: list it once, merge with the local walk, write the result.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(os.environ.get("EXPORT_DIR") or (Path(__file__).resolve().parents[1] / "export"))
KEEP = ("Photos/", "Drive/", "Notes/", "Calendar/", "Contacts/")
RCLONE = os.environ.get("RCLONE") or "/usr/local/bin/rclone"
REMOTE = os.environ.get("S4_REMOTE", "s4:icld").rstrip("/")


def bucket_listing(account: str = "") -> dict[str, dict[str, dict]]:
    source = f"{REMOTE}/{account}" if account else REMOTE
    result = subprocess.run(
        [RCLONE, "lsf", source, "--recursive", "--files-only", "--format", "pst"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print("bucket listing failed:", result.stderr.strip()[-200:], file=sys.stderr)
        return {}
    out: dict[str, dict[str, dict]] = {}
    for line in result.stdout.splitlines():
        parts = line.split(";")
        if len(parts) < 2:
            continue
        if account:
            name, rel = account, parts[0]
        else:
            if "/" not in parts[0]:
                continue
            name, rel = parts[0].split("/", 1)
        if not rel.startswith(KEEP):
            continue
        try:
            size = int(parts[1])
        except ValueError:
            size = 0
        mtime = 0
        if len(parts) > 2:
            try:
                mtime = int(
                    time.mktime(time.strptime(parts[2].split(".")[0], "%Y-%m-%d %H:%M:%S")) * 1000
                )
            except Exception:
                mtime = 0
        out.setdefault(name, {})[rel] = {"p": rel, "s": size, "m": mtime}
    return out


def local_files(account: Path) -> dict[str, dict]:
    found: dict[str, dict] = {}
    for prefix in KEEP:
        base = account / prefix.rstrip("/")
        if not base.is_dir():
            continue
        for current, _dirs, names in os.walk(base, followlinks=True):
            for name in names:
                full = Path(current) / name
                try:
                    stat = full.stat()
                except OSError:
                    continue
                rel = full.relative_to(account).as_posix()
                found[rel] = {"p": rel, "s": stat.st_size, "m": int(stat.st_mtime * 1000)}
    return found


def main() -> None:
    only = sys.argv[1].strip() if len(sys.argv) > 1 else ""
    remote = bucket_listing(only)
    print(f"bucket accounts: {len(remote)}")
    total = 0
    for account in sorted(ROOT.iterdir()):
        if not account.is_dir() or account.name.startswith("."):
            continue
        if only and account.name != only:
            continue
        merged = dict(remote.get(account.name) or {})
        # Local files win for size/mtime: they may be newer than the upload.
        for rel, entry in local_files(account).items():
            merged[rel] = entry
        if not merged:
            print(f"{account.name}: nothing")
            continue
        files = sorted(merged.values(), key=lambda item: item["p"])
        out = account / "Scan" / "s4-manifest.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            json.dumps(
                {"generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "files": files}
            )
        )
        photos = sum(1 for f in files if f["p"].startswith("Photos/"))
        total += photos
        print(f"{account.name}: {len(files)} entries ({photos} photos)")
    print(f"photos across manifests: {total}")


if __name__ == "__main__":
    main()
