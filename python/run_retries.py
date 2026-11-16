#!/usr/bin/env python3
"""Retry every account that the first bulk pass failed on.

Waits for the main bulk run to release its lock, then re-runs only the failed
emails (the exporter resumes from zips/index.json, so nothing is downloaded
twice).  Up to three attempts per account; each attempt re-reads the report.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bulk_images import ROOT, report_rows  # noqa: E402

PYTHON = "/opt/icloud3-venv/bin/python"
SCRIPT = str(ROOT / "python/bulk_images.py")
RETRY_LOG = ROOT / "retry_failed.log"


def log(message: str) -> None:
    line = time.strftime("%Y-%m-%d %H:%M:%S ") + message
    with RETRY_LOG.open("a") as handle:
        handle.write(line + "\n")
    print(line, flush=True)


def failed_emails() -> list[str]:
    try:
        rows = report_rows()
    except Exception:
        return []
    return [
        str(row.get("email"))
        for row in rows
        if isinstance(row, dict)
        and row.get("email")
        and (row.get("error") or row.get("failures"))
    ]


def locks() -> list[Path]:
    return sorted(Path("/tmp").glob("bulk_images*.lock"))


def shard_alive() -> bool:
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            args = (entry / "cmdline").read_bytes().decode().split("\0")
        except OSError:
            continue
        if any(arg.endswith("bulk_images.py") for arg in args) and "--shard" in args:
            return True
    return False


def wait_for_lock() -> None:
    while True:
        active = []
        for lock in locks():
            try:
                pid = int(lock.read_text().strip())
                os.kill(pid, 0)
                active.append(lock)
            except (ValueError, ProcessLookupError):
                lock.unlink(missing_ok=True)
        if not active and not shard_alive():
            return
        time.sleep(60)


def main() -> None:
    wait_for_lock()
    attempted: dict[str, int] = {}
    for attempt in range(1, 5):
        emails = [email for email in failed_emails() if attempted.get(email, 0) < 3]
        if not emails:
            break
        log(f"retry attempt {attempt}: {len(emails)} accounts")
        for email in emails:
            attempted[email] = attempted.get(email, 0) + 1
        env = dict(os.environ)
        env.setdefault("ANYIP_PROXY_URL", "http://user:pass@portal.anyip.io:1080")
        with RETRY_LOG.open("a") as handle:
            subprocess.run(
                [PYTHON, SCRIPT, "--email", ",".join(emails), "--workers", "90", "--batch", "500"],
                cwd=str(ROOT),
                env=env,
                stdout=handle,
                stderr=subprocess.STDOUT,
                check=False,
            )
    remaining = failed_emails()
    log(f"retry done, still failing: {len(remaining)} {remaining[:10]}")


if __name__ == "__main__":
    main()
