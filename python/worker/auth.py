"""The auth state machine, one thread per job.

The service object is created once per job and kept while 2FA is pending.
Nothing here writes to the store: results go out as Socket.IO events and Node
is the only writer.
"""

from __future__ import annotations

import json
import logging
import os
import queue
import secrets
import shutil
import threading
import time
import traceback
from pathlib import Path
from typing import Any
from urllib.parse import quote

try:
    from pyicloud import PyiCloudService
    from pyicloud.exceptions import (
        PyiCloudAccountLockedException,
        PyiCloudConnectionException,
        PyiCloudException,
        PyiCloudFailedLoginException,
    )
except Exception:  # pyicloud is optional for the non-auth parts of the worker
    PyiCloudService = None

    class PyiCloudException(Exception):
        pass

    class PyiCloudFailedLoginException(PyiCloudException):
        pass

    class PyiCloudConnectionException(PyiCloudException):
        pass

    class PyiCloudAccountLockedException(PyiCloudException):
        pass

from . import inventory, session_vault, twofa
from .proxy_countries import is_supported
from .proxy import (
    apply_proxy,
    build_proxy_url,
    country_code,
    mask_proxy_url,
    observe_exit,
    stable_ssid,
)

log = logging.getLogger("worker.auth")

# Cookies exported from the operator's browser live here.  iCloud accepts the
# browser's web-auth token, so when a session jar has lost only that cookie we
# can lift the accepted one instead of asking for another 2FA code.
BROWSER_EXPORT_ROOT = Path(
    os.environ.get("BROWSER_EXPORT_DIR") or "/opt/icloud3/session-export/browser"
)
COOKIE_SITES = ("apple.com", "icloud.com")
WEB_TOKEN = "X-APPLE-WEBAUTH-TOKEN"


class JobContext:
    def __init__(self, job_id: str, payload: dict, emitter):
        self.job_id = job_id
        self.payload = payload
        self.account = payload.get("account") or {}
        self.emitter = emitter
        self.commands: queue.Queue[dict] = queue.Queue()
        self.cancel = threading.Event()
        self.api = None
        self.proxy_url = ""
        self.proxy_ssid = ""
        self.exit_ip = ""
        self.exit_country = ""
        self.exit_matched = None
        self.requested_country = ""
        self.country_supported = None

    def emit(self, event: str, payload: dict) -> None:
        body = dict(payload)
        body.setdefault("jobId", self.job_id)
        self.emitter.send(event, body)

    def state(self, state: str, message: str = "", **extra) -> None:
        self.emit("job:state", {"state": state, "message": message, **extra})


def _service(ctx: JobContext, password: str):
    email = ctx.account.get("email", "")
    session_dir = Path(ctx.account.get("sessionDir") or "")
    if not session_dir or session_dir == Path("."):
        session_dir = Path("sessions") / stable_ssid(email)
    session_dir.mkdir(parents=True, exist_ok=True)
    try:
        session_dir.chmod(0o700)
    except OSError:
        pass
    # A jar that lost the web token but has a snapshot that still carries it is
    # recoverable without a code: put the snapshot back before Apple sees the
    # pre-2FA cookie set.
    try:
        restored = session_vault.restore_web_token(session_dir, email)
        if restored:
            log.info("restored web token from %s (%s)", restored.name, email)
    except Exception as error:
        log.info("web-token restore skipped: %s", error)
    # If the working cookie jar is gone (new node, wiped disk), restore the
    # newest verified snapshot before Apple sees a fresh browser.
    try:
        session_vault.restore_if_empty(session_dir, email)
    except Exception as error:
        log.info("session restore skipped: %s", error)
    # ``run_auth`` logs in inside a staging copy (ctx.working_dir) so a login
    # that stops at the 2FA prompt can never overwrite a working jar.
    working = Path(getattr(ctx, "working_dir", None) or session_dir)
    api = PyiCloudService(
        email,
        password,
        cookie_directory=str(working),
        authenticate=False,
        accept_terms=True,
    )
    _apply_identity(api, ctx)
    _apply_browser_cookies(api, ctx)
    return api, session_dir


def _apply_identity(api, ctx: JobContext) -> None:
    fingerprint = ctx.payload.get("fingerprint") or {}
    headers = {}
    if fingerprint.get("userAgent"):
        headers["User-Agent"] = fingerprint["userAgent"]
    if fingerprint.get("language"):
        headers["Accept-Language"] = fingerprint["language"]
    # iCloud's browser sessions answer service requests only when the caller
    # looks like the iCloud web app.  Without this header a perfectly valid
    # browser-exported web token gets 421 "Missing validate token" from Drive
    # and Photos (the "session lost" false negative).
    headers["Origin"] = "https://www.icloud.com"
    try:
        api.session.headers.update(headers)
    except Exception:
        pass


