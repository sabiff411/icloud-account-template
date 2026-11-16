#!/usr/bin/env python3
"""Unzipped export -> MEGA S4 (S3) -> panel links -> prune local bytes.

The worker writes the export tree; `auto_unzip.py` extracts the bulk ZIPs.
This script mirrors each account to the S4 bucket with rclone, writes the
`Scan/s4-manifest.json` the panel lists from, writes `Scan/s4-complete.json`
only after a size check, and (optionally) deletes the local Photos/Drive
originals so the server does not fill up.

    python3 python/s4_upload.py --email user@icloud.com --prune
    python3 python/s4_upload.py --watch --prune

Env:
    S4_REMOTE=s4:icld             rclone remote + bucket
    RCLONE_CONFIG=/root/.config/rclone/rclone.conf
    RCLONE=/usr/local/bin/rclone
    ICLOUD_ROOT=/opt/icloud3       repo/state root
    EXPORT_DIR=/opt/icloud3/export
    S4_PRUNE=1                     default for --watch
    S4_SYNC_INTERVAL=60
    S4_TRANSFERS=8
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(os.environ.get("ICLOUD_ROOT") or Path(__file__).resolve().parents[1])
EXPORT = Path(os.environ.get("EXPORT_DIR") or ROOT / "export")
RCLONE = os.environ.get("RCLONE") or shutil.which("rclone") or "/usr/local/bin/rclone"
REMOTE = os.environ.get("S4_REMOTE", "s4:icld").rstrip("/")
RCLONE_CONFIG = os.environ.get("RCLONE_CONFIG") or (
    "/root/.config/rclone/rclone.conf"
    if os.path.exists("/root/.config/rclone/rclone.conf")
    else ""
)
TRANSFERS = str(max(1, int(os.environ.get("S4_TRANSFERS", "8") or 8)))
CHECKERS = str(max(1, int(os.environ.get("S4_CHECKERS", "16") or 16)))
INTERVAL = max(15, int(os.environ.get("S4_SYNC_INTERVAL", "60") or 60))
CHECKSUM = str(os.environ.get("S4_CHECKSUM", "0")).lower() not in ("0", "false", "no", "")
DEFAULT_PRUNE = str(os.environ.get("S4_PRUNE", "0")).lower() not in ("0", "false", "no", "")
KEEP_LOCAL = ("Scan", "Notes", "Contacts", "Calendar", "manifest.sqlite3", "Photos/urls.json")
MANIFEST_PREFIX = ("Photos/", "Drive/", "Notes/", "Calendar/", "Contacts/")


def log(*parts: object) -> None:
    print(time.strftime("%H:%M:%S"), *parts, flush=True)


def account_dirs() -> list[Path]:
    if not EXPORT.exists():
        return []
    return [
        item
        for item in sorted(EXPORT.iterdir())
        if item.is_dir() and not item.name.startswith(".") and item.name != "export-overflow"
    ]


def pending_zips(account: Path) -> bool:
    folder = account / "zips"
    index = folder / "index.json"
    if not index.exists():
        return False
    try:
        data = json.loads(index.read_text())
    except Exception:
        return True
    return any((folder / batch.get("file", "")).exists() for batch in data.get("batches") or [])


def scan_done(account: Path) -> bool:
    return (account / "Scan" / "index.json").exists() or (account / "Scan" / "summary.json").exists()


def complete_data(account: Path) -> dict:
    try:
        return json.loads((account / "Scan" / "s4-complete.json").read_text())
    except Exception:
        return {}


def needs_upload(account: Path) -> bool:
    """True when a local file is newer than the last checked mirror."""
    data = complete_data(account)
    if not data.get("checked"):
        return True
    try:
        mark = datetime.datetime.strptime(
            str(data.get("generated")), "%Y-%m-%dT%H:%M:%SZ"
        ).replace(tzinfo=datetime.timezone.utc).timestamp() * 1000
    except Exception:
        return True
    return any(entry["m"] > mark + 5_000 for entry in file_entries(account))


def scan_entries(account: Path) -> list[dict]:
    files: list[dict] = []
    base = account / "Scan"
    if not base.is_dir():
        return files
    for current, _dirs, names in os.walk(base, followlinks=True):
        for name in names:
            full = Path(current) / name
            try:
                stat = full.stat()
            except OSError:
                continue
            files.append({"p": full.relative_to(account).as_posix(), "s": int(stat.st_size), "m": int(stat.st_mtime * 1000)})
    return files


def scan_needs_upload(account: Path) -> bool:
    data = complete_data(account)
    if not data.get("checked"):
        return True
    try:
        mark = datetime.datetime.strptime(
            str(data.get("scanAt")), "%Y-%m-%dT%H:%M:%SZ"
        ).replace(tzinfo=datetime.timezone.utc).timestamp() * 1000
    except Exception:
        return True
    return any(entry["m"] > mark + 5_000 for entry in scan_entries(account))


def mark_scan(account: Path, email: str) -> None:
    data = complete_data(account)
    if not data.get("checked"):
        return
    data["scanAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    (account / "Scan" / "s4-complete.json").write_text(json.dumps(data, indent=2))
    try:
        subprocess.run(
            base_cmd() + ["copyto", str(account / "Scan" / "s4-complete.json"),
                          f"{REMOTE}/{email}/Scan/s4-complete.json"],
            check=False,
        )
    except FileNotFoundError:
        pass


def file_entries(account: Path) -> list[dict]:
    files: list[dict] = []
    for prefix in MANIFEST_PREFIX:
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
                files.append(
                    {
                        "p": full.relative_to(account).as_posix(),
                        "s": int(stat.st_size),
                        "m": int(stat.st_mtime * 1000),
                    }
                )
    return files


def write_manifest(account: Path, dry: bool = False) -> dict:
    files = file_entries(account)
    out = account / "Scan" / "s4-manifest.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    merged = {entry["p"]: entry for entry in files}
    if out.exists():
        try:
            for entry in json.loads(out.read_text()).get("files") or []:
                merged.setdefault(entry["p"], entry)
        except Exception:
            pass
    data = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "files": sorted(merged.values(), key=lambda entry: entry["p"]),
    }
    if not dry:
        out.write_text(json.dumps(data))
    return data


def base_cmd() -> list[str]:
    cmd = [RCLONE]
    if RCLONE_CONFIG:
        cmd += ["--config", RCLONE_CONFIG]
    return cmd


def copy_account(account: Path, email: str, dry: bool = False) -> bool:
    cmd = base_cmd() + [
        "copy",
        str(account),
        f"{REMOTE}/{email}",
        "--transfers", TRANSFERS,
        "--checkers", CHECKERS,
        "--s3-upload-concurrency", "4",
        "--s3-chunk-size", "16M",
        "--header-upload", "Cache-Control: private, max-age=86400",
        "--exclude", "zips/**",
        "--exclude", "*.part",
        "--exclude", "manifest.sqlite3",
        "--stats", "30s",
        "--stats-one-line",
        "--log-level", "INFO",
    ]
    log("copy", email, " ".join(cmd[1:]))
    if dry:
        return True
    try:
        result = subprocess.run(cmd, check=False)
    except FileNotFoundError:
        log("copy", email, "rclone not found:", RCLONE)
        return False
    if result.returncode != 0:
        log("copy", email, "failed", result.returncode)
        return False
    return True


def copy_scan(account: Path, email: str, dry: bool = False) -> bool:
    scan = account / "Scan"
    if not scan.is_dir():
        return True
    cmd = base_cmd() + [
        "copy", str(scan), f"{REMOTE}/{email}/Scan",
        "--transfers", TRANSFERS, "--checkers", CHECKERS,
        "--header-upload", "Cache-Control: private, max-age=86400",
        "--log-level", "INFO",
    ]
    log("copy-scan", email)
    if dry:
        return True
    try:
        result = subprocess.run(cmd, check=False)
    except FileNotFoundError:
        return False
    return result.returncode == 0


def write_complete(account: Path, email: str, dry: bool = False) -> dict:
    entries = file_entries(account)
    data = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "email": email,
        "files": len(entries),
        "bytes": sum(entry["s"] for entry in entries),
        "checked": True,
        "scanAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) if scan_done(account) else None,
    }
    target = account / "Scan" / "s4-complete.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    if not dry:
        target.write_text(json.dumps(data, indent=2))
    if not dry:
        cmd = base_cmd() + ["copyto", str(target), f"{REMOTE}/{email}/Scan/s4-complete.json"]
        try:
            subprocess.run(cmd, check=False)
        except FileNotFoundError:
            pass
    return data


def check_account(account: Path, email: str, dry: bool = False) -> bool:
    cmd = base_cmd() + [
        "check", str(account), f"{REMOTE}/{email}",
        *(["--checksum"] if CHECKSUM else ["--size-only"]), "--one-way",
        "--exclude", "zips/**", "--exclude", "*.part",
        "--exclude", "manifest.sqlite3",
        "--checkers", CHECKERS,
    ]
    log("check", email)
    if dry:
        return True
    try:
        result = subprocess.run(cmd, check=False)
    except FileNotFoundError:
        return False
    if result.returncode != 0:
        log("check", email, "differs", result.returncode)
        return False
    return True


def prune_account(account: Path, email: str, dry: bool = False, force: bool = False) -> int:
    data = complete_data(account)
    if not data.get("checked"):
        log("prune", email, "no checked complete marker")
        return 0
    if not force and not scan_done(account):
        log("prune", email, "scan not finished yet")
        return 0
    if data.get("prunedAt") and not force:
        log("prune", email, "already pruned")
        return 0
    freed = 0
    removed = 0
    for area in ("Photos", "Drive"):
        base = account / area
        if not base.is_dir():
            continue
        for current, _dirs, names in os.walk(base, topdown=False):
            for name in names:
                full = Path(current) / name
                rel = full.relative_to(account).as_posix()
                if rel in KEEP_LOCAL or rel == "Photos/urls.json":
                    continue
                try:
                    size = full.stat().st_size if full.is_file() else 0
                except OSError:
                    size = 0
                if dry:
                    log("prune-would", rel, size)
                else:
                    try:
                        full.unlink()
                        removed += 1
                        freed += size
                    except OSError as error:
                        log("prune", rel, type(error).__name__)
    if not dry:
        data["prunedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        data["prunedFiles"] = int(data.get("prunedFiles") or 0) + removed
        data["prunedBytes"] = int(data.get("prunedBytes") or 0) + freed
        (account / "Scan" / "s4-complete.json").write_text(json.dumps(data, indent=2))
        try:
            subprocess.run(
                base_cmd() + ["copyto", str(account / "Scan" / "s4-complete.json"),
                              f"{REMOTE}/{email}/Scan/s4-complete.json"],
                check=False,
            )
        except FileNotFoundError:
            pass
    log("prune", email, "files", removed, "bytes", freed)
    return freed


def sync_one(account: Path, prune: bool, force: bool = False, dry: bool = False) -> bool:
    email = account.name
    if pending_zips(account) and not force:
        log("sync", email, "waiting for unzip")
        return False
    if force or needs_upload(account):
        # Do not leave an old "complete" marker pointing at a mirror that is
        # about to change; if this upload fails the panel falls back to local.
        if not dry:
            (account / "Scan" / "s4-complete.json").unlink(missing_ok=True)
        write_manifest(account, dry)
        if not copy_account(account, email, dry):
            return False
        if scan_done(account) and not copy_scan(account, email, dry):
            return False
        if not check_account(account, email, dry):
            return False
        write_complete(account, email, dry)
    elif scan_done(account) and scan_needs_upload(account):
        if copy_scan(account, email, dry) and not dry:
            mark_scan(account, email)
    if prune:
        prune_account(account, email, dry, force)
    return True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--email")
    parser.add_argument("--watch", action="store_true")
    parser.add_argument("--prune", dest="prune", action="store_true", default=None)
    parser.add_argument("--no-prune", dest="prune", action="store_false")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    prune = DEFAULT_PRUNE if args.prune is None else args.prune

    if args.email:
        accounts = [EXPORT / args.email]
    else:
        accounts = account_dirs()
    if not accounts:
        log("no accounts under", EXPORT)
        return 1

    if args.watch:
        log("watch", EXPORT, "remote", REMOTE, "prune", prune, "interval", INTERVAL)
        while True:
            for account in account_dirs():
                if account.is_dir():
                    sync_one(account, prune, args.force, args.dry_run)
            time.sleep(INTERVAL)

    failures = 0
    for account in accounts:
        if not account.is_dir():
            log("missing", account)
            failures += 1
            continue
        if not sync_one(account, prune, args.force, args.dry_run):
            failures += 1
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
