"""Counts must come from the export tree, not the stale login inventory."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from worker.exporter import collect_counts


class CollectCountsTests(unittest.TestCase):
    def test_counts_from_tree(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "Photos" / "Library").mkdir(parents=True)
            (root / "Photos" / "Library" / "a.jpg").write_bytes(b"x")
            (root / "Photos" / "Library" / "clip.mov").write_bytes(b"video")
            (root / "Photos" / "Hidden").mkdir(parents=True)
            (root / "Photos" / "Hidden" / "b.jpg").write_bytes(b"x")
            (root / "Notes" / "txt").mkdir(parents=True)
            (root / "Notes" / "txt" / "n.txt").write_text("hello", encoding="utf-8")
            (root / "Drive" / "folder").mkdir(parents=True)
            (root / "Drive" / "folder" / "d.bin").write_bytes(b"1234")
            (root / "Contacts").mkdir()
            (root / "Contacts" / "contacts.json").write_text(
                json.dumps(
                    {
                        "contacts": [
                            {"phones": ["+1"], "emails": []},
                            {"phones": [], "emails": ["a@b.c"]},
                        ]
                    }
                ),
                encoding="utf-8",
            )
            (root / "Calendar").mkdir()
            (root / "Calendar" / "calendars.json").write_text(
                json.dumps({"calendars": [{"title": "a"}, {"title": "b"}]}),
                encoding="utf-8",
            )
            (root / "Reminders").mkdir()
            (root / "Reminders" / "reminders.json").write_text(
                json.dumps(
                    [
                        {"reminders": [1, 2]},
                        {"reminders": [3]},
                    ]
                ),
                encoding="utf-8",
            )
            (root / "Mail").mkdir()
            (root / "Mail" / "index.json").write_text(
                json.dumps(
                    {
                        "available": True,
                        "folders": [{"name": "INBOX"}, {"name": "Sent"}],
                        "messages": 7,
                    }
                ),
                encoding="utf-8",
            )

            areas = {
                "photos": {"done": 2, "bytes": 6},
                "hidden": {"done": 1, "bytes": 1},
                "deleted": {"done": 0, "bytes": 0},
                "notes": {"done": 1, "bytes": 5},
                "drive": {"done": 1, "bytes": 4},
            }
            counts = collect_counts(root, areas)

            self.assertEqual(counts["photos"], 2)
            self.assertEqual(counts["hidden"], 1)
            self.assertEqual(counts["notes"], 1)
            self.assertEqual(counts["driveFiles"], 1)
            self.assertEqual(counts["driveBytes"], 4)
            self.assertEqual(counts["contacts"], 2)
            self.assertEqual(counts["contactsPhone"], 1)
            self.assertEqual(counts["contactsEmail"], 1)
            self.assertEqual(counts["calendars"], 2)
            self.assertEqual(counts["reminders"], 3)
            self.assertEqual(counts["mailFolders"], 2)
            self.assertEqual(counts["mailMessages"], 7)
            self.assertEqual(counts["videos"], 1)
            self.assertEqual(counts["images"], 1)


if __name__ == "__main__":
    unittest.main()
