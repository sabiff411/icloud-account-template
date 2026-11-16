"""BIP39 detection: tiers, checksum, numbered grids, dedup."""

from __future__ import annotations

import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from worker import scan

VALID_12 = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
INVALID_12 = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon"


class TierTests(unittest.TestCase):
    def test_tiers(self):
        self.assertEqual(scan.tier_for(2), "none")
        self.assertEqual(scan.tier_for(3), "low")
        self.assertEqual(scan.tier_for(4), "low")
        self.assertEqual(scan.tier_for(5), "minimum")
        self.assertEqual(scan.tier_for(7), "minimum")
        self.assertEqual(scan.tier_for(8), "medium")
        self.assertEqual(scan.tier_for(11), "medium")
        self.assertEqual(scan.tier_for(12), "high")
        self.assertEqual(scan.tier_for(24), "high")


class ChecksumTests(unittest.TestCase):
    def test_valid_and_invalid(self):
        words = scan.word_index()
        self.assertTrue(scan.checksum_ok(VALID_12.split(), words))
        self.assertFalse(scan.checksum_ok(INVALID_12.split(), words))

    def test_short_has_no_checksum(self):
        self.assertFalse(scan.checksum_ok("abandon about".split()))


class SpamTests(unittest.TestCase):
    def test_repeated_word_is_spam(self):
        sample = list(scan.word_index())
        self.assertTrue(scan.is_spam_phrase("test " * 12))
        self.assertTrue(scan.is_spam_phrase(VALID_12))
        self.assertTrue(scan.is_spam_phrase("abandon " * 12))
        self.assertTrue(scan.is_spam_phrase(" ".join(sample[:17])))
        self.assertTrue(scan.is_spam_phrase(" ".join(sample[:24] + sample[:6])))
        self.assertFalse(scan.is_spam_phrase(" ".join(sample[:24])))
        self.assertFalse(
            scan.is_spam_phrase(
                "again empty warm hip fat allow broccoli turn finger insane hunt service"
            )
        )
        self.assertFalse(
            scan.is_spam_phrase(
                "victory split joke recall detect rather crack fabric immense cotton actor hidden"
            )
        )

    def test_html_and_document_noise_is_spam(self):
        self.assertTrue(scan.is_spam_phrase("style border top width border top style solid"))
        self.assertTrue(
            scan.is_spam_phrase(
                "section main input type time section main input type"
            )
        )
        self.assertTrue(
            scan.is_spam_phrase(
                "bedienungsanleitung air beruhrungssensor sekunden mikrofon ladeschale "
                "ladekontakt led usb sekunden"
            )
        )

    def test_numbered_manual_is_not_a_seed_grid(self):
        words = scan.word_index()
        text = "\n".join(
            f"{number + 1}. {word}"
            for number, word in enumerate(
                "bedienungsanleitung air beruhrungssensor sekunden mikrofon "
                "ladeschale ladekontakt led usb".split()
            )
        )
        self.assertEqual(scan._grid_sequences(text, words), [])

    def test_html_style_and_script_are_stripped(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "page.html"
            path.write_text(
                "<style>.border{top:0;width:100%}</style>"
                "<script>const width = 'top';</script>"
                f"<p>{VALID_12}</p>",
                encoding="utf-8",
            )
            text = scan.read_text(path)
            self.assertNotIn("border", text)
            self.assertNotIn("const", text)
            self.assertIn(VALID_12, text)

    def test_findings_carry_the_flag(self):
        found = scan.find_sequences("test " * 12, scan.word_index())
        self.assertTrue(found, found)
        self.assertTrue(found[0]["spam"])
        good = scan.find_sequences(
            "again empty warm hip fat allow broccoli turn finger insane hunt service",
            scan.word_index(),
        )
        self.assertFalse(good[0]["spam"])


class SequenceTests(unittest.TestCase):
    def setUp(self):
        self.words = scan.word_index()

    def test_three_word_low_candidate(self):
        found = scan.find_sequences("candidate: abandon about zoo", self.words)
        self.assertEqual(len(found), 1, found)
        self.assertEqual(found[0]["words"], 3)
        self.assertEqual(found[0]["tier"], "low")
        self.assertFalse(found[0]["checksum"])

        four = scan.find_sequences("abandon about zoo ability", self.words)
        self.assertEqual(four[0]["words"], 4)
        self.assertEqual(four[0]["tier"], "low")

    def test_five_and_eight(self):
        text = "backup: abandon abandon abandon abandon abandon"
        found = scan.find_sequences(text, self.words)
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["words"], 5)
        self.assertEqual(found[0]["tier"], "minimum")
        self.assertFalse(found[0]["checksum"])

        eight = "abandon " * 8
        found = scan.find_sequences(eight, self.words)
        self.assertEqual(found[0]["words"], 8)
        self.assertEqual(found[0]["tier"], "medium")

    def test_twelve_valid_and_invalid(self):
        good = scan.find_sequences(f"wallet {VALID_12} end", self.words)
        self.assertEqual(good[0]["tier"], "high")
        self.assertTrue(good[0]["checksum"])

        bad = scan.find_sequences(INVALID_12, self.words)
        self.assertEqual(bad[0]["tier"], "high")
        self.assertFalse(bad[0]["checksum"])

    def test_numbered_grid(self):
        words = VALID_12.split()
        grid = "\n".join(f"{i + 1}. {word}" for i, word in enumerate(words))
        found = scan.find_sequences(grid, self.words)
        self.assertTrue(any(item["words"] == 12 and item["checksum"] for item in found), found)

    def test_interleaved_grid_with_missing_number(self):
        # Real OCR from a MetaMask backup screen: two columns, one number lost.
        text = (
            "1relax\n7civil\n2 arrive\n8loud\nmidnight\n3\n9code\n"
            "4 interest\n10 action\n5spice\n11erode\n6 eye\n12 warrior"
        )
        found = scan.find_sequences(text, self.words)
        valid = [item for item in found if item["checksum"]]
        self.assertEqual(len(valid), 1, found)
        self.assertEqual(
            valid[0]["phrase"],
            "relax arrive midnight interest spice eye civil loud code action erode warrior",
        )

    def test_five_gaps_reconstructs_the_one_valid_permutation(self):
        text = (
            "SecretKey\nWrite down yourbackup\n"
            "monster\ncapital\n2 rebel\n8\nyou\n3 fame\n9phone\n"
            "10 camera\ncanoe\n5wire\n11 song\nmoral\n12 arrive"
        )
        found = scan.find_sequences(text, self.words)
        valid = [item for item in found if item["checksum"]]
        self.assertEqual(len(valid), 1, found)
        # Text-only OCR cannot order four unnumbered words uniquely; any
        # arrangement that passes the checksum is a candidate, and the panel
        # shows the source image beside it.
        self.assertEqual(
            sorted(valid[0]["phrase"].split()),
            sorted("monster rebel fame canoe wire moral capital you phone camera song arrive".split()),
        )

    def test_dedup_same_phrase(self):
        text = f"{VALID_12}\nand again:\n{VALID_12}"
        found = scan.find_sequences(text, self.words)
        phrases = [item["phrase"] for item in found if item["words"] == 12]
        self.assertEqual(len(phrases), len(set(phrases)))

    def test_prose_only_produces_low_candidates(self):
        # "quick brown fox" is three BIP39 words; with low-tier detection it
        # is reported, but it must never be promoted to minimum/medium/high.
        found = scan.find_sequences("the quick brown fox jumps over the lazy dog", self.words)
        self.assertTrue(found)
        self.assertTrue(all(item["tier"] == "low" for item in found), found)


