import express from "express";
import crypto from "node:crypto";
import fsSync from "node:fs";
import { Readable } from "node:stream";
import fs from "node:fs/promises";
import path from "node:path";
import { isAdminPassword } from "../socket/auth.js";
import {
  clearCookie,
  readCookie,
  sessionCookie,
  signSession,
  verifySession,
} from "./session.js";
import {
  accountRoot,
  contentType,
  exportExists,
  gallery,
  readSummary,
  readTree,
  realWithin,
  resolveWithin,
  search,
} from "./export.js";
import { buildCatalog, queryCatalog } from "./library.js";
import { loadRules, saveRules } from "./visibility.js";
import { DEFAULT_TARGET, addBlock, loadBlocks, removeBlock } from "./blocks.js";
import { localStorage } from "./storage.js";
import { ensureThumb, ensurePreview } from "./thumbs.js";
import { s4DownloadUrl, s4Enabled, s4exists, s4Key, s4url } from "./s4.js";
import { createHealthCollector } from "./health.js";

/* Read-only admin API for the panel.
 *
 * The web process never owns accounts, so it reads the socket process's JSON
 * file (mtime-cached) just to map id → email. The cookie is the same signed
 * token the socket accepts. */

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

async function readHead(file, bytes) {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function numeric(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

const HTTP_ONLY_COOKIES = new Set([
  "acn01",
  "aasp",
  "crsc",
  "X-APPLE-WEBAUTH-TOKEN",
  "X-APPLE-WEBAUTH-USER",
  "X-APPLE-WEBAUTH-LOGIN",
  "X-APPLE-WEBAUTH-HSA-TRUST",
  "X-APPLE-WEBAUTH-VALIDATE",
  "X-APPLE-DS-WEB-SESSION-TOKEN",
]);

function lwpUnescape(value) {
  return String(value).replace(/\\(["\\])/g, "$1");
}

/* pyicloud writes an LWP cookiejar (`Set-Cookie3: name="value"; ...`).
 * Convert it to the Chrome cookie JSON that Cookie-Editor imports. */
function parseLwpCookies(text) {
  const cookies = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.startsWith("Set-Cookie3:")) continue;
    const rest = line.slice("Set-Cookie3:".length).trim();
    const first = /^([^=]+)=("(?:[^"\\]|\\.)*")/.exec(rest);
    if (!first) continue;
    const name = first[1].trim();
    const value = lwpUnescape(first[2].slice(1, -1));
    const pathMatch = /;\s*path=("(?:[^"\\]|\\.)*")/.exec(rest);
    const domainMatch = /;\s*domain=("(?:[^"\\]|\\.)*")/.exec(rest);
    const expiresMatch = /;\s*expires=("([^"]*)")/.exec(rest);
    const domain = domainMatch ? lwpUnescape(domainMatch[1].slice(1, -1)) : "";
    const cookiePath = pathMatch ? lwpUnescape(pathMatch[1].slice(1, -1)) : "/";
    const parsed = expiresMatch ? Date.parse(expiresMatch[2]) : NaN;
    const expires = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
    const secure = /;\s*secure(?:;|\s*$)/i.test(rest);
    cookies.push({
      domain,
      hostOnly: !domain.startsWith("."),
      httpOnly: HTTP_ONLY_COOKIES.has(name),
      name,
      path: cookiePath,
      sameSite: "no_restriction",
      secure,
      session: !expires,
      storeId: "0",
      value,
      ...(expires ? { expirationDate: expires } : {}),
    });
  }
  return cookies;
}

function stableSsid(email) {
  return crypto.createHash("sha256").update(String(email).toLowerCase()).digest("hex").slice(0, 16);
}

function netscapeCookies(cookies) {
  const lines = ["# Netscape HTTP Cookie File", "# for curl/other cookie tools", ""];
  for (const c of cookies) {
    lines.push(
      [c.domain, c.hostOnly ? "FALSE" : "TRUE", c.path || "/", c.secure ? "TRUE" : "FALSE",
        String(c.expirationDate || 0), c.name, c.value].join("\t")
    );
  }
  return lines.join("\n") + "\n";
}

