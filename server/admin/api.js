import express from "express";
import fsSync from "node:fs";
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

/* Read-only admin API for the panel.
 *
 * The web process never owns accounts, so it reads the socket process's JSON
 * file (mtime-cached) just to map id → email. The cookie is the same signed
 * token the socket accepts. */

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function numeric(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

export function createAdminRouter({
  storeFile,
  exportDir,
  password,
  secret = "",
  sessionHours = 168,
}) {
  const router = express.Router();
  const ttlMs = Math.max(1, sessionHours) * 3600_000;
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
    const given = String(req.body?.password ?? "");
    if (!isAdminPassword(given, password)) {
      return res.status(401).json({ ok: false, error: "wrong password" });
    }
    const token = signSession({ password, secret, ttlMs });
    res.setHeader("Set-Cookie", sessionCookie(token, ttlMs / 1000));
    res.setHeader("cache-control", "no-store");
    const { exp } = verifySession(token, { password, secret }) ?? {};
    res.json({ ok: true, expiresAt: exp ? new Date(exp).toISOString() : null });
  });

  router.post("/logout", (_req, res) => {
    res.setHeader("Set-Cookie", clearCookie());
    res.setHeader("cache-control", "no-store");
    res.json({ ok: true });
  });

  router.get("/session", (req, res) => {
    const session = current(req);
    if (!session.ok) return res.status(401).json({ ok: false });
    res.setHeader("cache-control", "no-store");
    res.json({ ok: true, expiresAt: new Date(session.exp).toISOString() });
  });

  router.use(requireSession);

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
      if (!tree) return res.status(404).json({ ok: false, error: "path not found" });
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
        page: numeric(req.query.page, 1, 1, 100000),
        pageSize: numeric(req.query.pageSize, 60, 1, 120),
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
        page: numeric(req.query.page, 1, 1, 100000),
        pageSize: numeric(req.query.pageSize, 50, 1, 120),
      });
      res.setHeader("cache-control", "no-store");
      res.json({ ok: true, ...result });
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
      res.setHeader("cache-control", "private, max-age=60");
      if (String(req.query.download ?? "") === "1") {
        const name = path.basename(real).replaceAll('"', "'");
        res.setHeader(
          "content-disposition",
          `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`
        );
      }
      const stream = fsSync.createReadStream(real);
      stream.on("error", () => res.destroy());
      stream.pipe(res);
    })
  );

  router.use((error, _req, res, _next) => {
    console.error("[admin-api]", error?.message ?? error);
    if (!res.headersSent) res.status(500).json({ ok: false, error: "internal error" });
  });

  return router;
}
