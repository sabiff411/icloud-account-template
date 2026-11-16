"""Live-vs-export verification: manifest keys and the comparison."""

from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from worker import exporter
from worker.inventory import quick_counts
from worker.verify import compare, enumerate_live, exported_content_counts, manifest_ids


class _UrlAsset:
    def __init__(self, asset_id, url, filename):
        self.id = asset_id
        self.filename = filename
        self.size = 10
        self.versions = {
            "original": {"url": url, "filename": filename, "size": 10}
        }


class _UrlAlbum:
    def __init__(self, name, assets):
        self.name = name
        self._assets = assets

    def __iter__(self):
        return iter(self._assets)


class UrlIndexTests(unittest.TestCase):
    def test_urls_json_has_no_downloaded_files(self):
        first = _UrlAsset("A", "https://cdn.example/A", "a.jpg")
        second = _UrlAsset("B", "https://cdn.example/B", "b.jpg")
        api = type(
            "Api",
            (),
            {
                "photos": type(
                    "Photos",
                    (),
                    {
                        "albums": [
                            _UrlAlbum("Library", [first, second]),
                            _UrlAlbum("Videos", [second]),
                        ]
                    },
                )()
            },
        )()
        with tempfile.TemporaryDirectory() as folder:
            run = exporter.Exporter(_Ctx(), export_dir=folder, mode="urls")
            run.enumerate_photo_urls(api)
            data = json.loads((run.root / "Photos" / "urls.json").read_text())
            self.assertEqual(data["count"], 2)  # B appears in two albums
            self.assertEqual(data["items"][0]["url"], "https://cdn.example/A")
            self.assertIn("expiresAt", data)
            self.assertEqual(run.done, 0)  # nothing downloaded


class DriveSkipTests(unittest.TestCase):
    def test_only_apps_are_skipped(self):
        for name in (
            "setup.exe",
            "Install.msi",
            "App.dmg",
            "tool.appimage",
            "Apps/Foo.app/Contents/MacOS/Foo",
        ):
            self.assertTrue(exporter.is_skipped_drive(name), name)
        for name in (
            "Photos/IMG_0001.JPG",
            "Notes/note.txt",
            "Documents/report.pdf",
            "data.json",
            "Archive.zip",
        ):
            self.assertFalse(exporter.is_skipped_drive(name), name)

    def test_env_override(self):
        with mock.patch.dict(os.environ, {"DRIVE_SKIP_EXT": "exe, .MSI"}):
            self.assertEqual(exporter._drive_skip_ext(), {".exe", ".msi"})
        with mock.patch.dict(os.environ, {"DRIVE_SKIP_EXT": "none"}):
            self.assertEqual(exporter._drive_skip_ext(), set())


class _Node:
    def __init__(self, name, size=0, kind="file", children=None):
        self.name = name
        self.size = size
        self.type = kind
        self._children = children or []

    def get_children(self):
        return self._children


class _Emitter:
    def progress(self, *args, **kwargs):
        return None


class _Ctx:
    def __init__(self):
        self.account = {"email": "drive@example.com"}
        self.cancel = threading.Event()
        self.emitter = _Emitter()


class DriveEnumerationTests(unittest.TestCase):
    def test_same_name_and_size_in_two_folders_is_two_files(self):
        root = _Node(
            "root",
            kind="folder",
            children=[
                _Node("A", kind="folder", children=[_Node("same.txt", 10)]),
                _Node("B", kind="folder", children=[_Node("same.txt", 10)]),
                _Node("setup.exe", 99),
            ],
        )
        api = type(
            "Api", (), {"drive": type("Drive", (), {"root": root})()}
        )()
        with tempfile.TemporaryDirectory() as folder:
            run = exporter.Exporter(_Ctx(), export_dir=folder, mode="drive")
            run.enumerate_drive(api)
            keys = sorted(task["key"] for task in run.tasks)
            self.assertEqual(keys, ["drive:A/same.txt:10", "drive:B/same.txt:10"])
            self.assertEqual(run.skipped, 1)
            row = run.manifest.get("drive:setup.exe:99")
            self.assertEqual(row["status"], "skipped")

    def test_legacy_manifest_row_is_adopted_not_redownloaded(self):
        with tempfile.TemporaryDirectory() as folder:
            run = exporter.Exporter(_Ctx(), export_dir=folder, mode="drive")
            path = run.root / "Drive" / "A" / "same.txt"
            path.parent.mkdir(parents=True)
            path.write_bytes(b"0123456789")
            run.manifest.mark("drive:same.txt:10", "drive", path, 10, "")
            calls = []

            def fetch():
                calls.append(1)
                raise AssertionError("download should not run")

            run._download_task(
                {
                    "area": "drive",
                    "key": "drive:A/same.txt:10",
                    "legacy_key": "drive:same.txt:10",
                    "path": path,
                    "size": 10,
                    "fetch": fetch,
                    "kind": "stream",
                    "priority": 6,
                }
            )
            self.assertEqual(calls, [])
            self.assertEqual(run.done, 1)
            self.assertEqual(run.manifest.get("drive:A/same.txt:10")["status"], "done")


