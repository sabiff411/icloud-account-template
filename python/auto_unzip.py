#!/usr/bin/env python3
"""Unzip each account as soon as its bulk export finishes.

Watches bulk_report.json: every account that finished without an error and
still has zips is extracted into its Photos tree, recorded in the manifest and
its zips are removed (keeps disk usage flat).  Runs until the bulk exporter
exits, then does one last pass.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bulk_images import EXPORT, load_accounts, log, report_rows  # noqa: E402
from s4_upload import sync_one  # noqa: E402
from unzip_bulk import process  # noqa: E402


def accounts_ready() -> dict[str, dict]:
    try:
        rows = report_rows()
    except Exception:
        rows = []
    ready = {
        str(row.get("email") or ""): row
        for row in rows
        if isinstance(row, dict) and row.get("email") and "error" not in row
    }
    # An interrupted bulk run may have ZIPs but no zips/report.json yet
    # (cssosa had 29 ZIPs, aminah 2).  They still need extracting.
    for account_dir in EXPORT.iterdir():
        if (account_dir / "zips" / "index.json").exists():
            ready.setdefault(account_dir.name, {"email": account_dir.name})
    return ready


def pending(account: dict) -> bool:
    folder = EXPORT / account["email"] / "zips"
    index_path = folder / "index.json"
    if not index_path.exists():
        return False
    try:
        index = json.loads(index_path.read_text())
    except Exception:
        return False
    # Presence of a ZIP is the real signal.  The `unzipped` flag can be
    # stale: batches added after a successful unzip used to leave it true,
    # so 38 ZIPs (33 GB) sat on disk never extracted.
    return any((folder / batch["file"]).exists() for batch in index.get("batches") or [])


def bulk_alive() -> bool:
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            args = (entry / "cmdline").read_bytes().decode().split("\0")
        except Exception:
            continue
        if any(arg.endswith("bulk_images.py") for arg in args):
            return True
    return False


def run_one(account: dict) -> bool:
    try:
        result = process(account, delete_zips=True)
        log("unzip", account["email"], json.dumps(result))
        # New bytes invalidate a previous mirror marker: a repair pass or a
        # late ZIP must be uploaded, not skipped because the account was
        # complete before this batch arrived.
        if result.get("restored") or result.get("corrupt"):
            (EXPORT / account["email"] / "Scan" / "s4-complete.json").unlink(missing_ok=True)
        # Mirror as soon as the ZIP is extracted.  The watcher also does this,
        # but a standalone auto_unzip run must not leave bytes only on disk.
        if str(os.environ.get("S4_UPLOAD", "0")).lower() not in ("0", "false", "no", ""):
            prune = str(os.environ.get("S4_PRUNE", "0")).lower() not in ("0", "false", "no", "")
            sync_one(EXPORT / account["email"], prune=prune)
        return True
    except Exception as error:  # noqa: BLE001
        log("unzip", account["email"], "failed", type(error).__name__, str(error)[:200])
        return False


def main() -> None:
    while True:
        # No "done" set: an account that is still exporting can produce new
        # ZIPs minutes after its first unzip, and they must be extracted too.
        accounts = load_accounts()
        for account in accounts:
            if pending(account):
                run_one(account)
        if not bulk_alive():
            for account in accounts:
                if pending(account):
                    run_one(account)
            log("unzip finish")
            return
        time.sleep(45)


if __name__ == "__main__":
    main()
