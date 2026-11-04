import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../store.js";

/* Store persistence, atomic reload, and stale-job recovery. */

const folder = fs.mkdtempSync(path.join(os.tmpdir(), "store-test-"));
const file = path.join(folder, "items.json");

const store = new Store({ file, seed: false });
const account = store.createAccount({
  email: "persist@example.com",
  password: "pw",
  status: "queued",
  sessionDir: "sessions/abc",
  fingerprint: { userAgent: "UA" },
  geo: { ip: "203.0.113.1", country: "Germany", countryCode: "DE" },
});
const job = store.createJob({ accountId: account.id, type: "auth" });
store.flush();

assert.ok(fs.existsSync(file), "store flush writes the file");
const reloaded = new Store({ file, seed: false });
assert.equal(reloaded.accounts.size, 1);
assert.equal(reloaded.getAccount(account.id).email, "persist@example.com");
assert.equal(reloaded.getAccountByEmail("PERSIST@example.com").id, account.id);
assert.equal(reloaded.getJob(job.id).status, "unknown", "stale jobs are marked unknown");

reloaded.updateAccount(account.id, { status: "connected", trusted: true });
reloaded.flush();
const again = new Store({ file, seed: false });
assert.equal(again.getAccount(account.id).status, "connected");
assert.equal(again.getAccount(account.id).trusted, true);
assert.equal(again.getAccountByShortId(account.shortId).id, account.id);

// No partial JSON after a burst.
for (let i = 0; i < 20; i += 1) {
  again.updateAccount(account.id, { lastError: `e${i}` });
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, "utf8")));
}
again.flush();

fs.rmSync(folder, { recursive: true, force: true });
console.log("store test ok");
