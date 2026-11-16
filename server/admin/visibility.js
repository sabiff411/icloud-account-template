import fs from "node:fs/promises";
import path from "node:path";

/* Per-account visibility rules for the cross-account catalog.
 *
 * The operator wants a noisy account (or just its "nude" photos) out of the
 * All page without deleting anything.  A rule is:
 *
 *     { email: "a@b.com", kinds: ["nude"] }      hide those categories
 *     { email: "a@b.com", kinds: [] }            hide the whole account
 *
 * Stored as JSON, read at most every two seconds so a change in the panel is
 * visible on the next page load.
 */

const FILE = process.env.VISIBILITY_FILE || "/opt/icloud3/server/data/visibility.json";
const TTL = 2000;

let cache = { at: 0, rules: [] };

function normalise(rules) {
  const out = [];
  for (const rule of Array.isArray(rules) ? rules : []) {
    const email = String(rule?.email ?? "").trim().toLowerCase();
    if (!email) continue;
    const kinds = Array.isArray(rule?.kinds)
      ? [...new Set(rule.kinds.map((kind) => String(kind ?? "").trim().toLowerCase()).filter(Boolean))]
      : [];
    out.push({ email, kinds });
  }
  return out;
}

export async function loadRules() {
  if (Date.now() - cache.at < TTL) return cache.rules;
  let rules = [];
  try {
    rules = normalise(JSON.parse(await fs.readFile(FILE, "utf8")).rules);
  } catch {
    rules = [];
  }
  cache = { at: Date.now(), rules };
  return rules;
}

export async function saveRules(input) {
  const rules = normalise(input);
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify({ rules }, null, 1));
  cache = { at: Date.now(), rules };
  return rules;
}

/** Is this item hidden? `kinds: []` hides every category of the account. */
export function isHidden(rules, email, kind) {
  const key = String(email ?? "").trim().toLowerCase();
  if (!key) return false;
  for (const rule of rules) {
    if (rule.email !== key) continue;
    if (rule.kinds.length === 0) return true;
    if (rule.kinds.includes(String(kind ?? "").toLowerCase())) return true;
  }
  return false;
}

/** Account-level rule with no categories: hide it from every catalog list. */
export function isAccountHidden(rules, email) {
  const key = String(email ?? "").trim().toLowerCase();
  return rules.some((rule) => rule.email === key && rule.kinds.length === 0);
}