def _browser_cookies(email: str) -> list[dict]:
    """Read the Cookie-Editor export for this account, if one exists."""
    if not email:
        return []
    path = BROWSER_EXPORT_ROOT / email / "cookies.json"
    try:
        rows = json.loads(path.read_text())
    except (OSError, ValueError):
        return []
    if isinstance(rows, dict):
        rows = rows.get("cookies") or []
    return rows if isinstance(rows, list) else []


def _apply_browser_cookies(api, ctx: JobContext) -> bool:
    """Lift the browser's accepted cookies when the jar lost its web token.

    A trusted account that signed in through a browser keeps a long-lived
    X-APPLE-WEBAUTH-TOKEN in the export.  pyicloud's jar often has only the DS
    and HSA cookies, so its own status probe reports "dead" even though the
    account is fine.  Importing the export restores Drive/Photos without 2FA.
    """
    try:
        if api.session.cookies.get(WEB_TOKEN):
            return False
    except Exception:
        return False
    rows = _browser_cookies(ctx.account.get("email", ""))
    if not rows:
        return False
    imported = 0
    for row in rows:
        name = str(row.get("name") or "")
        if not name:
            continue
        domain = str(row.get("domain") or ".icloud.com")
        if not any(domain.endswith(site) for site in COOKIE_SITES):
            continue
        value = str(row.get("value") or "")
        try:
            api.session.cookies.set(
                name, value, domain=domain, path=str(row.get("path") or "/")
            )
        except Exception:
            continue
        if name in (
            "X-APPLE-DS-WEB-SESSION-TOKEN",
            "X-APPLE-WEBAUTH-TOKEN",
            "X-APPLE-WEBAUTH-HSA-TRUST",
        ):
            # X-APPLE-WEBAUTH-TOKEN is the web token Drive wants; the DS token
            # is only a fallback when the browser export did not include it.
            if name == "X-APPLE-WEBAUTH-HSA-TRUST":
                key = "trust_token"
            elif name == "X-APPLE-WEBAUTH-TOKEN":
                key = "session_token"
            else:
                key = "session_token"
            try:
                # Keep the DS/trust pair that the session file already holds: it
                # is the one /accountLogin accepts.  The browser's copies are
                # for its own login and only needed when the jar has none.
                if not api.session.data.get(key):
                    api.session.data[key] = value.strip('"')
            except Exception:
                pass
        imported += 1
    if imported:
        log.info("imported %s browser cookies for %s", imported, ctx.account.get("email"))
    return bool(imported)


def ensure_services(api, ctx: JobContext) -> dict:
    """Load the account's webservice URLs when pyicloud has none.

    A password-less (browser cookie) session has no ``api.data``; Drive and
    Photos need the per-account service hosts from it.  /accountLogin with the
    stored DS token returns them even when Apple reports the HSA challenge.
    """
    data = getattr(api, "data", None) or {}
    if data.get("webservices"):
        return data
    session_data = getattr(api.session, "data", {}) or {}
    token = session_data.get("session_token")
    if not token:
        return {}
    login = {
        "accountCountryCode": session_data.get("account_country"),
        "dsWebAuthToken": token,
        "extended_login": True,
        "trustToken": session_data.get("trust_token", ""),
    }
    try:
        response = api.session.post(f"{api._setup_endpoint}/accountLogin", json=login)
        body = response.json()
    except Exception as error:
        log.info("accountLogin failed: %s", type(error).__name__)
        return {}
    if not body.get("webservices"):
        return {}
    api.data = body
    try:
        api._update_state()
    except Exception:
        pass
    return body


def _session_token_dead(error: Exception) -> bool:
    """True when Apple says the global session/token is gone (not a blip).

    ``get_auth_status`` can keep answering "authenticated" from /validate
    while Drive and Photos return 421 "Invalid global session"; without this
    check a ping reports the account healthy and nobody re-authenticates until
    the token is unrecoverable.
    """
    if getattr(error, "code", None) == 421:
        return True
    text = str(error)
    return "421" in text or "Invalid global session" in text


def _web_expires(api) -> float:
    """Unix expiry of the web token, 0 when unknown."""
    try:
        jar = api.session.cookies
        for by_path in jar._cookies.values():
            for by_name in by_path.values():
                cookie = by_name.get(WEB_TOKEN)
                if cookie is not None:
                    return float(cookie.expires or 0)
    except Exception:
        pass
    return 0.0


REFRESH_MARGIN = 7 * 24 * 3600  # refresh a week before Apple expires it


