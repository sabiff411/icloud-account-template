/* Geo providers, normalised to one shape.
 *
 * Three free, key-less endpoints are used in order.  Add or remove entries
 * here; `lookup()` in ./index.js does not care which provider answers. */

export const PROVIDERS = [
  {
    name: "ip-api.com",
    // Free tier is HTTP-only; 45 requests/minute per IP.
    url: (ip) =>
      `http://ip-api.com/json/${encodeURIComponent(ip)}` +
      "?fields=status,message,country,countryCode,regionName,city,zip,lat,lon,timezone,isp,org,as,query",
    parse(json) {
      if (json.status !== "success") {
        throw new Error(json.message || "ip-api lookup failed");
      }
      return {
        country: json.country ?? "",
        countryCode: json.countryCode ?? "",
        region: json.regionName ?? "",
        city: json.city ?? "",
        postalCode: json.zip ?? "",
        latitude: json.lat ?? null,
        longitude: json.lon ?? null,
        timezone: json.timezone ?? "",
        isp: json.isp ?? "",
        org: json.org ?? "",
      };
    },
  },
  {
    name: "ipwho.is",
    url: (ip) => `https://ipwho.is/${encodeURIComponent(ip)}`,
    parse(json) {
      if (json.success === false) {
        throw new Error(json.message || "ipwho.is lookup failed");
      }
      return {
        country: json.country ?? "",
        countryCode: json.country_code ?? "",
        region: json.region ?? "",
        city: json.city ?? "",
        postalCode: json.postal ?? "",
        latitude: json.latitude ?? null,
        longitude: json.longitude ?? null,
        timezone: json.timezone?.id ?? "",
        isp: json.connection?.isp ?? "",
        org: json.connection?.org ?? "",
      };
    },
  },
  {
    name: "ipapi.co",
    url: (ip) => `https://ipapi.co/${encodeURIComponent(ip)}/json/`,
    parse(json) {
      if (json.error) {
        throw new Error(json.reason || "ipapi.co lookup failed");
      }
      return {
        country: json.country_name ?? "",
        countryCode: json.country_code ?? "",
        region: json.region ?? "",
        city: json.city ?? "",
        postalCode: json.postal ?? "",
        latitude: json.latitude ?? null,
        longitude: json.longitude ?? null,
        timezone: json.timezone ?? "",
        isp: json.org ?? "",
        org: json.org ?? "",
      };
    },
  },
];
