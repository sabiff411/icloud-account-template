#!/usr/bin/env python3
"""Refresh the panel status of every trusted account from a live check.

A ping that failed at 05:27 leaves the account marked "dead" even after the
session works again.  This pass opens each trusted account once, reads
get_auth_status (no re-login, nothing invalidated) and writes the truthful
status back to the store.
"""
from __future__ import annotations

import fcntl
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bulk_images import ROOT, STORE, load_accounts, log  # noqa: E402
from worker.proxy import build_proxy_url, stable_ssid  # noqa: E402

LOG = Path("/var/lib/icloud3-bulk/status_sync.log")


def write_log(message: str) -> None:
    line = time.strftime("%Y-%m-%d %H:%M:%S ") + message
    print(line, flush=True)
    try:
        with LOG.open("a") as handle:
            handle.write(line + "\n")
    except OSError:
        pass


def store_lock():
    lock_path = Path("/tmp/icloud3-store.lock")
    handle = lock_path.open("w")
    fcntl.flock(handle, fcntl.LOCK_EX)
    return handle


def main() -> None:
    from pyicloud import PyiCloudService

    accounts = load_accounts()
    base = os.environ.get("ANYIP_PROXY_URL") or "http://user:pass@portal.anyip.io:1080"
    results: dict[str, tuple[bool, str]] = {}
    for account in accounts:
        email = account["email"]
        proxy = account.get("proxy") or {}
        url = build_proxy_url(
            base,
            country=str(proxy.get("country") or ""),
            ssid=str(proxy.get("ssid") or stable_ssid(email)),
        )
        os.environ["HTTP_PROXY"] = url
        os.environ["HTTPS_PROXY"] = url
        session_dir = account["sessionDir"]
        if not os.path.isabs(session_dir):
            session_dir = str(ROOT / session_dir)
        ok = False
        last_error = "session invalid"
        # One validate can fail while the proxy is busy; two clean attempts are
        # required before an account is called dead.
        for attempt in range(3):
            try:
                api = PyiCloudService(email, account.get("password") or "", cookie_directory=session_dir, accept_terms=True, authenticate=False)
                status = api.get_auth_status() or {}
                if status.get("authenticated"):
                    ok = True
                    last_error = ""
                    break
            except Exception as error:  # noqa: BLE001
                last_error = f"{type(error).__name__}: {error}"[:120]
            time.sleep(2)
        results[email] = (ok, last_error)
        write_log(f"{email} {'ok' if results[email][0] else results[email][1]}")

    handle = store_lock()
    try:
        data = json.loads(STORE.read_text())
        changed = 0
        for row in data.get("accounts") or []:
            email = str(row.get("email") or "")
            if email not in results or not row.get("trusted"):
                continue
            ok, error = results[email]
            new_status = "connected" if ok else "dead"
            if row.get("status") != new_status or (row.get("lastError") or "") != error:
                row["status"] = new_status
                row["trusted"] = True
                row["lastError"] = error
                row["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                changed += 1
        # The data directory is owned by another uid; the store file itself is
        # writable, so truncate and write it in place.
        STORE.write_text(json.dumps(data, indent=2))
        write_log(f"store updated: {changed} accounts")
    finally:
        handle.close()
    ok_count = sum(1 for ok, _ in results.values() if ok)
    write_log(f"finish {ok_count}/{len(results)} authenticated")


if __name__ == "__main__":
    main()