def renew(api, ctx: JobContext) -> bool:
    """Password re-login that reuses the stored trust token (no code).

    A web token has a fixed ~30 day life and no request extends it, so the only
    way a session survives is a fresh sign-in before it expires.  When the
    original 2FA ran through this client, Apple accepts the stored trust token
    and skips the code; the result is a new 30-day token pair plus an extended
    trust token.  If the login stops at 2FA (a trust token from someone else's
    browser), the previous jar is put back untouched.
    """
    saved: list[tuple[Path, Path]] = []
    for attribute in ("session_path", "cookiejar_path"):
        path = Path(getattr(api.session, attribute, "") or "")
        if not path.is_file():
            continue
        backup = path.with_suffix(path.suffix + ".renew")
        try:
            shutil.copy2(path, backup)
            saved.append((path, backup))
        except OSError:
            pass
    try:
        api.authenticate()
    except Exception as error:
        log.info("renew failed: %s: %s", type(error).__name__, str(error)[:120])
    if _has_web(api) and not getattr(api, "requires_2fa", False):
        log.info("session renewed: %s", ctx.account.get("email", ""))
        return True
    for path, backup in saved:
        try:
            shutil.copy2(backup, path)
        except OSError:
            pass
    return False


def refresh_tokens(api, ctx: JobContext, *, force: bool = False) -> bool:
    """Mint a fresh DS/web token pair without a 2FA code.

    ``accountLogin`` with the stored ``dsWebAuthToken`` + ``trustToken``
    returns new cookies for a trusted account.  Both the DS token and the web
    token live about 30 days, so calling this on a schedule is what makes a
    session outlive Apple's expiry instead of dying with it.
    """
    if not force and _has_web(api):
        expires = _web_expires(api)
        if not expires or expires - time.time() > REFRESH_MARGIN:
            return True
    try:
        data = api.session.data or {}
        if not data.get("session_token"):
            # A browser export carries the DS token as a cookie: use it so a
            # jar-only session can still be refreshed instead of called dead.
            ds = api.session.cookies.get("X-APPLE-DS-WEB-SESSION-TOKEN")
            if ds:
                data["session_token"] = str(ds).strip('"')
        if not data.get("session_token"):
            return False
        if not data.get("trust_token"):
            trust = api.session.cookies.get("X-APPLE-WEBAUTH-HSA-TRUST")
            if trust:
                data["trust_token"] = str(trust).strip('"')
        api._authenticate_with_token(require_trust=False)
    except Exception as error:
        log.info(
            "token refresh failed: %s: %s", type(error).__name__, str(error)[:120]
        )
        return False
    return _has_web(api)


def _network_error(error: Exception | None) -> bool:
    """True when the failure says nothing about the session (proxy/timeout)."""
    if error is None:
        return False
    name = type(error).__name__
    if "Connection" in name or "Proxy" in name or "Timeout" in name:
        return True
    text = str(error).lower()
    return "proxyerror" in text or "max retries" in text or "timed out" in text


def _alive_with_fresh_token(api, ctx: JobContext) -> tuple[bool, bool, bool]:
    """Drive answered: renew the token before Apple expires it."""
    expires = _web_expires(api)
    if not expires:
        return True, True, False
    left = expires - time.time()
    if left > REFRESH_MARGIN:
        return True, True, False
    if renew(api, ctx):
        return True, True, False
    # Working right now, but Apple drops this token within a week and the
    # stored trust token cannot skip the code from here: ask for one in time.
    log.warning(
        "web token expires in %d days and needs a 2FA code: %s",
        max(0, int(left / 86400)),
        ctx.account.get("email", ""),
    )
    return True, True, True


