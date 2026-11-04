"""2FA / 2SA discovery, masking and delivery switching.

Apple's HSA2 payload is the source of truth.  Public properties cover the
active method; the trusted-phone list is only exposed by the verify/phone
call (measured on 2026.10.1), so the private call is used deliberately and
every use is guarded.
"""

from __future__ import annotations

import re
from typing import Any

try:
    from pyicloud.exceptions import PyiCloudAPIResponseException
except Exception:  # allows the pure helpers to be tested without pyicloud

    class PyiCloudAPIResponseException(Exception):
        response = None


def mask_phone(value: Any) -> str:
    raw = str(value or "").strip()
    digits = re.sub(r"\D", "", raw)
    last4 = digits[-4:] if len(digits) >= 4 else "••••"
    match = re.match(r"\+(\d{1,3})", raw)
    if match:
        return f"+{match.group(1)} ••• ••• {last4}"
    return f"••• ••• {last4}"


def _raw_phones(api) -> list[dict]:
    data = getattr(api, "_auth_data", {}) or {}
    phones = data.get("trustedPhoneNumbers") or []
    if not phones:
        phones = (data.get("phoneNumberVerification") or {}).get("trustedPhoneNumbers") or []
    return [p for p in phones if isinstance(p, dict)]


def challenge_phones(api) -> list[dict]:
    """Read the phone challenge Apple only exposes via verify/phone."""
    endpoint = getattr(api, "_auth_endpoint", "")
    if not endpoint:
        return []
    try:
        headers = api._get_auth_headers({"Accept": "application/json"})
        response = api.session.put(
            f"{endpoint}/verify/phone", json={"mode": "sms"}, headers=headers
        )
        body = response.json()
    except PyiCloudAPIResponseException as error:
        try:
            body = error.response.json()
        except Exception:
            return []
    except Exception:
        return []
    if not isinstance(body, dict):
        return []
    phones = body.get("trustedPhoneNumbers") or []
    if not phones and isinstance(body.get("trustedPhoneNumber"), dict):
        phones = [body["trustedPhoneNumber"]]
    return [p for p in phones if isinstance(p, dict)]


def trusted_phones(api) -> list[dict]:
    return _raw_phones(api) or challenge_phones(api)


def delivery_options(api) -> list[dict]:
    """Options for the picker. Only masked numbers leave the worker."""
    options: list[dict] = []
    method = getattr(api, "two_factor_delivery_method", "unknown") or "unknown"
    notice = getattr(api, "two_factor_delivery_notice", "") or ""
    options.append(
        {
            "id": "trusted_device",
            "kind": "trusted_device",
            "label": "Trusted device",
            "detail": notice or "Enter the code shown on your devices",
            "active": method == "trusted_device",
        }
    )
    for index, phone in enumerate(trusted_phones(api)[:8]):
        number = (
            phone.get("numberWithDialCode")
            or phone.get("obfuscatedNumber")
            or phone.get("maskedNumber")
            or ""
        )
        options.append(
            {
                "id": f"sms:{index}",
                "kind": "sms",
                "label": mask_phone(number),
                "detail": "Text message",
                "active": method == "sms" and index == 0,
            }
        )
    names = list(getattr(api, "security_key_names", None) or [])
    for index, name in enumerate(names[:4]):
        options.append(
            {
                "id": f"security_key:{index}",
                "kind": "security_key",
                "label": str(name or "Security key"),
                "detail": "Physical security key",
                "active": method == "security_key",
            }
        )
    if not any(o["active"] for o in options) and options:
        options[0]["active"] = True
    return options


def default_choice(options: list[dict]) -> str:
    for option in options:
        if option.get("active"):
            return option["id"]
    return options[0]["id"] if options else "trusted_device"


def option_by_id(options: list[dict], choice_id: str) -> dict | None:
    for option in options:
        if option["id"] == choice_id:
            return option
    return None


