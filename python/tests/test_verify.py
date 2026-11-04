"""Live-vs-export verification: manifest keys and the comparison."""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from worker.verify import compare, manifest_ids


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
            self.assertEqual(ids["drive"], {"report.pdf:123"})
            self.assertEqual(counts["photos"], 1)
            self.assertEqual(counts["hidden"], 1)
            self.assertEqual(counts["notes"], 1)

    def test_missing_manifest_is_empty(self):
        ids, counts = manifest_ids("/nonexistent/manifest.sqlite3")
        self.assertEqual(ids["photos"], set())
        self.assertEqual(counts, {})


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
