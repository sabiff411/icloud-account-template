import fs from "node:fs";
import fsp from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

/* Local export size + free space, for the dashboard.
 *
 * The account store keeps the live iCloud counts ("in cloud").  What the
 * operator also needs is how much of that is on this machine right now, and
 * how much room is left — the prune moves photos to S4, so "downloaded" and
 * "on disk" are not the same number.
 */

const VIDEO_EXT = new Set([".mov", ".mp4", ".m4v", ".3gp", ".avi", ".mkv", ".webm"]);
const IMAGE_EXT = new Set([
  ".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".bmp", ".tif", ".tiff",
  ".avif", ".gif", ".dng", ".nef", ".cr2", ".cr3", ".arw", ".orf", ".rw2", ".raf",
]);
const TTL_MS = 60_000;

let cache = { at: 0, key: "", data: null };

async function bucketCount(root) {
  // What the prune moved to S4 stays "downloaded" even though it is no
  // longer on this disk: the panel must not look empty for a finished
  // account.
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(root, "Scan", "s4-manifest.json"), "utf8"));
    const files = Array.isArray(raw?.files) ? raw.files : [];
    let photos = 0;
    for (const entry of files) {
      const rel = String(entry?.p ?? "");
      if (!rel.startsWith("Photos/")) continue;
      if (VIDEO_EXT.has(path.extname(rel).toLowerCase())) continue;
      photos += 1;
    }
    return photos;
  } catch {
    return 0;
  }
}

const WALK_CONCURRENCY = 32;

/** Count media without blocking the event loop.  A 50k-image NFS tree used to
 *  run 50k synchronous stats inside the panel's 60 s /storage poll; the walk is
 *  now bounded-concurrency fsp, so a hung mount stalls one request, not the
 *  process. */
async function walkCounts(root) {
  const out = { photos: 0, videos: 0, bytes: 0 };
  const photos = path.join(root, "Photos");
  try {
    await fsp.access(photos);
  } catch {
    return out;
  }
  const dirs = [photos];
  const files = [];
  while (dirs.length) {
    const current = dirs.pop();
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        dirs.push(full);
        continue;
      }
      if (!entry.isFile() || entry.name.endsWith(".part")) continue;
      const suffix = path.extname(entry.name).toLowerCase();
      if (VIDEO_EXT.has(suffix) || IMAGE_EXT.has(suffix)) files.push({ full, suffix });
    }
  }
  let index = 0;
  async function worker() {
    while (index < files.length) {
      const { full, suffix } = files[index++];
      try {
        const stat = await fsp.stat(full);
        out.bytes += stat.size;
        if (VIDEO_EXT.has(suffix)) out.videos += 1;
        else out.photos += 1;
      } catch {
        // vanished during the walk
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(WALK_CONCURRENCY, files.length || 1) }, worker));
  return out;
}

const execFileP = promisify(execFile);

/* df in a killable child, not statfs on the libuv pool: a hard-mounted NFS
 * that stops answering must not pin one of the web process's four threads. */
async function diskOf(label, dir) {
  try {
    const { stdout } = await execFileP("df", ["-P", dir], {
      timeout: 1200,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
    });
    const line = String(stdout).trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
    const parts = line.split(/\s+/);
    if (parts.length < 6) return null;
    const total = (Number(parts[1]) || 0) * 1024;
    const used = (Number(parts[2]) || 0) * 1024;
    const free = (Number(parts[3]) || 0) * 1024;
    return { label, path: dir, total, free, used };
  } catch {
    return null;
  }
}

/** Per-account local media counts plus the free space of both disks. */
export async function localStorage(accounts, exportDir, overflowDir = "") {
  const key = exportDir;
  if (cache.data && cache.key === key && Date.now() - cache.at < TTL_MS) return cache.data;

  const perAccount = {};
  const perDisk = {};
  let cloud = 0;
  let local = 0;
  let bucket = 0;
  const rows = await Promise.all(
    accounts
      .filter((account) => account.root)
      .map(async (account) => {
        const counts = await walkCounts(account.root);
        counts.bucket = await bucketCount(account.root);
        counts.cloud = Number(account.livePhotos || 0);
        counts.onDisk = counts.photos + counts.videos;
        let real = account.root;
        try {
          real = await fsp.realpath(account.root);
        } catch {
          real = account.root;
        }
        const onOverflow = overflowDir && real.startsWith(path.resolve(overflowDir));
        return { account, counts, disk: onOverflow ? "overflow" : "export" };
      }),
  );
  for (const { account, counts, disk } of rows) {
    perAccount[account.id] = counts;
    cloud += counts.cloud;
    local += counts.onDisk;
    bucket += counts.bucket;
    const slot = (perDisk[disk] ||= { photos: 0, videos: 0, bytes: 0, accounts: 0 });
    slot.photos += counts.photos;
    slot.videos += counts.videos;
    slot.bytes += counts.bytes;
    slot.accounts += 1;
  }
  // "Downloaded" is everything we already hold: on disk now, or moved to S4
  // by the prune.  Pending is what the live account still has.
  let downloaded = 0;
  for (const counts of Object.values(perAccount)) {
    // A complete-but-not-pruned account has the same files on disk and in
    // S4; adding them double-counts and can push donePct past 100.
    downloaded += Math.max(Number(counts.onDisk || 0), Number(counts.bucket || 0));
  }
  const totals = {
    cloud,
    local,
    bucket,
    downloaded,
    pending: Math.max(0, cloud - downloaded),
    donePct: cloud ? Math.round((downloaded / cloud) * 1000) / 10 : 0,
    pendingPct: cloud ? Math.round(((cloud - downloaded) / cloud) * 1000) / 10 : 0,
  };
  const disks = [];
  const seen = new Set();
  const add = (disk) => {
    if (!disk) return;
    // export-overflow usually lives on the system disk: one bar, not two.
    const key = `${disk.total}-${disk.free}`;
    if (seen.has(key)) return;
    seen.add(key);
    disks.push(disk);
  };
  add(await diskOf("export", exportDir));
  if (overflowDir) add(await diskOf("overflow", overflowDir));
  add(await diskOf("system", "/"));

  const data = {
    at: new Date().toISOString(),
    disks,
    totals,
    perDisk,
    accounts: perAccount,
  };
  cache = { at: Date.now(), key, data };
  return data;
}

export function invalidateStorage() {
  cache = { at: 0, key: "", data: null };
}
