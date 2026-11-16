#!/usr/bin/env python3
"""Audit label coverage on every source, so no image can be silently skipped.

Compares four sets and writes /opt/icloud3/classify/coverage.json:

    mounted local files   every image under each account directory
    S4 bucket objects    every image object outside Scan/ (cached listing)
    iCloud cloud count   what the accounts report, to size the download queue
    labelled results     status="ok" rows in results.jsonl

The bucket listing is expensive (2.6M objects), so it is cached for 6 hours and
refreshed in the background.  Exit code 1 when anything local or in the bucket
has no label, which makes it usable from cron or a monitoring check.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import classify_all as ca  # noqa: E402

CACHE = Path("/tmp/s4-files.txt")
COVERAGE = ca.OUT_DIR / "coverage.json"
CACHE_AGE = 6 * 3600


def log(message: str) -> None:
    print(time.strftime("%Y-%m-%d %H:%M:%S ") + message, flush=True)


def labelled() -> set[str]:
    found: set[str] = set()
    with ca.RESULTS.open(errors="ignore") as handle:
        for line in handle:
            try:
                row = json.loads(line)
            except Exception:  # noqa: BLE001
                continue
            if row.get("rel_path") and row.get("status") == "ok":
                found.add(row["rel_path"])
    return found


def local_images(accounts: dict[str, Path]) -> set[str]:
    found: set[str] = set()
    for email, root in accounts.items():
        for path in ca.local_photos(root):
            found.add(f"{email}/{path.relative_to(root).as_posix()}")
    return found


def bucket_images() -> tuple[set[str], bool]:
    """Image objects outside Scan/; (set, stale) when the listing is old."""
    stale = True
    try:
        stale = time.time() - CACHE.stat().st_mtime > CACHE_AGE
    except OSError:
        stale = True
    if stale:
        log("refreshing the bucket listing in the background")
        subprocess.Popen(
            ["sh", "-c", f"rclone lsf {ca.REMOTE} --files-only -R > {CACHE}.new && "
                         f"mv {CACHE}.new {CACHE}"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    found: set[str] = set()
    try:
        with CACHE.open(errors="ignore") as handle:
            for line in handle:
                rel = line.rstrip("\n")
                if not rel or "/Scan/" in rel:
                    continue
                if Path(rel).suffix.lower() in ca.core.IMAGE_EXT:
                    found.add(rel)
    except OSError:
        pass
    return found, stale


def cloud_total() -> int:
    try:
        store = json.loads(Path("/opt/icloud3/server/data/items.json").read_text())
        accounts = store.get("accounts") if isinstance(store, dict) else store
        return sum(int(((a.get("counts") or {}).get("images") or 0)) for a in accounts)
    except Exception:  # noqa: BLE001
        return 0


def main() -> int:
    accounts = ca.account_roots()
    seen = labelled()
    local = local_images(accounts)
    bucket, stale = bucket_images()
    cloud = cloud_total()

    local_missing = sorted(local - seen)
    bucket_missing = sorted(bucket - seen)
    report = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "accounts": len(accounts),
        "labelled": len(seen),
        "cloudImages": cloud,
        "local": {"total": len(local), "labelled": len(local) - len(local_missing),
                  "missing": len(local_missing)},
        "bucket": {"total": len(bucket), "labelled": len(bucket) - len(bucket_missing),
                   "missing": len(bucket_missing), "stale": stale},
        "cloud": {"total": cloud, "labelled": min(len(seen), cloud),
                  "notDownloaded": max(0, cloud - len(seen))},
        "missingLocalSample": local_missing[:20],
        "missingBucketSample": bucket_missing[:20],
    }
    COVERAGE.write_text(json.dumps(report, indent=1))
    log(f"labelled {report['labelled']:,} · local {report['local']['labelled']:,}/"
        f"{report['local']['total']:,} · bucket {report['bucket']['labelled']:,}/"
        f"{report['bucket']['total']:,}" +
        (" (listing stale)" if stale else "") +
        f" · cloud not downloaded ~{report['cloud']['notDownloaded']:,}")
    if local_missing:
        log(f"local without a label: {len(local_missing)} e.g. {local_missing[:3]}")
    if bucket_missing:
        log(f"bucket without a label: {len(bucket_missing)} e.g. {bucket_missing[:3]}")
    for name in ("missingLocal.txt", "missingBucket.txt"):
        pass
    (ca.OUT_DIR / "missingLocal.txt").write_text("\n".join(local_missing) + "\n")
    (ca.OUT_DIR / "missingBucket.txt").write_text("\n".join(bucket_missing) + "\n")
    return 1 if (local_missing or bucket_missing) else 0


if __name__ == "__main__":
    raise SystemExit(main())
