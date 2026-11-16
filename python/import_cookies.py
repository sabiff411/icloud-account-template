#!/usr/bin/env python3
"""Import a browser Cookie-Editor export into an account's pyicloud session.

The operator can open the account in a browser (same proxy, same password) and
export its cookies.  Those cookies are the ones Apple accepts; this tool puts
them into the session directory pyicloud reads, verifies them, and (optionally)
flips the account back to connected in the panel store.

    import_cookies.py --email user@icloud.com --file cookies.json [--mark-connected]

The JSON is Cookie-Editor's shape: a list of
{name, value, domain, path, expirationDate, secure, httpOnly}.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from http.cookiejar import Cookie, LWPCookieJar
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bulk_images import ROOT, STORE  # noqa: E402
from worker.proxy import build_proxy_url, stable_ssid  # noqa: E402

APPLES = ("apple.com", "icloud.com")


def cookiejar_path(session_dir: Path) -> Path:
    jars = sorted(session_dir.glob("*.cookiejar"))
    return jars[0] if jars else session_dir / "imported.cookiejar"


def to_lwp(rows: list[dict]) -> LWPCookieJar:
    jar = LWPCookieJar()
    for row in rows:
        domain = str(row.get("domain") or "")
        if not any(domain.endswith(site) for site in APPLES):
            continue
        expires = row.get("expirationDate")
        jar.set_cookie(
            Cookie(
                version=0,
                name=str(row.get("name") or ""),
                value=str(row.get("value") or ""),
                port=None,
                port_specified=False,
                domain=domain,
                domain_specified=domain.startswith("."),
                domain_initial_dot=domain.startswith("."),
                path=str(row.get("path") or "/"),
                path_specified=True,
                secure=bool(row.get("secure", True)),
                expires=int(expires) if expires else None,
                discard=not expires,
                comment=None,
                comment_url=None,
                rest={"HttpOnly": None} if row.get("httpOnly") else {},
                rfc2109=False,
            )
        )
    return jar


def sync_session_tokens(session_dir: Path, jar: LWPCookieJar) -> dict:
    """Copy the web/trust tokens from the jar into the pyicloud session file.

    Drive rejects a session that has DS token but no X-APPLE-WEBAUTH-TOKEN, and
    a missing trust token means Apple asks for the 2FA code again.
    """
    session_file = next(iter(sorted(session_dir.glob("*.session"))), None)
    data: dict = {}
    if session_file and session_file.exists():
        try:
            data = json.loads(session_file.read_text())
        except Exception:
            data = {}
    web = next((c.value for c in jar if c.name == "X-APPLE-WEBAUTH-TOKEN"), "")
    trust = next((c.value for c in jar if c.name == "X-APPLE-WEBAUTH-HSA-TRUST"), "")
    ds = next((c.value for c in jar if c.name == "X-APPLE-DS-WEB-SESSION-TOKEN"), "")
    if web:
        data["session_token"] = web
    elif ds and not data.get("session_token"):
        data["session_token"] = ds
    if trust:
        data["trust_token"] = trust
    if session_file and data:
        session_file.write_text(json.dumps(data))
    return {"web_token": bool(web), "trust_token": bool(trust), "ds_token": bool(ds)}


def account_for(email: str) -> dict:
    data = json.loads(STORE.read_text())
    for account in data.get("accounts") or []:
        if str(account.get("email") or "").lower() == email.lower():
            account["_store"] = data
            return account
    raise SystemExit(f"account not found: {email}")


def mark_connected(account: dict) -> None:
    data = account.pop("_store")
    for row in data.get("accounts") or []:
        if str(row.get("email") or "").lower() == str(account.get("email")).lower():
            row["trusted"] = True
            row["status"] = "connected"
            row["lastError"] = ""
            row["lastPingAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            break
    temp = STORE.with_suffix(".tmp")
    temp.write_text(json.dumps(data, indent=2))
    temp.replace(STORE)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--email", required=True)
    parser.add_argument("--file", required=True)
    parser.add_argument("--mark-connected", action="store_true")
    args = parser.parse_args()

    account = account_for(args.email)
    session_dir = Path(account["sessionDir"])
    if not session_dir.is_absolute():
        session_dir = ROOT / session_dir
    session_dir.mkdir(parents=True, exist_ok=True)

    rows = json.loads(Path(args.file).read_text())
    if isinstance(rows, dict):
        rows = rows.get("cookies") or []
    jar = to_lwp(rows)
    target = cookiejar_path(session_dir)
    # Merge with what the session already holds: a browser export that lacks
    # X-APPLE-WEBAUTH-TOKEN must not wipe a working token from an earlier login.
    if target.exists():
        try:
            existing = LWPCookieJar(str(target))
            existing.load(ignore_discard=True, ignore_expires=True)
            imported_names = {str(row.get("name") or "") for row in rows}
            keep = [c for c in existing if c.name not in imported_names]
            if keep:
                rows = list(rows) + [
                    {
                        "name": c.name,
                        "value": c.value,
                        "domain": c.domain,
                        "path": c.path,
                        "secure": c.secure,
                        "httpOnly": True,
                        "expirationDate": c.expires,
                    }
                    for c in keep
                ]
                print(f"kept {len(keep)} cookies from the existing jar")
        except Exception as error:  # noqa: BLE001
            print(f"could not read the existing jar: {type(error).__name__}")
    jar.save(str(target), ignore_discard=True, ignore_expires=True)
    print(f"wrote {target} ({len(list(jar))} cookies)")
    state = sync_session_tokens(session_dir, jar)
    print(
        "tokens: web={web_token} trust={trust_token} ds={ds_token}".format(**state)
    )
    if not state["web_token"]:
        print("WARNING: no X-APPLE-WEBAUTH-TOKEN in the export -> the account will")
        print("         stay 'limited' (Drive 421) until the login completes 2FA")

    proxy = account.get("proxy") or {}
    url = build_proxy_url(
        "http://user:pass@portal.anyip.io:1080",
        country=str(proxy.get("country") or ""),
        ssid=str(proxy.get("ssid") or stable_ssid(args.email)),
    )
    os.environ["HTTP_PROXY"] = url
    os.environ["HTTPS_PROXY"] = url
    from pyicloud import PyiCloudService

    api = PyiCloudService(args.email, account.get("password") or "", cookie_directory=str(session_dir), accept_terms=True, authenticate=False)
    status = api.get_auth_status() or {}
    print("auth", status)
    if status.get("authenticated") and args.mark_connected:
        mark_connected(account)
        print("panel status set to connected")


if __name__ == "__main__":
    main()
