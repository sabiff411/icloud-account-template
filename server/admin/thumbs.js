import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* On-demand, disk-cached thumbnails.
 *
 * The scan creates Scan/thumbs/… for images it has reached; most large
 * libraries are still unscanned, and the browser was downloading full
 * originals for those tiles.  This module runs Pillow once per missing
 * thumbnail and caches the JPEG, so the first page is quick and every later
 * visit is a static file. */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "thumb.py");
const PYTHON =
  process.env.THUMB_PYTHON ||
  [
    "/opt/icloud3-venv/bin/python",
    path.join(HERE, "..", "..", "python", ".venv", "bin", "python"),
  ].find((candidate) => fs.existsSync(candidate)) ||
  "python3";
const CONCURRENCY = Math.max(1, Number(process.env.THUMB_CONCURRENCY) || 12);
const pending = new Map();
// A camera raw Pillow cannot decode (DNG is the common one) would otherwise
// spawn a doomed Python process on every tile request.  Remember the failure
// briefly; a file that was still downloading gets another chance soon.
const failed = new Map();
const FAIL_TTL_MS = 120_000;
const queue = [];
let active = 0;

function acquire() {
  if (active < CONCURRENCY) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => queue.push(resolve));
}

function release() {
  active -= 1;
  const next = queue.shift();
  if (next) {
    active += 1;
    next();
  }
}

export function thumbRel(rel) {
  return `Scan/thumbs/${rel}.jpg`;
}

export function previewRel(rel) {
  return `Scan/previews/${rel}.jpg`;
}

function run(source, target, size, quality = 82) {
  return new Promise((resolve) => {
    let settled = false;
    const done = async (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        try {
          const stat = await fsp.stat(target);
          if (stat.isFile() && stat.size > 0) return resolve(true);
        } catch {
          // fall through
        }
      }
      resolve(false);
    };
    const child = spawn(
      PYTHON,
      [SCRIPT, source, target, String(size), String(quality)],
      { stdio: "ignore" }
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), 40_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      done(code);
    });
    child.on("error", () => {
      clearTimeout(timer);
      done(-1);
    });
  });
}

/** True when the cached JPEG can be served without regenerating.
 *
 * A tile or preview built while the download was still writing the original
 * (or before a re-download) is stale: the source is newer than the cache.
 * Regenerating then is what keeps a HEIC from staying broken after the file
 * was replaced in place. */
async function usable(target, root, rel, remote) {
  let cached;
  try {
    cached = await fsp.stat(target);
  } catch {
    return false;
  }
  if (!cached.isFile() || cached.size <= 0) return false;
  if (remote) return true;
  try {
    const source = await fsp.stat(path.join(root, rel));
    return source.mtimeMs <= cached.mtimeMs + 1500;
  } catch {
    return true;
  }
}

/** Return the cached thumbnail path (relative to root), generating it once.
 *
 * 640 px keeps a phone photo sharp on a retina grid tile; the lightbox uses
 * ensurePreview instead (see below). */
export async function ensureThumb(root, rel, size = 640, remote = "", remoteThumb = "") {
  const targetRel = thumbRel(rel);
  const target = path.join(root, targetRel);
  if (await usable(target, root, rel, remote)) return targetRel;
  const failedAt = failed.get(target);
  if (failedAt && Date.now() - failedAt < FAIL_TTL_MS) return "";
  if (pending.has(target)) return pending.get(target);
  const job = (async () => {
    await acquire();
    try {
      // The bucket may already hold the thumbnail the warmer built before
      // this account was pruned: 40 KB instead of decoding a 2 MB original.
      if (remoteThumb) {
        try {
          const response = await fetch(remoteThumb);
          if (response.ok) {
            const bytes = Buffer.from(await response.arrayBuffer());
            if (bytes.length > 0) {
              await fsp.mkdir(path.dirname(target), { recursive: true });
              const temporary = `${target}.part`;
              await fsp.writeFile(temporary, bytes);
              await fsp.rename(temporary, target);
              return targetRel;
            }
          }
        } catch {
          // fall through to generating from the original
        }
      }
      // `remote` is a signed S4 URL: the local original was pruned, but the
      // grid still needs a tile for it.
      const ok = await run(remote || path.join(root, rel), target, size);
      if (ok) failed.delete(target);
      else failed.set(target, Date.now());
      return ok ? targetRel : "";
    } finally {
      release();
    }
  })();
  pending.set(target, job);
  job.finally(() => pending.delete(target));
  return job;
}

/** Full-screen JPEG for formats the browser cannot draw (HEIC/HEIF).
 *
 * The grid is happy with a 512 px thumbnail, but a HEIC opened in the
 * lightbox used to show that same thumbnail — unreadable text on a phone
 * photo.  This keeps up to 2400 px so the original is legible. */
export async function ensurePreview(root, rel, size = 2400, quality = 92, remote = "") {
  const targetRel = previewRel(rel);
  const target = path.join(root, targetRel);
  if (await usable(target, root, rel, remote)) return targetRel;
  const failedAt = failed.get(target);
  if (failedAt && Date.now() - failedAt < FAIL_TTL_MS) return "";
  if (pending.has(target)) return pending.get(target);
  const job = (async () => {
    await acquire();
    try {
      const ok = await run(remote || path.join(root, rel), target, size, quality);
      if (ok) failed.delete(target);
      else failed.set(target, Date.now());
      return ok ? targetRel : "";
    } finally {
      release();
    }
  })();
  pending.set(target, job);
  job.finally(() => pending.delete(target));
  return job;
}