def force_sms(api, choice_id: str) -> str:
    """Send the code to the chosen trusted phone (the verify/phone path)."""
    try:
        index = int(str(choice_id).split(":", 1)[1])
    except (IndexError, ValueError):
        index = 0
    phones = trusted_phones(api)
    if not phones:
        raise RuntimeError("Apple offered no trusted phone number")
    phone = phones[min(index, len(phones) - 1)]
    label = mask_phone(
        phone.get("numberWithDialCode")
        or phone.get("obfuscatedNumber")
        or phone.get("maskedNumber")
    )
    verification = api._auth_data.setdefault("phoneNumberVerification", {})
    verification["trustedPhoneNumbers"] = [phone]
    api._auth_data["trustedPhoneNumber"] = phone
    api._auth_data["mode"] = phone.get("pushMode") or "sms"
    api._sms_throttled = False
    try:
        api._request_sms_2fa_code(notice=f"SMS to {label}")
    except PyiCloudAPIResponseException as error:
        text = ""
        try:
            text = (error.response.text if error.response is not None else "") or str(error)
        except Exception:
            text = str(error)
        if "-22981" not in text and "too many" not in text.lower():
            raise
        api._sms_throttled = True
        api._set_two_factor_delivery_state("sms", f"SMS to {label}")
        api._two_factor_code_requested = True
    return label


def switch_delivery(api, option: dict) -> str:
    """Switch the active delivery; returns a human notice."""
    kind = option.get("kind")
    if kind == "sms":
        label = force_sms(api, option["id"])
        return f"Code sent to {label}"
    if kind == "trusted_device":
        try:
            if hasattr(api, "use_existing_trusted_device_code"):
                api.use_existing_trusted_device_code()
        except Exception:
            pass
        try:
            api.request_2fa_code()
        except Exception:
            pass
        return "Check the code shown on your trusted devices"
    if kind == "security_key":
        return "Use your security key"
    return "Choose a delivery method"


def submit_code(api, code: str) -> bool:
    code = str(code or "").strip()
    if not code:
        return False
    try:
        return bool(api.validate_2fa_code(code))
    except PyiCloudAPIResponseException as error:
        # 409/412 repair answers can arrive for a correct code on some releases.
        text = ""
        try:
            text = error.response.text if error.response is not None else ""
        except Exception:
            text = str(error)
        if "409" in text or "412" in text:
            try:
                return bool(api.validate_2fa_code(code))
            except Exception:
                return False
        return False


def ensure_trusted(api) -> bool:
    if getattr(api, "is_trusted_session", False):
        return True
    try:
        return bool(api.trust_session())
    except Exception:
        return False


# ---------------------------------------------------------------- legacy 2SA


def legacy_options(api) -> list[dict]:
    options = []
    for index, device in enumerate(getattr(api, "trusted_devices", None) or []):
        name = device.get("deviceName") if isinstance(device, dict) else ""
        phone = device.get("phoneNumber") if isinstance(device, dict) else ""
        label = name or mask_phone(phone) or f"Device {index + 1}"
        options.append(
            {
                "id": f"2sa:{index}",
                "kind": "legacy_device",
                "label": str(label),
                "detail": mask_phone(phone) if phone else "Two-step verification",
                "active": index == 0,
            }
        )
    return options


def send_legacy(api, choice_id: str) -> str:
    devices = getattr(api, "trusted_devices", None) or []
    try:
        index = int(str(choice_id).split(":", 1)[1])
    except (IndexError, ValueError):
        index = 0
    if not devices:
        raise RuntimeError("no legacy trusted devices")
    device = devices[min(index, len(devices) - 1)]
    api.send_verification_code(device)
    if isinstance(device, dict):
        return str(device.get("deviceName") or mask_phone(device.get("phoneNumber")))
    return "trusted device"


def validate_legacy(api, choice_id: str, code: str) -> bool:
    devices = getattr(api, "trusted_devices", None) or []
    try:
        index = int(str(choice_id).split(":", 1)[1])
    except (IndexError, ValueError):
        index = 0
    if not devices:
        return False
    return bool(
        api.validate_verification_code(devices[min(index, len(devices) - 1)], code)
    )
