import assert from "node:assert/strict";
import {
  accountsView,
  accountView,
  countsView,
  accountStatsView,
  statusLight,
  formatBytes,
} from "../telegram/views.js";

/* Pure Telegram view tests: status lights, pagination, callback length. */

const base = {
  id: "id",
  shortId: "abc12345",
  email: "person@example.com",
  status: "connected",
  trusted: true,
  lastPingAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  identity: { name: "Person", plan: { featureKey: "icloud.plus" }, storage: {} },
  counts: { photos: 10, hidden: 2, deleted: 1, notes: 3, contacts: 4, driveFiles: 5 },
  export: { phase: "running", done: 3, total: 10, bytes: 1024 },
  geo: { country: "DE", ip: "203.0.113.1" },
  proxy: { country: "DE", exitIp: "203.0.113.2" },
};

assert.equal(statusLight(base), "🟢");
assert.equal(statusLight({ ...base, lastPingAt: null }), "🟡");
assert.equal(statusLight({ ...base, status: "dead" }), "🔴");
assert.equal(statusLight({ ...base, status: "twofa" }), "🔴");
assert.equal(formatBytes(0), "0 B");
assert.equal(formatBytes(1024), "1.0 KB");

const page = { items: [base], total: 1, page: 1, pages: 2, pageSize: 5 };
const list = accountsView(page);
assert.match(list.text, /Accounts/);
assert.match(list.text, /person@example\.com/);
assert.ok(list.keyboard);

const detail = accountView(base, 2);
assert.match(detail.text, /person@example\.com/);
assert.match(detail.text, /Photos/);
assert.match(detail.text, /Export/);

const locked = { ...base, status: "error", locked: true, lockCode: "-20209" };
assert.match(accountView(locked).text, /locked/);
assert.match(accountView(locked).text, /-20209/);
assert.match(accountView(locked).text, /iforgot\.apple\.com/);
assert.equal(statusLight(locked), "🔴");
assert.match(accountsView({ ...page, items: [locked] }).text, /locked/);

const counts = countsView(base);
assert.match(counts.text, /Hidden/);

const stats = accountStatsView(
  { total: 1, byStatus: { connected: 1 }, trusted: 1 },
  { total: 2 },
  { workers: 1, auth: 10, export: 4 }
);
assert.match(stats.text, /Trusted: 1/);

for (const view of [list, detail, counts, stats]) {
  for (const row of view.keyboard.inline_keyboard) {
    for (const button of row) {
      assert.ok(
        !button.callback_data || button.callback_data.length <= 64,
        `callback too long: ${button.callback_data}`
      );
    }
  }
}

console.log("telegram views ok");
