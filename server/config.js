import "dotenv/config";

/* One place for every knob the server reads.  Everything has a safe default so
 * `npm run serve` works with no .env file; see .env.example for the full list. */

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
};

const bool = (value, fallback = false) => {
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
};

const list = (value) =>
  String(value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const config = {
  env: process.env.NODE_ENV ?? "development",

  // Express: serves the built React app and /api/geo.
  httpPort: int(process.env.PORT, 3000),

  // Socket.IO lives in its own process/port, as requested.
  socketPort: int(process.env.SOCKET_PORT, 4001),
  socketCorsOrigin: process.env.SOCKET_CORS_ORIGIN ?? "*",

  // Admin password for the /admin Socket.IO namespace. Change it in .env.
  adminPassword: process.env.ADMIN_PASSWORD ?? "change-me-admin",

  distDir: process.env.DIST_DIR ?? "dist",

  geo: {
    // Comma-separated proxy URLs, e.g.
    // http://user:pass@host:port,http://host:port
    proxies: list(process.env.GEO_PROXIES),
    // If every proxy fails, query the providers directly (rate limits apply).
    allowDirect: bool(process.env.GEO_ALLOW_DIRECT, true),
    // Trust Cloudflare's cf-ipcountry header and skip the provider call.
    trustCountryHeader: bool(process.env.GEO_TRUST_COUNTRY_HEADER, true),
    timeoutMs: int(process.env.GEO_TIMEOUT_MS, 4500),
    cacheTtlMs: int(process.env.GEO_CACHE_TTL_MS, 12 * 60 * 60 * 1000),
    negativeCacheTtlMs: int(process.env.GEO_NEGATIVE_CACHE_TTL_MS, 60 * 1000),
    maxAttemptsPerProvider: int(process.env.GEO_MAX_ATTEMPTS, 3),
  },

  telegram: {
    enabled:
      bool(process.env.TELEGRAM_ENABLED, false) &&
      Boolean(process.env.TELEGRAM_BOT_TOKEN),
    token: process.env.TELEGRAM_BOT_TOKEN ?? "",
    // Where the bot posts new submissions (optional).
    chatId: process.env.TELEGRAM_CHAT_ID ?? "",
    // Optional comma-separated Telegram user ids allowed to use the bot.
    allowedUsers: list(process.env.TELEGRAM_ALLOWED_USERS),
  },

  store: {
    // Small JSON file so the template survives restarts. Swap for a DB later.
    file: process.env.STORE_FILE ?? "server/data/items.json",
    seed: bool(process.env.STORE_SEED, true),
  },
};
