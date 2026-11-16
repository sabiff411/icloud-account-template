#!/usr/bin/env python3
"""Restore trusted iCloud sessions that stopped authenticating.

Apple invalidated a batch of sessions while the worker was running its own
auth checks through IPv6 proxy exits.  The password and the trust token are
still stored, so ``authenticate(force_refresh=True)`` through the account's
stable anyIP session signs back in without a 2FA prompt.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bulk_images import ROOT, STATE, load_accounts  # noqa: E402
from worker.proxy import build_proxy_url, stable_ssid  # noqa: E402

LOG = Path("/var/lib/icloud3-bulk/reauth.log")


def log(message: str) -> None:
    line = time.strftime("%Y-%m-%d %H:%M:%S ") + message
    print(line, flush=True)
    with LOG.open("a") as handle:
        handle.write(line + "\n")


def failed_emails() -> list[str]:
    failed: set[str] = set()
    for path in STATE.glob("bulk_report*.json"):
        try:
            rows = json.loads(path.read_text())
        except Exception:
            continue
        for row in rows if isinstance(rows, list) else []:
            if isinstance(row, dict) and row.get("email") and row.get("error"):
                failed.add(str(row["email"]).lower())
    return sorted(failed)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--email", help="comma-separated emails (default: failed report rows)")
    parser.add_argument("--all", action="store_true", help="probe every trusted account")
    args = parser.parse_args()

    accounts = load_accounts()
    if args.email:
        wanted = {item.strip().lower() for item in args.email.split(",") if item.strip()}
        accounts = [account for account in accounts if account["email"].lower() in wanted]
    elif not args.all:
        failed = {email.lower() for email in failed_emails()}
        accounts = [account for account in accounts if account["email"].lower() in failed]

    base = os.environ.get("ANYIP_PROXY_URL") or "http://user:pass@portal.anyip.io:1080"
    from pyicloud import PyiCloudService

    log(f"reauth start {len(accounts)} accounts")
    ok = 0
    for account in accounts:
        email = account["email"]
        password = account.get("password") or ""
        if not password:
            log(f"{email} no password stored")
            continue
        proxy = account.get("proxy") or {}
        country = str(proxy.get("country") or (account.get("geo") or {}).get("countryCode") or "")
        ssid = str(proxy.get("ssid") or stable_ssid(email))
        url = build_proxy_url(base, country=country, ssid=ssid)
        os.environ["HTTP_PROXY"] = url
        os.environ["HTTPS_PROXY"] = url
        session_dir = account["sessionDir"]
        if not os.path.isabs(session_dir):
            session_dir = str(ROOT / session_dir)
        try:
            api = PyiCloudService(
                email,
                password,
                cookie_directory=session_dir,
                accept_terms=True,
                authenticate=False,
            )
            api.authenticate(force_refresh=True)
            status = api.get_auth_status() or {}
            if status.get("authenticated"):
                ok += 1
                log(f"{email} ok trusted={status.get('trusted_session')}")
            else:
                log(f"{email} still not authenticated")
        except Exception as error:  # noqa: BLE001
            log(f"{email} failed {type(error).__name__}: {str(error)[:160]}")
    log(f"reauth finish {ok}/{len(accounts)}")


if __name__ == "__main__":
    main()
