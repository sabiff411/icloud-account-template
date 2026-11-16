#!/usr/bin/env python3
"""Re-check every trusted account and reconnect the ones that are still alive.

For each account:
  * read the exit IP of its own stable anyIP session (the same proxy the
    cookie was made on);
  * open the stored cookie as user icloud3 (ownership matters: a root-owned
    cookiejar makes a healthy session look dead);
  * if the cookie is stale, try one force-refresh (the trust token usually
    still works);
  * write the truthful status back to the panel store.

Nothing is deleted; a failure is only reported as "needs 2FA" or an error.
"""
from __future__ import annotations

import fcntl
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bulk_images import ROOT, STORE, load_accounts  # noqa: E402
from worker.proxy import build_proxy_url, stable_ssid  # noqa: E402

LOG = Path("/var/lib/icloud3-bulk/reconnect.log")


def log(message: str) -> None:
    line = time.strftime("%Y-%m-%d %H:%M:%S ") + message
    print(line, flush=True)
    try:
        with LOG.open("a") as handle:
            handle.write(line + "\n")
    except OSError:
        pass


def store_lock():
    handle = Path("/tmp/icloud3-store.lock").open("w")
    fcntl.flock(handle, fcntl.LOCK_EX)
    return handle


def main() -> None:
    from pyicloud import PyiCloudService
    import requests

    accounts = load_accounts()
    base = os.environ.get("ANYIP_PROXY_URL") or "http://user:pass@portal.anyip.io:1080"
    results: dict[str, dict] = {}
    log(f"reconnect start {len(accounts)} accounts")

    for account in accounts:
        email = account["email"]
        proxy = account.get("proxy") or {}
        stored_exit = str(proxy.get("exitIp") or "")
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

        # Confirm the exit before touching the cookie; a different IP is what
        # makes Apple answer 421 to an otherwise valid cookie.
        exit_ip = ""
        try:
            exit_ip = requests.get(
                "https://api.ipify.org",
                proxies={"http": url, "https": url},
                timeout=20,
            ).text.strip()
        except Exception:
            exit_ip = ""

        state = "error"
        detail = ""
        try:
            api = PyiCloudService(email, account.get("password") or "", cookie_directory=session_dir, accept_terms=True, authenticate=False)
            status = api.get_auth_status() or {}
            if status.get("authenticated"):
                state = "connected"
            else:
                try:
                    api.authenticate(force_refresh=True)
                    status = api.get_auth_status() or {}
                    if status.get("authenticated"):
                        state = "reconnected"
                    else:
                        state = "needs_2fa"
                except Exception as error:  # noqa: BLE001
                    name = type(error).__name__
                    state = "needs_2fa" if "2FA" in name else "error"
                    detail = f"{name}: {error}"[:120]
        except Exception as error:  # noqa: BLE001
            detail = f"{type(error).__name__}: {error}"[:120]

        results[email] = {"state": state, "exit": exit_ip, "storedExit": stored_exit, "detail": detail}
        log(f"{email} {state} exit={exit_ip or '?'} stored={stored_exit or '?'} {detail}")

    handle = store_lock()
    try:
        data = json.loads(STORE.read_text())
        changed = 0
        for row in data.get("accounts") or []:
            email = str(row.get("email") or "")
            if email not in results or not row.get("trusted"):
                continue
            state = results[email]["state"]
            new_status = "connected" if state in ("connected", "reconnected") else "dead"
            error = "" if new_status == "connected" else (results[email]["detail"] or state)
            if row.get("status") != new_status or (row.get("lastError") or "") != error:
                row["status"] = new_status
                row["trusted"] = True
                row["lastError"] = error
                row["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                changed += 1
        STORE.write_text(json.dumps(data, indent=2))
        log(f"store updated: {changed} accounts")
    finally:
        handle.close()

    counts: dict[str, int] = {}
    for item in results.values():
        counts[item["state"]] = counts.get(item["state"], 0) + 1
    log(f"reconnect finish {counts}")


if __name__ == "__main__":
    main()
