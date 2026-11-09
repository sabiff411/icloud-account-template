import fs from "node:fs/promises";
import path from "node:path";
import { safeName } from "./export.js";

/* Cross-account catalog for the panel Library.
 *
 * The export tree is the source of truth: one directory per account, with
 * Notes/, Contacts/, Calendar/, Photos/ and the Scan/ cache.  Walking it on
 * every search is too slow at 58 GB, so this module builds the metadata once,
 * keeps note text and existing OCR text in memory, and caches it briefly.
 * Nothing here writes to an export. */

const TTL_MS = 120_000;
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
  const seeds = [];
  const scanText = new Map();

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

  for (const area of PHOTO_AREAS) {
    for (const file of await walk(path.join(root, "Photos", area))) {
      const suffix = path.extname(file).toLowerCase();
      if (!IMAGE_EXT.has(suffix) && !VIDEO_EXT.has(suffix)) continue;
      const rel = path.relative(root, file).split(path.sep).join("/");
      let stat = null;
      try {
        stat = await fs.stat(file);
      } catch {
        // keep going
      }
      const thumbRel = `Scan/thumbs/${rel}.jpg`;
      const ocrRel = `Scan/ocr/${rel}.txt`;
      const previewRel = `Scan/previews/${rel}.jpg`;
      const playRel = `Scan/play/${rel}.mp4`;
      const isVideo = VIDEO_EXT.has(suffix);
      const isHeic = suffix === ".heic" || suffix === ".heif";
      const ocr = await isFile(path.join(root, ocrRel));
      photos.push({
        ...base,
        path: rel,
        name: path.basename(file),
        area,
        size: stat?.size ?? 0,
        mtime: stat?.mtimeMs ?? 0,
        thumb: (await isFile(path.join(root, thumbRel))) ? thumbRel : "",
        preview:
          isHeic && (await isFile(path.join(root, previewRel))) ? previewRel : "",
        play: isVideo && (await isFile(path.join(root, playRel))) ? playRel : "",
        ocr,
        video: isVideo,
      });
    }
  }

  const index = await readJson(path.join(root, "Scan", "index.json"));
  const entries = Array.isArray(index) ? index : index?.entries ?? [];
  for (const entry of entries) {
    if (!entry?.path) continue;
    scanText.set(entry.path, String(entry.text ?? "").slice(0, NOTE_CAP));
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
    seeds.push({
      ...base,
      file: item.file ?? item.path ?? "",
      area: item.area ?? "",
      phrase: item.phrase ?? "",
      words: Number(item.words) || 0,
      tier: item.tier ?? "low",
      checksum: Boolean(item.checksum),
      source: item.source ?? "",
      snippet: item.snippet ?? "",
    });
  }

  return { notes, contacts, calendar, photos, seeds, scanText, scanned: Boolean(entries.length) || (await isFile(path.join(root, "Scan", "index.json"))) };
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
    seeds: [],
    ocr: new Map(),
    scannedAccounts: 0,
  };
  for (let index = 0; index < built.length; index += 1) {
    const item = built[index];
    const account = withRoots[index];
    catalog.notes.push(...item.notes);
    catalog.contacts.push(...item.contacts);
    catalog.calendar.push(...item.calendar);
    catalog.photos.push(...item.photos);
    catalog.seeds.push(...item.seeds);
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
  catalog.seeds.sort(
    (a, b) =>
      (TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9) ||
      a.phrase.localeCompare(b.phrase)
  );
  return catalog;
}

export function invalidateCatalog() {
  cache = { key: "", at: 0, data: null, promise: null };
}

/** Build or return the cached catalog.  One build runs at a time. */
export async function buildCatalog({ storeFile, exportDir, force = false } = {}) {
  const key = `${path.resolve(storeFile)}|${path.resolve(exportDir)}`;
  const now = Date.now();
  if (!force && cache.data && cache.key === key && now - cache.at < TTL_MS) {
    return cache.data;
  }
  if (cache.promise && cache.key === key) return cache.promise;
  cache = { key, at: cache.at, data: cache.data, promise: build({ storeFile, exportDir }) };
  try {
    const data = await cache.promise;
    cache = { key, at: Date.now(), data, promise: null };
    return data;
  } catch (error) {
    cache = { key, at: 0, data: null, promise: null };
    throw error;
  }
}

