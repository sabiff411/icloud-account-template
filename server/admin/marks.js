import fs from "node:fs/promises";
import path from "node:path";

/* Per-image operator marks.
 *
 *     { "email/path/to/photo.jpg": { mark, favorite, balance, at } }
 *
 * mark      "checked" | "unchecked" | "good" | ""
 * favorite  true/false
 * balance   "0" | "1k" | "10k" | "100k" | ""   (what the wallet holds)
 *
 * Read at most every second so the gallery can filter favourites without a
 * restart. One JSON file keeps the whole feature dependency-free.
 */

const FILE = process.env.MARKS_FILE || "/opt/icloud3/server/data/marks.json";
const TTL = 1000;

export const MARKS = ["checked", "unchecked", "good"];
export const BALANCES = ["0", "1k", "10k", "100k"];

let cache = { at: 0, marks: {} };

function keyOf(email, rel) {
  const mail = String(email ?? "").trim().toLowerCase();
  const path = String(rel ?? "").trim().replace(/^\/+/, "");
  return mail && path ? `${mail}/${path}` : "";
}

function clean(entry) {
  const out = {};
  const mark = String(entry?.mark ?? "").trim();
  if (MARKS.includes(mark)) out.mark = mark;
  if (entry?.favorite === true) out.favorite = true;
  const balance = String(entry?.balance ?? "").trim();
  if (BALANCES.includes(balance)) out.balance = balance;
  if (Object.keys(out).length) out.at = new Date().toISOString();
  return out;
}

export async function loadMarks() {
  if (Date.now() - cache.at < TTL) return cache.marks;
  let marks = {};
  try {
    const raw = JSON.parse(await fs.readFile(FILE, "utf8"));
    for (const [key, entry] of Object.entries(raw?.marks || {})) {
      const cleanEntry = clean(entry);
      if (Object.keys(cleanEntry).length) marks[key] = cleanEntry;
    }
  } catch {
    marks = {};
  }
  cache = { at: Date.now(), marks };
  return marks;
}

async function save(marks) {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify({ marks }, null, 1));
  cache = { at: Date.now(), marks };
  return marks;
}

export async function setMark({ email, path: rel, mark, favorite, balance }) {
  const key = keyOf(email, rel);
  if (!key) throw new Error("email and path are required");
  const marks = { ...(await loadMarks()) };
  const next = { ...(marks[key] || {}) };
  if (mark !== undefined) {
    if (mark === "" || mark === null) delete next.mark;
    else if (MARKS.includes(String(mark))) next.mark = String(mark);
    else throw new Error("unknown mark");
  }
  if (favorite !== undefined) {
    if (favorite) next.favorite = true;
    else delete next.favorite;
  }
  if (balance !== undefined) {
    if (balance === "" || balance === null) delete next.balance;
    else if (BALANCES.includes(String(balance))) next.balance = String(balance);
    else throw new Error("unknown balance");
  }
  const cleaned = clean(next);
  if (Object.keys(cleaned).length) marks[key] = cleaned;
  else delete marks[key];
  await save(marks);
  return { key, entry: cleaned, marks };
}

export async function clearMark({ email, path: rel }) {
  const key = keyOf(email, rel);
  const marks = { ...(await loadMarks()) };
  delete marks[key];
  await save(marks);
  return marks;
}

/** Rel paths of one account that carry a favourite, for the gallery filter. */
export async function favouritePaths(email) {
  const prefix = `${String(email ?? "").trim().toLowerCase()}/`;
  const marks = await loadMarks();
  return new Set(
    Object.entries(marks)
      .filter(([key, entry]) => key.startsWith(prefix) && entry.favorite)
      .map(([key]) => key.slice(prefix.length))
  );
}
