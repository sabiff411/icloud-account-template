"""Session vault: durable, verified, optionally encrypted snapshots."""

from __future__ import annotations

import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from worker import session_vault


class SessionVaultTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.session = self.root / "sessions" / "0123456789abcdef"
        self.session.mkdir(parents=True)
        (self.session / "account.session").write_bytes(b"session-token")
        (self.session / "account.cookiejar").write_bytes(b"cookie-jar")
        (self.session / "notes.txt").write_bytes(b"not a session file")
        self.vault = self.root / "vault"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_snapshot_and_restore(self) -> None:
        snap = session_vault.snapshot(self.session, "a@example.com", vault=self.vault)
        self.assertIsNotNone(snap)
        self.assertTrue((snap / "manifest.json").exists())
        self.assertTrue((snap / "account.session").exists())
        self.assertFalse((snap / "notes.txt").exists())

        shutil.rmtree(self.session)
        self.session.mkdir()
        restored = session_vault.restore(self.session, vault=self.vault)
        self.assertEqual(restored, snap)
        self.assertEqual((self.session / "account.session").read_bytes(), b"session-token")
        self.assertEqual((self.session / "account.cookiejar").read_bytes(), b"cookie-jar")

    def test_unchanged_returns_previous(self) -> None:
        first = session_vault.snapshot(self.session, vault=self.vault)
        second = session_vault.snapshot(self.session, vault=self.vault)
        self.assertEqual(first, second)

    def test_change_creates_a_new_snapshot(self) -> None:
        first = session_vault.snapshot(self.session, vault=self.vault)
        (self.session / "account.session").write_bytes(b"rotated-token")
        second = session_vault.snapshot(self.session, vault=self.vault)
        self.assertNotEqual(first, second)
        ok, errors = session_vault.verify(second)
        self.assertTrue(ok, errors)

    def test_tamper_is_detected(self) -> None:
        snap = session_vault.snapshot(self.session, vault=self.vault)
        target = snap / "account.session"
        target.write_bytes(target.read_bytes() + b"x")
        ok, errors = session_vault.verify(snap)
        self.assertFalse(ok)
        self.assertTrue(any("hash mismatch" in error for error in errors), errors)

    def test_encrypted_round_trip(self) -> None:
        with mock.patch.dict(os.environ, {"SESSION_VAULT_KEY": "correct horse battery staple"}):
            snap = session_vault.snapshot(self.session, vault=self.vault)
            raw = (snap / "account.session").read_bytes()
            self.assertTrue(raw.startswith(session_vault.MAGIC))
            self.assertNotIn(b"session-token", raw)
            shutil.rmtree(self.session)
            self.session.mkdir()
            session_vault.restore(self.session, vault=self.vault)
            self.assertEqual((self.session / "account.session").read_bytes(), b"session-token")

    def test_wrong_key_fails_closed(self) -> None:
        with mock.patch.dict(os.environ, {"SESSION_VAULT_KEY": "right-key"}):
            snap = session_vault.snapshot(self.session, vault=self.vault)
        with mock.patch.dict(os.environ, {"SESSION_VAULT_KEY": "wrong-key"}):
            ok, errors = session_vault.verify(snap)
            self.assertFalse(ok)
            with self.assertRaises(RuntimeError):
                session_vault.restore(self.session, vault=self.vault)

    def test_prune_keeps_the_newest(self) -> None:
        for index in range(6):
            (self.session / "account.session").write_bytes(f"token-{index}".encode())
            session_vault.snapshot(self.session, vault=self.vault, keep=3)
        account = self.vault / self.session.name
        snapshots = sorted(p for p in account.iterdir() if p.is_dir() and not p.name.startswith("."))
        self.assertEqual(len(snapshots), 3)
        ok, errors = session_vault.verify(session_vault._latest(account))
        self.assertTrue(ok, errors)

    def test_restore_if_empty_only_when_empty(self) -> None:
        session_vault.snapshot(self.session, vault=self.vault)
        self.assertIsNone(session_vault.restore_if_empty(self.session, vault=None))
        shutil.rmtree(self.session)
        self.session.mkdir()
        self.assertIsNotNone(session_vault.restore(self.session, vault=self.vault))

    def test_snapshot_all(self) -> None:
        second = self.root / "sessions" / "fedcba9876543210"
        second.mkdir(parents=True)
        (second / "x.cookiejar").write_bytes(b"jar-2")
        count = session_vault.snapshot_all(self.root / "sessions", vault=self.vault)
        self.assertEqual(count, 2)
        self.assertTrue((self.vault / "fedcba9876543210").is_dir())


if __name__ == "__main__":
    unittest.main()
