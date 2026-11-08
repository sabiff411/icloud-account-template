"""Minimal worker tests (unittest, no live Apple account).

Run:  PYTHONPATH=python python3 -m unittest discover -s python/tests -v
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from unittest.mock import patch

from worker import auth, exporter, twofa
from pyicloud.exceptions import PyiCloudAccountLockedException, PyiCloudFailedLoginException
from worker.proxy import build_proxy_url, mask_proxy_url, stable_ssid


class ProxyTests(unittest.TestCase):
    def test_anyip_username_flags(self):
        url = build_proxy_url(
            "http://user:pass@portal.anyip.io:1080",
            country="de",
            ssid="abcd1234",
            attempt=2,
        )
        self.assertIn("user,country_DE,session_abcd12342", url)
        self.assertIn(":pass@portal.anyip.io:1080", url)

    def test_niceproxy_rotation(self):
        url = build_proxy_url(
            "http://user-ssid-old-country-US:pw@niceproxy.io:9000",
            country="GB",
            ssid="stable",
        )
        self.assertIn("user-ssid-stable-country-GB", url)

    def test_plain_proxy_and_mask(self):
        url = build_proxy_url("http://u:p@127.0.0.1:8080", country="US")
        self.assertTrue(url.endswith("@127.0.0.1:8080"))
        masked = mask_proxy_url(url)
        self.assertIn(":***@", masked)
        self.assertNotIn(":p@", masked)

    def test_stable_ssid(self):
        self.assertEqual(stable_ssid("A@B.com"), stable_ssid("a@b.com"))
        self.assertEqual(len(stable_ssid("a@b.com")), 16)


class MaskingTests(unittest.TestCase):
    def test_mask_last_four_only(self):
        masked = twofa.mask_phone("+1 (555) 123-4567")
        self.assertTrue(masked.endswith("4567"))
        self.assertNotIn("123", masked)

    def test_mask_short(self):
        self.assertIn("••••", twofa.mask_phone("12"))

    def test_mask_dict_keeps_apple_suffix(self):
        self.assertTrue(
            twofa.mask_phone(
                {
                    "numberWithDialCode": "+1 (•••) •••-••67",
                    "obfuscatedNumber": "•••-•••-••67",
                }
            ).endswith("67")
        )
        self.assertTrue(
            twofa.mask_phone(
                {
                    "numberWithDialCode": "+1 ••• ••• ••••",
                    "lastFourDigits": "4567",
                }
            ).endswith("4567")
        )
        self.assertTrue(
            twofa.mask_phone(
                {
                    "numberWithDialCode": "+1 ••• ••• ••••",
                    "lastTwoDigits": 89,
                }
            ).endswith("89")
        )


class ExporterTests(unittest.TestCase):
    def test_safe_name_blocks_traversal(self):
        name = exporter.safe_name("../../etc/passwd")
        self.assertNotIn("/", name)
        self.assertTrue(name.endswith("etc_passwd"))
        self.assertEqual(exporter.safe_name(""), "unnamed")

    def test_manifest_skip_and_resume(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            manifest = exporter.Manifest(root / "manifest.sqlite3")
            target = root / "a.bin"
            target.write_bytes(b"hello")
            self.assertTrue(manifest.needs("k", target, 5))
            digest = exporter.file_sha256(target)
            manifest.mark("k", "drive", target, 5, digest)
            self.assertFalse(manifest.needs("k", target, 5))
            self.assertTrue(manifest.needs("k", target, 6))
            target.write_bytes(b"hell0")
            self.assertTrue(manifest.needs("k", target, 5), "hash mismatch re-downloads")
            target.unlink()
            self.assertTrue(manifest.needs("k", target, 5))

    def test_contained(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.assertTrue(exporter.contained(root, root / "x" / "y"))
            self.assertFalse(exporter.contained(root, root.parent / "escape"))

    def test_progress_file_fetch(self):
        # A tiny fake context: export one byte string and check totals.
        class Emitter:
            def __init__(self):
                self.events = []

            def progress(self, payload, **kwargs):
                self.events.append(dict(payload))

        class Ctx:
            def __init__(self, folder):
                self.account = {"email": "test@example.com"}
                self.api = None
                self.emitter = Emitter()
                self.folder = folder

            def emit(self, event, payload):
                self.events = getattr(self, "events", []) + [(event, payload)]

        with tempfile.TemporaryDirectory() as folder:
            head = Path(folder) / "head"
            head.mkdir()
            (head / "manifest.sqlite3").write_bytes(b"")
            ctx = Ctx(folder)
            run = exporter.Exporter(ctx, export_dir=folder)
            run.add(
                area="drive",
                key="one",
                path=run.root / "Drive" / "a.txt",
                size=5,
                fetch=lambda: b"hello",
                kind="bytes",
            )
            totals = run.run()
            self.assertEqual(totals["done"], 1)
            self.assertEqual((run.root / "Drive" / "a.txt").read_bytes(), b"hello")
            self.assertTrue(any(e[0] == "job:export_done" for e in ctx.events))


if __name__ == "__main__":
    unittest.main()


class FakeSession:
    def __init__(self):
        self.headers = {}
        self.proxies = {}


class FakeService:
    def __init__(self, email, password, cookie_directory, authenticate, accept_terms):
        self.email = email
        self.password = password
        self.session = FakeSession()
        self.requires_2fa = False
        self.requires_2sa = False
        self.is_trusted_session = "reuse" in email
        self._auth_data = {}
        self._auth_endpoint = "https://example.invalid/auth"
        self.two_factor_delivery_method = "trusted_device"
        self.two_factor_delivery_notice = ""
        self.security_key_names = []
        self.fido2_devices = []
        self.trusted_devices = []

    def get_auth_status(self):
        return {
            "authenticated": self.is_trusted_session,
            "trusted_session": self.is_trusted_session,
        }

    def authenticate(self):
        if "locked" in self.email:
            class _Response:
                status_code = 403
                text = '{"serviceErrors":[{"code":"-20209"}]}'

                def json(self):
                    return {"serviceErrors": [{"code": "-20209"}]}

            raise PyiCloudAccountLockedException("-20209", _Response())
        if "invalid" in self.email:
            raise PyiCloudFailedLoginException("bad password")
        self.requires_2fa = "2fa" in self.email
        self.is_trusted_session = not self.requires_2fa

    def trust_session(self):
        self.is_trusted_session = True
        return True

    def validate_2fa_code(self, code):
        return code == "123456"


class FakeEmitter:
    def __init__(self):
        self.events = []

    def send(self, event, payload, **kwargs):
        self.events.append((event, payload))

    def progress(self, payload, **kwargs):
        self.events.append(("progress", payload))


class AuthTests(unittest.TestCase):
    def run_job(self, email):
        emitter = FakeEmitter()
        with tempfile.TemporaryDirectory() as folder:
            payload = {
                "account": {
                    "email": email,
                    "password": "pw",
                    "sessionDir": folder,
                },
                "proxy": {},
                "fingerprint": {},
            }
            ctx = auth.JobContext("job-1", payload, emitter)
            with patch.object(auth, "PyiCloudService", FakeService), patch.object(
                auth.inventory, "collect", return_value={"identity": {}, "counts": {}}
            ):
                auth.run_auth(ctx)
        return emitter.events

    def test_valid_login(self):
        events = self.run_job("valid@example.com")
        results = [p for e, p in events if e == "job:result"]
        self.assertEqual(results[-1]["status"], "ok")
        self.assertTrue(results[-1]["account"]["trusted"])

    def test_existing_session_reused(self):
        events = self.run_job("reuse@example.com")
        states = [p for e, p in events if e == "job:state"]
        self.assertTrue(any(p.get("reused") for p in states), states)
        results = [p for e, p in events if e == "job:result"]
        self.assertEqual(results[-1]["status"], "ok")

    def test_invalid_login(self):
        events = self.run_job("invalid@example.com")
        results = [p for e, p in events if e == "job:result"]
        self.assertEqual(results[-1]["status"], "invalid")

    def test_locked_login(self):
        events = self.run_job("locked@example.com")
        results = [p for e, p in events if e == "job:result"]
        self.assertEqual(results[-1]["status"], "error")
        self.assertIn("locked", results[-1]["message"].lower())

    def test_two_factor_submit(self):
        # Simpler: patch the twofa helpers around the whole run.
        emitter = FakeEmitter()
        with tempfile.TemporaryDirectory() as folder:
            payload = {
                "account": {
                    "email": "2fa@example.com",
                    "password": "pw",
                    "sessionDir": folder,
                },
                "proxy": {},
                "fingerprint": {},
            }
            ctx = auth.JobContext("job-2fa", payload, emitter)
            ctx.commands.put({"action": "submit", "code": "123456"})
            options = [
                {"id": "sms:0", "kind": "sms", "label": "+1 ••• ••• 1234", "active": True}
            ]
            with patch.object(auth, "PyiCloudService", FakeService), patch.object(
                auth.inventory, "collect", return_value={"identity": {}, "counts": {}}
            ), patch.object(auth.twofa, "delivery_options", return_value=options), patch.object(
                auth.twofa, "default_choice", return_value="sms:0"
            ), patch.object(auth.twofa, "switch_delivery", return_value="Code sent"), patch.object(
                auth.twofa, "submit_code_any", return_value=(True, "sms:0")
            ), patch.object(auth.twofa, "ensure_trusted", return_value=True):
                auth.run_auth(ctx)
        results = [p for e, p in emitter.events if e == "job:result"]
        self.assertEqual(results[-1]["status"], "ok")
        self.assertTrue(results[-1]["account"]["trusted"])


class ExportJsonTests(unittest.TestCase):
    """Contacts/calendar/mail tasks must survive one unavailable sub-call."""

    class Emitter:
        def __init__(self):
            self.events = []

        def send(self, event, payload, **kwargs):
            self.events.append((event, payload))

        def progress(self, payload, **kwargs):
            self.events.append(("progress", payload))

    class Ctx:
        def __init__(self, api):
            self.account = {"email": "json@example.com"}
            self.api = api
            self.emitter = ExportJsonTests.Emitter()

        def emit(self, event, payload):
            self.events = getattr(self, "events", []) + [(event, payload)]

    class Me:
        raw_data = {"firstName": "Me"}

    class BrokenMe:
        @property
        def raw_data(self):
            raise KeyError("contacts not found")

    class Contacts:
        me = None
        all = [{"first_name": "Alice", "note": "abandon about zoo"}]

    class Mail:
        class Folder:
            id = "inbox-1"
            name = "INBOX"

        class Part:
            id = "part-1"
            is_attachment = True
            filename = "memo.txt"
            size = 5
            mail_drop_url = None

        class Message:
            id = "message-1"
            uid = 7
            thread_id = "t1"
            subject = "Backup"
            sender = "sender@example.com"
            to = "json@example.com"
            cc = None
            flags = 0
            internal_date = 1700000000.0
            size = 100
            has_attachment = True

            def __init__(self):
                self.id = self.__class__.id
                self.uid = self.__class__.uid
                self.thread_id = self.__class__.thread_id
                self.subject = self.__class__.subject
                self.sender = self.__class__.sender
                self.to = self.__class__.to
                self.cc = self.__class__.cc
                self.flags = self.__class__.flags
                self.internal_date = self.__class__.internal_date
                self.size = self.__class__.size
                self.has_attachment = self.__class__.has_attachment
                self.parts = [ExportJsonTests.Mail.Part()]
                self.folder = ExportJsonTests.Mail.Folder()

        def folders(self):
            return [self.Folder()]

        def iter_messages(self, folder, page_size=50, max_pages=10000):
            return iter([self.Message()])

        def body(self, message):
            return {"parts": [{"content": "hello from mail"}]}

        def attachment(self, message, part_id):
            return iter([b"hello"])

    class Api:
        pass

    def api(self):
        instance = self.Api()
        instance.mail = self.Mail()
        instance.contacts = self.Contacts()
        instance.contacts.me = None  # MeCard absent: book must still export
        return instance

    def test_contacts_survive_missing_me_card(self):
        api = self.api()
        with tempfile.TemporaryDirectory() as folder:
            run = exporter.Exporter(self.Ctx(api), export_dir=folder)
            run.enumerate_json(api)
            run.run()
            data = json.loads((run.root / "Contacts" / "contacts.json").read_text())
            self.assertEqual(data["contacts"][0]["note"], "abandon about zoo")

    def test_mail_messages_and_attachment(self):
        api = self.api()
        with tempfile.TemporaryDirectory() as folder:
            run = exporter.Exporter(self.Ctx(api), export_dir=folder)
            run.enumerate_mail(api)
            run.run()
            index = json.loads((run.root / "Mail" / "index.json").read_text())
            self.assertTrue(index["available"])
            self.assertEqual(index["messages"], 1)
            messages = json.loads((run.root / "Mail" / "messages.json").read_text())
            self.assertEqual(messages[0]["subject"], "Backup")
            message = json.loads((run.root / "Mail" / "inbox-1_INBOX" / "message-1.json").read_text())
            self.assertEqual(message["body"]["parts"][0]["content"], "hello from mail")
            attachment = run.root / "Mail" / "inbox-1_INBOX" / "attachments" / "message-1-1-memo.txt"
            self.assertEqual(attachment.read_bytes(), b"hello")
