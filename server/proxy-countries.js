/* anyIP's live country list (https://dashboard.anyip.io/api/data/country).
 * A code outside this set must not be sent as country_XX: anyIP answers
 * no_peers_available.  The panel marks it as unsupported and the worker
 * falls back to an any-country exit. */

export const ANYIP_COUNTRIES = new Set(
  "AE AF AL AM AO AR AT AU AZ BA BB BD BE BF BG BH BI BJ BN BO BR BT BW BY CA CD CH CI CL CM CN CO CR CU CY CZ DE DK DO DZ EC EE EG ES ET FI FR GA GB GE GH GR GT GY HK HN HR HT HU ID IE IL IN IQ IR IT JM JO JP KE KG KH KR KW KZ LA LB LK LR LT LU LV LY MA MD ME MG MK ML MM MN MR MT MU MW MX MY MZ NE NG NI NL NO NP NZ OM PA PE PH PK PL PR PS PT PY QA RO RS RU RW SA SD SE SI SK SN SO SS SV SY TG TH TJ TL TN TR TT TW TZ UA UG US UY UZ VE VN XK YE ZA ZM ZW".split(" ")
);

export function isAnyIpCountry(code) {
  const cc = String(code ?? "").trim().toUpperCase();
  return cc ? ANYIP_COUNTRIES.has(cc) : null;
}