def check_alive(api, ctx: JobContext) -> tuple[bool, bool, bool]:
    """Return (alive, trusted, limited) without demanding a /validate success.

    ``get_auth_status`` requires X-APPLE-WEBAUTH-TOKEN and a 200 from
    /validate.  A browser-minted token often validates for Drive/Photos but
    answers /validate with the HSA challenge, and a DS-only token reaches Find
    My but not Drive.  Probe the real service before calling an account dead.
    """
    trusted_hint = bool(ctx.account.get("trusted"))

    # A missing web token is not death: a password login with the stored trust
    # token mints a new one without a code when the original 2FA ran here.
    if not _has_web(api):
        if renew(api, ctx):
            return True, True, False
        refresh_tokens(api, ctx, force=True)

    if _has_web(api):
        # Check the service first: a failed /validate clears the session's
        # webservice state and can invalidate the very token we are testing.
        ensure_services(api, ctx)
        try:
            api.drive.dir()
            # A browser web token that opens Drive proves the account itself is
            # trusted; the session's own flag stays false for cookie logins.
            return _alive_with_fresh_token(api, ctx)
        except Exception as drive_error:
            # Some accounts have Drive disabled; Photos is the other proof.
            try:
                api.photos.albums["Library"]
                return _alive_with_fresh_token(api, ctx)
            except Exception as photo_error:
                if _session_token_dead(drive_error) or _session_token_dead(photo_error):
                    # /validate may still say yes, but the global session is
                    # gone: report it now so the panel can ask for a code.
                    # One password login with the stored trust token is worth
                    # trying first: an expired token is not a dead account.
                    if renew(api, ctx):
                        try:
                            api.drive.dir()
                            return True, True, False
                        except Exception:
                            pass
                    return False, trusted_hint, False

    last_error: Exception | None = None
    try:
        status = api.get_auth_status() or {}
    except Exception as error:
        last_error = error
        status = {}
    if status.get("authenticated"):
        return True, bool(status.get("trusted_session")) or trusted_hint, not _has_web(api)

    try:
        api._authenticate_with_token(require_trust=False)
        if api.data:
            return True, trusted_hint, not _has_web(api)
    except Exception as error:
        last_error = error
    if _network_error(last_error):
        # The proxy (not Apple) failed.  Keep the session instead of writing
        # "dead": the next ping will tell the truth, and a dead flag on a
        # healthy account is exactly how sessions used to get lost.
        return True, trusted_hint, False
    return False, False, False


def _set_default_timeout(api, connect: float = 20, read: float = 60) -> None:
    """Give every service call a timeout.

    A residential proxy occasionally stalls a TLS read forever.  requests has
    no default timeout, so one stalled ping would hold an auth slot for the
    life of the process and starve the whole queue.  Wrap the session's active
    adapter instead of replacing it: the proxy's retry/rotation logic stays.
    """
    try:
        adapters = getattr(api.session, "adapters", {})
        for prefix in ("https://", "http://"):
            adapter = adapters.get(prefix)
            if adapter is None or getattr(adapter, "_opencode_timeout", False):
                continue
            original = adapter.send

            def send(request, _original=original, **kwargs):
                if kwargs.get("timeout") is None:
                    kwargs["timeout"] = (connect, read)
                return _original(request, **kwargs)

            adapter.send = send
            adapter._opencode_timeout = True
    except Exception:
        pass


def _apply_proxy(api, ctx: JobContext) -> None:
    proxy = ctx.payload.get("proxy") or {}
    base = proxy.get("baseUrl") or ""
    requested = country_code(proxy.get("country"))
    fallback = country_code(proxy.get("fallbackCountry"))
    ctx.requested_country = requested
    ctx.country_supported = is_supported(requested) if requested else None
    if requested and not ctx.country_supported:
        log.info("anyIP does not list country_%s; using an any-country exit", requested)
        requested = ""
    if fallback and not is_supported(fallback):
        fallback = ""
    ssid = proxy.get("ssid") or stable_ssid(ctx.account.get("email", ""))
    trusted = bool(proxy.get("trusted"))

    def use(url: str, session: str) -> dict:
        ctx.proxy_url = url
        ctx.proxy_ssid = session
        try:
            from .proxy_support import attach as attach_proxy

            attach_proxy(api.session, url)
        except Exception:
            apply_proxy(api.session, url)
        info = observe_exit(url, timeout=12)
        ctx.exit_ip = info.get("ip", "")
        ctx.exit_country = info.get("countryCode", "")
        ctx.exit_matched = (
            bool(ctx.exit_country and requested == ctx.exit_country)
            if requested and ctx.exit_country
            else None
        )
        return info

    url = build_proxy_url(
        base,
        country=requested,
        ssid=ssid,
        fallback_country=fallback,
    )
    info = use(url, ssid)

    # The victim's country first.  If this exit is in another country (the
    # provider silently ignores country_XX or has no peer), retry with a fresh
    # session in the requested country, then fall back to the configured
    # fallback or to any exit.  A trusted session keeps its existing exit:
    # Apple's trust token is bound to that IP.  The real exit country is
    # always reported to the panel/Telegram.
    if requested and not trusted and (not ctx.exit_country or ctx.exit_country != requested):
        targets = []
        if ctx.exit_country:
            # A fresh session sometimes escapes a sticky wrong-country peer.
            targets.append(requested)
        if fallback and fallback != requested:
            targets.append(fallback)
        targets.append("")

        selected = False
        for index, target in enumerate(targets):
            # A wrong-country sticky peer can poison the original session
            # name; use a fresh random session for fallback/any exits.
            if target == requested and ctx.exit_country:
                alt_ssid = ssid
                attempt = 1
            else:
                alt_ssid = f"{ssid}{secrets.token_hex(3)}"[:32]
                attempt = 0
            alternate = build_proxy_url(
                base,
                country=target,
                ssid=alt_ssid,
                attempt=attempt,
            )
            if not alternate or alternate == url:
                continue
            alternate_info = use(alternate, f"{alt_ssid}{attempt}" if attempt else alt_ssid)
            if not alternate_info.get("ip"):
                continue
            selected = True
            log.info(
                "proxy country fallback: requested=%s actual=%s (target=%s)",
                requested,
                ctx.exit_country or "unknown",
                target or "any",
            )
            if target == requested and ctx.exit_country == requested:
                break
            # A fallback/any exit is the last resort.
            if target != requested:
                break

        if not selected:
            # No alternate answered; keep the country-tagged URL and let the
            # gateway's own retry logic pick a peer.
            use(url, ssid)

    if url and not ctx.exit_ip and not ctx.exit_country:
        log.info("proxy exit unknown; keeping the configured country tag")
    log.info(
        "proxy %s exit=%s country=%s matched=%s",
        mask_proxy_url(ctx.proxy_url),
        ctx.exit_ip or "unknown",
        ctx.exit_country or "unknown",
        ctx.exit_matched,
    )
    _set_default_timeout(api)


