"""BIP39 detection: tiers, checksum, numbered grids, dedup."""

from __future__ import annotations

import unittest
from pathlib import Path

from worker import scan

VALID_12 = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
INVALID_12 = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon"


class TierTests(unittest.TestCase):
    def test_tiers(self):
        self.assertEqual(scan.tier_for(4), "none")
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


class SequenceTests(unittest.TestCase):
    def setUp(self):
        self.words = scan.word_index()

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

    def test_dedup_same_phrase(self):
        text = f"{VALID_12}\nand again:\n{VALID_12}"
        found = scan.find_sequences(text, self.words)
        phrases = [item["phrase"] for item in found if item["words"] == 12]
        self.assertEqual(len(phrases), len(set(phrases)))

    def test_none_for_prose(self):
        found = scan.find_sequences("the quick brown fox jumps over the lazy dog", self.words)
        self.assertEqual(found, [])


class WordlistTests(unittest.TestCase):
    def test_bundled_wordlist(self):
        words = scan.word_index()
        self.assertEqual(len(words), 2048)
        self.assertIn("abandon", words)
        self.assertIn("zoo", words)
        self.assertEqual(Path(scan.WORDLIST).name, "bip39_english.txt")


if __name__ == "__main__":
    unittest.main()
