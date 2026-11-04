import express from "express";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { geo } from "./geo/index.js";
import { clientIp, countryHeader } from "./ip.js";

/* The web process.  It has one job: serve the built React app and answer
 * /api/geo with the visitor's address + country.  Socket.IO is NOT here; it
 * runs in server/socket on its own port. */

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.json({ limit: "32kb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, env: config.env, proxyCount: geo.proxyCount });
  });

  app.get("/api/geo", async (req, res) => {
    const ip = clientIp(req);
    const result = await geo.lookup(ip, { headerCountry: countryHeader(req) });
    res.set("cache-control", "no-store").json({
      ...result,
      lookedUpAt: new Date().toISOString(),
    });
  });

  const dist = path.resolve(config.distDir);
  app.use(
    express.static(dist, {
      index: false,
      maxAge: config.env === "production" ? "1h" : 0,
    })
  );

  // SPA fallback: every non-API GET renders the React app.
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
    const index = path.join(dist, "index.html");
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