def _proxy_info(ctx: JobContext) -> dict:
    return {
        "country": (ctx.payload.get("proxy") or {}).get("country", ""),
        "requestedCountry": ctx.requested_country,
        "supported": ctx.country_supported,
        "replacedCountry": (
            ctx.exit_country if ctx.country_supported is False else ""
        ),
        "exitIp": ctx.exit_ip,
        "exitCountry": ctx.exit_country,
        "matched": ctx.exit_matched,
        "urlMasked": mask_proxy_url(ctx.proxy_url),
        "ssid": ctx.proxy_ssid
        or (ctx.payload.get("proxy") or {}).get("ssid", ""),
    }


def _result_with_proxy(ctx: JobContext, payload: dict) -> dict:
    body = dict(payload)
    account = dict(body.get("account") or {})
    account["proxy"] = _proxy_info(ctx)
    body["account"] = account
    return body


def _backup(session_dir: Path) -> dict[str, Path]:
    saved = {}
    for pattern in ("*.session", "*.cookiejar"):
        for source in session_dir.glob(pattern):
            target = source.with_suffix(source.suffix + ".bak")
            try:
                shutil.copy2(source, target)
                saved[str(source)] = target
            except OSError:
                pass
    return saved


def _restore(saved: dict[str, Path]) -> None:
    for source, backup in saved.items():
        try:
            if backup.exists():
                shutil.copy2(backup, source)
        except OSError:
            pass


def _stage_login(session_dir: Path) -> Path:
    """Copy the session into a scratch dir so the login writes only there.

    Apple rotates its cookies on every password login.  A login that stops at
    the 2FA prompt therefore replaces a working jar with a pre-2FA one and the
    web token is gone, although the hoster never got a code.  Logging in inside
    ``<session>/.login`` and promoting the result only when the token pair is
    present makes the login atomic: a timeout, a closed tab or a crash leaves
    the live jar exactly as it was.
    """
    stage = session_dir / ".login"
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir(parents=True, exist_ok=True)
    for pattern in ("*.session", "*.cookiejar"):
        for source in session_dir.glob(pattern):
            try:
                shutil.copy2(source, stage / source.name)
            except OSError:
                pass
    return stage


def _promote(stage: Path | str | None, session_dir: Path | str) -> bool:
    """Replace the live jar/session with a completed login's copy."""
    if not stage:
        return False
    stage, session_dir = Path(stage), Path(session_dir)
    if not any(stage.glob("*.cookiejar")):
        return False
    ok = True
    for pattern in ("*.session", "*.cookiejar"):
        for source in stage.glob(pattern):
            target = session_dir / source.name
            temporary = target.with_suffix(target.suffix + ".new")
            try:
                shutil.copy2(source, temporary)
                os.replace(temporary, target)
            except OSError as error:
                log.warning("could not promote %s: %s", target.name, error)
                ok = False
    return ok


def _promote_staged(ctx: JobContext) -> None:
    stage = getattr(ctx, "working_dir", None)
    if not stage:
        return
    session_dir = Path(ctx.account.get("sessionDir") or "")
    if session_dir and session_dir != Path(".") and _promote(stage, session_dir):
        log.info("login promoted to %s", session_dir.name)


def _has_web(api) -> bool:
    try:
        return bool(api.session.cookies.get(WEB_TOKEN))
    except Exception:
        return False