class _Asset:
    def __init__(self, asset_id):
        self.id = asset_id


class _Note:
    def __init__(self, note_id, deleted=False):
        self.id = note_id
        self.is_deleted = deleted


class _DriveChild:
    def __init__(self, name, size, kind="file"):
        self.name = name
        self.size = size
        self.type = kind

    def get_children(self):
        return []


class _DriveRoot(_DriveChild):
    def __init__(self, children):
        super().__init__("root", 0, "folder")
        self._children = children

    def get_children(self):
        return self._children


class _RemindersList:
    id = "list-1"


class _RemindersResult:
    def __init__(self, count):
        self.reminders = [object()] * count


class _Folder:
    def __init__(self, message_count):
        self.message_count = message_count


class _FakeApi:
    def __init__(self):
        self.photos = type(
            "Photos",
            (),
            {
                "all": [_Asset("A"), _Asset("B")],
                "albums": {
                    "Library": [_Asset("A"), _Asset("B")],
                    "Hidden": [_Asset("H")],
                    "Recently Deleted": [],
                    "Videos": [_Asset("V")],
                },
            },
        )()
        self.notes = type(
            "Notes", (), {"iter_all": lambda _self: [_Note("N1"), _Note("N2"), _Note("N3", True)]}
        )()
        self.drive = type(
            "Drive",
            (),
            {"root": _DriveRoot([_DriveChild("a.txt", 10), _DriveChild("b.txt", 5)])},
        )()
        self.contacts = type(
            "Contacts",
            (),
            {"all": [{"phones": ["1"], "emails": []}, {"phones": [], "emails": ["x"]}]},
        )()
        self.calendar = type("Calendar", (), {"get_calendars": lambda _self: [1, 2]})()
        self.reminders = type(
            "Reminders",
            (),
            {
                "lists": lambda _self: [_RemindersList()],
                "list_reminders": lambda _self, _id, include_completed=True: _RemindersResult(3),
            },
        )()
        self.mail = type(
            "Mail", (), {"folders": lambda _self: [_Folder(10), _Folder(5)]}
        )()


class LiveCountTests(unittest.TestCase):
    def test_live_pass_fills_every_count(self):
        counts: dict = {}
        partial: list[dict] = []
        live = enumerate_live(_FakeApi(), counts_out=counts, on_counts=partial.append)
        self.assertEqual(live["photos"], {"A", "B"})
        # Cheap counters are published before the photo enumeration, so the
        # panel does not wait for a 20k-photo scan to show albums/mail.
        photo_at = next(i for i, item in enumerate(partial) if "photos" in item)
        mail_at = next(i for i, item in enumerate(partial) if "mailMessages" in item)
        drive_at = next(i for i, item in enumerate(partial) if "driveFiles" in item)
        self.assertIn("albums", partial[0])
        # Photo totals are cheap (album length) and go out with the first
        # flush; only the id walk for missing detection waits.
        self.assertIn("photos", partial[0])
        self.assertLess(photo_at, mail_at)
        self.assertLess(photo_at, drive_at)
        self.assertEqual(
            counts,
            {
                "photos": 2,
                "hidden": 1,
                "deleted": 0,
                "albums": 4,
                "videos": 1,
                "images": 1,
                "notes": 2,
                "driveFiles": 2,
                "driveBytes": 15,
                "contacts": 2,
                "contactsPhone": 1,
                "contactsEmail": 1,
                "calendars": 2,
                "reminders": 3,
                "mailFolders": 2,
                "mailMessages": 15,
            },
        )


class QuickCountTests(unittest.TestCase):
    def test_ping_counts_are_cheap_but_complete(self):
        counts = quick_counts(_FakeApi())
        self.assertEqual(counts["photos"], 2)
        self.assertEqual(counts["hidden"], 1)
        self.assertEqual(counts["deleted"], 0)
        self.assertEqual(counts["albums"], 4)
        self.assertEqual(counts["videos"], 1)
        self.assertEqual(counts["images"], 1)
        self.assertEqual(counts["contacts"], 2)
        self.assertEqual(counts["calendars"], 2)
        self.assertEqual(counts["reminders"], 3)
        self.assertEqual(counts["mailMessages"], 15)
        # Notes and Drive need a real walk; a ping does not spend that.
        self.assertNotIn("notes", counts)
        self.assertNotIn("driveFiles", counts)


