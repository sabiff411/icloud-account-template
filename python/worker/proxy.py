"""Residential proxy URL construction and observation.

Only the username carries the country/session flags.  anyip wants
`user,country_US,session_<stable>`; niceproxy wants
`user-ssid-<stable>-country-US`.  Keep the session id stable per account so
the exit IP (and the Apple trust token bound to it) stays stable.
"""

from __future__ import annotations

import base64
import hashlib
import re
from urllib.parse import quote, urlsplit, urlunsplit

import requests


def stable_ssid(email: str) -> str:
    return hashlib.sha256(email.strip().lower().encode()).hexdigest()[:16]


def _country(value: str | None, fallback: str = "") -> str:
    code = (value or fallback or "").strip().upper()
    return code if re.fullmatch(r"[A-Z]{2}", code) else ""


def country_code(value: str | None, fallback: str = "") -> str:
    """Public alias used by the auth/proxy selection code."""
    return _country(value, fallback)


def build_proxy_url(
    base_url: str,
    *,
    country: str = "",
    ssid: str = "",
    attempt: int = 0,
    fallback_country: str = "",
) -> str:
    """Return a proxy URL with the country and stable session in the user."""
    if not base_url:
        return ""
    raw = base_url if "://" in base_url else f"http://{base_url}"
    parts = urlsplit(raw)
    code = _country(country, fallback_country)
    session = re.sub(r"[^A-Za-z0-9_-]", "", ssid or "worker")[:32]
    suffix = str(attempt) if attempt else ""

    # Placeholder style, for custom gateways.
    if "{country}" in parts.netloc or "{ssid}" in parts.netloc:
        netloc = parts.netloc.replace("{country}", quote(code)).replace(
            "{ssid}", quote(f"{session}{suffix}")
        )
        return urlunsplit(parts._replace(netloc=netloc))

    if not parts.username:
        return raw

    user = parts.username
    password = parts.password or ""
    host = parts.hostname or ""

    if "anyip" in host.lower() or "," in user:
        flags = [p for p in user.split(",") if not p.startswith(("country_", "session_"))]
        if code:
            flags.append(f"country_{code}")
        flags.append(f"session_{session}{suffix}")
        new_user = ",".join(flags)
        netloc = f"{quote(new_user, safe=',_-')}:{quote(password, safe='')}@{host}"
    elif "niceproxy" in host.lower() or "-ssid-" in user or "-country-" in user:
        base = re.sub(r"(-ssid-[^-]*|-country-[A-Za-z]{2})", "", user)
        new_user = f"{base}-ssid-{session}{suffix}"
        if code:
            new_user += f"-country-{code}"
        netloc = f"{quote(new_user, safe='_-')}:{quote(password, safe='')}@{host}"
    else:
        # A plain authenticated proxy: keep it usable, country is a no-op.
        netloc = f"{quote(user, safe='')}:{quote(password, safe='')}@{host}"

    if parts.port:
        netloc += f":{parts.port}"
    return urlunsplit(parts._replace(netloc=netloc))


def mask_proxy_url(url: str) -> str:
    if not url:
        return ""
    parts = urlsplit(url)
    if not parts.username:
        return url
    user = parts.username
    netloc = f"{user}:***@{parts.hostname or ''}"
    if parts.port:
        netloc += f":{parts.port}"
    return urlunsplit(parts._replace(netloc=netloc))


def apply_proxy(session: requests.Session, url: str) -> None:
    if not url:
        return
    session.proxies.update({"http": url, "https": url})


def observe_exit_ip(proxy_url: str, timeout: float = 8.0) -> str:
    """One echo request through the same proxy; best effort, never raises."""
    try:
        if proxy_url:
            from .proxy_support import attach

            session = requests.Session()
            attach(session, proxy_url)
        else:
            session = requests.Session()
        response = session.get(
            "https://api.ipify.org?format=json", timeout=timeout
        )
        response.raise_for_status()
        return str(response.json().get("ip", ""))
    except Exception:
        return ""


def country_for_ip(ip: str, timeout: float = 6.0) -> str:
    """Best-effort country of an exit IP (direct lookup, no proxy)."""
    if not ip:
        return ""
    for url in (
        f"https://ipinfo.io/{ip}/country",
        f"http://ip-api.com/json/{ip}?fields=status,countryCode",
    ):
        try:
            response = requests.get(url, timeout=timeout)
            response.raise_for_status()
            text = response.text.strip()
            if text.startswith("{"):
                code = str(response.json().get("countryCode", "")).upper()
            else:
                code = text.upper()
            if re.fullmatch(r"[A-Z]{2}", code):
                return code
        except Exception:
            continue
    return ""


def observe_exit(proxy_url: str, timeout: float = 8.0) -> dict:
    """Exit IP and country through the proxy.

    anyIP itself verifies locations with ip-api.com (see their location
    targeting guide), so that is the primary check.  Cloudflare trace and
    ipify are fallbacks.  Never raises.
    """
    try:
        if proxy_url:
            from .proxy_support import attach

            session = requests.Session()
            attach(session, proxy_url)
        else:
            session = requests.Session()
        try:
            response = session.get(
                "http://ip-api.com/json/?fields=status,countryCode,query",
                timeout=timeout,
            )
            response.raise_for_status()
            data = response.json()
            if data.get("status") == "success" and data.get("query"):
                code = str(data.get("countryCode", "")).strip().upper()
                return {
                    "ip": str(data["query"]).strip(),
                    "countryCode": code if re.fullmatch(r"[A-Z]{2}", code) else "",
                }
        except Exception:
            pass

        try:
            response = session.get(
                "https://www.cloudflare.com/cdn-cgi/trace", timeout=timeout
            )
            response.raise_for_status()
            data = dict(
                line.split("=", 1)
                for line in response.text.splitlines()
                if "=" in line
            )
            ip = str(data.get("ip", "")).strip()
            code = str(data.get("loc", "")).strip().upper()
            if ip:
                return {
                    "ip": ip,
                    "countryCode": code if re.fullmatch(r"[A-Z]{2}", code) else "",
                }
        finally:
            session.close()
    except Exception:
        pass

    ip = observe_exit_ip(proxy_url, timeout=timeout)
    return {"ip": ip, "countryCode": country_for_ip(ip) if ip else ""}


def basic_proxy_header(url: str) -> str | None:
    """Some gateways need Proxy-Authorization before CONNECT."""
    parts = urlsplit(url)
    if not parts.username:
        return None
    token = base64.b64encode(
        f"{parts.username}:{parts.password or ''}".encode()
    ).decode()
    return f"Basic {token}"
