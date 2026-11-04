"""A fake pyicloud service for local end-to-end runs without an Apple ID.

Enable with WORKER_FAKE=1. It speaks the same auth/2FA surface the real
worker uses, so the Node protocol, UI and bot can be exercised end to end.
"""

from __future__ import annotations


class _Asset:
    def __init__(self, asset_id):
        self.id = asset_id
        self.size = 1024


class _Album:
    def __init__(self, ids):
        self._items = [_Asset(value) for value in ids]

    def __iter__(self):
        return iter(self._items)


class _Notes:
    class _Summary:
        def __init__(self, value):
            self.id = value
            self.title = f"note-{value}"
            self.is_deleted = False

    def iter_all(self):
        return [self._Summary("note-1"), self._Summary("note-2")]


class _DriveChild:
    def __init__(self, name, size=1024):
        self.name = name
        self.size = size
        self.type = "file"

    def get_children(self):
        return []


class _DriveRoot:
    def get_children(self):
        return [_DriveChild("report.txt", 300), _DriveChild("photo.jpg", 2048)]


class _Drive:
    def __init__(self):
        self.root = _DriveRoot()


class _Contacts:
    all = [{"first_name": "A"}, {"first_name": "B"}, {"first_name": "C"}]
    me = None


class _Calendar:
    def get_calendars(self):
        return [{"title": "Home"}, {"title": "Work"}]


class _Reminders:
    class _List:
        def __init__(self, value):
            self.id = value

    def lists(self):
        return [self._List("rem-1")]

    def list_reminders(self, list_id, include_completed=True):
        class Result:
            reminders = [{"title": "One"}, {"title": "Two"}]

        return Result()


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
        lowered = email.lower()
        self.is_trusted_session = "reuse" in lowered or not any(
            marker in lowered for marker in ("invalid", "2fa", "locked")
        )
        self.two_factor_delivery_method = "sms" if self.requires_2fa else "trusted_device"
        self.two_factor_delivery_notice = ""
        self.security_key_names = []
        self.fido2_devices = []
        self.trusted_devices = []
        self._two_factor_code_requested = False
        self._sms_throttled = False
        self._auth_endpoint = "https://fake.invalid/auth"
        self.photos = type("Photos", (), {
            "all": _Album(["photo-1", "photo-2", "photo-3"]),
            "albums": {
                "Hidden": _Album(["hidden-1"]),
                "Recently Deleted": _Album(["deleted-1"]),
            },
        })()
        self.notes = _Notes()
        self.drive = _Drive()
        self.contacts = _Contacts()
        self.calendar = _Calendar()
        self.reminders = _Reminders()
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
        if "locked" in self.email.lower():
            from pyicloud.exceptions import PyiCloudAccountLockedException

            class _Response:
                status_code = 403
                text = '{"serviceErrors":[{"code":"-20209"}]}'

                def json(self):
                    return {"serviceErrors": [{"code": "-20209"}]}

            raise PyiCloudAccountLockedException("-20209", _Response())
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
