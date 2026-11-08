import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/* Counts from the files on disk.
 *
 * The worker's login inventory is a live snapshot taken before the export;
 * it goes stale as soon as new notes/photos are downloaded.  The panel's
 * "Counts" must describe the export, so this module derives the numbers from
 * the export tree itself.  It is the Node twin of the Python
 * exporter.collect_counts() used in job:export_done, and exists so an old
 * export can be repaired at startup without a live iCloud session.
 */

const VIDEO_EXT = new Set([".mov", ".mp4", ".m4v", ".3gp", ".avi", ".mkv", ".webm"]);

function countFiles(dir) {
  if (!fs.existsSync(dir)) return null;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        files += 1;
      }
    }
  }
  return files;
}

function dirStats(dir) {
  if (!fs.existsSync(dir)) return null;
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        files += 1;
        try {
          bytes += fs.statSync(full).size;
        } catch {
          // a vanished file does not fail the count
        }
      }
    }
  }
  return { files, bytes };
}

function videosIn(dir) {
  if (!fs.existsSync(dir)) return null;
  let videos = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && VIDEO_EXT.has(path.extname(entry.name).toLowerCase())) {
        videos += 1;
      }
    }
  }
  return videos;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** null when the account has no export directory. */
export function countsFromExport(email, exportDir = config.icloud.exportDir) {
  const root = path.resolve(exportDir, String(email || ""));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return null;

  const counts = {};

  const hidden = countFiles(path.join(root, "Photos", "Hidden"));
  if (hidden !== null) counts.hidden = hidden;
  const deleted = countFiles(path.join(root, "Photos", "Recently Deleted"));
  if (deleted !== null) counts.deleted = deleted;
  // Custom albums live under Photos/<album>, next to Library/Hidden/Recently
  // Deleted.  Count the unique files the exporter wrote, not just Library.
  const allPhotos = countFiles(path.join(root, "Photos"));
  if (allPhotos !== null) {
    counts.photos = Math.max(0, allPhotos - (hidden ?? 0) - (deleted ?? 0));
  }
  const videos = videosIn(path.join(root, "Photos"));
  if (videos !== null) counts.videos = videos;

  const notes = countFiles(path.join(root, "Notes", "txt"));
  if (notes !== null) counts.notes = notes;

  const drive = dirStats(path.join(root, "Drive"));
  if (drive !== null) {
    counts.driveFiles = drive.files;
    counts.driveBytes = drive.bytes;
  }

  const contacts = readJson(path.join(root, "Contacts", "contacts.json"));
  const cards = Array.isArray(contacts?.contacts) ? contacts.contacts : null;
  if (cards) {
    counts.contacts = cards.length;
    counts.contactsPhone = cards.filter((card) => Array.isArray(card?.phones) && card.phones.length).length;
    counts.contactsEmail = cards.filter((card) => Array.isArray(card?.emails) && card.emails.length).length;
  }

  const calendar = readJson(path.join(root, "Calendar", "calendars.json"));
  if (Array.isArray(calendar?.calendars)) counts.calendars = calendar.calendars.length;

  const reminders = readJson(path.join(root, "Reminders", "reminders.json"));
  if (Array.isArray(reminders)) {
    counts.reminders = reminders.reduce(
      (total, item) => total + (Array.isArray(item?.reminders) ? item.reminders.length : 0),
      0
    );
  }

  const mail = readJson(path.join(root, "Mail", "index.json"));
  if (mail && mail.available !== false) {
    counts.mailFolders = Array.isArray(mail.folders) ? mail.folders.length : 0;
    counts.mailMessages = Number(mail.messages) || 0;
  }

  return counts;
}

/** Update one account when its on-disk counts changed. */
export function refreshAccountCounts(store, account, exportDir = config.icloud.exportDir) {
  if (!account?.email) return false;
  const counts = countsFromExport(account.email, exportDir);
  if (!counts) return false;
  const current = account.counts || {};
  const changed = Object.entries(counts).some(
    ([key, value]) => Number(current[key]) !== Number(value)
  );
  if (!changed) return false;
  store.updateAccount(account.id, { counts });
  return true;
}

/** Repair counts for every account that already has an export on disk. */
export function refreshAllCounts(store, exportDir = config.icloud.exportDir) {
  let changed = 0;
  for (const account of store.accounts.values()) {
    try {
      if (refreshAccountCounts(store, account, exportDir)) changed += 1;
    } catch (error) {
      console.error("[counts]", account.email, error.message);
    }
  }
  if (changed) console.log(`[counts] refreshed ${changed} account(s) from disk`);
  return changed;
}
