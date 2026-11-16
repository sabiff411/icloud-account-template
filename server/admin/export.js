import fs from "node:fs/promises";
import path from "node:path";
import { dedupeSeeds, filterSeeds, seedLabel } from "./seeds.js";
import { thumbRel } from "./thumbs.js";
import { s4exists, s4Key, s4url } from "./s4.js";

/* Read-only access to one account's export tree.
 *
 * Every path is resolved inside the account root and symlinks are resolved
 * again before a file is served, so neither `../` nor a link can escape
 * export/<email>. Nothing here writes. */

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
  ".dng",
]);
const VIDEO_EXT = new Set([".mov", ".mp4", ".m4v", ".3gp"]);
const MEDIA_EXT = new Set([...IMAGE_EXT, ...VIDEO_EXT]);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".avif": "image/avif",
  ".dng": "image/x-adobe-dng",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".3gp": "video/3gpp",
};

/** Mirror the exporter's Python `safe_name` so paths match on disk. */
export function safeName(value, fallback = "unnamed") {
  const name = String(value ?? "")
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, "_")
    .replace(/^[ .]+|[ .]+$/g, "")
    .slice(0, 120);
  return name || fallback;
}

export function safeEmail(email) {
  // Preserve case like the Python exporter's safe_name; accountRoot falls
  // back to the lowercase directory when an older export used it.
  return safeName(String(email ?? "").trim(), "account");
}

export function accountRoot(exportDir, email) {
  return path.resolve(String(exportDir || "./export"), safeEmail(email));
}

/** Resolve `rel` under `root`; null when it escapes. */
export function resolveWithin(root, rel) {
  const base = path.resolve(root);
  const cleaned = String(rel ?? "").replace(/^[/\\]+/, "");
  const target = path.resolve(base, cleaned || ".");
  if (target === base) return target;
  return target.startsWith(base + path.sep) ? target : null;
}

/** Resolve symlinks and require the real path to stay inside the root. */
export async function realWithin(root, target) {
  try {
    const realRoot = await fs.realpath(root);
    const real = await fs.realpath(target);
    if (real === realRoot) return real;
    return real.startsWith(realRoot + path.sep) ? real : null;
  } catch {
    return null;
  }
}

export function contentType(file) {
  return TYPES[path.extname(String(file)).toLowerCase()] ?? "application/octet-stream";
}

