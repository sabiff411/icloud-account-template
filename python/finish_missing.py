#!/usr/bin/env python3
"""After the bulk pass: check every account and download whatever is missing.

    finish_missing.py [--rounds 3] [--workers 80]

For each trusted account it compares the live image count (account store)
with the exporter's own record (manifest.sqlite3), then re-runs the exporter
for the shortfall.  It repeats until a round makes no progress, so an account
that was skipped by a session error or a listed-but-missing file is picked up.

Notes and Drive are checked the same way and filled with the notes/Drive
passes.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import time
from pathlib import Path

ROOT = Path("/opt/icloud3")
EXPORT = ROOT / "export"
STORE = ROOT / "server/data/items.json"
PYTHON = "/opt/icloud3-venv/bin/python"
LOG = ROOT / "finish_missing.log"
LOCK_GLOB = "/tmp/bulk_images*.lock"


def log(message: str) -> None:
    line = time.strftime("%Y-%m-%d %H:%M:%S ") + message
    print(line, flush=True)
    try:
        with LOG.open("a") as handle:
            handle.write(line + "\n")
    except OSError:
        pass


def env() -> dict:
    value = dict(os.environ)
    value.setdefault("HOME", "/home/icloud3")
    value.setdefault("DOWNLOAD_DIRECT", "1")
    value.setdefault("METADATA_DIRECT", "1")
    return value


def counts(email: str) -> tuple[int, int]:
    base = EXPORT / email
    root = base.resolve() if base.exists() else base
    photos = 0
    if (root / "manifest.sqlite3").exists():
        try:
            db = sqlite3.connect(f"file:{root / 'manifest.sqlite3'}?mode=ro", uri=True, timeout=10)
            photos = db.execute(
                "SELECT COUNT(*) FROM files WHERE area IN ('photos','hidden','deleted')"
            ).fetchone()[0]
            db.close()
        except sqlite3.Error:
            photos = 0
    notes = len(list((root / "Notes" / "txt").glob("*.txt"))) if (root / "Notes/txt").is_dir() else 0
    drive = sum(1 for p in (root / "Drive").rglob("*") if p.is_file()) if (root / "Drive").is_dir() else 0
    return photos, notes, drive


def run(script: str, email: str, *extra: str) -> int:
    command = [PYTHON, str(ROOT / "python" / script), "--email", email, *extra]
    with LOG.open("a") as handle:
        handle.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} run {script} {email}\n")
        handle.flush()
        return subprocess.run(command, env=env(), cwd=str(ROOT), stdout=handle,
                              stderr=subprocess.STDOUT, check=False).returncode


def waiting_for_shards() -> bool:
    for lock in Path("/tmp").glob(Path(LOCK_GLOB).name):
        try:
            pid = int(lock.read_text().strip())
            os.kill(pid, 0)
            return True
        except (ValueError, ProcessLookupError):
            lock.unlink(missing_ok=True)
    return False


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--workers", type=int, default=80)
    args = parser.parse_args()

    log("finish_missing start, waiting for the bulk shards")
    while waiting_for_shards():
        time.sleep(60)
    log("bulk shards finished; auditing every account")

    for round_no in range(1, args.rounds + 1):
        store = json.loads(STORE.read_text())
        todo = []
        for account in store.get("accounts") or []:
            if not account.get("trusted"):
                continue
            email = str(account.get("email") or "")
            live_counts = account.get("counts") or {}
            live = int(live_counts.get("images") or 0)
            live_notes = int(live_counts.get("notes") or 0)
            live_drive = int(live_counts.get("driveFiles") or 0)
            photos, notes, drive = counts(email)
            missing_images = max(0, live - photos)
            missing_notes = max(0, live_notes - notes)
            missing_drive = max(0, live_drive - drive)
            if missing_images or missing_notes or missing_drive:
                todo.append((missing_images, email, missing_notes, missing_drive))
        todo.sort(reverse=True)
        log(
            f"round {round_no}: {len(todo)} accounts short "
            f"({sum(t[0] for t in todo)} images, {sum(t[2] for t in todo)} notes, "
            f"{sum(t[3] for t in todo)} drive files)"
        )
        if not todo:
            break
        improved = 0
        for missing_images, email, missing_notes, missing_drive in todo:
            before = counts(email)
            if missing_images:
                run("bulk_images.py", email, "--videos", "--workers", str(args.workers), "--batch", "500")
            if missing_notes:
                run("bulk_other.py", email, "--force")
            if missing_drive:
                run("bulk_drive.py", email, "--workers", "6")
            after = counts(email)
            if after != before:
                improved += 1
            log(
                f"  {email}: images {before[0]}->{after[0]}/{missing_images + before[0]}, "
                f"notes {before[1]}->{after[1]}, drive {before[2]}->{after[2]}"
            )
        log(f"round {round_no} improved {improved} accounts")
        if improved == 0:
            break

    log("finish_missing done")


if __name__ == "__main__":
    main()