function isNeedle(value, needle) {
  return !needle || String(value ?? "").toLowerCase().includes(needle);
}

function pageOf(list, page, size) {
  const pages = Math.max(1, Math.ceil(list.length / size));
  const current = Math.min(Math.max(Number(page) || 1, 1), pages);
  const offset = (current - 1) * size;
  return { items: list.slice(offset, offset + size), total: list.length, page: current, pages };
}

export function queryCatalog(catalog, { type = "all", q = "", accountId = "", area = "All", page = 1, pageSize = 0 } = {}) {
  const needle = String(q ?? "").trim().toLowerCase();
  const scope = (item) => !accountId || item.accountId === accountId;
  const inScope = accountId ? (list) => list.filter(scope) : (list) => list;
  const scopedPhotos = inScope(catalog.photos);
  const counts = {
    accounts: catalog.accounts.length,
    notes: inScope(catalog.notes).length,
    contacts: inScope(catalog.contacts).length,
    calendar: inScope(catalog.calendar).length,
    photos: scopedPhotos.length,
    seeds: inScope(catalog.seeds).length,
    scannedAccounts: catalog.scannedAccounts ?? 0,
    ocrDone: scopedPhotos.filter((photo) => photo.ocr).length,
    ocrPending: scopedPhotos.filter((photo) => !photo.ocr).length,
    scanning: catalog.accounts.filter((account) => account.scanPhase === "running").length,
  };

  const notes = catalog.notes.filter((item) => {
    if (!scope(item)) return false;
    if (!needle) return true;
    return isNeedle(`${item.title} ${item.name} ${item.text}`, needle);
  });
  const contacts = catalog.contacts.filter((item) => {
    if (!scope(item)) return false;
    if (!needle) return true;
    return isNeedle(
      [item.name, ...item.phones, ...item.emails, item.company, item.note].join(" "),
      needle
    );
  });
  const calendar = catalog.calendar.filter((item) => {
    if (!scope(item)) return false;
    if (!needle) return true;
    return isNeedle([item.title, item.when, item.notes].join(" "), needle);
  });
  const wantsArea = area && area !== "All";
  const photos = catalog.photos
    .filter((item) => {
      if (!scope(item)) return false;
      if (wantsArea && item.area !== area) return false;
      if (!needle) return true;
      const body = catalog.ocr.get(`${item.accountId}:${item.path}`) ?? "";
      return isNeedle(`${item.name} ${body}`, needle);
    })
    .map((item) => {
      const body = catalog.ocr.get(`${item.accountId}:${item.path}`) ?? "";
      return { ...item, snippet: needle ? snippet(body, needle) : "" };
    });
  const seeds = catalog.seeds.filter((item) => {
    if (!scope(item)) return false;
    if (!needle) return true;
    return isNeedle(`${item.phrase} ${item.file} ${item.area}`, needle);
  });

  const totals = {
    notes: notes.length,
    contacts: contacts.length,
    calendar: calendar.length,
    photos: photos.length,
    seeds: seeds.length,
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
      },
      total: totals.notes + totals.contacts + totals.calendar + totals.photos + totals.seeds,
      page: 1,
      pages: 1,
    };
  }
  if (type === "notes") return { ...common, ...pageOf(notes, page, Number(pageSize) || TEXT_PAGE) };
  if (type === "contacts") return { ...common, ...pageOf(contacts, page, Number(pageSize) || TEXT_PAGE) };
  if (type === "calendar") return { ...common, ...pageOf(calendar, page, Number(pageSize) || TEXT_PAGE) };
  if (type === "photos") return { ...common, ...pageOf(photos, page, Number(pageSize) || PHOTO_PAGE) };
  if (type === "seeds") return { ...common, ...pageOf(seeds, page, Number(pageSize) || TEXT_PAGE) };
  return { ...common, items: [], total: 0, page: 1, pages: 1 };
}
