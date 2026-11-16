import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCatalog, queryCatalog, accountsWithExport, invalidateCatalog, cryptoMatch } from "../admin/library.js";
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
await write(path.join(alice, "Drive", "Crypto Jahresauszug.pdf"), Buffer.from("pdf"));
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
      {
        path: "Drive/Crypto Jahresauszug.pdf",
        area: "drive",
        kind: "file",
        name: "Crypto Jahresauszug.pdf",
        text: "Bitcoin wallet balance and seed phrase backup",
        mtime: 1000,
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
        phrase: "again empty warm hip fat allow broccoli turn finger insane hunt service",
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
assert.equal(catalog.crypto.length, 3, "one seed, the wallet note and one Drive match");
assert.ok(catalog.crypto.some((item) => item.kind === "seed" && item.signal === "seed"));
assert.ok(
  catalog.crypto.some(
    (item) => item.source === "Drive" && item.path === "Drive/Crypto Jahresauszug.pdf" && item.email === "alice@example.com"
  )
);
assert.ok(
  catalog.crypto.some((item) => item.kind === "note" && item.source === "Notes" && item.matched === "wallet")
);
assert.equal(catalog.cryptoAccounts.length, 1, "one account has crypto signals");
assert.equal(catalog.cryptoAccounts[0].seeds, 1);
assert.equal(catalog.cryptoAccounts[0].notes, 1);
assert.equal(catalog.cryptoAccounts[0].files, 1);
assert.ok(catalog.cryptoAccounts[0].signals.some((signal) => signal.name === "seed"));

const cryptoDrive = queryCatalog(catalog, { type: "crypto", q: "bitcoin" });
assert.equal(cryptoDrive.items.length, 1);
assert.equal(cryptoDrive.items[0].path, "Drive/Crypto Jahresauszug.pdf");
assert.equal(cryptoDrive.counts.crypto, 3);
assert.equal(cryptoDrive.summary.length, 1);

const cryptoAll = queryCatalog(catalog, { type: "crypto" });
assert.equal(cryptoAll.items.length, 3);
assert.equal(cryptoAll.items[0].kind, "seed", "seeds come first");

assert.equal(cryptoMatch("addr bc1q8azd2dx6hfu9dm5456fxm073399lv9d7fq99w0").signal, "address");
assert.equal(cryptoMatch("id 367e8e8d273b4beca12ae31ad77989db"), null, "UUID is not a BTC address");
assert.equal(cryptoMatch("Bison").signal, "exchange");
assert.equal(cryptoMatch("BTC").signal, "ticker");
assert.equal(cryptoMatch("Sparplan").signal, "trading");
assert.equal(cryptoMatch("plain quarterly report"), null);

const cryptoNotes = queryCatalog(catalog, { type: "crypto", cryptoKind: "note" });
assert.equal(cryptoNotes.items.length, 1);
assert.equal(cryptoNotes.items[0].kind, "note");

const verifiedSeeds = queryCatalog(catalog, { type: "seeds", checksum: "valid" });
assert.equal(verifiedSeeds.items.length, 1);
assert.equal(verifiedSeeds.items[0].checksum, true);
assert.equal(queryCatalog(catalog, { type: "seeds", checksum: "failed" }).items.length, 0);
assert.equal(queryCatalog(catalog, { type: "seeds", words: 15 }).items.length, 0);

const seedCopy = queryCatalog(catalog, { type: "seeds", checksum: "valid", compact: "1" });
assert.equal(seedCopy.items.length, 0);
assert.match(seedCopy.lines, /checksum valid\t12 words/);

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

// Global export waves: notes first, lightest account first, then small.
const waveCalls = [];
const waves = Object.create(WorkerPool.prototype);
waves.store = { accounts: new Map(), activeJobForAccount: () => null };
waves.wave = null;
waves.waveAccounts = new Map();
waves.startExport = async (id, options) => {
  waveCalls.push({ id, ...options });
  return { reused: false };
};
const first = waves.startExportWaves([
  { id: "a", email: "a@example.com", trusted: true, hidden: false, status: "connected", counts: { photos: 500, notes: 2 } },
  { id: "b", email: "b@example.com", trusted: true, hidden: false, status: "connected", counts: { photos: 1, notes: 2 } },
]);
assert.equal(first.mode, "notes");
assert.deepEqual(waveCalls.slice(0, 2).map((call) => call.id), ["b", "a"]);
waves.onWaveJobDone({ type: "export", accountId: "b", payload: { wave: true, mode: "notes" } });
waves.onWaveJobDone({ type: "export", accountId: "a", payload: { wave: true, mode: "notes" } });
assert.equal(waves.wave.mode, "small");
assert.ok(waveCalls.some((call) => call.mode === "small"));

invalidateCatalog();
fs.rmSync(folder, { recursive: true, force: true });
console.log("library test ok");