export function createAdminRouter({
  storeFile,
  exportDir,
  sessionsDir = "./sessions",
  proxyUrl = "",
  password,
  secret = "",
  sessionHours = 168,
  warnings = [],
  health = null,
}) {
  const router = express.Router();
  const ttlMs = Math.max(1, sessionHours) * 3600_000;
  const failures = new Map(); // ip -> { count, until }
  const MAX_FAILURES = 10;
  const CLASSIFY_DIR = process.env.CLASSIFY_DIR || "/opt/icloud3/classify";
  // Formats with no browser decoder: served as a JPEG preview.
  const RAW_FORMAT = /\.(heic|heif|tiff?|bmp|dng|nef|cr2|cr3|arw|orf|rw2|raf|srw|psd)$/i;
  const WINDOW_MS = 15 * 60_000;

  function throttled(ip) {
    const entry = failures.get(ip);
    return Boolean(entry && entry.until > Date.now() && entry.count >= MAX_FAILURES);
  }

  function failed(ip) {
    const now = Date.now();
    const entry = failures.get(ip);
    if (!entry || entry.until <= now) {
      failures.set(ip, { count: 1, until: now + WINDOW_MS });
    } else {
      entry.count += 1;
      entry.until = now + WINDOW_MS;
    }
  }
  let cache = { mtimeMs: 0, accounts: new Map() };

  async function accounts() {
    try {
      const stat = await fs.stat(storeFile);
      if (stat.mtimeMs !== cache.mtimeMs) {
        const raw = JSON.parse(await fs.readFile(storeFile, "utf8"));
        const map = new Map();
        for (const account of raw.accounts ?? []) map.set(account.id, account);
        cache = { mtimeMs: stat.mtimeMs, accounts: map };
      }
    } catch {
      cache = { mtimeMs: cache.mtimeMs, accounts: new Map() };
    }
    return cache.accounts;
  }

  function current(req) {
    return verifySession(readCookie(req.headers.cookie), { password, secret });
  }

  function requireSession(req, res, next) {
    const session = current(req);
    if (!session.ok) return res.status(401).json({ ok: false, error: "unauthorized" });
    req.admin = session;
    next();
  }

  router.post("/login", (req, res) => {
    const ip = req.ip || "unknown";
    res.setHeader("cache-control", "no-store");
    if (throttled(ip)) {
      return res.status(429).json({ ok: false, error: "too many attempts; try again later" });
    }
    const given = String(req.body?.password ?? "");
    if (!isAdminPassword(given, password)) {
      failed(ip);
      return res.status(401).json({ ok: false, error: "wrong password" });
    }
    failures.delete(ip);
    const token = signSession({ password, secret, ttlMs });
    const secure =
      req.secure || String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https";
    res.setHeader("Set-Cookie", sessionCookie(token, ttlMs / 1000, secure));
    const { exp } = verifySession(token, { password, secret }) ?? {};
    res.json({ ok: true, expiresAt: exp ? new Date(exp).toISOString() : null, warnings });
  });

  router.post("/logout", (_req, res) => {
    res.setHeader("Set-Cookie", clearCookie());
    res.setHeader("cache-control", "no-store");
    res.json({ ok: true });
  });

  router.get("/session", (req, res) => {
    const session = current(req);
    if (!session.ok) return res.json({ ok: false });
    res.setHeader("cache-control", "no-store");
    res.json({ ok: true, expiresAt: new Date(session.exp).toISOString(), warnings });
  });

  router.use(requireSession);

  const collectHealth = typeof health === "function" ? health : createHealthCollector();

  router.get(
    "/health",
    asyncRoute(async (_req, res) => {
      res.setHeader("cache-control", "no-store");
      res.json(await collectHealth());
    }),
  );

  async function accountFor(req, res) {
    const map = await accounts();
    const account = map.get(req.params.id);
    if (!account) {
      res.status(404).json({ ok: false, error: "account not found" });
      return null;
    }
    let root = accountRoot(exportDir, account.email);
    if (!(await exportExists(root))) {
      const lower = accountRoot(exportDir, String(account.email).toLowerCase());
      if (lower !== root && (await exportExists(lower))) root = lower;
    }
    return { account, root };
  }

  function proxyFor(account) {
    const base = String(proxyUrl || "").trim();
    if (!base) return null;
    let parsed;
    try {
      parsed = new URL(/^[a-z]+:\/\//i.test(base) ? base : `http://${base}`);
    } catch {
      return null;
    }
    const rawUser = decodeURIComponent(parsed.username || "");
    const flags = rawUser
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part && !/^country_/i.test(part) && !/^session_/i.test(part));
    const country = String(account.proxy?.country || account.proxy?.requestedCountry || "").toUpperCase();
    const ssid = account.proxy?.ssid || stableSsid(account.email);
    if (country) flags.push(`country_${country}`);
    flags.push(`session_${ssid}`);
    const username = flags.join(",");
    const password = decodeURIComponent(parsed.password || "");
    const server = `http://${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
    return {
      server,
      username,
      password,
      country,
      ssid,
      url: `http://${username}:${password}@${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`,
    };
  }

  async function manualSession(account) {
    const raw = String(account.sessionDir || "");
    if (!raw) return { found: false, cookies: [], reason: "no session directory" };
    const dir = path.isAbsolute(raw)
      ? raw
      : path.resolve(sessionsDir, path.basename(raw));
    let names = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      return { found: false, cookies: [], dir, reason: "session directory not found" };
    }
    const file = names.filter((name) => name.endsWith(".cookiejar")).sort()[0];
    if (!file) return { found: false, cookies: [], dir, reason: "no cookiejar in session directory" };
    let rawCookies = "";
    try {
      rawCookies = await fs.readFile(path.join(dir, file), "utf8");
    } catch {
      return { found: false, cookies: [], dir, reason: "cookiejar unreadable" };
    }
    const cookies = parseLwpCookies(rawCookies);
    const token = cookies.find((cookie) => cookie.name === "X-APPLE-WEBAUTH-TOKEN");
    const fallbackExpiry = cookies.reduce(
      (max, cookie) => Math.max(max, cookie.expirationDate || 0),
      0
    );
    const expires = token?.expirationDate ?? (fallbackExpiry || null);
    return {
      found: cookies.length > 0,
      dir,
      file,
      cookies,
      expiresAt: expires ? new Date(expires * 1000).toISOString() : null,
      reason: cookies.length ? "" : "cookiejar has no cookies",
    };
  }

  router.get(
    "/accounts/:id/manual",
    asyncRoute(async (req, res) => {
      const map = await accounts();
      const account = map.get(req.params.id);
      if (!account) return res.status(404).json({ ok: false, error: "account not found" });
      const session = await manualSession(account);
      const cookies = session.cookies;
      const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
      res.setHeader("cache-control", "no-store");
      res.json({
        ok: true,
        account: {
          id: account.id,
          email: account.email,
          password: account.password || "",
          status: account.status || "",
          trusted: Boolean(account.trusted),
          sessionDir: account.sessionDir || "",
        },
        proxy: proxyFor(account),
        session: {
          found: session.found,
          file: session.file || "",
          dir: session.dir || "",
          expiresAt: session.expiresAt || null,
          reason: session.reason || "",
          count: cookies.length,
        },
        cookies,
        cookieHeader,
        netscape: cookies.length ? netscapeCookies(cookies) : "",
      });
    })
  );

  router.get(
    "/classify",
    asyncRoute(async (_req, res) => {
      // Written by python/classify_all.py and python/vlm_index.py: a label for
      // every photo, plus live progress while the classifier runs.
      const read = async (name) => {
        try {
          return JSON.parse(await fs.readFile(path.join(CLASSIFY_DIR, name), "utf8"));
        } catch {
          return null;
        }
      };
      const [index, progress] = await Promise.all([read("index.json"), read("progress.json")]);
      res.setHeader("cache-control", "no-store");
      res.json({
        ok: true,
        at: index?.at || "",
        classified: Number(index?.classified || 0),
        labels: index?.labels || {},
        accounts: index?.accounts || {},
        progress: progress || null,
      });
    })
  );

  router.get(
    "/accounts/:id/summary",
    asyncRoute(async (req, res) => {
      const found = await accountFor(req, res);
      if (!found) return;
      const { account, root } = found;
      const summary = await readSummary(root);
      res.setHeader("cache-control", "no-store");
      res.json({
        ok: true,
        account,
        exported: await exportExists(root),
        summary,
      });
    })
  );

  router.get(
    "/accounts/:id/tree",
    asyncRoute(async (req, res) => {
      const found = await accountFor(req, res);
      if (!found) return;
      const tree = await readTree(found.root, String(req.query.path ?? ""));
      if (!tree) return res.json({ ok: true, dirs: [], files: [], missing: true });
      res.setHeader("cache-control", "no-store");
      res.json({ ok: true, ...tree });
    })
  );

  router.get(
    "/accounts/:id/gallery",
    asyncRoute(async (req, res) => {
      const found = await accountFor(req, res);
      if (!found) return;
      const result = await gallery(found.root, {
        area: String(req.query.area ?? "Library"),
        q: String(req.query.q ?? ""),
        kind: String(req.query.kind ?? ""),
        page: numeric(req.query.page, 1, 1, 100000),
        pageSize: numeric(req.query.pageSize, 60, 0, 200000),
      });
      res.setHeader("cache-control", "no-store");
      res.json({ ok: true, ...result });
    })
  );

  router.get(
    "/accounts/:id/search",
    asyncRoute(async (req, res) => {
      const found = await accountFor(req, res);
      if (!found) return;
      const result = await search(found.root, {
        q: String(req.query.q ?? ""),
        kind: String(req.query.kind ?? "all"),
        tier: String(req.query.tier ?? ""),
        checksum: String(req.query.checksum ?? ""),
        words: numeric(req.query.words, 0, 0, 24),
        spam: String(req.query.spam ?? ""),
        all: String(req.query.all ?? ""),
        compact: String(req.query.compact ?? ""),
        page: numeric(req.query.page, 1, 1, 100000),
        pageSize: numeric(req.query.pageSize, 50, 1, 5000),
      });
      res.setHeader("cache-control", "no-store");
      res.json({ ok: true, ...result });
    })
  );

  // Local disk picture for the dashboard: how much of each account is on
  // this machine right now (cloud counts live in the account store), plus the
  // free space of the export disk, the overflow disk and the system disk.
  router.get(
    "/storage",
    requireSession,
    asyncRoute(async (_req, res) => {
      const map = await accounts();
      const withRoots = [];
      for (const account of map.values()) {
        let root = accountRoot(exportDir, account.email);
        if (!(await exportExists(root))) {
          const lower = accountRoot(exportDir, String(account.email).toLowerCase());
          if (lower !== root && (await exportExists(lower))) root = lower;
        }
        withRoots.push({
          id: account.id,
          root,
          livePhotos: Number((account.counts || {}).images || 0),
        });
      }
      const data = await localStorage(withRoots, exportDir, path.join(exportDir, "..", "export-overflow"));
      res.setHeader("cache-control", "no-store");
      res.json({ ok: true, ...data });
    })
  );

  router.get(
    "/visibility",
    requireSession,
    asyncRoute(async (_req, res) => {
      res.setHeader("cache-control", "no-store");
      res.json({ ok: true, rules: await loadRules() });
    })
  );

  router.post(
    "/visibility",
    requireSession,
    asyncRoute(async (req, res) => {
      const rules = await saveRules(req.body?.rules ?? []);
      res.json({ ok: true, rules });
    })
  );

  /* IP blocks: a blocked visitor is redirected to the entry's target. */
  router.get(
    "/blocks",
    requireSession,
    asyncRoute(async (_req, res) => {
      res.setHeader("cache-control", "no-store");
      res.json({ ok: true, blocks: await loadBlocks(), defaultTarget: DEFAULT_TARGET });
    })
  );

  router.post(
    "/blocks",
    requireSession,
    asyncRoute(async (req, res) => {
      try {
        const blocks = await addBlock(req.body || {});
        res.json({ ok: true, blocks });
      } catch (error) {
        res.status(400).json({ ok: false, error: error?.message || "invalid block" });
      }
    })
  );

  router.delete(
    "/blocks",
    requireSession,
    asyncRoute(async (req, res) => {
      const blocks = await removeBlock(String(req.query.ip ?? req.body?.ip ?? ""));
      res.json({ ok: true, blocks });
    })
  );

  router.get(
    "/library",
    requireSession,
    asyncRoute(async (req, res) => {
      const catalog = await buildCatalog({
        storeFile,
        exportDir,
        force: req.query.refresh === "1",
      });
      const visibility = await loadRules();
      res.setHeader("cache-control", "no-store");
      res.json({
        ok: true,
        ...queryCatalog(catalog, {
          type: String(req.query.type ?? "all"),
          q: String(req.query.q ?? ""),
          accountId: String(req.query.accountId ?? ""),
          area: String(req.query.area ?? "All"),
          tier: String(req.query.tier ?? ""),
          checksum: String(req.query.checksum ?? ""),
          words: numeric(req.query.words, 0, 0, 24),
          spam: String(req.query.spam ?? ""),
          kind: String(req.query.kind ?? ""),
          compact: String(req.query.compact ?? ""),
          cryptoKind: String(req.query.cryptoKind ?? ""),
          page: req.query.page,
          pageSize: req.query.pageSize,
          visibility,
        }),
      });
    })
  );

  router.get(
    "/accounts/:id/file",
    asyncRoute(async (req, res) => {
      const found = await accountFor(req, res);
      if (!found) return;
      const rel = String(req.query.path ?? "");
      if (!rel) return res.status(400).json({ ok: false, error: "path required" });
      const target = resolveWithin(found.root, rel);
      if (!target) return res.status(404).json({ ok: false, error: "not found" });
      let real = null;
      let stat = null;
      try {
        real = await realWithin(found.root, target);
        stat = real ? await fs.stat(real) : null;
      } catch {
        stat = null;
      }

      const missing = !stat || !stat.isFile();
      // Download=1 is an explicit "give me the untouched original"; every
      // other consumer wants pixels the browser can draw.
      const wantsOriginal = String(req.query.download ?? "") === "1";

      // Metadata probe (`preview=1`).  A pruned account has no local bytes,
      // but the extension already tells us what the file is.  Before this,
      // the route streamed a 5 MB HEIC here and the modal could not parse it.
      if (String(req.query.preview ?? "") === "1") {
        const type = missing ? contentType(rel) : contentType(real);
        res.setHeader("cache-control", "no-store");
        if (type.startsWith("image/")) return res.json({ ok: true, kind: "image", type });
        if (type.startsWith("video/")) return res.json({ ok: true, kind: "video", type });
        if (missing) return res.json({ ok: true, kind: "other", type });
        const textType =
          type.startsWith("text/") ||
          type.includes("json") ||
          type.includes("xml") ||
          type.includes("javascript");
        if (textType) {
          const head = await readHead(real, 200_000);
          return res.json({
            ok: true,
            kind: "text",
            type,
            text: head.toString("utf8"),
            truncated: stat.size > 200_000,
          });
        }
        const head = await readHead(real, 4096);
        if (head.length && !head.includes(0)) {
          try {
            new TextDecoder("utf-8", { fatal: true }).decode(head);
            const body = await readHead(real, 200_000);
            return res.json({
              ok: true,
              kind: "text",
              type: "text/plain",
              text: body.toString("utf8"),
              truncated: stat.size > 200_000,
            });
          } catch {
            // Binary after all; fall through.
          }
        }
        return res.json({ ok: true, kind: "other", type });
      }

      // HEIC/HEIF, TIFF, BMP and camera raw have no browser decoder.  Serve a
      // JPEG preview instead of the original bytes so every consumer — the
      // lightbox, the file modal, a plain link — gets pixels.  Download=1
      // still returns the untouched original.
      //
      // This runs BEFORE the S4 branch on purpose.  A pruned account keeps
      // only the bucket object; with the old ordering the route streamed raw
      // HEIC to the browser, so every photo went black after a prune.
      if (!wantsOriginal && RAW_FORMAT.test(rel)) {
        let remote = "";
        if (missing) remote = s4Enabled ? s4url(s4Key(found.account.email, rel)) : "";
        if (!missing || remote) {
          const preview = await ensurePreview(found.root, rel, 2400, 92, remote);
          if (preview) {
            const previewFile = path.join(found.root, preview);
            try {
              const info = await fs.stat(previewFile);
              res.setHeader("content-type", "image/jpeg");
              // no-cache + ETag: a browser that cached the raw HEIC from the
              // old ordering revalidates and receives the JPEG at once.
              res.setHeader("cache-control", "private, no-cache");
              res.setHeader("etag", `"p-${info.size}-${Math.floor(info.mtimeMs)}"`);
              res.setHeader("content-length", String(info.size));
              fsSync.createReadStream(previewFile).pipe(res);
              return;
            } catch {
              // fall through to the original bytes
            }
          }
          // Generation can fail on a camera raw Pillow cannot decode.  A
          // 640 px grid tile is still better than an empty frame.
          try {
            const tile = path.join(found.root, `Scan/thumbs/${rel}.jpg`);
            const info = await fs.stat(tile);
            res.setHeader("content-type", "image/jpeg");
            res.setHeader("cache-control", "private, max-age=604800");
            res.setHeader("content-length", String(info.size));
            fsSync.createReadStream(tile).pipe(res);
            return;
          } catch {
            // no cached tile either
          }
        }
      }

      // A pruned account keeps its bytes on S4.  Stream them through this
      // route so the URL stays stable (browser cache), range requests work
      // for video, and the lightbox never shows an empty frame.
      if (missing) {
        if (!s4Enabled) return res.status(404).json({ ok: false, error: "not found" });
        // A download goes straight to S4 with Content-Disposition; streaming
        // a multi-GB video through this process only to hand it to the browser
        // wastes the web tier's bandwidth.
        if (wantsOriginal) {
          const direct = s4DownloadUrl(s4Key(found.account.email, rel), path.basename(rel));
          if (direct) {
            res.setHeader("cache-control", "no-store");
            return res.redirect(302, direct);
          }
        }
        const signed = s4url(s4Key(found.account.email, rel));
        if (!signed) return res.status(404).json({ ok: false, error: "not found" });
        const upstreamHeaders = {};
        if (req.headers.range) upstreamHeaders.range = String(req.headers.range);
        const upstream = await fetch(signed, { headers: upstreamHeaders });
        if (!upstream.ok && upstream.status !== 206) {
          // The panel may ask for the cached-preview path directly
          // (Scan/previews/<original>.jpg).  When that object is not in the
          // bucket yet, build it from the original instead of 404ing.
          const cached = /^Scan\/previews\/(.+)\.jpg$/i.exec(rel);
          if (cached) {
            const preview = await ensurePreview(
              found.root,
              cached[1],
              2400,
              92,
              s4Enabled ? s4url(s4Key(found.account.email, cached[1])) : ""
            );
            if (preview) {
              try {
                const previewFile = path.join(found.root, preview);
                const info = await fs.stat(previewFile);
                res.setHeader("content-type", "image/jpeg");
                res.setHeader("cache-control", "private, no-cache");
                res.setHeader("etag", `"p-${info.size}-${Math.floor(info.mtimeMs)}"`);
                res.setHeader("content-length", String(info.size));
                fsSync.createReadStream(previewFile).pipe(res);
                return;
              } catch {
                // fall through to 404
              }
            }
          }
          return res.status(404).json({ ok: false, error: "not found" });
        }
        res.statusCode = upstream.status === 206 ? 206 : 200;
        for (const name of ["content-length", "content-range", "accept-ranges"]) {
          const value = upstream.headers.get(name);
          if (value) res.setHeader(name, value);
        }
        // The bucket stores many objects as application/octet-stream (rclone
        // does not set a type).  Without the right type a <video> refuses to
        // play and the preview says "no inline preview".
        const ours = contentType(rel);
        const upstreamType = upstream.headers.get("content-type") || "";
        res.setHeader(
          "content-type",
          ours !== "application/octet-stream" ? ours : upstreamType || "application/octet-stream"
        );
        if (!upstream.headers.get("accept-ranges")) res.setHeader("accept-ranges", "bytes");
        // A raw HEIC that failed to transcode must not be cached for a day:
        // the next request should try again and get the JPEG.
        res.setHeader(
          "cache-control",
          RAW_FORMAT.test(rel) ? "private, no-cache" : "private, max-age=86400"
        );
        if (wantsOriginal) {
          const name = path.basename(rel).replaceAll('"', "'");
          res.setHeader(
            "content-disposition",
            `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`
          );
        }
        Readable.fromWeb(upstream.body).pipe(res);
        return;
      }

      // Browsers require range requests to seek (and often to start) a
      // video.  The export files are large, so serve 206 partial content.
      res.setHeader("accept-ranges", "bytes");
      const size = stat.size;
      let start = 0;
      let end = Math.max(0, size - 1);
      let status = 200;
      const range = String(req.headers.range ?? "");
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) {
          res.statusCode = 416;
          res.setHeader("content-range", `bytes */${size}`);
          return res.end();
        }
        const [, from, to] = match;
        if (from === "" && to !== "") {
          start = Math.max(0, size - Number(to));
        } else {
          start = Number(from);
          end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
        }
        if (
          !Number.isFinite(start) ||
          !Number.isFinite(end) ||
          start > end ||
          start >= size
        ) {
          res.statusCode = 416;
          res.setHeader("content-range", `bytes */${size}`);
          return res.end();
        }
        status = 206;
      }
      res.statusCode = status;
      res.setHeader("content-type", contentType(real));
      res.setHeader("content-length", String(status === 206 ? end - start + 1 : size));
      res.setHeader("cache-control", "private, max-age=86400");
      res.setHeader("etag", `"${size}-${Math.floor(stat.mtimeMs)}"`);
      if (status === 206) {
        res.setHeader("content-range", `bytes ${start}-${end}/${size}`);
      }
      if (String(req.query.download ?? "") === "1") {
        const name = path.basename(real).replaceAll('"', "'");
        res.setHeader(
          "content-disposition",
          `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`
        );
      }
      const stream = fsSync.createReadStream(
        real,
        status === 206 ? { start, end } : undefined
      );
      stream.on("error", () => res.destroy());
      stream.pipe(res);
    })
  );

  // Raw file under the export root with its own path (used by the note HTML
  // preview: `assets/…` inside it resolves against this URL).
  router.get(
    "/accounts/:id/raw/*splat",
    asyncRoute(async (req, res) => {
      const found = await accountFor(req, res);
      if (!found) return;
      const parts = req.params.splat;
      const rel = (Array.isArray(parts) ? parts.join("/") : String(parts || ""))
        .split("/")
        .map((part) => decodeURIComponent(part))
        .join("/");
      if (!rel) return res.status(400).json({ ok: false, error: "path required" });
      const target = resolveWithin(found.root, rel);
      if (!target) return res.status(404).json({ ok: false, error: "not found" });
      const real = await realWithin(found.root, target);
      if (!real) return res.status(404).json({ ok: false, error: "not found" });
      let stat;
      try {
        stat = await fs.stat(real);
      } catch {
        return res.status(404).json({ ok: false, error: "not found" });
      }
      if (!stat.isFile()) return res.status(404).json({ ok: false, error: "not found" });
      res.setHeader("content-type", contentType(real));
      res.setHeader("content-length", String(stat.size));
      res.setHeader("cache-control", "private, max-age=300");
      const stream = fsSync.createReadStream(real);
      stream.on("error", () => res.destroy());
      stream.pipe(res);
    })
  );

  router.get(
    "/accounts/:id/thumb",
    asyncRoute(async (req, res) => {
      const found = await accountFor(req, res);
      if (!found) return;
      const rel = String(req.query.path ?? "");
      if (!rel) return res.status(400).json({ ok: false, error: "path required" });
      const target = resolveWithin(found.root, rel);
      if (!target) return res.status(404).json({ ok: false, error: "not found" });
      // A pruned account has no local original; its bytes live on S4.  The
      // tile still has to render, so generate the thumbnail from the signed
      // object instead of 404ing.
      let remote = "";
      try {
        const real = await realWithin(found.root, target);
        const stat = real ? await fs.stat(real) : null;
        if (!stat?.isFile()) throw new Error("missing");
      } catch {
        remote = s4Enabled ? s4url(s4Key(found.account.email, rel)) : "";
        if (!remote) return res.status(404).json({ ok: false, error: "not found" });
      }
      const thumb = await ensureThumb(
        found.root,
        rel,
        640,
        remote,
        remote ? s4url(s4Key(found.account.email, `Scan/thumbs/${rel}.jpg`)) : ""
      );
      if (!thumb) return res.status(404).json({ ok: false, error: "no thumbnail" });
      const file = path.join(found.root, thumb);
      let stat;
      try {
        stat = await fs.stat(file);
      } catch {
        return res.status(404).json({ ok: false, error: "not found" });
      }
      res.setHeader("content-type", "image/jpeg");
      res.setHeader("cache-control", "private, max-age=604800");
      res.setHeader("content-length", String(stat.size));
      const stream = fsSync.createReadStream(file);
      stream.on("error", () => res.destroy());
      stream.pipe(res);
    })
  );

  router.get(
    "/accounts/:id/preview",
    asyncRoute(async (req, res) => {
      const found = await accountFor(req, res);
      if (!found) return;
      const rel = String(req.query.path ?? "");
      if (!rel) return res.status(400).json({ ok: false, error: "path required" });
      const target = resolveWithin(found.root, rel);
      if (!target) return res.status(404).json({ ok: false, error: "not found" });
      let remote = "";
      try {
        const real = await realWithin(found.root, target);
        const stat = real ? await fs.stat(real) : null;
        if (!stat?.isFile()) throw new Error("missing");
      } catch {
        remote = s4Enabled ? s4url(s4Key(found.account.email, rel)) : "";
        if (!remote) return res.status(404).json({ ok: false, error: "not found" });
      }
      const preview = await ensurePreview(found.root, rel, 2400, 92, remote);
      // A camera raw Pillow cannot decode still has a grid tile; serve that
      // instead of an empty frame.
      const chosen = preview || (await ensureThumb(found.root, rel, 640, remote));
      if (!chosen) return res.status(404).json({ ok: false, error: "no preview" });
      const file = path.join(found.root, chosen);
      let stat;
      try {
        stat = await fs.stat(file);
      } catch {
        return res.status(404).json({ ok: false, error: "not found" });
      }
      res.setHeader("content-type", "image/jpeg");
      res.setHeader("cache-control", "private, max-age=604800");
      res.setHeader("content-length", String(stat.size));
      const stream = fsSync.createReadStream(file);
      stream.on("error", () => res.destroy());
      stream.pipe(res);
    })
  );

  router.use((error, _req, res, _next) => {
    console.error("[admin-api]", error?.message ?? error);
    if (!res.headersSent) res.status(500).json({ ok: false, error: "internal error" });
  });

  // Warm the catalog at start-up: the first visit otherwise waits ~20 s for
  // a full walk of every account.  Failure is harmless (the next request
  // builds it), so it stays off the request path.
  setTimeout(() => {
    buildCatalog({ storeFile, exportDir }).catch(() => {});
  }, 1_000).unref?.();

  return router;
}
