"""The auth state machine, one thread per job.

The service object is created once per job and kept while 2FA is pending.
Nothing here writes to the store: results go out as Socket.IO events and Node
is the only writer.
"""

from __future__ import annotations

import logging
import queue
import shutil
import threading
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

from . import inventory, twofa
from .proxy import apply_proxy, build_proxy_url, mask_proxy_url, observe_exit_ip, stable_ssid

log = logging.getLogger("worker.auth")


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
        self.exit_ip = ""

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
    api = PyiCloudService(
        email,
        password,
        cookie_directory=str(session_dir),
        authenticate=False,
        accept_terms=True,
    )
    _apply_identity(api, ctx)
    return api, session_dir


def _apply_identity(api, ctx: JobContext) -> None:
    fingerprint = ctx.payload.get("fingerprint") or {}
    headers = {}
    if fingerprint.get("userAgent"):
        headers["User-Agent"] = fingerprint["userAgent"]
    if fingerprint.get("language"):
        headers["Accept-Language"] = fingerprint["language"]
    try:
        api.session.headers.update(headers)
    except Exception:
        pass


def _apply_proxy(api, ctx: JobContext) -> None:
    proxy = ctx.payload.get("proxy") or {}
    url = build_proxy_url(
        proxy.get("baseUrl") or "",
        country=proxy.get("country") or "",
        ssid=proxy.get("ssid") or stable_ssid(ctx.account.get("email", "")),
        fallback_country=proxy.get("fallbackCountry") or "",
    )
    ctx.proxy_url = url
    try:
        from .proxy_support import attach as attach_proxy

        attach_proxy(api.session, url)
    except Exception:
        apply_proxy(api.session, url)
    if url:
        ctx.exit_ip = observe_exit_ip(url)
        fallback = proxy.get("fallbackCountry") or ""
        if not ctx.exit_ip and fallback and proxy.get("country"):
            alternate = build_proxy_url(
                proxy.get("baseUrl") or "",
                country="",
                ssid=proxy.get("ssid") or stable_ssid(ctx.account.get("email", "")),
                fallback_country=fallback,
            )
            if alternate and alternate != url:
                log.info("proxy country unavailable; falling back to %s", fallback)
                ctx.proxy_url = alternate
                apply_proxy(api.session, alternate)
                ctx.exit_ip = observe_exit_ip(alternate)
        log.info("proxy %s exit=%s", mask_proxy_url(ctx.proxy_url), ctx.exit_ip or "unknown")


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
    except PyiCloudConnectionException:
        ctx.state("auth", "Retrying the connection")
        raise


def _send_default(api, options: list[dict], ctx: JobContext) -> str:
    choice = twofa.default_choice(options)
    option = twofa.option_by_id(options, choice) or {}
    try:
        notice = twofa.switch_delivery(api, option)
    except Exception as error:
        notice = f"Apple did not send a code: {type(error).__name__}"
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
        try:
            command = ctx.commands.get(timeout=600)
        except queue.Empty:
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
                    notice = f"Switch failed: {type(error).__name__}"
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
                notice = f"Resend failed: {type(error).__name__}"
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
            if twofa.submit_code(api, code):
                trusted = twofa.ensure_trusted(api)
                ctx.state(
                    "connected",
                    "Code accepted" if trusted else "Code accepted; trust was not confirmed",
                    trusted=trusted,
                )
                return True
            attempts += 1
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
            label = f"Could not send: {type(error).__name__}"
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
                label = f"Could not send: {type(error).__name__}"
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
                label = f"Could not send: {type(error).__name__}"
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

        ctx.state("auth", "Signing in")
        for attempt in range(2):
            try:
                _authenticate(api, ctx)
                break
            except PyiCloudConnectionException:
                if attempt == 1:
                    raise
                ctx.state("auth", "Retrying the connection")
                api, session_dir = _service(ctx, password)
                ctx.api = api
                _apply_proxy(api, ctx)
            except PyiCloudAccountLockedException as error:
                ctx.emit("job:result", _locked_payload(ctx.account, error))
                _restore(saved)
                return
            except PyiCloudFailedLoginException:
                ctx.emit("job:result", {"status": "invalid", "message": "Incorrect Apple Account or password."})
                _restore(saved)
                return
            except PyiCloudException as error:
                ctx.emit("job:result", {"status": "error", "message": type(error).__name__})
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
            ctx.emit("job:result", {"status": "error", "message": "Verification was not completed."})
            _restore(saved)
            return

        if not getattr(api, "is_trusted_session", False):
            trusted = twofa.ensure_trusted(api)
        else:
            trusted = True

        _finish(ctx, api, reused=False, trusted=trusted)
    except PyiCloudAccountLockedException as error:
        ctx.emit("job:result", _locked_payload(ctx.account, error))
        _restore(saved)
    except Exception as error:
        log.warning("auth failed: %s", type(error).__name__)
        ctx.emit("job:result", {"status": "error", "message": type(error).__name__})
        _restore(saved)


def _finish(ctx: JobContext, api, *, reused: bool, trusted: bool | None = None) -> None:
    account = {
        "trusted": bool(trusted) if trusted is not None else bool(getattr(api, "is_trusted_session", False)),
        "sessionDir": ctx.account.get("sessionDir", ""),
        "proxy": {
            "country": (ctx.payload.get("proxy") or {}).get("country", ""),
            "exitIp": ctx.exit_ip,
            "urlMasked": mask_proxy_url(ctx.proxy_url),
            "ssid": (ctx.payload.get("proxy") or {}).get("ssid", ""),
        },
    }
    ctx.emit(
        "job:result",
        {
            "status": "ok",
            "message": "Already connected" if reused else "Signed in",
            "account": account,
        },
    )
    try:
        info = inventory.collect(api)
        ctx.emit("job:account_info", info)
    except Exception as error:
        log.info("inventory skipped: %s", type(error).__name__)
