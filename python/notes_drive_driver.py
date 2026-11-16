#!/usr/bin/env python3
"""One account at a time: every note, then every Drive file.

    notes_drive_driver.py --emails "$(cat list.csv)" [--order large]

Images are pulled by the bulk shards; this fills the two small halves of the
account so the panel can show notes and Drive next to the photos.  Each
account runs to completion before the next starts: two exporters on one
session invalidate it.
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

PYTHON = os.environ.get("PYTHON_BIN") or sys.executable
ROOT = Path(os.environ.get("ICLOUD_ROOT") or Path(__file__).resolve().parents[1])
STATE = Path("/var/lib/icloud3-bulk")
LOG = ROOT / "notes_drive.log"


def log(message: str) -> None:
    line = time.strftime("%Y-%m-%d %H:%M:%S ") + message
    print(line, flush=True)
    try:
        with LOG.open("a") as handle:
            handle.write(line + "\n")
    except OSError:
        pass


def run(script: str, email: str, *extra: str) -> int:
    env = dict(os.environ)
    env.setdefault("ANYIP_PROXY_URL", "http://user:pass@portal.anyip.io:1080")
    command = [PYTHON, str(ROOT / "python" / script), "--email", email, *extra]
    with LOG.open("a") as handle:
        handle.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} run {script} {email}\n")
        handle.flush()
        result = subprocess.run(command, env=env, cwd=str(ROOT), stdout=handle,
                                stderr=subprocess.STDOUT, check=False)
    return result.returncode


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--emails", required=True, help="comma-separated list")
    parser.add_argument("--order", choices=["large", "small"], default="small")
    args = parser.parse_args()

    import json

    store = json.loads((ROOT / "server/data/items.json").read_text())
    weight = {
        str(a.get("email")): int((a.get("counts") or {}).get("images") or 0)
        for a in store.get("accounts") or []
    }
    emails = [item.strip() for item in args.emails.split(",") if item.strip()]
    # The image shards walk their list smallest-first, so work this list
    # largest-first: the two jobs rarely touch the same account at once.
    emails.sort(key=lambda email: weight.get(email, 0), reverse=args.order == "large")

    log(f"driver start {len(emails)} accounts order={args.order}")
    for index, email in enumerate(emails, 1):
        started = time.time()
        notes = run("bulk_other.py", email, "--force")
        drive = run("bulk_drive.py", email, "--workers", "4")
        log(
            f"driver {index}/{len(emails)} {email} notes rc={notes} drive rc={drive} "
            f"{time.time() - started:.0f}s"
        )
    log("driver finish")


if __name__ == "__main__":
    main()
