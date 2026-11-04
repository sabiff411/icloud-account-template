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


def basic_proxy_header(url: str) -> str | None:
    """Some gateways need Proxy-Authorization before CONNECT."""
    parts = urlsplit(url)
    if not parts.username:
        return None
    token = base64.b64encode(
        f"{parts.username}:{parts.password or ''}".encode()
    ).decode()
    return f"Basic {token}"
