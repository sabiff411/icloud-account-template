import http from "node:http";
import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createGate } from "../gate.js";

const IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1";
const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const BROWSER = {
  accept: "text/html,application/xhtml+xml",
  "accept-language": "en-US,en;q=0.9",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
  "upgrade-insecure-requests": "1",
};

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

async function boot(overrides = {}) {
  const app = express();
  app.use(
    createGate({
      mode: "http",
      botQuiet: true,
      adminToken: "opensesame",
      adminIps: [],
      adminPath: "/admin",
      decoyUrl: "https://decoy.test/",
      timeoutMs: 300,
      bindUa: false,
      bindDevice: false,
      bindFp: false,
      suspectMode: "decoy",
      suspectThreshold: 3,
      sessionHours: 12,
      ...overrides,
    }),
  );
  app.use((_req, res) => res.type("html").send("<title>Apple Account</title>PAGE"));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, server };
}

test("a known bot gets a 404, never the page", async (t) => {
  const app = await boot();
  t.after(() => app.server.close());
  const res = await get(`${app.base}/`, { "user-agent": GOOGLEBOT, ...BROWSER });
  assert.equal(res.status, 404);
  assert.match(res.body, /Not Found/);
  assert.doesNotMatch(res.body, /PAGE/);
  assert.match(String(res.headers["x-robots-tag"]), /noindex/);
});

test("a visitor without a pass also sees a removed page", async (t) => {
  const app = await boot();
  t.after(() => app.server.close());
  const res = await get(`${app.base}/sign-in`, { "user-agent": IOS, ...BROWSER });
  assert.equal(res.status, 404);
  assert.match(res.body, /Not Found/);
  assert.doesNotMatch(res.body, /PAGE/);
});

test("robots.txt and an empty sitemap keep crawlers out", async (t) => {
  const app = await boot();
  t.after(() => app.server.close());
  let res = await get(`${app.base}/robots.txt`);
  assert.equal(res.status, 200);
  assert.match(res.body, /Disallow: \//);
  res = await get(`${app.base}/sitemap.xml`);
  assert.equal(res.status, 200);
  assert.match(res.body, /<urlset/);
  assert.doesNotMatch(res.body, /<url>/);
});

test("the admin token still opens the page", async (t) => {
  const app = await boot();
  t.after(() => app.server.close());
  const res = await get(`${app.base}/?gate=opensesame`, { "user-agent": IOS, ...BROWSER });
  assert.equal(res.status, 302);
  assert.doesNotMatch(String(res.headers.location), /gate=/);
  const cookie = (res.headers["set-cookie"] || []).map((c) => String(c).split(";")[0]).join("; ");
  assert.ok(cookie);
  const page = await get(`${app.base}/`, { "user-agent": IOS, ...BROWSER, cookie });
  assert.equal(page.status, 200);
  assert.match(page.body, /PAGE/);
});
