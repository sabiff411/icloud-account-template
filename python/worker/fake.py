"""A fake pyicloud service for local end-to-end runs without an Apple ID.

Enable with WORKER_FAKE=1. It speaks the same auth/2FA surface the real
worker uses, so the Node protocol, UI and bot can be exercised end to end.
"""

from __future__ import annotations


class FakeSession:
    def __init__(self):
        self.headers = {}
        self.proxies = {}


class FakeService:
    def __init__(self, email, password, cookie_directory=None, authenticate=True, **_kw):
        self.email = email
        self.password = password
        self.cookie_directory = cookie_directory
        self.session = FakeSession()
        self.requires_2fa = "2fa" in email.lower()
        self.requires_2sa = False
        self.is_trusted_session = (
            "reuse" in email.lower()
            or ("invalid" not in email.lower() and "2fa" not in email.lower())
        )
        self.two_factor_delivery_method = "sms" if self.requires_2fa else "trusted_device"
        self.two_factor_delivery_notice = ""
        self.security_key_names = []
        self.fido2_devices = []
        self.trusted_devices = []
        self._two_factor_code_requested = False
        self._sms_throttled = False
        self._auth_endpoint = "https://fake.invalid/auth"
        self._auth_data = {
            "trustedPhoneNumbers": [
                {"numberWithDialCode": "+1 (555) 123-4567", "pushMode": "sms"}
            ]
        }

    def get_auth_status(self):
        return {
            "authenticated": self.is_trusted_session,
            "trusted_session": self.is_trusted_session,
            "requires_2fa": self.requires_2fa,
        }

    def authenticate(self):
        if "invalid" in self.email.lower():
            from pyicloud.exceptions import PyiCloudFailedLoginException

            raise PyiCloudFailedLoginException("fake bad password")
        self.requires_2fa = "2fa" in self.email.lower()
        if not self.requires_2fa:
            self.is_trusted_session = True

    def trust_session(self):
        self.is_trusted_session = True
        return True

    def validate_2fa_code(self, code):
        return str(code).strip() == "123456"

    def _get_auth_headers(self, overrides=None):
        return dict(overrides or {})

    def _request_sms_2fa_code(self, notice=""):
        self.two_factor_delivery_notice = notice
        self._two_factor_code_requested = True
        return True

    def _set_two_factor_delivery_state(self, method, notice):
        self.two_factor_delivery_method = method
        self.two_factor_delivery_notice = notice

    def use_existing_trusted_device_code(self):
        self._two_factor_code_requested = True


def fake_inventory(api):
    return {
        "identity": {
            "name": "Fake Person",
            "phone": "+1 ••• ••• 4567",
            "plan": {"featureKey": "icloud.plus"},
            "storage": {"used": 42_000_000_000, "total": 200_000_000_000},
            "family": ["Alex"],
            "devices": ["iPhone"],
        },
        "counts": {
            "photos": 1234,
            "hidden": 12,
            "deleted": 3,
            "notes": 41,
            "contacts": 88,
            "contactsPhone": 40,
            "contactsEmail": 60,
            "driveFiles": 120,
            "driveBytes": 8_000_000,
            "reminders": 9,
            "calendars": 2,
            "albums": 6,
        },
    }
