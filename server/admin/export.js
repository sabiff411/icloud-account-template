import fs from "node:fs/promises";
import path from "node:path";

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
  return safeName(String(email ?? "").trim().toLowerCase(), "account");
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
export async function readTree(root, rel = "") {
  const dir = resolveWithin(root, rel);
  if (!dir) return null;
  const real = await realWithin(root, dir);
  if (!real) return null;
  let entries;
  try {
    entries = await fs.readdir(real, { withFileTypes: true });
  } catch {
    return null;
  }
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

/** One page of photos for an area (Library, Hidden, Recently Deleted, album). */
export async function gallery(root, { area = "Library", q = "", page = 1, pageSize = 60 } = {}) {
  const segment = String(area || "Library").replace(/[\\/]+/g, "_");
  const rel = `Photos/${segment}`;
  const dir = resolveWithin(root, rel);
  if (!dir) return { area: segment, items: [], total: 0, page: 1, pages: 1 };
  const real = await realWithin(root, dir);
  if (!real) return { area: segment, items: [], total: 0, page: 1, pages: 1 };

  let names = [];
  try {
    names = await fs.readdir(real);
  } catch {
    return { area: segment, items: [], total: 0, page: 1, pages: 1 };
  }
  const needle = String(q || "").trim().toLowerCase();
  const candidates = names.filter((name) => {
    if (!isMedia(name)) return false;
    return !needle || name.toLowerCase().includes(needle);
  });

  const withStats = await Promise.all(
    candidates.map(async (name) => {
      try {
        const stat = await fs.stat(path.join(real, name));
        if (!stat.isFile()) return null;
        return { name, size: stat.size, mtime: stat.mtimeMs };
      } catch {
        return null;
      }
    })
  );
  const all = withStats.filter(Boolean).sort((a, b) => b.mtime - a.mtime || byName(a, b));

  const size = Math.min(Math.max(Number(pageSize) || 60, 1), 120);
  const pages = Math.max(1, Math.ceil(all.length / size));
  const current = Math.min(Math.max(Number(page) || 1, 1), pages);
  const slice = all.slice((current - 1) * size, current * size);
  const items = await Promise.all(
    slice.map(async (item) => {
      const relPath = `${rel}/${item.name}`;
      return {
        ...item,
        path: relPath,
        thumb: await thumbFor(root, relPath),
        video: VIDEO_EXT.has(path.extname(item.name).toLowerCase()),
      };
    })
  );
  return { area: segment, items, total: all.length, page: current, pages, pageSize: size };
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
  const [account, contacts, calendars, reminders, scan] = await Promise.all([
    readJson(path.join(root, "Account", "account.json"), null),
    readJson(path.join(root, "Contacts", "contacts.json"), null),
    readJson(path.join(root, "Calendar", "calendars.json"), null),
    readJson(path.join(root, "Reminders", "reminders.json"), null),
    scanSummary(root),
  ]);
  return { account, contacts, calendars, reminders, scan };
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
  { q = "", kind = "all", tier = "", page = 1, pageSize = 50 } = {}
) {
  const needle = String(q || "").trim();
  const lower = needle.toLowerCase();
  const size = Math.min(Math.max(Number(pageSize) || 50, 1), 120);
  const current = Math.max(Number(page) || 1, 1);
  const result = { q: needle, kind, tier, page: current, images: [], notes: [], files: [], seeds: [] };

  if (kind === "seed" || (!needle && kind === "all")) {
    let findings = await loadFindings(root);
    if (tier === "valid") findings = findings.filter((item) => item.checksum);
    else if (tier) findings = findings.filter((item) => item.tier === tier);
    if (lower) {
      findings = findings.filter(
        (item) =>
          String(item.phrase || "").toLowerCase().includes(lower) ||
          String(item.name || "").toLowerCase().includes(lower)
      );
    }
    const slice = findings.slice(0, size);
    result.seeds = await Promise.all(
      slice.map(async (item) => ({
        ...item,
        path: item.file || item.path || "",
        thumb: item.file ? await thumbFor(root, item.file) : "",
      }))
    );
    if (kind === "seed") return result;
    result.seedTotal = findings.length;
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
