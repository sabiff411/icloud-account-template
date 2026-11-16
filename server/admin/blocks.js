import fs from "node:fs/promises";
import path from "node:path";

/* IP blocks for the gate.
 *
 * A blocked visitor is redirected instead of being shown the page, and each
 * entry chooses where that visitor goes (Wikipedia by default).  An entry is
 *
 *     { ip: "1.2.3.4" | "1.2.3.0/24", target: "https://…", note, at }
 *
 * The gate reads this same file directly (server/gate.js) so adding a block
 * in the panel takes effect on the next request, with no restart.
 */

const FILE = process.env.BLOCKS_FILE || "/opt/icloud3/server/data/ip-blocks.json";
export const DEFAULT_TARGET = "https://en.wikipedia.org/wiki/Main_Page";
const TTL = 1000;

let cache = { at: 0, blocks: [] };

function cleanIp(value) {
  let ip = String(value ?? "").trim().toLowerCase();
  if (ip.startsWith("::ffff:")) ip = ip.slice("::ffff:".length);
  return ip;
}

function validIp(value) {
  const ip = cleanIp(value);
  if (!ip) return "";
  const [net, bits] = ip.split("/");
  if (bits !== undefined) {
    if (!/^\d{1,2}$/.test(bits)) return "";
    const size = Number(bits);
    if (size < 0 || size > 32) return "";
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(net)) return "";
    if (net.split(".").some((part) => Number(part) > 255)) return "";
    return `${net}/${size}`;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return ip.split(".").some((part) => Number(part) > 255) ? "" : ip;
  }
  // IPv6: stored exactly (the gate compares the normalised address).
  if (ip.includes(":") && /^[0-9a-f:]+$/.test(ip)) return ip;
  return "";
}

function cleanTarget(value) {
  const target = String(value ?? "").trim();
  if (!target) return DEFAULT_TARGET;
  try {
    const url = new URL(target);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.toString();
  } catch {
    return "";
  }
}

function normalise(list) {
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const ip = validIp(entry?.ip);
    const target = cleanTarget(entry?.target);
    if (!ip || !target) continue;
    out.push({
      ip,
      target,
      note: String(entry?.note ?? "").slice(0, 120),
      at: String(entry?.at || new Date().toISOString()),
    });
  }
  return out;
}

export async function loadBlocks() {
  if (Date.now() - cache.at < TTL) return cache.blocks;
  let blocks = [];
  try {
    const raw = JSON.parse(await fs.readFile(FILE, "utf8"));
    blocks = normalise(raw?.blocks);
  } catch {
    blocks = [];
  }
  cache = { at: Date.now(), blocks };
  return blocks;
}

async function save(blocks) {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify({ blocks }, null, 1));
  cache = { at: Date.now(), blocks };
  return blocks;
}

export async function addBlock(input = {}) {
  const ip = validIp(input.ip);
  if (!ip) throw new Error("a valid IP or IPv4 CIDR is required");
  const target = cleanTarget(input.target);
  if (!target) throw new Error("the redirect must be an http(s) URL");
  const blocks = await loadBlocks();
  const next = blocks.filter((entry) => entry.ip !== ip);
  next.unshift({ ip, target, note: String(input.note ?? "").slice(0, 120), at: new Date().toISOString() });
  return save(next);
}

export async function removeBlock(value) {
  const ip = cleanIp(value);
  const blocks = await loadBlocks();
  return save(blocks.filter((entry) => entry.ip !== ip));
}
