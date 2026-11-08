"""anyIP country targeting.

Format (from https://anyip.io/docs/guides/location-targeting):

    user_XXXX,country_FR,session_<stable>

The docs' "Supported Countries" page is stale; the live dashboard endpoint
(https://dashboard.anyip.io/api/data/country) currently returns 151 ISO
codes.  Asking for an unsupported country makes anyIP answer
``no_peers_available`` (502), so callers should fall back to "any" instead of
sending the tag.
"""

from __future__ import annotations

SUPPORTED_COUNTRIES = frozenset(
    """
    AE AF AL AM AO AR AT AU AZ BA BB BD BE BF BG BH BI BJ BN BO BR BT BW BY
    CA CD CH CI CL CM CN CO CR CU CY CZ DE DK DO DZ EC EE EG ES ET FI FR GA
    GB GE GH GR GT GY HK HN HR HT HU ID IE IL IN IQ IR IT JM JO JP KE KG KH
    KR KW KZ LA LB LK LR LT LU LV LY MA MD ME MG MK ML MM MN MR MT MU MW MX
    MY MZ NE NG NI NL NO NP NZ OM PA PE PH PK PL PR PS PT PY QA RO RS RU RW
    SA SD SE SI SK SN SO SS SV SY TG TH TJ TL TN TR TT TW TZ UA UG US UY UZ
    VE VN XK YE ZA ZM ZW
    """.split()
)


def is_supported(code: str | None) -> bool:
    return str(code or "").strip().upper() in SUPPORTED_COUNTRIES
