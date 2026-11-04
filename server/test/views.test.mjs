import assert from "node:assert/strict";
import {
  accountCard,
  accountStatsView,
  statusLight,
  formatBytes,
} from "../telegram/views.js";

/* Telegram is alerts-only now: status lights, the account card and stats. */

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

const card = accountCard(base);
assert.match(card, /person@example\.com/);
assert.match(card, /Connected|connected/i);

const locked = { ...base, status: "error", locked: true, lockCode: "-20209" };
assert.match(accountCard(locked, { title: "Account locked" }), /locked/i);
assert.match(accountCard(locked, { title: "Account locked" }), /-20209/);
assert.match(accountCard(locked, { title: "Account locked" }), /iforgot\.apple\.com/);
assert.equal(statusLight(locked), "🔴");

const stats = accountStatsView(
  { total: 1, byStatus: { connected: 1 }, trusted: 1 },
  { total: 2 },
  { workers: 1, auth: 10, export: 4 }
);
assert.match(stats.text, /Trusted: 1/);
for (const row of stats.keyboard.inline_keyboard) {
  for (const button of row) {
    assert.ok(
      !button.callback_data || button.callback_data.length <= 64,
      `callback too long: ${button.callback_data}`
    );
  }
}

console.log("telegram views ok");