class CoverageTests(unittest.TestCase):
    """Files that used to be skipped or truncated before phrase scanning."""

    def setUp(self):
        self.words = scan.word_index()

    def _scan(self, root: Path):
        return scan.scan_export(None, root)

    def _phrases(self, root: Path):
        payload = json.loads((root / "Scan" / "findings.json").read_text())
        return [item["phrase"] for item in payload["findings"]]

    def test_json_values_beyond_20k_are_scanned(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "Contacts").mkdir()
            payload = {
                "contacts": [
                    {"firstName": "A", "notes": "x" * 60000 + " " + VALID_12}
                ]
            }
            (root / "Contacts" / "contacts.json").write_text(json.dumps(payload))
            self._scan(root)
            self.assertIn(VALID_12, self._phrases(root))

    def test_calendar_ics_and_contact_vcf_are_scanned(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "Calendar").mkdir()
            (root / "Contacts").mkdir()
            (root / "Calendar" / "calendar.ics").write_text(
                "BEGIN:VEVENT\nDESCRIPTION:" + VALID_12 + "\nEND:VEVENT\n"
            )
            (root / "Contacts" / "contact.vcf").write_text(
                "BEGIN:VCARD\nNOTE:" + VALID_12 + "\nEND:VCARD\n"
            )
            self._scan(root)
            phrases = self._phrases(root)
            self.assertEqual(phrases.count(VALID_12), 2, phrases)

    def test_docx_xlsx_text_is_scanned(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "Drive").mkdir()
            with zipfile.ZipFile(root / "Drive" / "wallet.docx", "w") as package:
                package.writestr(
                    "word/document.xml",
                    f"<w:document><w:body><w:t>{VALID_12}</w:t></w:body></w:document>",
                )
            with zipfile.ZipFile(root / "Drive" / "wallet.xlsx", "w") as package:
                package.writestr(
                    "xl/sharedStrings.xml",
                    f"<sst><si><t>{VALID_12}</t></si></sst>",
                )
            self._scan(root)
            self.assertEqual(self._phrases(root).count(VALID_12), 2)
            self.assertTrue((root / "Scan" / "text" / "Drive" / "wallet.docx.txt").exists())
            self._scan(root)  # second pass reads the text cache

    def test_text_file_larger_than_5mb_is_scanned(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "Notes" / "txt").mkdir(parents=True)
            filler = "lorem ipsum dolor sit amet " * 240000  # ~6.4 MB
            (root / "Notes" / "txt" / "big.txt").write_text(filler + VALID_12)
            self._scan(root)
            self.assertIn(VALID_12, self._phrases(root))

    def test_mbox_tail_is_scanned(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "Mail").mkdir()
            (root / "Mail" / "archive.mbox").write_text(
                ("filler line\n" * 100) + "seed: " + VALID_12 + "\n"
            )
            self._scan(root)
            self.assertIn(VALID_12, self._phrases(root))


class WordlistTests(unittest.TestCase):
    def test_bundled_wordlist(self):
        words = scan.word_index()
        self.assertEqual(len(words), 2048)
        self.assertIn("abandon", words)
        self.assertIn("zoo", words)
        self.assertEqual(Path(scan.WORDLIST).name, "bip39_english.txt")


if __name__ == "__main__":
    unittest.main()
