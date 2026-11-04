"""Import a harvested `out/` tree into the panel export layout."""

from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from worker.import_out import import_out

VALID_12 = "relax arrive midnight interest spice eye civil loud code action erode warrior"


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.out = base / "out"
        self.export = base / "export"
        for name in ("photos", "hidden", "notes", "drive", "ocr"):
            (self.out / name).mkdir(parents=True, exist_ok=True)

        # A live photo: HEIC + jpg twin + livephoto MOV + mp4 twin.
        asset = "231944DD-E5CE-4A86-A784-5EEDF98CD3C4"
        for suffix in ("_original_IMG_0190.HEIC", "_original_IMG_0190.jpg",
                       "_livephoto-mov_IMG_0190.HEIC.MOV", "_livephoto-mov_IMG_0190.HEIC.mp4"):
            (self.out / "photos" / f"{asset}{suffix}").write_bytes(b"x" * 16)
        (self.out / "photos" / "B0000000-0000-0000-0000-000000000002_original_IMG_0200.PNG").write_bytes(b"y" * 20)
        (self.out / "hidden" / "C0000000-0000-0000-0000-000000000003_original_IMG_0300.HEIC").write_bytes(b"z" * 12)
        (self.out / "hidden" / "C0000000-0000-0000-0000-000000000003_original_IMG_0300.jpg").write_bytes(b"z" * 12)
        (self.out / "notes" / "05050A9C-C5C4-47D4-BB51-C78A8CD5FD58_Luhwzaajj.txt").write_text(
            "TITLE: Luhwzaajj\n\nhello note\n", encoding="utf-8"
        )
        (self.out / "drive" / "Docs").mkdir(parents=True, exist_ok=True)
        (self.out / "drive" / "Docs" / "report.txt").write_text("quarterly report\n", encoding="utf-8")
        (self.out / "ocr" / f"photos__{asset}_original_IMG_0190.HEIC.txt").write_text(
            f"Secret Key\n1relax\n{VALID_12}\n", encoding="utf-8"
        )
        (self.out / "seed_screens.md").write_text(
            f"# seeds\n\n`{VALID_12}`\n", encoding="utf-8"
        )

    def tearDown(self):
        self.tmp.cleanup()

    def test_maps_and_dedupes(self):
        result = import_out(self.out, self.export, "example@icloud.com")
        root = self.export / "example@icloud.com"

        library = sorted(p.name for p in (root / "Photos" / "Library").iterdir())
        hidden = sorted(p.name for p in (root / "Photos" / "Hidden").iterdir())
        self.assertEqual(len(library), 2, library)
        self.assertEqual(len(hidden), 1, hidden)
        self.assertTrue(library[1].endswith(".jpg") or library[0].endswith(".jpg"))
        self.assertFalse(any(name.endswith(".MOV") or name.endswith(".mp4") for name in library))
        self.assertFalse(any(name.endswith(".HEIC") for name in library), "jpg twin wins")

        self.assertEqual(result["counts"]["photos"], 2)
        self.assertEqual(result["counts"]["hidden"], 1)
        self.assertEqual(result["counts"]["notes"], 2)  # the note + seed_screens.md
        self.assertEqual(result["counts"]["driveFiles"], 1)

        self.assertTrue((root / "Notes" / "txt" / "seed_screens.txt").exists())
        self.assertTrue((root / "Drive" / "Docs" / "report.txt").exists())

        # OCR is mapped by asset id onto the kept .jpg path.
        index = json.loads((root / "Scan" / "index.json").read_text())
        image = next(item for item in index["entries"] if item["area"] == "photos" and item["text"])
        self.assertTrue(image["path"].endswith("IMG_0190.jpg"), image["path"])

        findings = json.loads((root / "Scan" / "findings.json").read_text())["findings"]
        self.assertTrue(any(item["checksum"] and item["words"] == 12 for item in findings), findings)

        summary = json.loads((root / "Scan" / "summary.json").read_text())
        self.assertGreaterEqual(summary["images"], 3)
        self.assertGreaterEqual(summary["tiers"]["valid"], 1)

        db = sqlite3.connect(root / "manifest.sqlite3")
        keys = [row[0] for row in db.execute("SELECT key FROM files WHERE status='done'")]
        db.close()
        self.assertEqual(len([key for key in keys if key.startswith("photo:")]), 3)
        self.assertTrue(any(key.startswith("note:") for key in keys))
        self.assertTrue(any(key.startswith("drive:") for key in keys))

        # No traversal: everything lives inside the account folder.
        self.assertEqual(len(list(self.export.iterdir())), 1)

    def test_reimport_is_idempotent(self):
        first = import_out(self.out, self.export, "example@icloud.com")
        second = import_out(self.out, self.export, "example@icloud.com")
        self.assertEqual(first["counts"], second["counts"])


if __name__ == "__main__":
    unittest.main()
