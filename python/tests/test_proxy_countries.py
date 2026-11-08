"""anyIP country list: supported codes are sent, unsupported ones fall back."""

from __future__ import annotations

import unittest

from worker.proxy_countries import SUPPORTED_COUNTRIES, is_supported


class AnyIpCountriesTests(unittest.TestCase):
    def test_known_codes(self):
        self.assertGreaterEqual(len(SUPPORTED_COUNTRIES), 150)
        for code in ("US", "GB", "DE", "FR", "ID", "IN", "BR", "JP"):
            self.assertTrue(is_supported(code), code)
        self.assertTrue(is_supported("id"))

    def test_unknown_codes(self):
        for code in ("ZZ", "AQ", "", None, "USA"):
            self.assertFalse(is_supported(code), code)


if __name__ == "__main__":
    unittest.main()
