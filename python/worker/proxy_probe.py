#!/usr/bin/env python3
"""Find a fast anyIP exit by rotating the `session_` flag.

anyIP pins one exit IP per `session_<id>`; a new id is a new IP.  This probes
several ids for one country, measures a real download through each, and prints
the fastest.  It does not change any account or store.

    python -m worker.proxy_probe --country US --attempts 10 --mb 10
    python -m worker.proxy_probe --country US --attempts 10 --mb 10 --info
    python -m worker.proxy_probe --country GB --attempts 6 --mb 5 --json

Run on the VPS with the worker environment:
    cd /opt/icloud3
    PYTHONPATH=/opt/icloud3/python /opt/icloud3-venv/bin/python -m worker.proxy_probe --country US
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
import time
from urllib.parse import urlsplit

import requests

from .proxy import build_proxy_url, mask_proxy_url
from .proxy_support import attach

DEFAULT_TEST_URL = "https://proof.ovh.net/files/100Mb.dat"


def base_url(value: str) -> str:
    value = (value or os.environ.get("ANYIP_PROXY_URL") or os.environ.get("ICLOUD_PROXY_URL") or "").strip()
    if value and "://" not in value:
        value = "http://" + value
    if not value:
        raise SystemExit("set ANYIP_PROXY_URL or pass --base")
    return value


def exit_info(proxy_url: str, timeout: float = 12.0) -> dict:
    session = requests.Session()
    attach(session, proxy_url)
    try:
        response = session.get("http://ip-api.com/json", timeout=timeout)
        return response.json() if response.ok else {}
    except Exception:
        return {}


def measure(proxy_url: str, test_url: str, target: int, timeout: float) -> tuple[int, float]:
    session = requests.Session()
    attach(session, proxy_url)
    started = time.monotonic()
    got = 0
    try:
        with session.get(test_url, stream=True, timeout=(10, timeout)) as response:
            response.raise_for_status()
            for chunk in response.iter_content(256 * 1024):
                if not chunk:
                    continue
                got += len(chunk)
                if got >= target:
                    break
    except Exception:
        pass
    return got, max(0.001, time.monotonic() - started)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--country", default="US", help="ISO country code for the exit")
    parser.add_argument("--attempts", type=int, default=8, help="number of session ids to try")
    parser.add_argument("--mb", type=float, default=10.0, help="download size per attempt")
    parser.add_argument("--url", default=DEFAULT_TEST_URL, help="throughput test URL")
    parser.add_argument("--timeout", type=float, default=45.0, help="per-attempt timeout (s)")
    parser.add_argument("--base", default="", help="base proxy URL (or ANYIP_PROXY_URL)")
    parser.add_argument("--prefix", default="probe", help="session name prefix")
    parser.add_argument("--session", default="", help="test one fixed session id instead of new ones")
    parser.add_argument("--sticky-check", action="store_true", help="open 5 new connections with the best session and compare exit IPs")
    parser.add_argument("--info", action="store_true", help="also look up each exit IP/country")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    args = parser.parse_args()

    base = base_url(args.base)
    target = int(args.mb * 1024 * 1024)
    results = []
    for index in range(max(1, args.attempts)):
        ssid = (args.session or f"{args.prefix}{secrets.token_hex(3)}")[:32]
        proxy_url = build_proxy_url(base, country=args.country, ssid=ssid)
        got, seconds = measure(proxy_url, args.url, target, args.timeout)
        mbps = (got * 8 / 1_000_000) / seconds if got else 0.0
        info = exit_info(proxy_url) if args.info else {}
        result = {
            "session": ssid,
            "mbps": round(mbps, 2),
            "mb": round(got / 1048576, 2),
            "seconds": round(seconds, 2),
            "ip": info.get("query", ""),
            "country": info.get("countryCode", ""),
            "city": info.get("city", ""),
            "proxy": mask_proxy_url(proxy_url),
        }
        results.append(result)
        if not args.json:
            print(
                f'{index + 1:>2}/{args.attempts}  {mbps:8.2f} Mbps  '
                f'{result["mb"]:6.2f} MB  {seconds:6.2f}s  '
                f'{result["ip"] or "-":<39} {result["country"] or "-":<3} '
                f'session_{ssid}',
                flush=True,
            )

    results.sort(key=lambda item: item["mbps"], reverse=True)
    best = results[0] if results else {}
    if args.sticky_check and best:
        session_url = build_proxy_url(base, country=args.country, ssid=best["session"])
        checked = []
        for _ in range(5):
            checked.append(exit_info(session_url).get("query", ""))
            time.sleep(1)
        if args.json:
            best["sticky"] = checked
        else:
            print("\nSTICKY CHECK (5 new connections, same session):")
            for ip in checked:
                print(" ", ip or "-")
            unique = len(set(ip for ip in checked if ip))
            print(f"  unique exit IPs: {unique}  ({'FIXED' if unique == 1 else 'NOT fixed'})")

    if args.json:
        print(json.dumps({"country": args.country, "best": best, "results": results}, indent=1))
    else:
        print("\nBEST:")
        print(json.dumps(best, indent=1))
        print("\nPin it for an account by using this session in its proxy block:")
        print(f'  session_{best.get("session", "")}')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