def _web_expires(api) -> float:
    """Unix expiry of the web token, 0 when unknown."""
    try:
        for cookie in api.session.cookies:
            if getattr(cookie, "name", "") == WEB_TOKEN:
                return float(getattr(cookie, "expires", 0) or 0)
    except Exception:
        pass
    return 0.0


UNLOCK_URL = (
    "https://iforgot.apple.com/password/verify/appleid"
    "?returnUrl=https%3A%2F%2Fwww.icloud.com%2F"
    "&prs_account_nm={email}&unlock=true"
)


def _locked_payload(account: dict, error: Exception) -> dict:
    """One shape for a locked account, whatever layer caught it."""
    code = str(getattr(error, "code", "") or "")
    email = str(account.get("email") or "")
    log.warning("Apple Account locked: %s (code %s)", email, code or "unknown")
    return {
        "status": "error",
        "reason": "locked",
        "code": code,
        "unlockUrl": UNLOCK_URL.format(email=quote(email, safe="")),
        "message": (
            "This Apple Account has been locked for security reasons. "
            "Unlock it at iforgot.apple.com, then try again."
        ),
    }


def _authenticate(api, ctx: JobContext):
    """Full password login with one retry for a network/5xx answer."""
    try:
        api.authenticate()
        return api
    except TypeError:
        # The anyIP tunnel raises TypeError when its CONNECT fails
        # ("expected string or bytes-like object" in urllib3 _tunnel).  The
        # password is fine and the cookie is valid from any IP, so drop the
        # proxy and log in directly instead of failing the whole submission.
        ctx.state("auth", "Proxy tunnel failed, logging in directly")
        try:
            api.session.proxies = {}
        except Exception:  # noqa: BLE001
            pass
        api.authenticate()
        return api
    except PyiCloudConnectionException:
        ctx.state("auth", "Retrying the connection")
        raise


def _send_default(api, options: list[dict], ctx: JobContext) -> str:
    choice = twofa.default_choice(options)
    option = twofa.option_by_id(options, choice) or {}
    try:
        notice = twofa.switch_delivery(api, option)
    except Exception as error:
        detail = twofa.describe_error(error)
        log.warning("2FA send failed: %s", detail)
        notice = f"Apple did not send a code: {detail}"
    method = option.get("kind", "trusted_device")
    ctx.emit(
        "job:2fa",
        {
            "method": method,
            "options": options,
            "notice": notice,
            "choiceId": choice,
        },
    )
    return choice


def _handle_hsa2(api, ctx: JobContext) -> bool:
    options = twofa.delivery_options(api)
    choice = _send_default(api, options, ctx)
    chosen = twofa.option_by_id(options, choice)
    if chosen and chosen.get("kind") == "security_key":
        return _handle_security_key(api, ctx, chosen)
    attempts = 0
    while attempts < 3:
        if ctx.cancel.is_set():
            return False
        email = ctx.account.get("email", "")
        try:
            command = ctx.commands.get(timeout=600)
        except queue.Empty:
            log.info("2fa timed out waiting for a code: %s", email)
            ctx.state("twofa", "The code timed out")
            return False
        action = command.get("action", "submit")
        if action == "switch":
            target = twofa.option_by_id(options, command.get("choiceId", ""))
            previous = twofa.option_by_id(options, command.get("fromChoiceId", "")) or {}
            if target:
                if target.get("kind") == "security_key":
                    return _handle_security_key(api, ctx, target)
                try:
                    notice = twofa.switch_delivery(api, target)
                except Exception as error:
                    notice = f"Switch failed: {twofa.describe_error(error)}"
                choice = target["id"]
                ctx.emit(
                    "job:2fa",
                    {
                        "method": target.get("kind", "trusted_device"),
                        "options": options,
                        "notice": notice,
                        "choiceId": choice,
                        "switchedFrom": previous.get("label", ""),
                        "switchedTo": target.get("label", ""),
                    },
                )
            continue
        if action == "resend":
            target = twofa.option_by_id(options, command.get("choiceId", "") or choice)
            try:
                notice = twofa.switch_delivery(api, target or {})
            except Exception as error:
                notice = f"Resend failed: {twofa.describe_error(error)}"
            ctx.emit(
                "job:2fa",
                {
                    "method": (target or {}).get("kind", "trusted_device"),
                    "options": options,
                    "notice": notice,
                    "choiceId": choice,
                },
            )
            continue
        if action == "submit":
            code = str(command.get("code", "")).strip()
            if not code:
                continue
            accepted, matched = twofa.submit_code_any(api, code, options, choice)
            if accepted:
                log.info("2fa accepted: %s via %s", ctx.account.get("email", ""), matched or choice)
                trusted = twofa.ensure_trusted(api)
                label = next(
                    (o.get("label") for o in options if o.get("id") == matched),
                    "",
                )
                ctx.state(
                    "connected",
                    (
                        f"Code accepted via {label}"
                        if trusted and label
                        else "Code accepted"
                        if trusted
                        else "Code accepted; trust was not confirmed"
                    ),
                    trusted=trusted,
                )
                return True
            attempts += 1
            log.info(
                "2fa code rejected: %s (%d/3, choice %s)",
                ctx.account.get("email", ""),
                attempts,
                choice,
            )
            ctx.state("twofa", f"Code not accepted ({attempts}/3)")
            if attempts >= 3:
                return False
    return False