class ManifestTests(unittest.TestCase):
    def test_reads_photo_note_drive_keys_and_counts(self):
        with tempfile.TemporaryDirectory() as folder:
            db_path = Path(folder) / "manifest.sqlite3"
            db = sqlite3.connect(db_path)
            db.execute(
                """CREATE TABLE files (
                    key TEXT PRIMARY KEY, area TEXT, path TEXT, size INTEGER,
                    sha256 TEXT, status TEXT, updated TEXT)"""
            )
            rows = [
                ("photo:AAA", "photos", "Photos/Library/a.jpg", 10, "done"),
                ("photo:BBB", "hidden", "Photos/Hidden/b.jpg", 10, "done"),
                ("note:N1", "notes", "Notes/txt/n.txt", 10, "done"),
                ("drive:report.pdf:123", "drive", "Drive/report.pdf", 123, "done"),
                ("drive:setup.exe:99", "drive", "Drive/setup.exe", 99, "skipped"),
                ("photo:FAILED", "photos", "Photos/Library/c.jpg", 10, "failed"),
            ]
            db.executemany(
                "INSERT INTO files(key, area, path, size, sha256, status, updated) "
                "VALUES (?,?,?,?, 'x', ?, 'now')",
                rows,
            )
            db.commit()
            db.close()

            ids, counts = manifest_ids(db_path)
            self.assertEqual(ids["photos"], {"AAA", "BBB"})
            self.assertEqual(ids["notes"], {"N1"})
            # Skipped apps count as handled for the diff, but not as
            # downloaded files.
            self.assertEqual(ids["drive"], {"report.pdf:123", "setup.exe:99"})
            self.assertEqual(counts["drive"], 1)
            self.assertEqual(counts["photos"], 1)
            self.assertEqual(counts["hidden"], 1)
            self.assertEqual(counts["notes"], 1)

    def test_missing_manifest_is_empty(self):
        ids, counts = manifest_ids("/nonexistent/manifest.sqlite3")
        self.assertEqual(ids["photos"], set())
        self.assertEqual(counts, {})


class ContentCountTests(unittest.TestCase):
    def test_contacts_calendar_reminders_use_content_counts(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "Contacts").mkdir()
            (root / "Contacts" / "contacts.json").write_text(
                '{"contacts": [{}, {}, {}]}', encoding="utf-8"
            )
            (root / "Calendar").mkdir()
            (root / "Calendar" / "calendars.json").write_text(
                '{"calendars": [{"title":"a"},{"title":"b"}]}', encoding="utf-8"
            )
            (root / "Reminders").mkdir()
            (root / "Reminders" / "reminders.json").write_text(
                '[{"reminders":[1,2,3]}]', encoding="utf-8"
            )
            merged = exported_content_counts(
                root, {"contacts": 2, "calendar": 1, "reminders": 1}
            )
            self.assertEqual(merged["contacts"], 3)
            self.assertEqual(merged["calendar"], 2)
            self.assertEqual(merged["reminders"], 3)


class CompareTests(unittest.TestCase):
    def test_reports_missing_by_area(self):
        live = {
            "photos": {"AAA", "BBB", "CCC"},
            "hidden": {"H1"},
            "deleted": set(),
            "notes": {"N1", "N2"},
            "drive": {"a.txt:10", "b.txt:5"},
            "contacts": 4,
            "calendar": 2,
            "reminders": 3,
        }
        ids = {
            "photos": {"AAA", "BBB"},
            "notes": {"N1"},
            "drive": {"a.txt:10"},
        }
        exported = {"photos": 2, "hidden": 1, "notes": 1, "drive": 1, "contacts": 4, "calendar": 2, "reminders": 3}

        result = compare(live, ids, exported)
        self.assertEqual(result["areas"]["photos"]["missing"], 1)
        self.assertEqual(result["areas"]["hidden"]["missing"], 1)
        self.assertEqual(result["areas"]["deleted"]["missing"], 0)
        self.assertEqual(result["areas"]["notes"]["missing"], 1)
        self.assertEqual(result["areas"]["drive"]["missing"], 1)
        self.assertEqual(result["missing"]["photos"], ["CCC"])
        self.assertEqual(result["missing"]["notes"], ["N2"])
        self.assertEqual(result["missing"]["drive"], ["b.txt:5"])
        self.assertEqual(result["areas"]["contacts"]["missing"], 0)


if __name__ == "__main__":
    unittest.main()