function relPosix(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function byName(a, b) {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

function isMedia(name) {
  return MEDIA_EXT.has(path.extname(name).toLowerCase());
}

/** Directory listing for the Drive/Notes/Photos tree. */
/** Directory listing rebuilt from the manifest (local bytes pruned). */
function treeFromManifest(manifest, rel) {
  const prefix = rel ? `${String(rel).replace(/\/+$/, "")}/` : "";
  const dirs = new Map();
  const files = [];
  for (const entry of manifest) {
    if (!entry.p || !entry.p.startsWith(prefix)) continue;
    const rest = entry.p.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash < 0) {
      files.push({
        name: rest,
        path: entry.p,
        size: entry.s,
        mtime: entry.m,
        media: isMedia(rest),
      });
    } else {
      const name = rest.slice(0, slash);
      if (!dirs.has(name)) dirs.set(name, { name, path: `${prefix}${name}` });
    }
  }
  return { base: rel, dirs: [...dirs.values()].sort(byName), files: files.sort(byName) };
}

export async function readTree(root, rel = "") {
  const dir = resolveWithin(root, rel);
  if (!dir) return null;
  const real = await realWithin(root, dir);
  let entries = null;
  if (real) {
    try {
      entries = await fs.readdir(real, { withFileTypes: true });
    } catch {
      entries = null;
    }
  }
  const manifest = await manifestFiles(root);
  if ((!entries || entries.length === 0) && manifest) {
    const rebuilt = treeFromManifest(manifest, rel);
    if (rebuilt.dirs.length || rebuilt.files.length) return rebuilt;
  }
  if (!entries) return null;
  const baseRel = relPosix(root, dir);
  const dirs = [];
  const files = [];
  await Promise.all(
    entries.map(async (entry) => {
      const join = (name) => (baseRel ? `${baseRel}/${name}` : name);
      if (entry.isDirectory()) {
        dirs.push({ name: entry.name, path: join(entry.name) });
        return;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) return;
      try {
        const stat = await fs.stat(path.join(real, entry.name));
        files.push({
          name: entry.name,
          path: join(entry.name),
          size: stat.size,
          mtime: stat.mtimeMs,
          media: isMedia(entry.name),
        });
      } catch {
        // A file that vanished between readdir and stat is not an error.
      }
    })
  );
  dirs.sort(byName);
  files.sort(byName);
  return { path: baseRel, dirs, files };
}

async function fileExists(file) {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function thumbFor(root, rel) {
  const thumb = path.join(root, "Scan", "thumbs", `${rel}.jpg`);
  try {
    const stat = await fs.stat(thumb);
    if (stat.isFile()) return relPosix(root, thumb);
  } catch {
    // No thumbnail yet: the UI falls back to the original.
  }
  return "";
}

/** Larger JPEG for HEIC/HEIF; browsers cannot decode the original. */
async function previewFor(root, rel) {
  const preview = path.join(root, "Scan", "previews", `${rel}.jpg`);
  try {
    const stat = await fs.stat(preview);
    if (stat.isFile()) return relPosix(root, preview);
  } catch {
    // No preview yet.
  }
  return "";
}

/** H.264/AAC playback proxy for HEVC phone videos. */
async function playFor(root, rel) {
  const play = path.join(root, "Scan", "play", `${rel}.mp4`);
  try {
    const stat = await fs.stat(play);
    if (stat.isFile()) return relPosix(root, play);
  } catch {
    // No proxy yet.
  }
  return "";
}

/** S4 delivery links for one item, only for objects already mirrored. */
async function s4Links(email, rel, thumb, preview, play, skipCheck = false) {
  if (skipCheck) {
    return {
      src: rel ? s4url(s4Key(email, rel)) : "",
      thumbSrc: thumb ? s4url(s4Key(email, thumb)) : "",
      previewSrc: preview ? s4url(s4Key(email, preview)) : "",
      playSrc: play ? s4url(s4Key(email, play)) : "",
    };
  }
  const [src, thumbSrc, previewSrc, playSrc] = await Promise.all([
    s4exists(s4Key(email, rel)).then((ok) => (ok ? s4url(s4Key(email, rel)) : "")),
    thumb
      ? s4exists(s4Key(email, thumb)).then((ok) => (ok ? s4url(s4Key(email, thumb)) : ""))
      : Promise.resolve(""),
    preview
      ? s4exists(s4Key(email, preview)).then((ok) => (ok ? s4url(s4Key(email, preview)) : ""))
      : Promise.resolve(""),
    play
      ? s4exists(s4Key(email, play)).then((ok) => (ok ? s4url(s4Key(email, play)) : ""))
      : Promise.resolve(""),
  ]);
  return { src, thumbSrc, previewSrc, playSrc };
}

/** True once the account is provably complete on S4 (written by the prune). */
const s4DoneCache = new Map();
async function s4Done(root) {
  const cached = s4DoneCache.get(root);
  if (cached && Date.now() - cached.at < 120_000) return cached.ok;
  let ok = false;
  try {
    ok = (await fs.stat(path.join(root, "Scan", "s4-complete.json"))).isFile();
  } catch {
    ok = false;
  }
  s4DoneCache.set(root, { ok, at: Date.now() });
  return ok;
}

const thumbRelFor = (rel) => `Scan/thumbs/${rel}.jpg`;

/** Media listing written before the local bytes were pruned. */
const manifestCache = new Map();
async function manifestFiles(root) {
  const cached = manifestCache.get(root);
  if (cached && Date.now() - cached.at < 60_000) return cached.files;
  let files = null;
  try {
    const data = JSON.parse(await fs.readFile(path.join(root, "Scan", "s4-manifest.json"), "utf8"));
    files = Array.isArray(data?.files) ? data.files : null;
  } catch {
    files = null;
  }
  manifestCache.set(root, { at: Date.now(), files });
  return files;
}

/** Recursively list files under dir (Drive media). */
async function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}


/* --- listing caches -------------------------------------------------------
 * The gallery used to readdir + stat every file (and walk the whole Drive
 * tree) on every request; with 60k photos that made the panel feel frozen.
 * Listings are cached and only rebuilt when the directory mtime changes. */
const dirCache = new Map();
const driveCache = new Map();
const jsonCache = new Map();

async function listDir(real) {
  let stat = null;
  try {
    stat = await fs.stat(real);
  } catch {
    return [];
  }
  const cached = dirCache.get(real);
  if (cached && cached.mtimeMs === stat.mtimeMs && Date.now() - cached.at < 60_000) {
    return cached.entries;
  }
  let names = [];
  try {
    names = await fs.readdir(real);
  } catch {
    return [];
  }
  const entries = [];
  for (const name of names) {
    try {
      const info = await fs.stat(path.join(real, name));
      if (info.isFile()) entries.push({ name, size: info.size, mtime: info.mtimeMs });
    } catch {
      // vanished during listing
    }
  }
  dirCache.set(real, { at: Date.now(), mtimeMs: stat.mtimeMs, entries });
  return entries;
}

async function driveFiles(root) {
  const cached = driveCache.get(root);
  if (cached && Date.now() - cached.at < 120_000) return cached.files;
  const files = await walkFiles(path.join(root, "Drive"));
  driveCache.set(root, { at: Date.now(), files });
  return files;
}

async function cachedJson(file) {
  const cached = jsonCache.get(file);
  // The classifier refreshes vlm-index.json every minute; a 15 s window keeps
  // the type filter close to live without re-reading the file per tile page.
  if (cached && Date.now() - cached.at < 15_000) return cached.value;
  const value = await readJson(file, {});
  jsonCache.set(file, { at: Date.now(), value });
  return value;
}

/** One page of photos. `area` may be "All" (Library + Hidden + Deleted + Drive). */
export async function gallery(root, { area = "All", q = "", kind = "", page = 1, pageSize = 60 } = {}) {
  const requested = String(area || "All").replace(/[\\/]+/g, "_");
  const segments =
    requested.toLowerCase() === "all"
      ? ["Library", "Hidden", "Recently Deleted"]
      : [requested];
  const wantsDrive = requested.toLowerCase() === "all" || requested.toLowerCase() === "drive";
  const needle = String(q || "").trim().toLowerCase();
  const collected = [];
  let kinds = {};
  try {
    kinds = (await cachedJson(path.join(root, "Scan", "vlm-index.json"))) || {};
  } catch {
    kinds = {};
  }

  const manifest = await manifestFiles(root);
  for (const segment of segments) {
    const rel = `Photos/${segment}`;
    const seen = new Set();
    if (manifest) {
      const prefix = `Photos/${segment}/`;
      for (const entry of manifest) {
        if (!entry.p.startsWith(prefix)) continue;
        const name = path.basename(entry.p);
        if (!isMedia(name)) continue;
        if (needle && !name.toLowerCase().includes(needle)) continue;
        seen.add(entry.p);
        collected.push({
          name,
          size: entry.s,
          mtime: entry.m,
          area: segment,
          path: entry.p,
          kind: kinds[entry.p]?.kind ?? "",
        });
      }
    }
    // Always merge the directory on disk: the manifest is regenerated in
    // batches, and a file that finished downloading a second ago must already
    // be visible.  Listing is cached on the directory mtime.
    const dir = resolveWithin(root, rel);
    if (!dir) continue;
    const real = await realWithin(root, dir);
    if (!real) continue;
    const entries = await listDir(real);
    for (const entry of entries) {
      if (!isMedia(entry.name)) continue;
      if (needle && !entry.name.toLowerCase().includes(needle)) continue;
      const key = `${rel}/${entry.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push({ ...entry, area: segment, path: key, kind: kinds[key]?.kind ?? "" });
    }
  }

  if (wantsDrive) {
    const seen = new Set();
    if (manifest) {
      for (const entry of manifest) {
        if (!entry.p.startsWith("Drive/")) continue;
        if (!isMedia(entry.p)) continue;
        if (needle && !entry.p.toLowerCase().includes(needle)) continue;
        seen.add(entry.p);
        collected.push({
          name: path.basename(entry.p),
          size: entry.s,
          mtime: entry.m,
          area: "Drive",
          path: entry.p,
          kind: kinds[entry.p]?.kind ?? "",
        });
      }
    }
    for (const file of await driveFiles(root)) {
      const suffix = path.extname(file).toLowerCase();
      if (!IMAGE_EXT.has(suffix) && !VIDEO_EXT.has(suffix)) continue;
      if (needle && !file.toLowerCase().includes(needle)) continue;
      const rel = relPosix(root, file);
      if (seen.has(rel)) continue;
      seen.add(rel);
      let stat = null;
      try {
        stat = await fs.stat(file);
      } catch {
        continue;
      }
      collected.push({
        name: path.basename(file),
        size: stat.size,
        mtime: stat.mtimeMs,
        area: "Drive",
        path: rel,
        kind: kinds[rel]?.kind ?? "",
      });
    }
  }

  const kindCounts = collected.reduce((acc, item) => {
    const key = item.kind || "unclassified";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const wanted = String(kind || "").trim();
  const filtered =
    wanted && wanted !== "any" ? collected.filter((item) => item.kind === wanted) : collected;
  const all = filtered.sort((a, b) => b.mtime - a.mtime || byName(a, b));
  // pageSize <= 0 means "everything in one response": the profile view shows
  // one list with no pages and no infinite scroll.
  const requestedSize = Number(pageSize);
  const everything = !Number.isFinite(requestedSize) || requestedSize <= 0;
  const size = everything ? Math.max(all.length, 1) : Math.min(requestedSize, 500);
  const pages = everything ? 1 : Math.max(1, Math.ceil(all.length / size));
  const current = everything ? 1 : Math.min(Math.max(Number(page) || 1, 1), pages);
  const slice = everything ? all : all.slice((current - 1) * size, current * size);
  const items = await Promise.all(
    slice.map(async (item) => {
      const video = VIDEO_EXT.has(path.extname(item.name).toLowerCase());
      const cached = await thumbFor(root, item.path);
      return {
        ...item,
        // Deterministic even when the local thumb was pruned: the S4 link is
        // built from this path, and the local route regenerates it on demand.
        thumb: cached || thumbRel(item.path),
        preview: await previewFor(root, item.path),
        play: await playFor(root, item.path),
        video,
        // OCR is a later pass (vision LLM): the image shows first, the tile
        // carries "OCR pending" until Scan/ocr/<path>.txt exists.
        ocr: video ? true : await fileExists(path.join(root, "Scan", "ocr", `${item.path}.txt`)),
        // Paths are deterministic: after pruning nothing local is left to
        // stat, and the S4 link is what the browser actually uses.
        ...(await s4Links(
          path.basename(root),
          item.path,
          // A thumb link is only offered when the thumb really exists (the
          // prune keeps Scan/, so this is a local stat, not an S3 call).
          // Complete accounts get the deterministic thumb key (no HEAD); a
          // miss falls back to the full image in the browser.
          (await fileExists(path.join(root, thumbRelFor(item.path)))) ||
          (await s4Done(root))
            ? thumbRelFor(item.path)
            : "",
          (await previewFor(root, item.path)) ||
            (/[.](heic|heif)$/i.test(item.path) ? `Scan/previews/${item.path}.jpg` : ""),
          (await playFor(root, item.path)) || (video ? `Scan/play/${item.path}.mp4` : ""),
          await s4Done(root)
        )),
      };
    })
  );
  return {
    area: requested,
    items,
    total: all.length,
    page: current,
    pages,
    pageSize: size,
    kindCounts,
  };
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

function scanSummary(root) {
  return readJson(path.join(root, "Scan", "summary.json"), null);
}

/** Parsed profile/contacts/calendar/reminders + scan summary. */
export async function readSummary(root) {
  const [account, contacts, calendars, reminders, mail, mailIndex, scan] =
    await Promise.all([
      readJson(path.join(root, "Account", "account.json"), null),
      readJson(path.join(root, "Contacts", "contacts.json"), null),
      readJson(path.join(root, "Calendar", "calendars.json"), null),
      readJson(path.join(root, "Reminders", "reminders.json"), null),
      readJson(path.join(root, "Mail", "messages.json"), null),
      readJson(path.join(root, "Mail", "index.json"), null),
      scanSummary(root),
    ]);
  return { account, contacts, calendars, reminders, mail, mailIndex, scan };
}

async function loadIndex(root) {
  const raw = await readJson(path.join(root, "Scan", "index.json"), null);
  if (!raw) return [];
  const entries = Array.isArray(raw) ? raw : raw.entries;
  return Array.isArray(entries) ? entries : [];
}

async function loadFindings(root) {
  const raw = await readJson(path.join(root, "Scan", "findings.json"), null);
  if (!raw) return [];
  const found = Array.isArray(raw) ? raw : raw.findings;
  return Array.isArray(found) ? found : [];
}

function snippet(text, needle, radius = 90) {
  const body = String(text || "").replace(/\s+/g, " ").trim();
  if (!needle) return body.slice(0, radius * 2);
  const at = body.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return body.slice(0, radius * 2);
  const start = Math.max(0, at - radius);
  const end = Math.min(body.length, at + needle.length + radius);
  return `${start > 0 ? "…" : ""}${body.slice(start, end)}${end < body.length ? "…" : ""}`;
}

/** Filename-only fallback before the first scan. */
async function walkNames(root, needle, limit = 200) {
  const results = [];
  const walk = async (dir, depth) => {
    if (results.length >= limit || depth > 6) return;
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= limit) return;
      if (entry.name === "Scan" || entry.name === "manifest.sqlite3") continue;
      const full = path.join(dir, entry.name);
      const rel = relPosix(root, full);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.name.toLowerCase().includes(needle)) {
        const ext = path.extname(entry.name).toLowerCase();
        results.push({
          path: rel,
          name: entry.name,
          area: rel.startsWith("Photos/") ? "photos" : rel.startsWith("Notes/") ? "notes" : "drive",
          kind: IMAGE_EXT.has(ext) || VIDEO_EXT.has(ext) ? "image" : "file",
          snippet: rel,
        });
      }
    }
  };
  await walk(root, 0);
  return results;
}

/**
 * Search OCR/notes text and seed findings. Image hits return the image path
 * (the UI shows the picture); the OCR text is only a snippet.
 */
export async function search(
  root,
  {
    q = "",
    kind = "all",
    tier = "",
    page = 1,
    pageSize = 50,
    checksum = "",
    words = 0,
    spam = "",
    all = "",
    compact = "",
  } = {}
) {
  const needle = String(q || "").trim();
  const lower = needle.toLowerCase();
  const size = Math.min(Math.max(Number(pageSize) || 50, 1), 5000);
  const current = Math.max(Number(page) || 1, 1);
  const result = { q: needle, kind, tier, page: current, images: [], notes: [], files: [], seeds: [] };

  if (kind === "seed" || (!needle && kind === "all")) {
    const every = dedupeSeeds(await loadFindings(root));
    const spamCount = every.filter((item) => item.spam).length;
    let findings = filterSeeds(every, { tier, checksum, words });
    if (spam !== "1") findings = findings.filter((item) => !item.spam);
    if (lower) {
      findings = findings.filter(
        (item) =>
          item.phrase.includes(lower) ||
          String(item.name || "").toLowerCase().includes(lower) ||
          item.files.some((file) => file.toLowerCase().includes(lower))
      );
    }
    const start = all === "1" || compact === "1" ? 0 : (current - 1) * size;
    const slice = all === "1" || compact === "1" ? findings : findings.slice(start, start + size);
    if (compact === "1") {
      result.lines = findings.map(seedLabel).join("\n");
      result.seeds = [];
    } else {
      result.seeds = await Promise.all(
        slice.map(async (item) => ({
          ...item,
          path: item.file || item.path || "",
          thumb: item.file ? await thumbFor(root, item.file) : "",
        }))
      );
    }
    result.seedTotal = findings.length;
    result.seedSpam = spamCount;
    result.seedAll = every.length;
    result.seedPage = current;
    result.seedPages = Math.max(1, Math.ceil(findings.length / size));
    if (kind === "seed") return result;
  }

  if (!needle) return result;

  const entries = await loadIndex(root);
  if (entries.length) {
    const hits = entries.filter((entry) =>
      `${entry.name ?? ""} ${entry.path ?? ""} ${entry.text ?? ""}`
        .toLowerCase()
        .includes(lower)
    );
    for (const entry of hits) {
      const item = {
        path: entry.path,
        name: entry.name || path.basename(entry.path || ""),
        area: entry.area || "photos",
        kind: entry.kind || "file",
        snippet: snippet(entry.text, needle),
        matchedName: String(entry.name || "").toLowerCase().includes(lower),
        thumb: await thumbFor(root, entry.path),
        preview: await previewFor(root, entry.path),
        play: await playFor(root, entry.path),
      };
      if (item.kind === "image") result.images.push(item);
      else if (item.kind === "note") result.notes.push(item);
      else result.files.push(item);
    }
  } else {
    const names = await walkNames(root, lower);
    for (const item of names) {
      if (item.kind === "image") result.images.push(item);
      else result.files.push(item);
    }
  }

  result.images = result.images.slice(0, size);
  result.notes = result.notes.slice(0, size);
  result.files = result.files.slice(0, size);
  return result;
}

/** Whether an export exists for this account (root readable). */
export async function exportExists(root) {
  try {
    const stat = await fs.stat(root);
    return stat.isDirectory();
  } catch {
    return false;
  }
}