def _handle_2sa(api, ctx: JobContext) -> bool:
    options = twofa.legacy_options(api)
    choice = options[0]["id"] if options else ""
    if choice:
        try:
            label = twofa.send_legacy(api, choice)
        except Exception as error:
            label = f"Could not send: {twofa.describe_error(error)}"
        ctx.emit(
            "job:2fa",
            {
                "method": "legacy_device",
                "options": options,
                "notice": f"Code sent to {label}",
                "choiceId": choice,
            },
        )
    for _ in range(3):
        try:
            command = ctx.commands.get(timeout=600)
        except queue.Empty:
            return False
        if command.get("action") == "switch":
            choice = command.get("choiceId") or choice
            try:
                label = twofa.send_legacy(api, choice)
            except Exception as error:
                label = f"Could not send: {twofa.describe_error(error)}"
            ctx.emit(
                "job:2fa",
                {
                    "method": "legacy_device",
                    "options": options,
                    "notice": f"Code sent to {label}",
                    "choiceId": choice,
                },
            )
            continue
        if command.get("action") == "resend":
            try:
                label = twofa.send_legacy(api, choice)
            except Exception as error:
                label = f"Could not send: {twofa.describe_error(error)}"
            ctx.emit(
                "job:2fa",
                {
                    "method": "legacy_device",
                    "options": options,
                    "notice": f"Code sent to {label}",
                    "choiceId": choice,
                },
            )
            continue
        if twofa.validate_legacy(api, choice, str(command.get("code", ""))):
            ctx.state("connected", "Code accepted")
            return True
        ctx.state("twofa", "Code not accepted")
    return False


def _handle_security_key(api, ctx: JobContext, option: dict) -> bool:
    ctx.emit(
        "job:2fa",
        {
            "method": "security_key",
            "options": twofa.delivery_options(api),
            "notice": "Touch your security key",
            "choiceId": option["id"],
        },
    )
    try:
        command = ctx.commands.get(timeout=300)
    except queue.Empty:
        return False
    if command.get("action") != "submit":
        return False
    try:
        devices = list(getattr(api, "fido2_devices", None) or [])
        try:
            index = int(option["id"].split(":", 1)[1])
        except (IndexError, ValueError):
            index = 0
        if not devices:
            ctx.state("twofa", "Apple did not expose a security key")
            return False
        api.confirm_security_key(devices[min(index, len(devices) - 1)])
        trusted = twofa.ensure_trusted(api)
        ctx.state("connected", "Security key accepted", trusted=trusted)
        return True
    except Exception as error:
        ctx.state("twofa", f"Security key failed: {type(error).__name__}")
        return False


