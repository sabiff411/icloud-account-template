import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCatalog, queryCatalog, accountsWithExport, invalidateCatalog } from "../admin/library.js";
import { safeName } from "../admin/export.js";
import { WorkerPool, shouldScanForOcr } from "../socket/worker-pool.js";

/* Cross-account catalog over a temporary export tree. */

const folder = fs.mkdtempSync(path.join(os.tmpdir(), "library-test-"));
const storeFile = path.join(folder, "items.json");
const exportDir = path.join(folder, "export");

const accounts = [
  { id: "alice-id", email: "alice@example.com", shortId: "alice", status: "connected", trusted: true, scan: { phase: "done" } },
  { id: "maria-id", email: "MariaJackson@example.com", shortId: "maria", status: "connected", trusted: true },
];
await fsp.writeFile(storeFile, JSON.stringify({ accounts }));

function root(email) {
  return path.join(exportDir, safeName(email));
}
async function write(file, body) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, body);
}

const alice = root("alice@example.com");
await write(
  path.join(alice, "Notes", "txt", "abcd1234_wallet.txt"),
  "wallet words: abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
);
await write(
  path.join(alice, "Contacts", "contacts.json"),
  JSON.stringify({
    me: {},
    contacts: [
      {
        firstName: "Bob",
        lastName: "Stone",
        phones: [{ field: "+15550001" }],
        emailAddresses: [{ field: "bob@example.com" }],
        notes: "met at work",
      },
    ],
  })
);
await write(
  path.join(alice, "Calendar", "calendars.json"),
  JSON.stringify({
    calendars: [{ guid: "home", title: "Home" }],
    events: [
      { title: "Dentist", startDate: [2026, 11, 9, 10, 30], pGuid: "home", location: "Clinic" },
    ],
  })
);
await write(path.join(alice, "Photos", "Library", "IMG_0001.jpg"), Buffer.from("one"));
await write(path.join(alice, "Photos", "Library", "IMG_0002.jpg"), Buffer.from("two"));
await write(path.join(alice, "Photos", "Library", "HEIC_1.HEIC"), Buffer.from("heic"));
await write(path.join(alice, "Scan", "thumbs", "Photos", "Library", "HEIC_1.HEIC.jpg"), Buffer.from("thumb"));
await write(path.join(alice, "Scan", "ocr", "Photos", "Library", "IMG_0001.jpg.txt"), "safe code 1234");
await write(
  path.join(alice, "Scan", "index.json"),
  JSON.stringify({
    entries: [
      {
        path: "Photos/Library/IMG_0001.jpg",
        area: "photos",
        kind: "image",
        name: "IMG_0001.jpg",
        text: "safe code 1234",
      },
    ],
  })
);
await write(
  path.join(alice, "Scan", "findings.json"),
  JSON.stringify({
    findings: [
      {
        file: "Photos/Library/IMG_0001.jpg",
        area: "photos",
        phrase: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        words: 12,
        tier: "high",
        checksum: true,
        source: "ocr",
      },
    ],
  })
);

const maria = root("MariaJackson@example.com");
await write(path.join(maria, "Notes", "txt", "ffff0000_private.txt"), "maria secret note");
await write(path.join(maria, "Photos", "Library", "MARIA_1.jpg"), Buffer.from("maria"));

invalidateCatalog();
const catalog = await buildCatalog({ storeFile, exportDir, force: true });
assert.equal(catalog.accounts.length, 2, "both accounts with an export root are indexed");
assert.equal(catalog.notes.length, 2);
assert.equal(catalog.contacts[0].emails[0], "bob@example.com");
assert.equal(catalog.calendar[0].title, "Dentist");
assert.equal(catalog.photos.find((item) => item.name === "IMG_0001.jpg").ocr, true);
assert.equal(catalog.photos.find((item) => item.name === "IMG_0002.jpg").ocr, false);
assert.equal(
  catalog.photos.find((item) => item.name === "HEIC_1.HEIC").thumb,
  "Scan/thumbs/Photos/Library/HEIC_1.HEIC.jpg"
);

const byText = queryCatalog(catalog, { type: "notes", q: "wallet" });
assert.equal(byText.items.length, 1);
assert.equal(byText.items[0].email, "alice@example.com");

const mixed = queryCatalog(catalog, { type: "notes", q: "maria" });
assert.equal(mixed.items[0].email, "MariaJackson@example.com");

const image = queryCatalog(catalog, { type: "photos", q: "safe code" });
assert.equal(image.items[0].name, "IMG_0001.jpg");

const pending = queryCatalog(catalog, { type: "photos", q: "IMG_0002" });
assert.equal(pending.items[0].ocr, false);

const onlyAlice = queryCatalog(catalog, { accountId: "alice-id", type: "all" });
assert.equal(onlyAlice.counts.notes, 1);
assert.ok(onlyAlice.counts.ocrDone >= 1 && onlyAlice.counts.ocrPending >= 1);

const targets = await accountsWithExport(
  [{ id: "m", email: "MariaJackson@example.com" }],
  exportDir
);
assert.equal(targets.length, 1);

assert.equal(shouldScanForOcr({ done: 0, at: 0 }, 199, 1_000_000), false);
assert.equal(shouldScanForOcr({ done: 0, at: 0 }, 200, 1_000_000), true);
assert.equal(shouldScanForOcr({ done: 500, at: 1_000_000 }, 600, 1_100_000), false);
assert.equal(shouldScanForOcr({ done: 500, at: 1_000_000 }, 600, 1_600_000), true);

const pool = Object.create(WorkerPool.prototype);
pool.store = { accounts: new Map([["m", { id: "m", email: "MariaJackson@example.com" }]]) };
pool.startScan = async () => ({ reused: true });
assert.deepEqual(await pool.startScanAll({ exportDir }), { queued: 0, reused: 1, failed: 0 });

invalidateCatalog();
fs.rmSync(folder, { recursive: true, force: true });
console.log("library test ok");
