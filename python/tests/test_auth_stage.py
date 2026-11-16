"""A password login must never overwrite a working jar with a pre-2FA one."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from worker import auth

TOKEN = 'Set-Cookie3: X-APPLE-WEBAUTH-TOKEN="abc"; path="/"; domain=".icloud.com"\n'
PRE_2FA = 'Set-Cookie3: aasp="1"; path="/"; domain=".apple.com"\n'


class StagedLoginTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.live = Path(self.tmp.name) / "0123456789abcdef"
        self.live.mkdir(parents=True)
        (self.live / "acct.cookiejar").write_text(TOKEN)
        (self.live / "acct.session").write_text('{"session_token": "one"}')

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_login_writes_only_the_stage(self) -> None:
        stage = auth._stage_login(self.live)
        self.assertNotEqual(stage, self.live)
        self.assertEqual((stage / "acct.cookiejar").read_text(), TOKEN)
        (stage / "acct.cookiejar").write_text(PRE_2FA)
        self.assertEqual((self.live / "acct.cookiejar").read_text(), TOKEN)

    def test_promote_replaces_the_live_jar(self) -> None:
        stage = auth._stage_login(self.live)
        (stage / "acct.cookiejar").write_text(PRE_2FA)
        self.assertTrue(auth._promote(stage, self.live))
        self.assertEqual((self.live / "acct.cookiejar").read_text(), PRE_2FA)

    def test_promote_refuses_an_empty_stage(self) -> None:
        stage = self.live / ".login"
        stage.mkdir()
        self.assertFalse(auth._promote(stage, self.live))
        self.assertEqual((self.live / "acct.cookiejar").read_text(), TOKEN)


if __name__ == "__main__":
    unittest.main()