def run_auth(ctx: JobContext) -> None:
    account = ctx.account
    email = account.get("email", "")
    password = account.get("password", "")
    ctx.state("auth", "Preparing a private session")
    if PyiCloudService is None:
        ctx.emit("job:error", {"error": "pyicloud is not installed"})
        return

    try:
        api, session_dir = _service(ctx, password)
    except Exception as error:
        ctx.emit("job:error", {"error": f"Could not create a session: {type(error).__name__}"})
        return
    ctx.api = api
    saved = _backup(session_dir)

    try:
        _apply_proxy(api, ctx)
        ctx.state("auth", "Checking the saved session")
        try:
            status = api.get_auth_status() or {}
        except Exception:
            status = {}  # a 421/expired token simply means: do the full login
        if status.get("authenticated") and status.get("trusted_session"):
            ctx.state("connected", "Already connected", reused=True, trusted=True)
            _finish(ctx, api, reused=True)
            return

        # Apple rotates its cookies on a password login, so a login that stops
        # at the 2FA prompt would replace a working jar with a pre-2FA one.
        # Do it in a copy and promote only the finished result.
        ctx.working_dir = _stage_login(session_dir)
        api, session_dir = _service(ctx, password)
        ctx.api = api
        _apply_proxy(api, ctx)

        ctx.state("auth", "Signing in")
        for attempt in range(2):
            try:
                _authenticate(api, ctx)
                break
            except PyiCloudConnectionException:
                if attempt == 1:
                    raise
                ctx.state("auth", "Retrying the connection")
                ctx.working_dir = _stage_login(session_dir)
                api, session_dir = _service(ctx, password)
                ctx.api = api
                _apply_proxy(api, ctx)
            except PyiCloudAccountLockedException as error:
                ctx.emit("job:result", _result_with_proxy(ctx, _locked_payload(ctx.account, error)))
                _restore(saved)
                return
            except PyiCloudFailedLoginException:
                ctx.emit("job:result", _result_with_proxy(ctx, {"status": "invalid", "message": "Incorrect Apple Account or password."}))
                _restore(saved)
                return
            except PyiCloudException as error:
                ctx.emit("job:result", _result_with_proxy(ctx, {"status": "error", "message": type(error).__name__}))
                _restore(saved)
                return

        ok = False
        if getattr(api, "requires_2fa", False):
            ctx.state("twofa", "Two-factor authentication required")
            options = twofa.delivery_options(api)
            security = next((o for o in options if o.get("kind") == "security_key" and o.get("active")), None)
            if security and not any(o.get("kind") == "sms" for o in options):
                ok = _handle_security_key(api, ctx, security)
            else:
                ok = _handle_hsa2(api, ctx)
        elif getattr(api, "requires_2sa", False):
            ctx.state("twofa", "Two-step verification required")
            ok = _handle_2sa(api, ctx)
        else:
            ok = True

        if not ok:
            ctx.emit("job:result", _result_with_proxy(ctx, {"status": "error", "message": "Verification was not completed."}))
            _restore(saved)
            return

        if not getattr(api, "is_trusted_session", False):
            trusted = twofa.ensure_trusted(api)
        else:
            trusted = True

        # Never promote a login that has no web token: it would erase the only
        # cookie Drive accepts.  accountLogin with the new session is the last
        # chance to mint it.
        if not _has_web(api):
            refresh_tokens(api, ctx, force=True)

        _finish(ctx, api, reused=False, trusted=trusted)
    except PyiCloudAccountLockedException as error:
        ctx.emit("job:result", _result_with_proxy(ctx, _locked_payload(ctx.account, error)))
        _restore(saved)
    except Exception as error:
        # The panel shows this name to the client, so keep it to the exception
        # class, but log the whole traceback: a bare "TypeError" is impossible
        # to act on.
        log.warning("auth failed: %s: %s\n%s", type(error).__name__, str(error)[:300],
                    traceback.format_exc())
        ctx.emit("job:result", _result_with_proxy(ctx, {"status": "error", "message": type(error).__name__}))
        _restore(saved)
    finally:
        stage = getattr(ctx, "working_dir", None)
        ctx.working_dir = None
        if stage:
            shutil.rmtree(stage, ignore_errors=True)


def _finish(ctx: JobContext, api, *, reused: bool, trusted: bool | None = None) -> None:
    account = {
        "trusted": bool(trusted) if trusted is not None else bool(getattr(api, "is_trusted_session", False)),
        "sessionDir": ctx.account.get("sessionDir", ""),
        "proxy": _proxy_info(ctx),
    }
    # A session without the web token authenticates but cannot read Drive.
    # Say so in the result so the pool files it as "twofa", not "connected".
    limited = not _has_web(api)
    if limited:
        log.warning("auth finished without a web token: %s", ctx.account.get("email", ""))
    ctx.emit(
        "job:result",
        {
            "status": "ok",
            "message": "Already connected" if reused else "Signed in",
            "limited": limited,
            "account": account,
        },
    )
    # The login ran in a staging dir: copy the finished jar/session back before
    # the snapshot, otherwise the vault would store the pre-login state.
    _promote_staged(ctx)
    try:
        from .proxy import stable_ssid
        session_dir = Path(ctx.account.get("sessionDir") or "")
        if not session_dir or session_dir == Path("."):
            session_dir = Path("sessions") / stable_ssid(ctx.account.get("email", ""))
        session_vault.snapshot(session_dir, ctx.account.get("email", ""))
    except Exception as error:
        log.info("session snapshot skipped: %s", error)
    try:
        info = inventory.collect(api)
        ctx.emit("job:account_info", info)
    except Exception as error:
        log.info("inventory skipped: %s", type(error).__name__)
    # inventory hits the services and refreshes their per-service cookies, so
    # promote once more and keep that richer jar in the vault too.
    _promote_staged(ctx)
    try:
        session_vault.snapshot(session_dir, ctx.account.get("email", ""))
    except Exception:
        pass
