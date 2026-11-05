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
const email = "alice@example.com";
const root = path.join(exportDir, safeName(email));

await fsp.mkdir(path.join(root, "Photos", "Library"), { recursive: true });
await fsp.mkdir(path.join(root, "Photos", "Hidden"), { recursive: true });
await fsp.mkdir(path.join(root, "Notes", "txt"), { recursive: true });
await fsp.mkdir(path.join(root, "Contacts"), { recursive: true });
await fsp.mkdir(path.join(root, "Drive"), { recursive: true });
await fsp.mkdir(path.join(root, "Scan"), { recursive: true });

await fsp.writeFile(path.join(root, "Photos", "Library", "IMG_0001.jpg"), Buffer.from("jpeg-one"));
await fsp.writeFile(path.join(root, "Photos", "Library", "IMG_0002.jpg"), Buffer.from("jpeg-two"));
await fsp.writeFile(path.join(root, "Photos", "Hidden", "HIDDEN_1.jpg"), Buffer.from("hidden"));
await fsp.writeFile(path.join(root, "Drive", "report.txt"), "quarterly report\nrevenue up\n");
await fsp.writeFile(path.join(root, "Drive", "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
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

const valid = await search(root, { kind: "seed", tier: "valid" });
assert.equal(valid.seeds.length, 1);
assert.equal(valid.seeds[0].checksum, true);

/* ------------------------------------------------------------------- HTTP */

const app = express();
app.use(express.json());
app.use(
  "/api/admin",
  createAdminRouter({
    storeFile,
    exportDir,
    password: "panel-pw",
    secret: "test-secret",
    sessionHours: 1,
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
assert.equal(anon.status, 401, "session needs a cookie");

const bad = await request("POST", "/api/admin/login", { password: "nope" });
assert.equal(bad.status, 401);

const login = await request("POST", "/api/admin/login", { password: "panel-pw" });
assert.equal(login.status, 200);
assert.equal(login.payload.ok, true);
assert.ok(cookie.startsWith("ic_admin="));

const session = await request("GET", "/api/admin/session");
assert.equal(session.status, 200);
assert.equal(session.payload.ok, true);

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
assert.equal(traversal.status, 404);

const file = await request(
  "GET",
  "/api/admin/accounts/acct-1/file?path=" + encodeURIComponent("Photos/Library/IMG_0001.jpg")
);
assert.equal(file.status, 200);
assert.equal(file.headers.get("content-type"), "image/jpeg");
assert.equal(Buffer.from(file.payload).toString(), "jpeg-one");

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

const allMedia = await request("GET", "/api/admin/accounts/acct-1/gallery?area=All&page=1&pageSize=60");
assert.equal(allMedia.payload.total, 3, "All spans Library + Hidden");
assert.deepEqual(
  [...new Set(allMedia.payload.items.map((item) => item.area))].sort(),
  ["Hidden", "Library"]
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

const out = await request("POST", "/api/admin/logout");
assert.equal(out.status, 200);
const after = await request("GET", "/api/admin/session");
assert.equal(after.status, 401);

server.close();
fs.rmSync(folder, { recursive: true, force: true });
console.log("admin api test ok");
